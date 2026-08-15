// PASSAI 就活版 — 就活相談AI（司令塔）へ「最新1件」ではなく「軽量な複数件＋推移」を渡す層。
//
// 役割: self-analysis / ES / interview / presentation の各ログ（複数件）から、相談AIが
//       成長・一貫性・繰り返し課題を読める軽量スナップショットと、プロンプト用テキスト（推移メモ付き）を作る。
//   - DOM / localStorage / API / DB には触れない純粋関数（client=snapshot 構築 / server=normalize+format）。
//   - 実データ読み出しは呼び出し側（page.tsx）が既存 load 関数で行い、その結果を渡す
//     （careerGd/context.ts・careerMatching/consultationContext.ts と同じ分離方針）。
//   - トークン肥大を避けるため、全文は渡さず truncate・配列上限・件数上限を必ずかける。

import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerEsLog } from '@/types/careerEs';
import type { CareerInterviewResult } from '@/types/careerInterview';
import type { CareerPresentationResult } from '@/types/careerPresentation';
import type { CareerActivity } from '@/types/careerActivity';
// P4-B: str / truncate / strList / repeatedItems を共通 util へ集約（出力は従来と byte 一致）。
import { str, truncate, strList, repeatedItems } from '@/lib/careerMemory/summaryUtils';
// 自己分析の更新（revision 追記）は「同じ自己分析の新しい版」。相談AIへ渡す履歴では
// lineage ごとに最新 revision だけを 1 件として数える（過去 revision は削除しない）。
import { collapseSelfAnalysisRevisions } from '@/lib/careerSelfAnalysis/revisionLineage';

// 件数上限（各ログ最新 N 件）。トークン肥大を避けるため 3 件まで。
const HISTORY_LIMIT = 3;

// ── self-analysis ────────────────────────────────────────────────

export type SelfAnalysisHistorySnapshot = {
  createdAt: string;
  summary: string;
  careerDirection: string;
  strengths: string[];
  weaknesses: string[];
  recommendedIndustries: string[];
  recommendedJobs: string[];
  companySelectionCriteria: string[];
  gakuchikaIdeas: string[];
};

export function buildSelfAnalysisHistory(
  logs: CareerSelfAnalysisLog[] | null | undefined,
  limit = HISTORY_LIMIT,
): SelfAnalysisHistorySnapshot[] {
  if (!logs || logs.length === 0) return [];
  // revision を持たないデータでは入力配列がそのまま返るため、既存出力は byte 一致。
  return collapseSelfAnalysisRevisions(logs)
    .slice(0, Math.max(1, limit))
    .map((log) => {
      const r = log?.result;
      if (!r) return null;
      return {
        createdAt: str(log.createdAt),
        summary: truncate(r.summary, 160),
        careerDirection: truncate(r.careerDirection, 120),
        strengths: strList(r.strengths, 3, 40),
        weaknesses: strList(r.weaknesses, 3, 40),
        recommendedIndustries: strList(r.recommendedIndustries, 3, 30),
        recommendedJobs: strList(r.recommendedJobs, 3, 30),
        companySelectionCriteria: strList(r.companySelectionCriteria, 3, 40),
        gakuchikaIdeas: strList(r.gakuchikaIdeas, 3, 60),
      };
    })
    .filter((s): s is SelfAnalysisHistorySnapshot => s !== null);
}

// ── ES ───────────────────────────────────────────────────────────

export type EsHistorySnapshot = {
  createdAt: string;
  companyName: string;
  question: string;
  headline: string;
  gakuchika: string;
  selfPr: string;
  motivation: string;
  appealPoints: string[];
  // 新: ユーザーが自分で書いた ES 本文（ESトレーニングシステム化以降）。
  // 旧生成ログには無いため optional。消費側は欠損を前提に扱うこと。
  body?: string;
};

