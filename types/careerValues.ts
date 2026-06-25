// PASSAI 就活版 — 「就活軸整理」(/career/values) のデータ型。
//
// 受験版（AO・推薦・大学入試）には一切依存しない、就活版専用の型のみを定義する。
// localStorage canonical（app/career/values/careerValuesStorage.ts）と
// Supabase 永続ミラー（lib/supabase/careerValues.ts）の双方が本型を共有する。
//
// 設計方針:
//   - チェック項目の選択値は「カテゴリごとの string[]」で保持する。値は
//     careerValuesCategories.ts が定義する日本語ラベルそのもの（CareerProfileContext の
//     targetIndustries 等と同じく、日本語文字列をそのまま AI が読める形にする）。
//   - 各カテゴリに自由記述の備考（notes）、最後に総合備考（overallNote）を持つ。
//   - AI が後から参照しやすいよう、選択（selections）と備考（notes）を分離した
//     構造化 JSON として保存する。

// カテゴリ識別子。DB のカラム名（priorities / avoidances / ...）と 1:1 対応する。
export type CareerValuesCategoryKey =
  | 'priorities' // A. 重視する条件
  | 'avoidances' // B. 避けたい条件
  | 'industries' // C. 興味ある業界
  | 'jobTypes' // D. 興味ある職種
  | 'workStyles' // E. 働き方の希望
  | 'companyTypes' // F. 会社タイプ
  | 'careerGoals' // G. キャリア志向
  | 'culturePreferences'; // H. 人間関係・社風

// 反復・バリデーション用の正本リスト。
export const CAREER_VALUES_CATEGORY_KEYS = [
  'priorities',
  'avoidances',
  'industries',
  'jobTypes',
  'workStyles',
  'companyTypes',
  'careerGoals',
  'culturePreferences',
] as const satisfies readonly CareerValuesCategoryKey[];

// カテゴリごとに選択されたチェック項目（日本語ラベルの配列）。
export type CareerValuesSelections = Record<CareerValuesCategoryKey, string[]>;

// カテゴリごとの自由記述備考。
export type CareerValuesNotes = Record<CareerValuesCategoryKey, string>;

// 「就活軸整理」1 件分の完全な状態。
export type CareerValues = {
  selections: CareerValuesSelections;
  notes: CareerValuesNotes;
  overallNote: string;
  // 最終更新時刻（ISO 文字列）。LS / DB 双方で保持し、表示・同期判断に使う。
  updatedAt?: string;
};

// 空の selections / notes を作る（未入力でも一部保存できるようにするための初期値）。
export function emptyCareerValuesSelections(): CareerValuesSelections {
  return {
    priorities: [],
    avoidances: [],
    industries: [],
    jobTypes: [],
    workStyles: [],
    companyTypes: [],
    careerGoals: [],
    culturePreferences: [],
  };
}

export function emptyCareerValuesNotes(): CareerValuesNotes {
  return {
    priorities: '',
    avoidances: '',
    industries: '',
    jobTypes: '',
    workStyles: '',
    companyTypes: '',
    careerGoals: '',
    culturePreferences: '',
  };
}

export function emptyCareerValues(): CareerValues {
  return {
    selections: emptyCareerValuesSelections(),
    notes: emptyCareerValuesNotes(),
    overallNote: '',
  };
}
