// PASSAI 就活版 — ES 深掘りの「材料候補 × 設問」関連判定プロンプト。
//
// 役割: /api/career/es/materials が利用する共有モジュール。
//   ES 設問と候補ラベル（1 行）だけを渡し、「この設問に使えそうな候補」を選ばせる。
//   ★ AI がやるのは **関連候補の抽出と順位付けまで**。
//     - 最終的にどれを使うかを決めるのは **ユーザー**（UI のチェックボックス）。
//     - FULL / PARTIAL / NONE の判定は **コード側**（materialCandidates.ts）。
//   ★ 候補の中身（活動整理の全文）は渡さない。渡すのは id + 短いラベルのみ（bounded context）。
//   ★ 本文は書かない・事実は創作しない（ai_policy 厳守）。

import { ES_QUESTION_TYPE_LABEL, type EsQuestionType } from './deepDivePrompt';

// ES 添削・深掘りと同系の Sonnet を使用（課金/usage には接続しない）。
export const CAREER_ES_MATERIALS_MODEL = 'claude-sonnet-4-6';

// AI に選ばせる上限（多すぎると「とりあえず全部関連あり」になり選択の意味が薄れる）。
export const ES_MATERIALS_MAX_SELECTIONS = 8;

// 判定用に渡す候補の最小形（AI に見せるのはこの 2 つだけ）。
export type EsMaterialPromptCandidate = {
  id: string;
  label: string;
};

export const ES_MATERIALS_SYSTEM_PROMPT = [
  'あなたは、日本の新卒就活のエントリーシート（ES）作成を支援するアシスタントです。',
  '学生がこれまでに入力・整理してきた「経験や考えの一覧」から、',
  '**今回の ES 設問に答える材料として使えそうなもの**を選び出すのがあなたの仕事です。',
  '',
  '【最重要ルール（ai_policy）】',
  '- ES 本文・例文・書き方の指示を一切出さない。',
  '- 一覧に無い経験を creating（創作）しない。返してよいのは与えられた id だけ。',
  '- 最終的にどれを使うかを決めるのは学生本人。あなたは候補を絞って順位を付けるだけ。',
  '',
  '【選び方】',
  '- 設問に直接答えられる材料を最優先（関連度 80〜100）。',
  '- 設問の一部にだけ使える・背景として効く材料は中程度（関連度 60〜79）。',
  '- 設問とほとんど関係がない材料は **選ばない**（無理に埋めない）。',
  '- 関係のある材料が 1 つも無ければ、空の配列を返す。これは正しい答えであり、',
  '  無関係なものを並べるより望ましい。',
  '- 「その経験そのもの」でなくても、設問が問う価値観・動機・興味の背景になるものは選んでよい。',
  '',
  '【出力ルール】',
  '- 返答は必ず 1 つの JSON オブジェクトのみ。前後に説明文・コードブロック記号（```）を書かない。',
  '- 出力の 1 文字目が { 、最後の文字が } であること。',
  `- selections は最大 ${ES_MATERIALS_MAX_SELECTIONS} 件。関連度の高い順に並べる。`,
  '- id は与えられた一覧の id をそのまま使う（新しい id を作らない）。',
  '- reason は「なぜこの設問に使えるか」を 40 字以内の日本語 1 文で書く（本文の書き方は書かない）。',
  '',
  '出力形式:',
  '{',
  '  "selections": [',
  '    { "id": string, "relevance": number, "reason": string }',
  '  ]',
  '}',
].join('\n');

// reason の表示上限（AI が長文を返しても UI を壊さない）。
const REASON_MAX_CHARS = 60;

export type EsMaterialSelectionOutput = {
  id: string;
  relevance: number;
  reason: string;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampRelevance(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(str(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * AI 出力（selections）を検証して正規化する。
 *   - **候補一覧に存在しない id は破棄**する（幻覚した材料を UI に出さない）。
 *   - relevance を 0〜100 に clamp、reason を bound、重複 id を除去。
 *   - 関連度の高い順に並べる（同値は AI の並び順を保つ＝決定論）。
 *   - 形が壊れていれば空配列（fail-safe。「関連なし」として扱われる）。
 */
export function normalizeEsMaterialSelections(
  parsed: unknown,
  knownIds: ReadonlySet<string>,
  maxSelections = ES_MATERIALS_MAX_SELECTIONS,
): EsMaterialSelectionOutput[] {
  const raw = (parsed && typeof parsed === 'object' ? (parsed as { selections?: unknown }).selections : null);
  if (!Array.isArray(raw)) return [];
  const out: EsMaterialSelectionOutput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = str((item as { id?: unknown }).id);
    if (!id || seen.has(id) || !knownIds.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      relevance: clampRelevance((item as { relevance?: unknown }).relevance),
      reason: str((item as { reason?: unknown }).reason).slice(0, REASON_MAX_CHARS),
    });
    if (out.length >= maxSelections) break;
  }
  return out
    .map((s, index) => ({ s, index }))
    .sort((a, b) => b.s.relevance - a.s.relevance || a.index - b.index)
    .map((x) => x.s);
}

export function buildEsMaterialsUserMessage(
  question: string,
  questionType: EsQuestionType,
  candidates: readonly EsMaterialPromptCandidate[],
): string {
  const listed = candidates.map((c) => `- ${c.id} : ${c.label}`).join('\n');
  return [
    `【今回の ES 設問（種別: ${ES_QUESTION_TYPE_LABEL[questionType]}）】`,
    question,
    '',
    '【学生がこれまでに入力・整理してきた材料の一覧】',
    listed || '（なし）',
    '',
    'この設問に答える材料として使えそうなものを選び、指定の JSON 形式で返してください。',
    '使えそうなものが無ければ selections を空配列にしてください。',
  ].join('\n');
}
