import type {
  CareerGdSession,
  CareerGdResult,
  GdParticipant,
  GdUtterance,
  GdParticipantFeedback,
  GdRankingEntry,
  GdCompanyGrade,
  GdBehaviorTrait,
} from '@/types/careerGd';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';

// 就活版（career）GD の localStorage 保存層。
// 受験版とは完全に分離する（キーは career プレフィックス）。
//   - セッション（会話状態）: 'careerGdSessions'
//   - 最終結果（評価ログ）  : 'careerGdResults'
// DB / Supabase / usage には一切接続しない（localStorage のみ / Phase1）。
const SESSIONS_KEY = 'careerGdSessions';
const RESULTS_KEY = 'careerGdResults';

const GRADES: GdCompanyGrade[] = ['S', 'A', 'B', 'C', 'D'];
const TRAITS: GdBehaviorTrait[] = [
  'leader',
  'coordinator',
  'analytical',
  'ideator',
  'listener',
  'driver',
];

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

// ── 防御的正規化（旧スキーマ・壊れたログを弾く / optional 欠損を許容） ────────

function normalizeParticipant(raw: unknown): GdParticipant | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const p: GdParticipant = {
    id: r.id,
    type: r.type === 'ai' ? 'ai' : 'user',
    displayName: str(r.displayName) || '参加者',
    role:
      r.role === 'facilitator' ||
      r.role === 'scribe' ||
      r.role === 'timekeeper' ||
      r.role === 'presenter' ||
      r.role === 'member'
        ? r.role
        : 'member',
  };
  if (r.isSelf === true) p.isSelf = true;
  if (typeof r.userId === 'string') p.userId = r.userId;
  if (r.persona && typeof r.persona === 'object') {
    const per = r.persona as Record<string, unknown>;
    const a = per.assertiveness;
    p.persona = {
      assertiveness: a === 1 || a === 2 || a === 3 ? a : 2,
      style: str(per.style) || '一般型',
    };
  }
  return p;
}

function normalizeUtterance(raw: unknown): GdUtterance | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.participantId !== 'string') return null;
  const u: GdUtterance = {
    id: r.id,
    participantId: r.participantId,
    content: str(r.content),
    createdAt: str(r.createdAt),
  };
  if (r.kind === 'system' || r.kind === 'speech') u.kind = r.kind;
  return u;
}

function normalizeSession(raw: unknown): CareerGdSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const theme = r.theme && typeof r.theme === 'object' ? (r.theme as Record<string, unknown>) : {};
  const session: CareerGdSession = {
    id: r.id,
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
    status: r.status === 'completed' ? 'completed' : 'in_progress',
    participationMode: r.participationMode === 'multi' ? 'multi' : 'solo',
    format: r.format === 'case' || r.format === 'abstract' ? r.format : 'free',
    theme: {
      title: str(theme.title),
      description: str(theme.description),
      format:
        theme.format === 'case' || theme.format === 'abstract' ? theme.format : 'free',
      ...(Array.isArray(theme.constraints)
        ? { constraints: strArray(theme.constraints) }
        : {}),
    },
    timeLimitSec: typeof r.timeLimitSec === 'number' ? r.timeLimitSec : 900,
    plannedParticipantCount:
      typeof r.plannedParticipantCount === 'number' ? r.plannedParticipantCount : 4,
    participants: Array.isArray(r.participants)
      ? r.participants.map(normalizeParticipant).filter((p): p is GdParticipant => p !== null)
      : [],
    transcript: Array.isArray(r.transcript)
      ? r.transcript.map(normalizeUtterance).filter((u): u is GdUtterance => u !== null)
      : [],
  };
  if (typeof r.roomId === 'string') session.roomId = r.roomId;
  if (typeof r.companyResearchLogId === 'string')
    session.companyResearchLogId = r.companyResearchLogId;
  if (typeof r.selfAnalysisLogId === 'string')
    session.selfAnalysisLogId = r.selfAnalysisLogId;
  return session;
}

function normalizeGrade(value: unknown): GdCompanyGrade {
  return GRADES.includes(value as GdCompanyGrade) ? (value as GdCompanyGrade) : 'B';
}

function normalizeTraits(value: unknown): GdBehaviorTrait[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is GdBehaviorTrait => TRAITS.includes(v as GdBehaviorTrait));
}

function normalizeFeedback(raw: unknown): GdParticipantFeedback | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.participantId !== 'string') return null;
  const ax = r.axisScores && typeof r.axisScores === 'object'
    ? (r.axisScores as Record<string, unknown>)
    : {};
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const hints = r.crossFeatureHints && typeof r.crossFeatureHints === 'object'
    ? (r.crossFeatureHints as Record<string, unknown>)
    : {};
  const cross: GdParticipantFeedback['crossFeatureHints'] = {};
  if (str(hints.matching)) cross.matching = str(hints.matching);
  if (str(hints.interview)) cross.interview = str(hints.interview);
  if (str(hints.es)) cross.es = str(hints.es);
  if (str(hints.selfAnalysis)) cross.selfAnalysis = str(hints.selfAnalysis);
  return {
    participantId: r.participantId,
    axisScores: {
      logic: num(ax.logic),
      cooperation: num(ax.cooperation),
      volume: num(ax.volume),
      roleExecution: num(ax.roleExecution),
      drive: num(ax.drive),
      listening: num(ax.listening),
    },
    totalScore: num(r.totalScore),
    companyGrade: normalizeGrade(r.companyGrade),
    companyImpression: str(r.companyImpression),
    behaviorTraits: normalizeTraits(r.behaviorTraits),
    improvements: strArray(r.improvements),
    nextPracticeTasks: strArray(r.nextPracticeTasks),
    crossFeatureHints: cross,
  };
}

