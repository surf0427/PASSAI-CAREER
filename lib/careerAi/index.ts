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
  CareerProfileContext,
  CareerActivityContext,
  CareerValuesContext,
  CareerAiContext,
  CareerAiContextMetadata,
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from './types';
export {
  CAREER_AI_FEATURE_KEYS,
  CAREER_AI_FEATURE_LABELS,
} from './types';

// コンテキスト正規化
export {
  normalizeCareerProfileContext,
  normalizeCareerActivityContext,
  normalizeCareerValuesContext,
  buildCareerAiContext,
} from './context';

// プロンプト
export {
  buildCareerSystemPrompt,
  buildCareerFeatureInstruction,
} from './prompts';

// ログ（スタブ）
export type {
  CareerAiLogPayload,
  CareerAiValidationPayload,
} from './logger';
export {
  logCareerAiUsage,
  logCareerAiValidation,
} from './logger';
