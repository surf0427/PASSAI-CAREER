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
 *
 * 2026-08-17: 会社概要 1 ページ・1 抽出から、理念 / IR / 採用 / ニュースの
 *   **ページ別抽出**へ拡張したため更新。
 */
export const COMPANY_FETCHER_REVISION = 'company-prefetch-fetcher-2026-08-17' as const;

/**
 * 保存する fact の schema 版（fact_key の集合・value 形状が変わったら上げる）。
 *
 * ★ この値は 2 つの役割を持つ（両方壊さないこと）:
 *   1. idempotency key の材料 → 上げると **新しい job 行**になり、旧 terminal 行の
 *      cooldown に縛られず再取得できる。
 *   2. facts の `schema_revision` 列へ書かれる → 旧世代 fact しか持たない group を
 *      `stale` と判定させ、TTL 内でも新 key を取りに行かせる
 *      （`isSchemaRevisionStale` / `lib/careerCompanyOfficial/freshness.ts`）。
 *   1 だけでは freshness short-circuit に阻まれて新 key が埋まらない。
 *
 * v2（2026-08-17）: ir / recruiting / developments group と profile の理念・
 *   ビジネスモデル系 key を追加（25 → 61 key）。
 */
export const COMPANY_FACT_SCHEMA_REVISION = 'company-facts-v2' as const;

/** 抽出 LLM の prompt 版（prompt 本文は保存せず、この文字列だけを revision に反映する）。 */
export const COMPANY_EXTRACTION_PROMPT_REVISION = 'company-extract-2026-08-17' as const;

/** 抽出に使う model（安価な抽出器で十分。生成には使わない）。 */
export const COMPANY_EXTRACTION_MODEL = 'claude-haiku-4-5-20251001' as const;

// ── attempt / retry ─────────────────────────────────────────────────
/**
 * 「1 取得サイクルあたりの最大試行回数」。1=初回、2/3=reclaim。
 *
 * ★ サイクル内の上限であり、企業の生涯上限ではない。
 *   TTL 経過後の新サイクル（CLAIMED_REFRESH）で attempt_count は 1 へ戻る。
 *   戻さないと「過去に 3 回失敗した企業」が永久に取得不能になる（本 slice で直した事故）。
 */
export const MAX_ATTEMPTS = 3 as const;

// ── refresh lifecycle（TTL 経過後の再取得サイクル）───────────────────
const REFRESH_DAY_SECONDS = 24 * 60 * 60;

/**
 * completed から **新しい取得サイクル**を開いてよくなるまでの最短間隔（秒）。
 *
 * ★ 値は freshness policy（`COMPANY_FACT_TTL_SECONDS` の prefetch 対象 group の最短 TTL
 *   ＝ profile / navigation の 90 日）と **一致させる**。
 *   これより長いと「呼び出し側は stale と判定したのに DB が claim を拒む」窓ができ、
 *   再取得できない状態へ逆戻りする。一致は
 *   `refreshCooldownIsConsistent()`（lib/careerCompanyPrefetch/refreshPolicy.ts）と
 *   `scripts/career-company-prefetch-ttl-qa.ts` が固定する。
 */
export const REFRESH_COOLDOWN_SECONDS = 90 * REFRESH_DAY_SECONDS;

/**
 * partial / failed から再試行サイクルを開いてよくなるまでの最短間隔（秒）。
 *
 * ★ 役割は「毎 request で外部に出ない」ことだけ。永久遮断のためではない。
 *   公式サイトが一時的に落ちていた企業を、翌日には取り直せるようにする。
 *   サイクル内の即時 retry（CLAIMED_RETRY・MAX_ATTEMPTS まで）は従来どおり cooldown 無しで走る。
 */
export const FAILURE_COOLDOWN_SECONDS = 1 * REFRESH_DAY_SECONDS;

// ── timeout / lease ─────────────────────────────────────────────────
/** route-level maxDuration（秒）。intent route で `export const maxDuration` に使う。 */
export const ROUTE_MAX_DURATION_SECONDS = 300 as const;
/** auth / gate / identity 解決など、外部 I/O 前の準備予算（ms）。 */
export const PREPARATION_BUDGET_MS = 15_000 as const;
/**
 * 外部 I/O 全体（registry + search + fetch + 抽出）の締切（ms）。
 *
 * ★ ページ別抽出（会社概要 / 理念 / IR / 採用 / ニュース）で最大 5 回の LLM 抽出が
 *   走るため、`prefetchJobService` が **各ページの取得・抽出の前に**この締切を確認して
 *   打ち切る（`isDeadlineExceeded`）。打ち切っても既に取れた fact は保存する（partial）。
 *   上限は `timeBudgetIsConsistent()`（preparation 15s + finalization 60s を残す）。
 */
export const ENRICHMENT_DEADLINE_MS = 225_000 as const;
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
/**
 * 1 job で fetch してよい URL 数の上限（暴走防止・`countedFetch` が強制する）。
 *
 * 内訳（最大）: domain 候補検証 5 + 会社概要 1 + 理念 1 + IR 1 + 採用 1 + ニュース 1。
 * 実際には候補 1 件目で検証を通るのが普通なので 5〜6 回に収まる。
 */
export const MAX_FETCHES_PER_JOB = 10 as const;
/** domain discovery で検証する候補数の上限。 */
export const MAX_DOMAIN_CANDIDATES = 5 as const;
/** 抽出 LLM へ渡す本文の最大文字数（token 予算の上限）。 */
export const MAX_EXTRACTION_INPUT_CHARS = 12_000 as const;
/**
 * 抽出 LLM の max_tokens。
 *
 * ★ 足りないと `stop_reason === 'max_tokens'` で **その page の抽出結果が丸ごと捨てられる**
 *   （runtime.server.ts は truncated JSON を parse しない）。key を増やしたら必ず上げる。
 */
export const EXTRACTION_MAX_TOKENS = 3_000 as const;
/** rawExcerpt の最大文字数（原文抜粋。全文保存をしないための上限）。 */
export const MAX_RAW_EXCERPT_CHARS = 400 as const;
/** businessDescription の最大文字数（原文抜粋であり要約ではない）。 */
export const MAX_BUSINESS_DESCRIPTION_CHARS = 400 as const;
/** 配列 fact の最大要素数。 */
export const MAX_SEGMENTS = 8 as const;
export const MAX_PRODUCTS = 12 as const;
/** 理念・強み・課題などの原文抜粋 fact の最大文字数。 */
export const MAX_STATEMENT_CHARS = 300 as const;
/** 一般的な配列 fact（顧客層 / 職種 / 研修 / 競合名 等）の最大要素数。 */
export const MAX_LIST_ITEMS = 8 as const;
/**
 * 「最近の動向」の最大件数。
 *
 * ★ prompt 肥大化防止の中核。ニュースの羅列を避け、企業分析に足る件数だけに絞る。
 */
export const MAX_DEVELOPMENTS = 6 as const;
/** 動向 1 件の最大文字数（見出し + 日付の原文表記が収まる長さ）。 */
export const MAX_DEVELOPMENT_CHARS = 120 as const;

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