function normalizeResult(raw: unknown): CareerGdResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const theme = r.theme && typeof r.theme === 'object' ? (r.theme as Record<string, unknown>) : {};
  const mh = r.matchingHints && typeof r.matchingHints === 'object'
    ? (r.matchingHints as Record<string, unknown>)
    : {};
  const result: CareerGdResult = {
    id: r.id,
    createdAt: str(r.createdAt),
    participationMode: r.participationMode === 'multi' ? 'multi' : 'solo',
    format: r.format === 'case' || r.format === 'abstract' ? r.format : 'free',
    theme: {
      title: str(theme.title),
      description: str(theme.description),
      format:
        theme.format === 'case' || theme.format === 'abstract' ? theme.format : 'free',
      ...(Array.isArray(theme.constraints)
        ? { constraints: strArray(theme.constraints) }
        : {}),
    },
    timeLimitSec: typeof r.timeLimitSec === 'number' ? r.timeLimitSec : 900,
    participants: Array.isArray(r.participants)
      ? r.participants.map(normalizeParticipant).filter((p): p is GdParticipant => p !== null)
      : [],
    transcript: Array.isArray(r.transcript)
      ? r.transcript.map(normalizeUtterance).filter((u): u is GdUtterance => u !== null)
      : [],
    selfRole:
      r.selfRole === 'facilitator' ||
      r.selfRole === 'scribe' ||
      r.selfRole === 'timekeeper' ||
      r.selfRole === 'presenter' ||
      r.selfRole === 'member'
        ? r.selfRole
        : 'member',
    feedbacks: Array.isArray(r.feedbacks)
      ? r.feedbacks
          .map(normalizeFeedback)
          .filter((f): f is GdParticipantFeedback => f !== null)
      : [],
    selfCompanyGrade: normalizeGrade(r.selfCompanyGrade),
    overallSummary: str(r.overallSummary),
    matchingHints: {
      behaviorTraits: normalizeTraits(mh.behaviorTraits),
      strengthKeywords: strArray(mh.strengthKeywords),
      suggestedEnvironments: strArray(mh.suggestedEnvironments),
      companyGrade: normalizeGrade(mh.companyGrade),
      summary: str(mh.summary),
    },
  };
  if (Array.isArray(r.ranking)) {
    const ranking = (r.ranking as unknown[])
      .map((raw2): GdRankingEntry | null => {
        if (!raw2 || typeof raw2 !== 'object') return null;
        const rr = raw2 as Record<string, unknown>;
        if (typeof rr.participantId !== 'string') return null;
        return {
          participantId: rr.participantId,
          rank: typeof rr.rank === 'number' ? rr.rank : 0,
          totalScore: typeof rr.totalScore === 'number' ? rr.totalScore : 0,
          companyGrade: normalizeGrade(rr.companyGrade),
          reason: str(rr.reason),
        };
      })
      .filter((e): e is GdRankingEntry => e !== null);
    if (ranking.length > 0) result.ranking = ranking;
  }
  if (typeof r.roomId === 'string') result.roomId = r.roomId;
  if (typeof r.companyResearchLogId === 'string')
    result.companyResearchLogId = r.companyResearchLogId;
  if (typeof r.selfAnalysisLogId === 'string')
    result.selfAnalysisLogId = r.selfAnalysisLogId;
  if (r.favorite === true) result.favorite = true;
  return result;
}

// ── セッション ────────────────────────────────────────────────────

export function loadGdSessions(): CareerGdSession[] {
  const raw = safeGetStorage<unknown[]>(SESSIONS_KEY, []);
  return raw.map(normalizeSession).filter((s): s is CareerGdSession => s !== null);
}

export function saveGdSessions(sessions: CareerGdSession[]): void {
  safeSetStorage(SESSIONS_KEY, sessions);
}

// id があれば置換、無ければ先頭に追加（最新が先頭）。
export function upsertGdSession(session: CareerGdSession): void {
  const sessions = loadGdSessions();
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    sessions[idx] = session;
    saveGdSessions(sessions);
  } else {
    saveGdSessions([session, ...sessions]);
  }
}

export function getGdSession(id: string): CareerGdSession | null {
  return loadGdSessions().find((s) => s.id === id) ?? null;
}

export function getInProgressGdSession(): CareerGdSession | null {
  return loadGdSessions().find((s) => s.status === 'in_progress') ?? null;
}

// ── 最終結果 ──────────────────────────────────────────────────────

export function loadGdResults(): CareerGdResult[] {
  const raw = safeGetStorage<unknown[]>(RESULTS_KEY, []);
  return raw.map(normalizeResult).filter((r): r is CareerGdResult => r !== null);
}

export function saveGdResults(results: CareerGdResult[]): void {
  safeSetStorage(RESULTS_KEY, results);
}

export function appendGdResult(result: CareerGdResult): void {
  saveGdResults([result, ...loadGdResults()]);
}

export function updateGdResult(id: string, patch: Partial<CareerGdResult>): void {
  const results = loadGdResults();
  const idx = results.findIndex((r) => r.id === id);
  if (idx < 0) return;
  results[idx] = { ...results[idx], ...patch };
  saveGdResults(results);
}
