// PASSAI 就活版 — 自己分析AI「深掘り」向けの過去ログ圧縮 & 入力カバレッジ棚卸し。
//
// 目的（STEP-SELF-ANALYSIS-DEEPDIVE-01）:
//   自己分析は「1回で掘り切る」のではなく「複数回で少しずつ深まる」設計にする。
//   そのために深掘り質問AI・結果生成AIへ、
//     1) 過去ログの軽量サマリ（繰り返し回避・次テーマ選定用）
//     2) 入力済みの活動・就活軸の棚卸し（1回で幅広く横断させるため）
//   を渡す。トークン肥大を避けるため、全文は渡さず truncate・件数上限・配列上限を必ずかける。
//
// 設計方針（historySnapshots.ts と同じ分離思想）:
//   - DOM / localStorage / API / DB には触れない純粋関数のみ。
//   - 過去ログの実データ読み出しは呼び出し側（run/page.tsx）が loadSelfAnalysisLogs() で行い、
//     その結果を build* に渡す。サーバ側は normalize* で防御的に再検証してから使う。
//   - 既存ログに v2 フィールドが無くても落ちないよう、全フィールドを「未定義なら空」で扱う。

import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerActivityInput, CareerValuesInput } from '@/lib/careerAi';
// P4-B: str / truncate / strList / repeatedItems を共通 util へ集約（出力は従来と byte 一致）。
import { str, truncate, strList, repeatedItems } from '@/lib/careerMemory/summaryUtils';

// 件数上限（過去ログ最新 N 件）。トークン肥大を避けるため 3 件まで。
export const SELF_ANALYSIS_PAST_LIMIT = 3;

// ── 過去ログ圧縮 ──────────────────────────────────────────────────
// 渡すのは「繰り返し回避」と「次の深掘りテーマ選定」に必要な項目だけ。全文は渡さない。

export type SelfAnalysisPastSummary = {
  createdAt: string;
  summary: string;
  careerDirection: string;
  strengths: string[];
  weaknesses: string[];
  valueKeywords: string[];
  strengthKeywords: string[];
  recommendedIndustries: string[];
  recommendedJobs: string[];
  companySelectionCriteria: string[];
  nextActions: string[];
};

// クライアント（run/page.tsx）が loadSelfAnalysisLogs() の結果から作る。最新が先頭。
export function buildSelfAnalysisPastSummaries(
  logs: CareerSelfAnalysisLog[] | null | undefined,
  limit = SELF_ANALYSIS_PAST_LIMIT,
): SelfAnalysisPastSummary[] {
  if (!logs || logs.length === 0) return [];
  return logs
    .slice(0, Math.max(1, limit))
    .map((log) => {
      const r = log?.result;
      if (!r) return null;
      return {
        createdAt: str(log.createdAt),
        summary: truncate(r.summary, 140),
        careerDirection: truncate(r.careerDirection, 120),
        strengths: strList(r.strengths, 3, 40),
        weaknesses: strList(r.weaknesses, 3, 40),
        valueKeywords: strList(r.valueKeywords, 5, 20),
        strengthKeywords: strList(r.strengthKeywords, 5, 20),
        recommendedIndustries: strList(r.recommendedIndustries, 3, 30),
        recommendedJobs: strList(r.recommendedJobs, 3, 30),
        companySelectionCriteria: strList(r.companySelectionCriteria, 3, 40),
        nextActions: strList(r.nextActions, 3, 60),
      };
    })
    .filter((s): s is SelfAnalysisPastSummary => s !== null);
}

