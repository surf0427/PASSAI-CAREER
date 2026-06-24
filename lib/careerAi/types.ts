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
import type { ActivityData } from '@/types/activity';

// ── 機能キー ──────────────────────────────────────────────────────

// 就活版 AI 機能の識別子。usage 上限・ログ・プロンプト出し分けの基準になる。
export type CareerAiFeatureKey =
  | 'career-self-analysis'
  | 'career-es'
  | 'career-interview'
  | 'career-consultation'
  | 'career-company-research'
  | 'career-gd'
  | 'career-aptitude';

// ランタイム判定・反復用の正本リスト（isCareerAiFeatureKey が参照）。
export const CAREER_AI_FEATURE_KEYS = [
  'career-self-analysis',
  'career-es',
  'career-interview',
  'career-consultation',
  'career-company-research',
  'career-gd',
  'career-aptitude',
] as const satisfies readonly CareerAiFeatureKey[];

// 各機能の表示用ラベル（プロンプトやログの可読性向上に利用）。
export const CAREER_AI_FEATURE_LABELS: Record<CareerAiFeatureKey, string> = {
  'career-self-analysis': '自己分析',
  'career-es': 'エントリーシート（ES）',
  'career-interview': '面接対策',
  'career-consultation': '就活相談',
  'career-company-research': '企業研究',
  'career-gd': 'グループディスカッション（GD）',
  'career-aptitude': '適性検査対策',
};

// ── プラン ────────────────────────────────────────────────────────

// 就活版のプラン区分。既存課金（Stripe）には未接続。usage.ts の上限設計値でのみ利用。
export type CareerPlan = 'free' | 'basic' | 'premium';

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
export type CareerActivityContext = {
  studentActivities: string[];
  partTimeJobs: string[];
  internships: string[];
  studyAbroad: string[];
  research: string[];
  volunteer: string[];
  certifications: string[];
  contests: string[];
  hobbies: string[];
  others: string[];
};

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

// /career/activity は現状 ActivityData を保存する。全カテゴリ optional 受け取りで
// 旧データ・部分データでも落ちないようにする。
export type CareerActivityInput = Partial<ActivityData>;