export function buildEsHistory(
  logs: CareerEsLog[] | null | undefined,
  limit = HISTORY_LIMIT,
): EsHistorySnapshot[] {
  if (!logs || logs.length === 0) return [];
  return logs
    .slice(0, Math.max(1, limit))
    .map((log): EsHistorySnapshot | null => {
      const r = log?.result;
      if (!r) return null;
      return {
        createdAt: str(log.createdAt),
        companyName: truncate(log.companyName ?? r.companyName, 40),
        question: truncate(log.question ?? r.question, 80),
        headline: truncate(r.headline, 60),
        gakuchika: truncate(r.gakuchika, 160),
        selfPr: truncate(r.selfPr, 160),
        motivation: truncate(r.motivation, 160),
        appealPoints: strList(r.appealPoints, 3, 40),
        // 新: ユーザーが書いた本文。body 優先、無ければ result.answer（設問モード回答）。
        body: truncate(log.body ?? r.answer, 200),
      };
    })
    .filter((s): s is EsHistorySnapshot => s !== null);
}

// ── interview ────────────────────────────────────────────────────

export type InterviewHistorySnapshot = {
  createdAt: string;
  mode: string;
  overallComment: string;
  strengths: string[];
  improvements: string[];
  deepDiveTopics: string[];
  nextActions: string[];
  companyFit: string;
};

export function buildInterviewHistory(
  logs: CareerInterviewResult[] | null | undefined,
  limit = HISTORY_LIMIT,
): InterviewHistorySnapshot[] {
  if (!logs || logs.length === 0) return [];
  return logs
    .slice(0, Math.max(1, limit))
    .map((log) => {
      const r = log?.result;
      if (!r) return null;
      return {
        createdAt: str(log.createdAt),
        mode: str(log.mode),
        overallComment: truncate(r.overallComment, 160),
        strengths: strList(r.strengths, 3, 40),
        improvements: strList(r.improvements, 3, 50),
        deepDiveTopics: strList(r.deepDiveTopics, 3, 50),
        nextActions: strList(r.nextActions, 3, 50),
        companyFit: truncate(r.companyFit, 120),
      };
    })
    .filter((s): s is InterviewHistorySnapshot => s !== null);
}

// ── presentation ─────────────────────────────────────────────────

export type PresentationHistorySnapshot = {
  createdAt: string;
  presentationType: string;
  theme: string;
  totalScore: number | null;
  rank: string;
  overallComment: string;
  improvements: string[];
  priorityImprovements: string[];
  expectedQuestions: string[];
  nextPractice: string[];
  companyFit: string;
};

export function buildPresentationHistory(
  logs: CareerPresentationResult[] | null | undefined,
  limit = HISTORY_LIMIT,
): PresentationHistorySnapshot[] {
  if (!logs || logs.length === 0) return [];
  return logs
    .slice(0, Math.max(1, limit))
    .map((log) => {
      const r = log?.result;
      if (!r) return null;
      return {
        createdAt: str(log.createdAt),
        presentationType: str(log.presentationType),
        theme: truncate(log.theme, 60),
        totalScore: typeof r.totalScore === 'number' ? r.totalScore : null,
        rank: str(r.rank),
        overallComment: truncate(r.overallComment, 160),
        improvements: strList(r.improvements, 3, 50),
        priorityImprovements: strList(r.priorityImprovements, 3, 50),
        expectedQuestions: strList(r.expectedQuestions, 3, 50),
        nextPractice: strList(r.nextPractice, 3, 50),
        companyFit: truncate(r.companyFit, 120),
      };
    })
    .filter((s): s is PresentationHistorySnapshot => s !== null);
}

// ── activity 圧縮（相談用ダイジェスト） ──────────────────────────────
// 活動整理は 18 セクション全量だとトークンが重い。同じ CareerActivity 形状のまま、
// あらゆる配列を先頭 maxArr 件・あらゆる文字列を maxStr 文字に丸めた「軽量版」を返す。
// 形状を保つため既存の共通基盤 renderActivity がそのまま描画でき、
// 「活動・経験→強み→ES/面接材料」の要点は残しつつ全文注入を避けられる。