// API 側の防御正規化（クライアントが送った配列を再検証）。build* と 1:1。
function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function normalizeSelfAnalysisPastSummaries(raw: unknown): SelfAnalysisPastSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const r = rec(item);
      if (!r) return null;
      const snap: SelfAnalysisPastSummary = {
        createdAt: str(r.createdAt),
        summary: truncate(r.summary, 140),
        careerDirection: truncate(r.careerDirection, 120),
        strengths: strList(r.strengths, 3, 40),
        weaknesses: strList(r.weaknesses, 3, 40),
        valueKeywords: strList(r.valueKeywords, 5, 20),
        strengthKeywords: strList(r.strengthKeywords, 5, 20),
        recommendedIndustries: strList(r.recommendedIndustries, 3, 30),
        recommendedJobs: strList(r.recommendedJobs, 3, 30),
        companySelectionCriteria: strList(r.companySelectionCriteria, 3, 40),
        nextActions: strList(r.nextActions, 3, 60),
      };
      const hasContent =
        snap.summary ||
        snap.strengths.length ||
        snap.valueKeywords.length ||
        snap.recommendedIndustries.length ||
        snap.nextActions.length;
      return hasContent ? snap : null;
    })
    .filter((s): s is SelfAnalysisPastSummary => s !== null)
    .slice(0, SELF_ANALYSIS_PAST_LIMIT);
}

