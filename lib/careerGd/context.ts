// PASSAI 就活版 — GD 結果を他機能（careerMatching / 相談AI / 面接 / ES / 自己分析）へ
// 渡すための共通整形ヘルパー（純粋関数）。
//
// 役割: GD 完了結果（CareerGdResult）から、他機能が参照しやすい軽量スナップショットと、
//       プロンプトへ注入しやすいテキストを作る。
//   - DOM / localStorage / Supabase には触れない純粋関数のみ（client / server 双方から使う）。
//   - 実際の localStorage 読み出しは呼び出し側が `loadGdResults()`（app/career/gd/gdStorage）で行い、
//     その結果を本モジュールに渡す（既存 careerCompanyResearch/context.ts と同じ分離方針）。
//
// 使用例（他機能側 / client）:
//   import { loadGdResults } from '@/app/career/gd/gdStorage';
//   import { buildGdMatchingSnapshot, formatGdMatchingForPrompt } from '@/lib/careerGd/context';
//   const snap = buildGdMatchingSnapshot(loadGdResults()[0]);          // 最新のGD結果
//   const block = formatGdMatchingForPrompt(snap);                     // プロンプトに差し込む

import {
  GD_BEHAVIOR_TRAIT_LABELS,
  GD_GRADE_LABELS,
  GD_ROLE_LABELS,
  CAREER_GD_EVAL_AXIS_LABELS,
  CAREER_GD_EVAL_AXIS_ORDER,
} from '@/app/career/gd/gdRoles';
import type {
  CareerGdResult,
  CareerGdRoomLog,
  CareerGdAxisKey,
  GdBehaviorTrait,
  GdCompanyGrade,
  GdRole,
} from '@/types/careerGd';

const GRADES: GdCompanyGrade[] = ['S', 'A', 'B', 'C', 'D'];
const TRAITS: GdBehaviorTrait[] = [
  'leader',
  'coordinator',
  'analytical',
  'ideator',
  'listener',
  'driver',
];
const ROLES: GdRole[] = ['facilitator', 'scribe', 'timekeeper', 'presenter', 'member'];

// 他機能へ渡す最小スナップショット（matchingHints を中心に、参照元も辿れる形）。
export type GdMatchingSnapshot = {
  resultId: string;
  createdAt: string;
  themeTitle: string;
  companyGrade: GdCompanyGrade;
  behaviorTraits: GdBehaviorTrait[];
  strengthKeywords: string[];
  suggestedEnvironments: string[];
  summary: string;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// GD 結果 1 件 → matching 連携スナップショット。null / 欠損に耐える。
export function buildGdMatchingSnapshot(
  result: CareerGdResult | null | undefined,
): GdMatchingSnapshot | null {
  if (!result || typeof result !== 'object' || typeof result.id !== 'string') return null;
  const mh = result.matchingHints;
  return {
    resultId: result.id,
    createdAt: str(result.createdAt),
    themeTitle: str(result.theme?.title),
    companyGrade: mh?.companyGrade ?? result.selfCompanyGrade ?? 'B',
    behaviorTraits: Array.isArray(mh?.behaviorTraits) ? mh.behaviorTraits : [],
    strengthKeywords: Array.isArray(mh?.strengthKeywords) ? mh.strengthKeywords : [],
    suggestedEnvironments: Array.isArray(mh?.suggestedEnvironments)
      ? mh.suggestedEnvironments
      : [],
    summary: str(mh?.summary),
  };
}

// 複数の GD 結果 → 最新 1 件のスナップショット（最新更新順を想定して先頭を採用）。
export function buildLatestGdMatchingSnapshot(
  results: CareerGdResult[] | null | undefined,
): GdMatchingSnapshot | null {
  if (!results || results.length === 0) return null;
  return buildGdMatchingSnapshot(results[0]);
}

// id で GD 結果を 1 件探す（見つからなければ null）。
export function findGdResultById(
  results: CareerGdResult[] | null | undefined,
  id: string | null | undefined,
): CareerGdResult | null {
  if (!results || !id) return null;
  return results.find((r) => r.id === id) ?? null;
}

// 指定 id の GD 結果 → matching スナップショット（無ければ null → 呼び出し側で最新へフォールバック）。
export function buildGdMatchingSnapshotById(
  results: CareerGdResult[] | null | undefined,
  id: string | null | undefined,
): GdMatchingSnapshot | null {
  return buildGdMatchingSnapshot(findGdResultById(results, id));
}

// 行動特性キー配列 → 日本語ラベル配列。
export function gdBehaviorTraitLabels(traits: GdBehaviorTrait[]): string[] {
  return traits.map((t) => GD_BEHAVIOR_TRAIT_LABELS[t]).filter(Boolean);
}

// スナップショット → プロンプト用テキストブロック。空なら空文字。
// careerMatching / 相談AI / 面接 などの system/user プロンプトに差し込む用途。
export function formatGdMatchingForPrompt(
  snapshot: GdMatchingSnapshot | null | undefined,
): string {
  if (!snapshot) return '';
  // 補助情報なので簡潔に（1〜2行）。断定回避の注意は 1 文だけ残す。
  const parts: string[] = [`GD評価${snapshot.companyGrade}`];
  const traitLabels = gdBehaviorTraitLabels(snapshot.behaviorTraits);
  if (traitLabels.length > 0) parts.push(`特性:${traitLabels.join('・')}`);
  if (snapshot.strengthKeywords.length > 0) {
    parts.push(`強み:${snapshot.strengthKeywords.slice(0, 3).join('・')}`);
  }
  if (snapshot.suggestedEnvironments.length > 0) {
    parts.push(`向く環境:${snapshot.suggestedEnvironments.slice(0, 2).join('・')}`);
  }
  return [
    '# GD（補助・参考程度／断定材料にしない）',
    parts.join(' / '),
  ].join('\n');
}

function strList(value: unknown, max = 6): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeGrade(value: unknown): GdCompanyGrade {
  return GRADES.includes(value as GdCompanyGrade) ? (value as GdCompanyGrade) : 'B';
}

function normalizeTraits(value: unknown): GdBehaviorTrait[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is GdBehaviorTrait => TRAITS.includes(v as GdBehaviorTrait));
}

