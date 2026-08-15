/**
 * career generation job — 定数一元管理（STEP-CAREER-GENJOB-01 / members pilot）。
 *
 * timeout / lease / attempt 上限 / revision / error_code allowlist を **ここだけ**で定義する。
 * route・repository・client・QA は必ず本ファイルを参照する（値のドリフト防止）。
 *
 * pure module（server-only にしない）。QA スクリプト（tsx / node）からも import する。
 */

// ── 機能識別（自己分析まとめ生成 pilot）─────────────────────────────
export const SELF_ANALYSIS_FEATURE = 'self_analysis' as const;
export const SELF_ANALYSIS_SUMMARY_OPERATION = 'summary' as const;

// route.ts の MODEL と一致させる（変わったら idempotency も自然に変わるよう revision に含める）。
export const SELF_ANALYSIS_MODEL = 'claude-sonnet-4-6' as const;

// prompt / output schema を変えたら revision を上げる → 旧 idempotency key と衝突させない。
// （プロンプト本文・schema 本体は保存せず、この version 文字列だけを key/row に反映する。）
// 2026-08-15: 出力量予算（配列最大3個 / 1文60字 CAP + 仮説 FLOOR）を導入し、
//   provider 側に effort='low' を明示した。出力の意味的な形（長さ・項目数）が変わるため
//   revision を上げ、旧 idempotency key と分離する。
//   ★ これは同時に、旧設定で OUTPUT_TRUNCATED（非 retryable terminal）になった job 行と
//     natural key が衝突しないことも意味する（同一入力のユーザーが再実行できる）。
export const SELF_ANALYSIS_PROMPT_REVISION = 'self-analysis-prompt-2026-08-15' as const;
export const SELF_ANALYSIS_OUTPUT_SCHEMA_REVISION = 'self-analysis-schema-v2' as const;

// ── attempt / retry ─────────────────────────────────────────────────
// 「初回を含む最大試行回数」。1=初回、2/3=reclaim。3 到達後は生成しない。
export const MAX_ATTEMPTS = 3 as const;

// ── timeout / lease（Vercel Pro ~300s 前提。数値はここで一元管理）──────
// route-level maxDuration（秒）。route.ts で `export const maxDuration` に使う。
// maxDuration は「response 後に別途 300s 始まる」ものではなく invocation 全体の上限。
export const ROUTE_MAX_DURATION_SECONDS = 300 as const;
// auth/validate/claim 等 provider 呼び出し前の準備予算（ms）。
export const PREPARATION_BUDGET_MS = 15_000 as const;
// validate + fenced DB 保存に残す余裕（ms）。provider deadline より後の finalization 用。
export const FINALIZATION_RESERVE_MS = 60_000 as const;
// Claude/provider の締切（ms）。invocation 上限より十分内側で必ず切り、
// deadline 発火後に fenced failed update を書く時間を残す。
// 不変条件: PROVIDER_DEADLINE_MS + PREPARATION_BUDGET_MS + FINALIZATION_RESERVE_MS ≤ route maxDuration。
export const PROVIDER_DEADLINE_MS = 225_000 as const;
// lease / stale 判定（秒）。**route maxDuration より長く**する（正常実行中の境界 reclaim 競合回避）。
// stale threshold を route maxDuration と同値（300s）にしない、という要件を満たす。
export const LEASE_SECONDS = 360 as const;

/** 時間予算の不変条件（QA で検証）。true なら整合。 */
export function timeBudgetIsConsistent(): boolean {
  return (
    PROVIDER_DEADLINE_MS + PREPARATION_BUDGET_MS + FINALIZATION_RESERVE_MS <=
      ROUTE_MAX_DURATION_SECONDS * 1000 && LEASE_SECONDS > ROUTE_MAX_DURATION_SECONDS
  );
}

// ── error_code 固定 allowlist（raw provider message は絶対に入れない）──
export const RETRYABLE_ERROR_CODES = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_5XX',
  'PROVIDER_RATE_LIMITED',
  'TRANSIENT_DB',
  'NETWORK',
] as const;

export const NONRETRYABLE_ERROR_CODES = [
  'INVALID_INPUT',
  'SCHEMA_VALIDATION_FAILED',
  'OUTPUT_TRUNCATED',
  'PARSE_FAILED',
  'POLICY_VIOLATION',
  'RETRY_LIMIT_REACHED',
] as const;

export const ALL_ERROR_CODES = [
  ...RETRYABLE_ERROR_CODES,
  ...NONRETRYABLE_ERROR_CODES,
] as const;

export type RetryableErrorCode = (typeof RETRYABLE_ERROR_CODES)[number];
export type NonRetryableErrorCode = (typeof NONRETRYABLE_ERROR_CODES)[number];
export type GenerationJobErrorCode = RetryableErrorCode | NonRetryableErrorCode;

/** error_code が retryable allowlist に属するか（未知コードは false=非 retryable 扱い）。 */
export function isRetryableErrorCode(code: string): boolean {
  return (RETRYABLE_ERROR_CODES as readonly string[]).includes(code);
}

/** 既知の error_code allowlist に属するか（route/repository の入口 validation 用）。 */
export function isKnownErrorCode(code: string): code is GenerationJobErrorCode {
  return (ALL_ERROR_CODES as readonly string[]).includes(code);
}
