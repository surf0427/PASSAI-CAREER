import type { BasicInfo } from './basicInfo';

// 就活版（PASSAI CAREER）の「基本情報＝プロフィール」型。
//
// 設計方針:
//   - 受験版 BasicInfo の構造をそのまま土台にする（大学・学部・学科は preferences[0] に格納）。
//     これは lib/careerAi/context.ts が「大学・学部は preferences[0] から引く」前提で
//     既に組まれているため、就活 AI 基盤に手を入れずに済ませるための意図的な流用。
//   - 就活固有のフィールド（卒業予定年・性別）だけを optional で重ねる。
//   - 受験版固有の項目（文理 track / 受験方式 examTypes / 評定 overallGpa / 科目別評定
//     subjectGrades）は型としては BasicInfo 由来で残るが、就活版プロフィール UI では
//     入力させず、保存時に既定値（track:'' / examTypes:[]）で埋める。
//     責務分離: 活動内容→活動整理、希望条件・価値観→就活軸整理、強み弱み→自己分析。
//
// CareerProfile は BasicInfo の上位互換（全 BasicInfo フィールドを含む）なので、
// 既存の career 消費側（home / activity / matching / 各 AI ルート）は型変更なしで動く。
export type CareerProfile = BasicInfo & {
  // 卒業予定年（例: '2027年卒'）。就活 AI の前提情報。未入力は ''。
  graduationYear?: string;
  // 性別（任意）。AI には渡さない属性情報。未入力時はキーを持たない。
  gender?: string;
};