function deepTrim(value: unknown, maxStr: number, maxArr: number): unknown {
  if (typeof value === 'string') {
    return value.length > maxStr ? `${value.slice(0, maxStr).trim()}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, maxArr).map((v) => deepTrim(v, maxStr, maxArr));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepTrim(v, maxStr, maxArr);
    }
    return out;
  }
  return value;
}

// 相談用に圧縮した CareerActivity（各セクション最大3件・各文字列160字まで）。
export function compressCareerActivityForConsultation(
  activity: CareerActivity | null | undefined,
): CareerActivity | null {
  if (!activity) return null;
  return deepTrim(activity, 160, 3) as CareerActivity;
}

// ── API 側の防御正規化（クライアントが送ったスナップショット配列を検証） ──────────
// 形は build* と 1:1。中身が実質空の要素は落とす。件数は HISTORY_LIMIT に丸める。

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function normalizeSelfAnalysisHistory(raw: unknown): SelfAnalysisHistorySnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const r = rec(item);
      if (!r) return null;
      const snap: SelfAnalysisHistorySnapshot = {
        createdAt: str(r.createdAt),
        summary: truncate(r.summary, 160),
        careerDirection: truncate(r.careerDirection, 120),
        strengths: strList(r.strengths, 3, 40),
        weaknesses: strList(r.weaknesses, 3, 40),
        recommendedIndustries: strList(r.recommendedIndustries, 3, 30),
        recommendedJobs: strList(r.recommendedJobs, 3, 30),
        companySelectionCriteria: strList(r.companySelectionCriteria, 3, 40),
        gakuchikaIdeas: strList(r.gakuchikaIdeas, 3, 60),
      };
      const hasContent =
        snap.summary ||
        snap.strengths.length ||
        snap.recommendedIndustries.length ||
        snap.gakuchikaIdeas.length;
      return hasContent ? snap : null;
    })
    .filter((s): s is SelfAnalysisHistorySnapshot => s !== null)
    .slice(0, HISTORY_LIMIT);
}

export function normalizeEsHistory(raw: unknown): EsHistorySnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const r = rec(item);
      if (!r) return null;
      // 新: client 側 buildEsHistory が保持した本人本文（body / 旧設問モード answer 投影）を
      // server 側でも保持する。string 以外・空白のみは truncate が空文字へ正規化する。
      const body = truncate(r.body, 200);
      const snap: EsHistorySnapshot = {
        createdAt: str(r.createdAt),
        companyName: truncate(r.companyName, 40),
        question: truncate(r.question, 80),
        headline: truncate(r.headline, 60),
        gakuchika: truncate(r.gakuchika, 160),
        selfPr: truncate(r.selfPr, 160),
        motivation: truncate(r.motivation, 160),
        appealPoints: strList(r.appealPoints, 3, 40),
        ...(body ? { body } : {}),
      };
      // body-only ログ（旧生成 4 field が空）を content 判定で落とさない。空白 body は content 扱いしない。
      const hasContent = body || snap.gakuchika || snap.selfPr || snap.motivation || snap.headline;
      return hasContent ? snap : null;
    })
    .filter((s): s is EsHistorySnapshot => s !== null)
    .slice(0, HISTORY_LIMIT);
}

export function normalizeInterviewHistory(raw: unknown): InterviewHistorySnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const r = rec(item);
      if (!r) return null;
      const snap: InterviewHistorySnapshot = {
        createdAt: str(r.createdAt),
        mode: str(r.mode),
        overallComment: truncate(r.overallComment, 160),
        strengths: strList(r.strengths, 3, 40),
        improvements: strList(r.improvements, 3, 50),
        deepDiveTopics: strList(r.deepDiveTopics, 3, 50),
        nextActions: strList(r.nextActions, 3, 50),
        companyFit: truncate(r.companyFit, 120),
      };
      const hasContent =
        snap.overallComment || snap.strengths.length || snap.improvements.length;
      return hasContent ? snap : null;
    })
    .filter((s): s is InterviewHistorySnapshot => s !== null)
    .slice(0, HISTORY_LIMIT);
}

export function normalizePresentationHistory(raw: unknown): PresentationHistorySnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const r = rec(item);
      if (!r) return null;
      const score = typeof r.totalScore === 'number' && Number.isFinite(r.totalScore)
        ? r.totalScore
        : null;
      const snap: PresentationHistorySnapshot = {
        createdAt: str(r.createdAt),
        presentationType: str(r.presentationType),
        theme: truncate(r.theme, 60),
        totalScore: score,
        rank: str(r.rank),
        overallComment: truncate(r.overallComment, 160),
        improvements: strList(r.improvements, 3, 50),
        priorityImprovements: strList(r.priorityImprovements, 3, 50),
        expectedQuestions: strList(r.expectedQuestions, 3, 50),
        nextPractice: strList(r.nextPractice, 3, 50),
        companyFit: truncate(r.companyFit, 120),
      };
      const hasContent =
        snap.overallComment || snap.improvements.length || snap.totalScore !== null;
      return hasContent ? snap : null;
    })
    .filter((s): s is PresentationHistorySnapshot => s !== null)
    .slice(0, HISTORY_LIMIT);
}

// ── 推移メモ（ルールベース・AI要約は使わない） ──────────────────────────

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

// ── プロンプト用整形（推移メモ付き）。空なら空文字。 ────────────────────────
// snapshots は「新しい順」を想定（page の load 関数が先頭=最新）。

export function formatSelfAnalysisHistoryForPrompt(
  snaps: SelfAnalysisHistorySnapshot[] | null | undefined,
): string {
  if (!snaps || snaps.length === 0) return '';
  const lines = snaps.map((s) => {
    const parts: string[] = [];
    if (s.careerDirection) parts.push(`方向性:${s.careerDirection}`);
    if (s.strengths.length) parts.push(`強み:${s.strengths.join('・')}`);
    if (s.weaknesses.length) parts.push(`弱み:${s.weaknesses.join('・')}`);
    if (s.recommendedIndustries.length) parts.push(`向く業界:${s.recommendedIndustries.join('・')}`);
    if (s.gakuchikaIdeas.length) parts.push(`ガクチカ候補:${s.gakuchikaIdeas.join('・')}`);
    return `- ${s.createdAt.slice(0, 10) || '日付不明'}：${parts.join(' / ') || s.summary}`;
  });
  const memo: string[] = [];
  if (snaps.length >= 2) {
    const consistent = repeatedItems(snaps.map((s) => s.strengths));
    if (consistent.length) memo.push(`複数回で一貫している強み: ${consistent.join('・')}`);
    const newest = snaps[0].recommendedIndustries;
    const oldest = snaps[snaps.length - 1].recommendedIndustries;
    if (newest.length && oldest.length && !sameSet(newest, oldest)) {
      memo.push(`推奨業界が変化: ${oldest.join('・')} → ${newest.join('・')}`);
    }
  }
  return [
    '# 自己分析の推移（最新→過去）',
    ...lines,
    memo.length ? `推移メモ：${memo.join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatEsHistoryForPrompt(
  snaps: EsHistorySnapshot[] | null | undefined,
): string {
  if (!snaps || snaps.length === 0) return '';
  const lines = snaps.map((s) => {
    const head = [s.createdAt.slice(0, 10) || '日付不明', s.companyName].filter(Boolean).join(' / ');
    const parts: string[] = [];
    if (s.question) parts.push(`設問:${s.question}`);
    // 新: ユーザー本人が書いた本文を最優先で出す。body があれば旧生成 4 field は出さない
    // （body-only ログでは空。both は現行データモデルでは発生しない）。旧生成ログは従来どおり。
    // 本文は本人執筆のみ（AI の添削・改善案は本文として出さない）。
    if (s.body) {
      parts.push(`本文:${s.body}`);
    } else {
      if (s.gakuchika) parts.push(`ガクチカ:${s.gakuchika}`);
      if (s.selfPr) parts.push(`自己PR:${s.selfPr}`);
      if (s.motivation) parts.push(`志望動機:${s.motivation}`);
    }
    return `- ${head}：${parts.join(' / ')}`;
  });
  const memo: string[] = [];
  const companies = [...new Set(snaps.map((s) => s.companyName).filter(Boolean))];
  if (companies.length >= 2) memo.push(`複数社（${companies.join('・')}）分のESあり。志望動機の企業固有性を確認`);
  if (snaps.length >= 2) {
    const consistentAppeal = repeatedItems(snaps.map((s) => s.appealPoints));
    if (consistentAppeal.length) memo.push(`繰り返すアピール軸: ${consistentAppeal.join('・')}`);
  }
  return [
    '# ESの推移（最新→過去）',
    ...lines,
    memo.length ? `推移メモ：${memo.join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatInterviewHistoryForPrompt(
  snaps: InterviewHistorySnapshot[] | null | undefined,
): string {
  if (!snaps || snaps.length === 0) return '';
  const lines = snaps.map((s) => {
    const parts: string[] = [];
    if (s.overallComment) parts.push(`総評:${s.overallComment}`);
    if (s.improvements.length) parts.push(`改善点:${s.improvements.join('・')}`);
    if (s.strengths.length) parts.push(`良かった点:${s.strengths.join('・')}`);
    return `- ${s.createdAt.slice(0, 10) || '日付不明'}${s.mode ? `(${s.mode})` : ''}：${parts.join(' / ')}`;
  });
  const memo: string[] = [];
  if (snaps.length >= 2) {
    const repeatedWeak = repeatedItems(snaps.map((s) => s.improvements));
    if (repeatedWeak.length) memo.push(`繰り返し出ている改善点（優先課題）: ${repeatedWeak.join('・')}`);
    const repeatedStrong = repeatedItems(snaps.map((s) => s.strengths));
    if (repeatedStrong.length) memo.push(`安定している強み: ${repeatedStrong.join('・')}`);
  }
  return [
    '# 面接練習の推移（最新→過去）',
    ...lines,
    memo.length ? `推移メモ：${memo.join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatPresentationHistoryForPrompt(
  snaps: PresentationHistorySnapshot[] | null | undefined,
): string {
  if (!snaps || snaps.length === 0) return '';
  const lines = snaps.map((s) => {
    const head = [
      s.createdAt.slice(0, 10) || '日付不明',
      s.theme,
      s.totalScore !== null ? `${s.totalScore}点${s.rank ? `(${s.rank})` : ''}` : '',
    ]
      .filter(Boolean)
      .join(' / ');
    const parts: string[] = [];
    if (s.improvements.length) parts.push(`改善点:${s.improvements.join('・')}`);
    if (s.expectedQuestions.length) parts.push(`想定質問:${s.expectedQuestions.join('・')}`);
    return `- ${head}：${parts.join(' / ')}`;
  });
  const memo: string[] = [];
  const scored = snaps.filter((s) => s.totalScore !== null);
  if (scored.length >= 2) {
    // snaps は新しい順なので、過去→最新の並びに直してから傾向を見る。
    const chrono = [...scored].reverse();
    const first = chrono[0].totalScore as number;
    const last = chrono[chrono.length - 1].totalScore as number;
    if (last > first) memo.push(`スコア改善傾向（${first}→${last}点）。次に伸ばす点を明確化`);
    else if (last < first) memo.push(`スコア低下傾向（${first}→${last}点）。原因は断定せず整理`);
  }
  return [
    '# プレゼン練習の推移（最新→過去）',
    ...lines,
    memo.length ? `推移メモ：${memo.join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
