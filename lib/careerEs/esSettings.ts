// PASSAI 就活版 — ES 設定（Step1 入力）の選択肢・正規化・必須バリデーション（純関数）。
//
// 位置づけ:
//   /career/es/new の入力（ES設問 / 文字数 / 企業名 / 志望業界 / 志望職種 / 選考種別）を
//   **新規作成時のみ**必須として検証し、draft へ入れる確定値に正規化する。
//   UI（React state）に依存しないため、QA harness から決定論で検証できる。
//
// 後方互換の境界（重要）:
//   ここは「新規作成の入口」だけの規約。**保存済み draft / log の読み込みには一切関与しない**。
//   旧 draft / 旧ログ（companyName 欠損・選考種別「指定なし」= undefined）は
//   esDraftStorage / esStorage の normalize がこれまで通り欠損のまま読み込む。
//
// 文字数の扱い:
//   既存の保存側ポリシー（esStorage.createEsWorkspaceLog: 正の数のみ・Math.floor、
//   es-review route: 正の有限数のみ）に合わせ「正の整数」だけを有効とする。
//   上限は既存コードに存在しないため、ここでも新設しない（独自ルールを増やさない）。

import type { CareerEsSelectionType } from '@/types/careerEs';

// 新規作成 UI で提示する選考種別（この 2 種類のみ。「指定なし」は廃止）。
// 表示順は仕様どおり「インターン応募 → 本選考」。
export const ES_SELECTION_TYPE_OPTIONS: ReadonlyArray<{
  value: CareerEsSelectionType;
  label: string;
}> = [
  { value: 'internship', label: 'インターン応募' },
  { value: 'main', label: '本選考' },
] as const;

// 選考種別の表示ラベル。旧ログの欠損（＝旧「指定なし」）は空文字にして何も表示しない。
export function esSelectionTypeLabel(
  type: CareerEsSelectionType | null | undefined,
): string {
  return ES_SELECTION_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? '';
}

// 文字数入力（文字列）→ 有効な正の整数 or null。
//   - 空 / 0 / 負数 / NaN / 小数 / 指数表記 / 数字以外の混入 は null（＝不正）。
//   - parseInt の部分一致（'400字' → 400）を避けるため半角数字のみを正とする。
export function parseEsCharLimitInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export type EsSettingsFieldKey =
  | 'question'
  | 'charLimit'
  | 'companyName'
  | 'industry'
  | 'jobType'
  | 'selectionType';

export type EsSettingsInput = {
  question: string;
  // 文字数は UI の生入力（文字列）を受け取り、ここで正規化・検証する。
  charLimitInput: string;
  companyName: string;
  industry: string;
  jobType: string;
  selectionType: CareerEsSelectionType | null;
};

// 検証を通過した確定値（draft へそのまま入れる）。
export type EsSettingsNormalized = {
  question: string;
  charLimit: number;
  companyName: string;
  industry: string;
  jobType: string;
  selectionType: CareerEsSelectionType;
};

export type EsSettingsValidation = {
  ok: boolean;
  // 未入力・不正のフィールドだけにメッセージが入る（UI はフィールド直下に出す）。
  errors: Partial<Record<EsSettingsFieldKey, string>>;
  // ok=false のときは null。
  normalized: EsSettingsNormalized | null;
};

// 新規 ES 作成の必須チェック。6 項目すべてが揃わない限り作成フローへ進めない。
export function validateEsSettings(input: EsSettingsInput): EsSettingsValidation {
  const errors: Partial<Record<EsSettingsFieldKey, string>> = {};

  const question = input.question.trim();
  if (question === '') errors.question = 'ES設問を入力してください';

  const charLimit = parseEsCharLimitInput(input.charLimitInput);
  if (charLimit === null) errors.charLimit = '文字数を正の整数で入力してください';

  const companyName = input.companyName.trim();
  if (companyName === '') errors.companyName = '企業名を入力してください';

  const industry = input.industry.trim();
  if (industry === '') errors.industry = '志望業界を入力してください';

  const jobType = input.jobType.trim();
  if (jobType === '') errors.jobType = '志望職種を入力してください';

  const selectionType =
    input.selectionType === 'main' || input.selectionType === 'internship'
      ? input.selectionType
      : null;
  if (selectionType === null) errors.selectionType = '選考種別を選択してください';

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    normalized:
      ok && charLimit !== null && selectionType !== null
        ? { question, charLimit, companyName, industry, jobType, selectionType }
        : null,
  };
}
