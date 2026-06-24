// PASSAI 就活版 AI 共通基盤 — 公開エントリ
//
// lib/careerAi/* の型・関数をまとめて re-export する。
// 利用側は `import { ... } from '@/lib/careerAi'` で参照する。
//
// 本基盤は純粋なロジックのみ（DB / Supabase / Stripe / API route 非依存）。
// 実際の AI 実行・API 接続・課金/usage 配線は次フェーズで行う。

// 型
export type {
  CareerAiFeatureKey,
  CareerPlan,
  CareerProfileContext,
  CareerActivityContext,
  CareerAiContext,
  CareerAiContextMetadata,
  CareerProfileInput,
  CareerActivityInput,
} from './types';
export {
  CAREER_AI_FEATURE_KEYS,
  CAREER_AI_FEATURE_LABELS,
} from './types';

// コンテキスト正規化
export {
  normalizeCareerProfileContext,
  normalizeCareerActivityContext,
  buildCareerAiContext,
} from './context';

// プロンプト
export {
  buildCareerSystemPrompt,
  buildCareerFeatureInstruction,
} from './prompts';

// usage（利用上限 設計値）
export {
  CAREER_PLAN_LIMITS,
  getCareerFeatureLimit,
  isCareerAiFeatureKey,
} from './usage';

// ログ（スタブ）
export type {
  CareerAiLogPayload,
  CareerAiValidationPayload,
} from './logger';
export {
  logCareerAiUsage,
  logCareerAiValidation,
} from './logger';