// プロンプト用整形。過去ログ無しなら空文字（ブロックごと出さない）。
// snaps は「新しい順」を想定（run/page.tsx の load 関数が先頭=最新）。
export function formatPastSummariesForPrompt(
  snaps: SelfAnalysisPastSummary[] | null | undefined,
): string {
  if (!snaps || snaps.length === 0) return '';
  const lines = snaps.map((s) => {
    const parts: string[] = [];
    if (s.careerDirection) parts.push(`方向性:${s.careerDirection}`);
    if (s.strengths.length) parts.push(`強み:${s.strengths.join('・')}`);
    if (s.weaknesses.length) parts.push(`弱み:${s.weaknesses.join('・')}`);
    if (s.valueKeywords.length) parts.push(`価値観:${s.valueKeywords.join('・')}`);
    if (s.recommendedIndustries.length) parts.push(`向く業界:${s.recommendedIndustries.join('・')}`);
    if (s.recommendedJobs.length) parts.push(`向く職種:${s.recommendedJobs.join('・')}`);
    if (s.nextActions.length) parts.push(`前回の次アクション:${s.nextActions.join('・')}`);
    return `- ${s.createdAt.slice(0, 10) || '日付不明'}：${parts.join(' / ') || s.summary}`;
  });
  const memo: string[] = [];
  if (snaps.length >= 2) {
    const consistent = repeatedItems(snaps.map((s) => s.strengths));
    if (consistent.length) memo.push(`複数回で一貫している強み: ${consistent.join('・')}`);
  }
  return [
    '# 過去の自己分析（最新→過去｜繰り返し回避・次テーマ選定用）',
    'このユーザーは過去に自己分析を行っています。以下はその要約です。',
    '- 前回までと同じ質問・同じ切り口の繰り返しを避け、まだ十分に確認できていない観点を優先してください。',
    '- 過去の結論は参考にしつつ絶対視せず、今回の対話で本人が語る内容を最優先してください。',
    '- 回数を重ねている分、前回の結論をさらに具体化する問い（ES・面接で使えるエピソード化／志望業界・職種との接続／矛盾点・意思決定基準の精密化）も混ぜてください。',
    ...lines,
    memo.length ? `推移メモ：${memo.join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ── 入力カバレッジ棚卸し（活動整理・就活軸整理） ──────────────────────
// 「今回はこの中から幅広く横断する」対象を AI に明示し、1つの活動・価値観への偏りを防ぐ。
// 活動・就活軸の全文は共通基盤（buildCareerSystemPrompt）が別途 context として渡すため、
// ここでは「どんな種類が入力済みか」の短いラベル列だけを作る（トークン軽量）。

function nonEmpty(value: unknown): boolean {
  return str(value) !== '';
}

function objHasValue(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  return Object.values(obj as Record<string, unknown>).some((v) => nonEmpty(v));
}

// 経験リストの先頭要素から短い識別名を拾う（無ければ件数のみ）。
function listLabel(
  base: string,
  list: unknown,
  nameKeys: string[],
): string | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const first = list[0];
  let name = '';
  if (first && typeof first === 'object') {
    for (const k of nameKeys) {
      const v = str((first as Record<string, unknown>)[k]);
      if (v) {
        name = v;
        break;
      }
    }
  }
  const suffix = list.length > 1 ? `他${list.length - 1}件` : '';
  const detail = [truncate(name, 20), suffix].filter(Boolean).join('・');
  return detail ? `${base}（${detail}）` : base;
}

export type CoverageInventory = {
  activities: string[];
  valueAxes: string[];
};

export function buildCoverageInventory(
  activity: CareerActivityInput | null | undefined,
  values: CareerValuesInput | null | undefined,
): CoverageInventory {
  const a = (activity ?? {}) as Record<string, unknown>;
  const activities: string[] = [];

  if (objHasValue(a.academics)) activities.push('学業・ゼミ・研究');
  const focused = listLabel('学生時代に力を入れたこと', a.focusedActivities, [
    'title',
    'category',
  ]);
  if (focused) activities.push(focused);
  const club = listLabel('サークル・部活動', a.club, ['organizationName']);
  if (club) activities.push(club);
  const part = listLabel('アルバイト', a.partTimeJobs, ['workplace']);
  if (part) activities.push(part);
  const intern = listLabel('長期インターン', a.internships, ['companyName']);
  if (intern) activities.push(intern);
  const proj = listLabel('プロジェクト・個人開発', a.projects, ['name']);
  if (proj) activities.push(proj);
  const lead = listLabel('リーダー経験', a.leadership, ['experience']);
  if (lead) activities.push(lead);
  const vol = listLabel('ボランティア・社会活動', a.volunteer, ['activityContent']);
  if (vol) activities.push(vol);
  const overseas = listLabel('留学・海外経験', a.overseas, ['title', 'country']);
  if (overseas) activities.push(overseas);
  const sns = listLabel('SNS・情報発信', a.snsActivities, ['platform', 'theme']);
  if (sns) activities.push(sns);
  const portfolio = listLabel('ポートフォリオ・制作物', a.portfolios, ['name', 'kind']);
  if (portfolio) activities.push(portfolio);
  if (Array.isArray(a.certifications) && a.certifications.length > 0) activities.push('資格');
  if (objHasValue(a.lifeExperiences)) activities.push('人生経験（挫折・転機・成長 等）');
  if (nonEmpty(a.hobbies)) activities.push('趣味・特技');

  const valueAxes: string[] = [];
  const v = (values ?? {}) as Record<string, unknown>;
  const selections = (v.selections ?? {}) as Record<string, unknown>;
  const notes = (v.notes ?? {}) as Record<string, unknown>;
  const AXES: Array<[key: string, label: string]> = [
    ['priorities', '重視する条件'],
    ['avoidances', '避けたい条件'],
    ['industries', '興味のある業界'],
    ['jobTypes', '興味のある職種'],
    ['workStyles', '働き方の希望'],
    ['companyTypes', '会社タイプ'],
    ['careerGoals', 'キャリア志向'],
    ['culturePreferences', '人間関係・社風'],
  ];
  for (const [key, label] of AXES) {
    const sel = selections[key];
    const hasSel = Array.isArray(sel) && sel.some((x) => nonEmpty(x));
    const hasNote = nonEmpty(notes[key]);
    if (hasSel || hasNote) valueAxes.push(label);
  }
  if (nonEmpty(v.overallNote)) valueAxes.push('就活軸の総合メモ');

  return { activities, valueAxes };
}

// カバレッジをプロンプト用テキストに整形。両方空なら空文字。
export function formatCoverageForPrompt(inv: CoverageInventory | null | undefined): string {
  if (!inv) return '';
  const { activities, valueAxes } = inv;
  if (activities.length === 0 && valueAxes.length === 0) return '';
  const lines: string[] = ['# 入力済みの活動・就活軸（今回はこの中から幅広く横断する）'];
  if (activities.length) lines.push(`活動: ${activities.join(' / ')}`);
  if (valueAxes.length) lines.push(`就活軸: ${valueAxes.join(' / ')}`);
  lines.push(
    '1回の自己分析で全てを掘り切る必要はありません。1つの活動・1つの価値観に偏らず、',
    '上記の複数項目を横断して質問し、活動整理と就活軸整理の両方に触れてください。',
  );
  return lines.join('\n');
}