// API 側で受け取った matching スナップショット（unknown）を防御的に正規化する。
// クライアントが送った GdMatchingSnapshot を検証してから prompt に使う用途。
export function normalizeGdMatchingSnapshot(raw: unknown): GdMatchingSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const themeTitle = str(r.themeTitle);
  const summary = str(r.summary);
  const traits = normalizeTraits(r.behaviorTraits);
  const strengths = strList(r.strengthKeywords);
  const envs = strList(r.suggestedEnvironments);
  // 中身が実質空なら無効扱い（プロンプトに空ブロックを出さない）。
  if (!themeTitle && !summary && traits.length === 0 && strengths.length === 0) return null;
  return {
    resultId: str(r.resultId),
    createdAt: str(r.createdAt),
    themeTitle,
    companyGrade: normalizeGrade(r.companyGrade),
    behaviorTraits: traits,
    strengthKeywords: strengths,
    suggestedEnvironments: envs,
    summary,
  };
}

// ── 就活相談AI 連携（matching より情報量を多く持つ） ────────────────
// 相談AIは「GDどうだった？」「面接でどう話す？」等に答えるため、テーマ・役割・企業評価・
// overallSummary・改善課題・次回練習まで含める。最新 1〜3 件を軽量に渡す。

export type GdConsultationSnapshot = {
  resultId: string;
  createdAt: string;
  themeTitle: string;
  selfRole: GdRole;
  companyGrade: GdCompanyGrade;
  behaviorTraits: GdBehaviorTrait[];
  strengthKeywords: string[];
  suggestedEnvironments: string[];
  summary: string;
  overallSummary: string;
  improvements: string[];
  nextPracticeTasks: string[];
};

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).trim()}…`;
}

// GD 結果 1 件 → 相談AI 連携スナップショット。本人の feedback から改善課題・次回練習を拾う。
export function buildGdConsultationSnapshot(
  result: CareerGdResult | null | undefined,
): GdConsultationSnapshot | null {
  if (!result || typeof result !== 'object' || typeof result.id !== 'string') return null;
  const mh = result.matchingHints;
  const self = Array.isArray(result.participants)
    ? result.participants.find((p) => p?.isSelf)
    : undefined;
  const selfFeedback =
    self && Array.isArray(result.feedbacks)
      ? result.feedbacks.find((f) => f.participantId === self.id)
      : undefined;
  return {
    resultId: result.id,
    createdAt: str(result.createdAt),
    themeTitle: str(result.theme?.title),
    selfRole: ROLES.includes(result.selfRole) ? result.selfRole : 'member',
    companyGrade: mh?.companyGrade ?? result.selfCompanyGrade ?? 'B',
    behaviorTraits: Array.isArray(mh?.behaviorTraits) ? mh.behaviorTraits : [],
    strengthKeywords: Array.isArray(mh?.strengthKeywords) ? mh.strengthKeywords : [],
    suggestedEnvironments: Array.isArray(mh?.suggestedEnvironments)
      ? mh.suggestedEnvironments
      : [],
    summary: str(mh?.summary),
    overallSummary: str(result.overallSummary),
    improvements: Array.isArray(selfFeedback?.improvements) ? selfFeedback.improvements : [],
    nextPracticeTasks: Array.isArray(selfFeedback?.nextPracticeTasks)
      ? selfFeedback.nextPracticeTasks
      : [],
  };
}

// 複数の GD 結果（新しい順を想定）→ 最新 N 件の相談用スナップショット。
export function buildLatestGdConsultationSnapshots(
  results: CareerGdResult[] | null | undefined,
  limit = 2,
): GdConsultationSnapshot[] {
  if (!results || results.length === 0) return [];
  return results
    .slice(0, Math.max(1, limit))
    .map((r) => buildGdConsultationSnapshot(r))
    .filter((s): s is GdConsultationSnapshot => s !== null);
}

// 指定 id の GD 結果 → 相談用スナップショット（無ければ null → 呼び出し側で最新へフォールバック）。
export function buildGdConsultationSnapshotById(
  results: CareerGdResult[] | null | undefined,
  id: string | null | undefined,
): GdConsultationSnapshot | null {
  return buildGdConsultationSnapshot(findGdResultById(results, id));
}

// API 側の防御正規化（相談用スナップショット）。
export function normalizeGdConsultationSnapshot(raw: unknown): GdConsultationSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const themeTitle = str(r.themeTitle);
  const overallSummary = str(r.overallSummary);
  const summary = str(r.summary);
  if (!themeTitle && !overallSummary && !summary) return null;
  return {
    resultId: str(r.resultId),
    createdAt: str(r.createdAt),
    themeTitle,
    selfRole: ROLES.includes(r.selfRole as GdRole) ? (r.selfRole as GdRole) : 'member',
    companyGrade: normalizeGrade(r.companyGrade),
    behaviorTraits: normalizeTraits(r.behaviorTraits),
    strengthKeywords: strList(r.strengthKeywords),
    suggestedEnvironments: strList(r.suggestedEnvironments),
    summary,
    overallSummary,
    improvements: strList(r.improvements, 4),
    nextPracticeTasks: strList(r.nextPracticeTasks, 4),
  };
}

// 相談用スナップショット配列 → プロンプト用テキストブロック。空なら空文字。
export function formatGdConsultationForPrompt(
  snapshots: GdConsultationSnapshot[] | null | undefined,
): string {
  if (!snapshots || snapshots.length === 0) return '';
  const blocks = snapshots.map((s, i) => {
    const head = `■ GD${snapshots.length > 1 ? ` ${i + 1}` : ''}：${s.themeTitle || '（テーマ不明）'}`;
    const metas: string[] = [];
    if (s.createdAt) metas.push(`実施 ${s.createdAt.slice(0, 10)}`);
    metas.push(`役割 ${GD_ROLE_LABELS[s.selfRole]}`);
    metas.push(`企業評価 ${s.companyGrade}（${GD_GRADE_LABELS[s.companyGrade]}）`);
    const lines = [head, `- ${metas.join('・')}`];
    const traitLabels = gdBehaviorTraitLabels(s.behaviorTraits);
    if (traitLabels.length > 0) lines.push(`- 行動特性: ${traitLabels.join('、')}`);
    if (s.strengthKeywords.length > 0) lines.push(`- 強み: ${s.strengthKeywords.join('、')}`);
    if (s.suggestedEnvironments.length > 0) {
      lines.push(`- 向いてそうな環境: ${s.suggestedEnvironments.join('、')}`);
    }
    if (s.overallSummary) lines.push(`- 総合講評: ${truncate(s.overallSummary, 220)}`);
    if (s.improvements.length > 0) lines.push(`- 改善課題: ${s.improvements.join('、')}`);
    if (s.nextPracticeTasks.length > 0) lines.push(`- 次回練習: ${s.nextPracticeTasks.join('、')}`);
    return lines.join('\n');
  });
  return [
    '# 直近のGD（グループディスカッション）練習結果',
    ...blocks,
    '',
    'GDについて聞かれたら、この練習結果を根拠に答える。ただし1〜数回の練習であり断定はせず、',
    '面接・ES・自己分析・業界選びの相談では「GDで見えた傾向」として他データと合わせて活かす。',
  ].join('\n');
}

// ── STEP-GD-17: マルチGD（合言葉参加型・careerGdRoomLogs）を参考シグナルとして連携 ──────
// STEP-15/16 の 6 軸評価（overallScore / rank / companyCommunicationGrade / strengths /
// improvements / matchingHints / consultationSummary=generateCareerGdSummary出力）を、
// 相談AI・careerMatching へ「補助シグナル」として渡す。能力の絶対評価ではなく、あくまで
// "傾向"。断定禁止・weight 低め。全文注入せず圧縮する（既存 solo 経路とは別関数・非破壊）。

export type GdRoomSignalSnapshot = {
  roomId: string;
  createdAt: string;
  themeTitle: string;
  overallScore: number; // 0〜100
  rank: GdCompanyGrade;
  companyCommunicationGrade: GdCompanyGrade;
  axisScores: Record<CareerGdAxisKey, number>;
  topAxes: { key: CareerGdAxisKey; label: string; score: number }[]; // 上位3軸
  strengths: string[];
  improvements: string[];
  matchingHints: string[];
  summary: string; // generateCareerGdSummary 出力（圧縮済み）
};

const AXIS_KEYS = CAREER_GD_EVAL_AXIS_ORDER;

function clamp100(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(100, Math.max(0, n)));
}

// CareerGdRoomLog 1 件 → 参考シグナル。採点不能（scored=false）は信号にならないので null。
export function buildGdRoomSignal(log: CareerGdRoomLog | null | undefined): GdRoomSignalSnapshot | null {
  if (!log || typeof log !== 'object' || typeof log.roomId !== 'string') return null;
  const ev = log.evaluation;
  if (!ev || ev.scored !== true) return null;
  const axisScores = AXIS_KEYS.reduce((acc, k) => {
    acc[k] = clamp100(ev.axisScores?.[k]);
    return acc;
  }, {} as Record<CareerGdAxisKey, number>);
  const topAxes = [...AXIS_KEYS]
    .sort((a, b) => axisScores[b] - axisScores[a])
    .slice(0, 3)
    .map((k) => ({ key: k, label: CAREER_GD_EVAL_AXIS_LABELS[k], score: axisScores[k] }));
  return {
    roomId: log.roomId,
    createdAt: str(log.createdAt),
    themeTitle: str(log.theme?.title),
    overallScore: clamp100(ev.overallScore),
    rank: normalizeGrade(ev.rank),
    companyCommunicationGrade: normalizeGrade(ev.companyCommunicationGrade),
    axisScores,
    topAxes,
    strengths: strList(ev.strengths, 3),
    improvements: strList(ev.improvements, 3),
    matchingHints: strList(log.matchingHints?.hints, 3),
    summary: str(log.consultationSummary),
  };
}

// 複数の履歴（新しい順を想定）→ 直近 N 件の参考シグナル（採点済みのみ・無制限投入を防ぐ）。
export function buildLatestGdRoomSignals(
  logs: CareerGdRoomLog[] | null | undefined,
  limit = 3,
): GdRoomSignalSnapshot[] {
  if (!logs || logs.length === 0) return [];
  const out: GdRoomSignalSnapshot[] = [];
  for (const log of logs) {
    const s = buildGdRoomSignal(log);
    if (s) out.push(s);
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

// API 側の防御正規化（クライアントが送った参考シグナル unknown を検証）。
export function normalizeGdRoomSignal(raw: unknown): GdRoomSignalSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const themeTitle = str(r.themeTitle);
  const summary = str(r.summary);
  const axisRaw = r.axisScores && typeof r.axisScores === 'object' ? (r.axisScores as Record<string, unknown>) : {};
  const axisScores = AXIS_KEYS.reduce((acc, k) => {
    acc[k] = clamp100(axisRaw[k]);
    return acc;
  }, {} as Record<CareerGdAxisKey, number>);
  const topAxes = [...AXIS_KEYS]
    .sort((a, b) => axisScores[b] - axisScores[a])
    .slice(0, 3)
    .map((k) => ({ key: k, label: CAREER_GD_EVAL_AXIS_LABELS[k], score: axisScores[k] }));
  // 中身が実質空なら無効扱い。
  if (!themeTitle && !summary && topAxes.every((a) => a.score === 0)) return null;
  return {
    roomId: str(r.roomId),
    createdAt: str(r.createdAt),
    themeTitle,
    overallScore: clamp100(r.overallScore),
    rank: normalizeGrade(r.rank),
    companyCommunicationGrade: normalizeGrade(r.companyCommunicationGrade),
    axisScores,
    topAxes,
    strengths: strList(r.strengths, 3),
    improvements: strList(r.improvements, 3),
    matchingHints: strList(r.matchingHints, 3),
    summary,
  };
}

// 参考シグナル配列 → 相談AI プロンプト用ブロック。overall_summary を主に、断定回避を明示。
export function formatGdRoomSignalsForConsultation(
  signals: GdRoomSignalSnapshot[] | null | undefined,
): string {
  if (!signals || signals.length === 0) return '';
  const blocks = signals.map((s, i) => {
    const head = `■ GD${signals.length > 1 ? ` ${i + 1}` : ''}：${s.themeTitle || '（テーマ不明）'}`;
    const lines = [head];
    const meta = [`総合${s.overallScore}点/ランク${s.rank}`, `企業コミュ適性${s.companyCommunicationGrade}`];
    if (s.createdAt) meta.unshift(`実施 ${s.createdAt.slice(0, 10)}`);
    lines.push(`- ${meta.join('・')}`);
    if (s.topAxes.length > 0) lines.push(`- 相対的に高い軸: ${s.topAxes.map((a) => `${a.label}${a.score}`).join('・')}`);
    if (s.strengths.length > 0) lines.push(`- 強み: ${s.strengths.join('、')}`);
    if (s.improvements.length > 0) lines.push(`- 改善余地: ${s.improvements.join('、')}`);
    if (s.matchingHints.length > 0) lines.push(`- 就活傾向（参考）: ${s.matchingHints.join('、')}`);
    if (s.summary) lines.push(`- 要約: ${truncate(s.summary, 200)}`);
    return lines.join('\n');
  });
  return [
    '# 直近のマルチGD（グループディスカッション）評価の傾向【参考シグナル】',
    ...blocks,
    '',
    'これは1〜数回のGD練習で見えた「傾向」であり、能力の絶対評価ではない。',
    'GDだけで人格や能力を断定しない・過剰評価しない。面接/ES/自己分析/業界選びでは',
    '他のデータ（活動・自己分析・就活軸）と合わせて「GDではこうした傾向が見られた」程度に留めて活かす。',
  ].join('\n');
}

// 参考シグナル配列 → careerMatching プロンプト用ブロック（さらに軽量・補助 weight 明示）。
export function formatGdRoomSignalsForMatching(
  signals: GdRoomSignalSnapshot[] | null | undefined,
): string {
  if (!signals || signals.length === 0) return '';
  // 直近 1 件を代表に、6 軸と企業コミュ適性を 1〜2 行で。無制限投入しない。
  const s = signals[0];
  const axisLine = AXIS_KEYS.map((k) => `${CAREER_GD_EVAL_AXIS_LABELS[k]}${s.axisScores[k]}`).join('・');
  const parts = [
    `GD総合${s.overallScore}/ランク${s.rank}・企業コミュ適性${s.companyCommunicationGrade}`,
    `6軸: ${axisLine}`,
  ];
  if (s.matchingHints.length > 0) parts.push(`傾向: ${s.matchingHints.slice(0, 2).join('・')}`);
  return [
    '# GDの傾向【補助シグナル・weight低め／断定材料にしない】',
    ...parts.map((p) => `- ${p}`),
    '主情報は活動整理・自己分析・就活軸・ES・面接。GDは補助的に参考にするだけで、これ単独で相性を決めない。',
  ].join('\n');
}
