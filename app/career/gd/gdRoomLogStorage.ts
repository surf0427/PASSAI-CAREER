// PASSAI 就活版 — マルチGD 結果の学習履歴 localStorage 層（STEP-GD-16）。
//
//   - キー: 'careerGdRoomLogs'（受験版とは完全分離・career プレフィックス）。
//   - canonical は localStorage（閲覧用）。Supabase career_gd_room_results が durable mirror。
//   - 重複保存を避けるため id=roomId で upsert（同じ room の再閲覧で二重登録しない）。
//   - 防御的正規化で旧/壊れたログを弾く（既存 gdStorage と同方針）。
//   - solo の careerGdResults とは別キー（既存データを壊さない）。

import type {
  CareerGdRoomLog,
  CareerGdEvaluation,
  CareerGdRankingEntry,
  CareerGdMatchingHints,
  CareerGdAxisScores,
  GdCompanyGrade,
  GdFormat,
  GdTheme,
} from '@/types/careerGd';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';

const KEY = 'careerGdRoomLogs';

const GRADES: GdCompanyGrade[] = ['S', 'A', 'B', 'C', 'D'];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}
function grade(v: unknown): GdCompanyGrade {
  return GRADES.includes(v as GdCompanyGrade) ? (v as GdCompanyGrade) : 'D';
}
function fmt(v: unknown): GdFormat {
  return v === 'case' || v === 'abstract' ? v : 'free';
}

function normTheme(raw: unknown): GdTheme {
  const t = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    title: str(t.title),
    description: str(t.description),
    format: fmt(t.format),
    ...(Array.isArray(t.constraints) ? { constraints: strArray(t.constraints) } : {}),
  };
}

function normAxis(raw: unknown): CareerGdAxisScores {
  const a = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const c = (v: unknown) => Math.min(100, Math.max(0, num(v)));
  return {
    logicalThinking: c(a.logicalThinking),
    collaboration: c(a.collaboration),
    initiative: c(a.initiative),
    creativity: c(a.creativity),
    persuasiveness: c(a.persuasiveness),
    discussionSkill: c(a.discussionSkill),
  };
}

function normEvaluation(raw: unknown): CareerGdEvaluation {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    version: 2,
    scored: r.scored === true,
    ...(str(r.unscoredReason) ? { unscoredReason: str(r.unscoredReason) } : {}),
    axisScores: normAxis(r.axisScores),
    overallScore: Math.min(100, Math.max(0, num(r.overallScore))),
    rank: grade(r.rank),
    companyCommunicationGrade: grade(r.companyCommunicationGrade),
    strengths: strArray(r.strengths),
    weaknesses: strArray(r.weaknesses),
    improvements: strArray(r.improvements),
    goodQuotes: strArray(r.goodQuotes),
    overallComment: str(r.overallComment),
    speechCount: num(r.speechCount),
    totalSpeechCount: num(r.totalSpeechCount),
  };
}

function normRanking(raw: unknown): CareerGdRankingEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e): CareerGdRankingEntry | null => {
      if (!e || typeof e !== 'object') return null;
      const r = e as Record<string, unknown>;
      if (typeof r.participantId !== 'string') return null;
      return {
        participantId: r.participantId,
        displayName: str(r.displayName) || '参加者',
        rank: num(r.rank),
        overallScore: num(r.overallScore),
        grade: grade(r.grade),
      };
    })
    .filter((e): e is CareerGdRankingEntry => e !== null);
}

function normMatching(raw: unknown): CareerGdMatchingHints {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { hints: strArray(r.hints), summary: str(r.summary) };
}

export function normalizeGdRoomLog(raw: unknown): CareerGdRoomLog | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id) || str(r.roomId);
  if (!id) return null;
  return {
    id,
    roomId: str(r.roomId) || id,
    participantId: str(r.participantId),
    createdAt: str(r.createdAt),
    theme: normTheme(r.theme),
    format: fmt(r.format),
    participantCount: num(r.participantCount),
    humanCount: num(r.humanCount),
    durationSec: num(r.durationSec),
    evaluation: normEvaluation(r.evaluation),
    ranking: normRanking(r.ranking),
    matchingHints: normMatching(r.matchingHints),
    consultationSummary: str(r.consultationSummary),
  };
}

function sortNewestFirst(logs: CareerGdRoomLog[]): CareerGdRoomLog[] {
  return logs.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
}

export function loadGdRoomLogs(): CareerGdRoomLog[] {
  const raw = safeGetStorage<unknown[]>(KEY, []);
  const logs = raw.map(normalizeGdRoomLog).filter((l): l is CareerGdRoomLog => l !== null);
  // 新しい順（createdAt 降順）。
  return sortNewestFirst(logs);
}

export function saveGdRoomLogs(logs: CareerGdRoomLog[]): void {
  safeSetStorage(KEY, logs);
}

// roomId で重複排除して upsert（同じ room を再閲覧しても二重登録しない）。最新を先頭に。
export function appendGdRoomLog(log: CareerGdRoomLog): void {
  const logs = loadGdRoomLogs().filter((l) => l.id !== log.id && l.roomId !== log.roomId);
  saveGdRoomLogs([log, ...logs]);
}

export function removeGdRoomLog(id: string): void {
  saveGdRoomLogs(loadGdRoomLogs().filter((l) => l.id !== id));
}

// STEP-GD-19: Supabase（career_gd_room_results）から取得した履歴を localStorage へ **merge only** する。
//   - localStorage は絶対に消さない（canonical を維持）。
//   - 重複判定キーは roomId（= career_gd_room_results の (room_id, user_id) UNIQUE に対応。
//     1 ユーザー 1 room 1 結果なので roomId で一意に定まる）。
//   - 両方に存在する room は **local を残す**（local はテーマ・所要時間まで持つ richer な行）。
//   - Supabase のみ存在する room だけを新規追加する。
//   返り値: マージ後の全ログ（新しい順）。新規追加が無ければ storage を書き換えない。
export function mergeGdRoomLogs(incoming: CareerGdRoomLog[]): {
  logs: CareerGdRoomLog[];
  added: number;
} {
  const local = loadGdRoomLogs();
  if (!Array.isArray(incoming) || incoming.length === 0) return { logs: local, added: 0 };

  const seen = new Set(local.map((l) => l.roomId || l.id));
  const added: CareerGdRoomLog[] = [];
  for (const log of incoming) {
    const key = log.roomId || log.id;
    if (!key || seen.has(key)) continue; // local 優先（richer）。重複は追加しない。
    seen.add(key);
    added.push(log);
  }
  if (added.length === 0) return { logs: local, added: 0 };

  const merged = sortNewestFirst([...local, ...added]);
  saveGdRoomLogs(merged);
  return { logs: merged, added: added.length };
}
