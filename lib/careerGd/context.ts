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
} from '@/app/career/gd/gdRoles';
import type {
  CareerGdResult,
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
  const lines: string[] = ['【GD（グループディスカッション）で見えた特性（本人の練習結果より）】'];
  if (snapshot.themeTitle) lines.push(`直近のテーマ: ${snapshot.themeTitle}`);
  lines.push(
    `企業選考目線の評価: ${snapshot.companyGrade}（${GD_GRADE_LABELS[snapshot.companyGrade]}）`,
  );
  const traitLabels = gdBehaviorTraitLabels(snapshot.behaviorTraits);
  if (traitLabels.length > 0) lines.push(`行動特性: ${traitLabels.join('、')}`);
  if (snapshot.strengthKeywords.length > 0) {
    lines.push(`GDで顕在化した強み: ${snapshot.strengthKeywords.join('、')}`);
  }
  if (snapshot.suggestedEnvironments.length > 0) {
    lines.push(`向いてそうな環境・役割: ${snapshot.suggestedEnvironments.join('、')}`);
  }
  if (snapshot.summary) lines.push(`要約: ${snapshot.summary}`);
  lines.push(
    '',
    '注意: これは1回の練習結果であり、断定材料にはしない。他データと合わせて参考程度に扱う。',
  );
  return lines.join('\n');
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
