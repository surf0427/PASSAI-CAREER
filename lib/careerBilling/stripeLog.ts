/**
 * PASSAI CAREER — Stripe API 失敗の server-side 診断ログ（server-only / observability 専用）。
 *
 * ── なぜ必要だったか ──────────────────────────────────────────────────────
 *   課金経路の Stripe 呼び出しはすべて `devWarn` で失敗を記録していたが、
 *   `lib/devLog.ts` の実装は `process.env.NODE_ENV !== 'production'` guard であり、
 *   **Vercel Preview / Production では build 時に dead code として除去される**。
 *   その結果、Checkout が 502 を返しても Runtime Logs に手掛かりが 1 行も残らず、
 *   「決済が始められない」障害の原因を運用側から特定できなかった
 *   （Preview E2E で実際に customers.create が落ち、原因不明のまま止まった）。
 *
 *   さらに `retrieveCareerPlanPrice()` の `prices.retrieve` は catch が空で、
 *   **権限エラーも通信エラーも一律 'not-found' に潰れていた**。これは
 *   「Price ID が間違っている」と「API key に権限が無い」を区別できないことを意味する。
 *
 * ── 本 module の責務は observability だけ ────────────────────────────────
 *   - 判定・分岐・retry・fallback を一切行わない。呼び出し側の戻り値と
 *     client への response contract（400 / 401 / 409 / 502 / 503）は不変。
 *   - client には Stripe の内部情報を返さない（従来どおり汎用文言のまま）。
 *
 * ── 出力してよいもの / 絶対に出さないもの ────────────────────────────────
 *   出力する（Stripe Dashboard → Developers → Logs と突き合わせるための最小集合）:
 *     operation / name / type / code / statusCode / requestId / param
 *
 *     ★ `param` は「どの**パラメータ名**が不正か」（例: 'email'）であって
 *       **値ではない**。値は Stripe の error.param に入らない仕様なので安全。
 *     ★ `requestId`（req_...）は Stripe 側ログとの照合キー。秘密情報ではない。
 *
 *   絶対に出力しない:
 *     error.message  … Stripe が入力値を引用することがあり PII 混入の恐れ
 *     error.raw / stack / request body / headers
 *     STRIPE_SECRET_KEY / CAREER_STRIPE_WEBHOOK_SECRET / Authorization
 *     email / app_user_id / customer id / Checkout URL / cookie / access token
 *
 *   → そのため本 module は **err から個別フィールドを allowlist で拾うだけ**で、
 *     err 自体や message を console へ渡す経路を持たない。
 */

import 'server-only';

/** 診断対象の Stripe API operation（課金 chain 上の外部呼び出しのみ）。 */
export type CareerStripeOperation =
  | 'prices.retrieve'
  | 'customers.create'
  | 'checkout.sessions.create'
  | 'billingPortal.sessions.create';

/** Stripe error から安全に取り出せるフィールドだけを写した形。 */
export type SafeStripeFailure = {
  operation: CareerStripeOperation;
  name?: string;
  type?: string;
  code?: string;
  statusCode?: number;
  requestId?: string;
  param?: string;
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Stripe error（SDK の StripeError / 任意の throw 値）から安全な診断フィールドだけを抽出する。
 * 純関数・never throw。**message / stack / raw は意図的に読まない**。
 */
export function toSafeStripeFailure(
  operation: CareerStripeOperation,
  err: unknown,
): SafeStripeFailure {
  const e = (err ?? {}) as Record<string, unknown>;
  return {
    operation,
    name: str(e.name),
    type: str(e.type),
    code: str(e.code),
    statusCode: num(e.statusCode),
    requestId: str(e.requestId),
    param: str(e.param),
  };
}

/**
 * Stripe API 失敗を Runtime Logs へ残す。
 *
 * ★ `console.error` を直接使う。`devWarn` は production build で DCE されるため、
 *   本 module の目的（本番で原因を追える）を満たせない。
 */
export function logCareerStripeFailure(
  operation: CareerStripeOperation,
  err: unknown,
): void {
  // ★ sanitize を先に済ませ、console へは **組み立て済みの安全オブジェクトだけ**を渡す。
  //   err を console 呼び出しの引数式に一切登場させないことで、
  //   「うっかり err ごと出す」変更が QA の静的検査で落ちるようにしている。
  const safe = toSafeStripeFailure(operation, err);
  console.error('[careerBilling/stripe] Stripe API operation failed', safe);
}
