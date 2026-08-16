/**
 * Company Prefetch — 定数一元管理。
 *
 * timeout / lease / attempt 上限 / revision / error_code allowlist / cost 上限を
 * **ここだけ**で定義する（route・repository・service・QA は必ず本ファイルを参照する）。
 * `lib/careerGenerationJob/constants.ts` と同じ役割・同じ規約。
 *
 * pure module（server-only にしない）。QA スクリプト（tsx / node）からも import する。
 */

// ── 機能識別 ─────────────────────────────────────────────────────────
/** 取得タスク名（fact_group の束の論理名）。DB の `task` 列に入る。 */
export const COMPANY_ENRICHMENT_TASK = 'identity_profile' as const;

/**
 * 取得ロジック（provider の組み合わせ・抽出規則）の版。
 * ★ 取得内容の意味が変わったら上げる → 旧 idempotency key と衝突せず再取得できる。
 */
export const COMPANY_FETCHER_REVISION = 'company-prefetch-fetcher-2026-08-16' as const;

/** 保存する fact の schema 版（fact_key の集合・value 形状が変わったら上げる）。 */
export const COMPANY_FACT_SCHEMA_REVISION = 'company-facts-v1' as const;

/** 抽出 LLM の prompt 版（prompt 本文は保存せず、この文字列だけを revision に反映する）。 */
export const COMPANY_EXTRACTION_PROMPT_REVISION = 'company-extract-2026-08-16' as const;

/** 抽出に使う model（安価な抽出器で十分。生成には使わない）。 */
export const COMPANY_EXTRACTION_MODEL = 'claude-haiku-4-5-20251001' as const;

// ── attempt / retry ─────────────────────────────────────────────────
/** 「初回を含む最大試行回数」。1=初回、2/3=reclaim。3 到達後は取得しない。 */
export const MAX_ATTEMPTS = 3 as const;

// ── timeout / lease ─────────────────────────────────────────────────
/** route-level maxDuration（秒）。intent route で `export const maxDuration` に使う。 */
export const ROUTE_MAX_DURATION_SECONDS = 300 as const;
/** auth / gate / identity 解決など、外部 I/O 前の準備予算（ms）。 */
export const PREPARATION_BUDGET_MS = 15_000 as const;
/** 外部 I/O 全体（registry + search + fetch + 抽出）の締切（ms）。 */
export const ENRICHMENT_DEADLINE_MS = 180_000 as const;
/** 永続化（sources / facts / job terminal 更新）に残す余裕（ms）。 */
export const FINALIZATION_RESERVE_MS = 60_000 as const;
/** lease / stale 判定（秒）。★ route maxDuration より長くする（正常実行中の reclaim 競合回避）。 */
export const LEASE_SECONDS = 360 as const;

/** 時間予算の不変条件（QA で検証）。true なら整合。 */
export function timeBudgetIsConsistent(): boolean {
  return (
    ENRICHMENT_DEADLINE_MS + PREPARATION_BUDGET_MS + FINALIZATION_RESERVE_MS <=
      ROUTE_MAX_DURATION_SECONDS * 1000 && LEASE_SECONDS > ROUTE_MAX_DURATION_SECONDS
  );
}

// ── 個別 I/O の予算（safeFetch へ渡す）──────────────────────────────
/** 1 回の外部 fetch の timeout（ms）。 */
export const SINGLE_FETCH_TIMEOUT_MS = 8_000 as const;
/** 1 応答の最大バイト数（超過分は読まずに中断する）。 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** redirect 追跡の上限（各 hop で SSRF guard を再評価する）。 */
export const MAX_REDIRECTS = 3 as const;
/** 1 job で fetch してよい URL 数の上限（暴走防止）。 */
export const MAX_FETCHES_PER_JOB = 6 as const;
/** domain discovery で検証する候補数の上限。 */
export const MAX_DOMAIN_CANDIDATES = 5 as const;
/** 抽出 LLM へ渡す本文の最大文字数（token 予算の上限）。 */
export const MAX_EXTRACTION_INPUT_CHARS = 12_000 as const;
/** 抽出 LLM の max_tokens。 */
export const EXTRACTION_MAX_TOKENS = 1_500 as const;
/** rawExcerpt の最大文字数（原文抜粋。全文保存をしないための上限）。 */
export const MAX_RAW_EXCERPT_CHARS = 400 as const;
/** businessDescription の最大文字数（原文抜粋であり要約ではない）。 */
export const MAX_BUSINESS_DESCRIPTION_CHARS = 400 as const;
/** 配列 fact の最大要素数。 */
export const MAX_SEGMENTS = 8 as const;
export const MAX_PRODUCTS = 12 as const;

// ── cost 制御（P1）──────────────────────────────────────────────────
/** intent route の rate limit（1 user / window あたりの受付回数）。 */
export const INTENT_RATE_LIMIT_WINDOW_MS = 60_000 as const;
export const INTENT_RATE_LIMIT_MAX_REQUESTS = 20 as const;
/** 1 process が 1 日に起動してよい enrichment job の上限（暴走時の最終防波堤）。 */
export const MAX_ENRICHMENT_JOBS_PER_DAY = 500 as const;

// ── error_code 固定 allowlist（raw provider message は絶対に入れない）──
export const RETRYABLE_ERROR_CODES = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_5XX',
  'PROVIDER_RATE_LIMITED',
  'TRANSIENT_DB',
  'PARTIAL_RESULT',
] as const;

export const NONRETRYABLE_ERROR_CODES = [
  'IDENTITY_UNRESOLVED',
  'IDENTITY_AMBIGUOUS',
  'DOMAIN_UNVERIFIED',
  'EXTRACTION_REJECTED',
  'RETRY_LIMIT_REACHED',
  'EXTERNAL_FETCH_DISABLED',
] as const;

export type CompanyEnrichmentErrorCode =
  | (typeof RETRYABLE_ERROR_CODES)[number]
  | (typeof NONRETRYABLE_ERROR_CODES)[number];

export const ALL_ERROR_CODES: readonly CompanyEnrichmentErrorCode[] = [
  ...RETRYABLE_ERROR_CODES,
  ...NONRETRYABLE_ERROR_CODES,
];

export function isRetryableErrorCode(code: string): boolean {
  return (RETRYABLE_ERROR_CODES as readonly string[]).includes(code);
}

export function isKnownErrorCode(code: string): code is CompanyEnrichmentErrorCode {
  return (ALL_ERROR_CODES as readonly string[]).includes(code);
}

// ── confidence（AI に自己申告させず、取得方法から決定論で導く）──────────
export const CONFIDENCE_BY_METHOD = {
  structured_api: 0.95,
  html_structured: 0.8,
  llm_extraction: 0.6,
} as const;
