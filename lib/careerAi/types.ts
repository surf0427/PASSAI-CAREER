// PASSAI 就活版 AI 共通基盤 — 型定義
//
// 本ファイルは就活版 AI 機能（自己分析・ES・面接・就活相談・企業研究・GD・適性）で
// 共通利用する型を定義する。受験版（AO・推薦・大学入試）の型・プロンプト・usage には
// 一切依存しない。DB / Supabase / Stripe への接続も持たない（純粋な型のみ）。
//
// 入力型としてのみ既存の BasicInfo / ActivityData を参照する（/career/profile・
// /career/activity が保持する localStorage 形状をそのまま受け取れるようにするため）。
// これは「型の再利用」であって受験版コードの編集ではない。

import type { BasicInfo } from '@/types/basicInfo';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';

// ── 機能キー ──────────────────────────────────────────────────────

// 就活版 AI 機能の識別子。usage 上限・ログ・プロンプト出し分けの基準になる。
export type CareerAiFeatureKey =
  | 'career-self-analysis'
  | 'career-es'
  | 'career-interview'
  | 'career-presentation'
  | 'career-consultation'
  | 'career-company-matching'
  | 'career-company-research'
  | 'career-gd'
  | 'career-aptitude';

// ランタイム判定・反復用の正本リスト（isCareerAiFeatureKey が参照）。
export const CAREER_AI_FEATURE_KEYS = [
  'career-self-analysis',
  'career-es',
  'career-interview',
  'career-presentation',
  'career-consultation',
  'career-company-matching',
  'career-company-research',
  'career-gd',
  'career-aptitude',
] as const satisfies readonly CareerAiFeatureKey[];

// 各機能の表示用ラベル（プロンプトやログの可読性向上に利用）。
export const CAREER_AI_FEATURE_LABELS: Record<CareerAiFeatureKey, string> = {
  'career-self-analysis': '自己分析',
  'career-es': 'エントリーシート（ES）',
  'career-interview': '面接対策',
  'career-presentation': 'プレゼン対策',
  'career-consultation': '就活相談',
  'career-company-matching': '企業マッチング',
  'career-company-research': '企業研究',
  'career-gd': 'グループディスカッション（GD）',
  'career-aptitude': '適性検査対策',
};

// ── プラン ────────────────────────────────────────────────────────


// ── プロフィールコンテキスト ──────────────────────────────────────

// 就活 AI に渡す「学生プロフィール」の正規化済み形状。
// 受験版の志望大学・学部中心ではなく、新卒就活（業界・職種・企業）視点を中心に持つ。
export type CareerProfileContext = {
  name: string;
  university: string;
  faculty: string;
  grade: string;
  graduationYear: string;
  targetIndustries: string[];
  targetJobs: string[];
  targetCompanies: string[];
  jobHuntingStatus: string;
  strengths: string[];
  weaknesses: string[];
  certifications: string[];
  internshipExperience: string;
  studyAbroadExperience: string;
  preferredLocations: string[];
  notes: string;
};

// ── 活動コンテキスト ──────────────────────────────────────────────

// 就活 AI に渡す「活動・経験」の正規化済み形状。各カテゴリは人間可読な行の配列。
// 就活版「活動整理」(/career/activity) の 18 セクションに対応する（受験版 ActivityData 由来の
// studentActivities / research / contests 等は廃止し、就活向けの粒度に再構成）。
export type CareerActivityContext = {
  personality: string[]; // ① MBTI・性格
  academics: string[]; // ② 学業・学生時代の活動
  focusedActivities: string[]; // ②' 学生時代に力を入れたこと（ガクチカ）
  partTimeJobs: string[]; // ③ アルバイト
  internships: string[]; // ④ インターン
  clubActivities: string[]; // ⑤ サークル・部活動
  projects: string[]; // ⑥ プロジェクト経験
  leadership: string[]; // ⑦ リーダー経験
  volunteer: string[]; // ⑧ ボランティア・社会活動
  overseas: string[]; // ⑨ 海外経験
  certifications: string[]; // ⑩ 資格
  itSkills: string[]; // ⑪ ITスキル
  languages: string[]; // ⑫ 語学
  hobbies: string[]; // ⑬ 趣味・特技
  awards: string[]; // ⑭ 表彰・実績
  snsActivities: string[]; // ⑮ SNS・情報発信経験
  portfolios: string[]; // ⑯ ポートフォリオ・制作物
  lifeExperiences: string[]; // ⑰ 人生経験
  others: string[]; // ⑱ その他
};

// ── 就活軸コンテキスト ────────────────────────────────────────────

// 就活 AI に渡す「就活軸整理」(/career/values) の正規化済み形状。
// 各カテゴリの選択（日本語ラベルの配列）+ カテゴリ別備考 + 総合備考を持つ。
// 自己分析・ES・面接・企業マッチング・企業研究・相談 すべてが「本人が何を重視し、
// 何を避けたいか」の前提として参照できる。
export type CareerValuesContext = {
  priorities: string[];
  avoidances: string[];
  industries: string[];
  jobTypes: string[];
  workStyles: string[];
  companyTypes: string[];
  careerGoals: string[];
  culturePreferences: string[];
  // カテゴリ別の自由記述備考（空文字も含む。表示側で空はスキップ）。
  notes: {
    priorities: string;
    avoidances: string;
    industries: string;
    jobTypes: string;
    workStyles: string;
    companyTypes: string;
    careerGoals: string;
    culturePreferences: string;
  };
  overallNote: string;
};

// /career/values は CareerValues（localStorage / Supabase 共通形状）を保存する。
// 部分データ・未入力でも落ちないよう全体を optional 受け取りにする。
export type CareerValuesInput = Partial<CareerValues>;

// ── 統合コンテキスト ──────────────────────────────────────────────

// AI 呼び出し 1 回分のメタ情報。生成や監査の手がかり。DB には書かない。
export type CareerAiContextMetadata = {
  source: 'career';
  schemaVersion: number;
  locale: string;
};

// 就活 AI の 1 リクエストを表す統合コンテキスト。
export type CareerAiContext = {
  profile: CareerProfileContext;
  activity: CareerActivityContext;
  // 就活軸整理。未入力なら全カテゴリ空（buildCareerAiContext が常に埋める）。
  values: CareerValuesContext;
  featureKey: CareerAiFeatureKey;
  userInput: string;
  metadata: CareerAiContextMetadata;
};

// ── 正規化関数の入力型 ────────────────────────────────────────────

// /career/profile は現状 BasicInfo を保存する。就活版で今後追加されるフィールドは
// optional として重ね、存在すれば正規化時に取り込む（未追加なら既定値で埋める）。
export type CareerProfileInput = Partial<BasicInfo> & {
  graduationYear?: string;
  targetIndustries?: string[];
  targetJobs?: string[];
  targetCompanies?: string[];
  jobHuntingStatus?: string;
  strengths?: string[];
  weaknesses?: string[];
  certifications?: string[];
  internshipExperience?: string;
  studyAbroadExperience?: string;
  preferredLocations?: string[];
  notes?: string;
};

// /career/activity は CareerActivity（就活版 活動整理）を保存する。全セクション optional
// 受け取りで、旧データ・部分データでも落ちないようにする。
export type CareerActivityInput = Partial<CareerActivity>;
