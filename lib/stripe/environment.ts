/**
 * Stripe の実行環境 ⇄ key モード（test / live）解決ポリシー。
 *
 * ── なぜ NODE_ENV だけでは駄目だったか ────────────────────────────────────
 *
 *   旧実装は `NODE_ENV === 'production'` で live key を要求していた。しかし
 *   **Vercel は Preview デプロイでも NODE_ENV=production でビルド／実行する**ため、
 *   Preview に Stripe Test key を入れると起動時に throw していた。
 *   結果として「本番へ実課金する前に Preview で E2E を通す」ことが構造的に不可能で、
 *   検証するには live key を Preview に入れるしかない = 事故の温床だった。
 *
 *   Vercel は `VERCEL_ENV` を production / preview / development の 3 値で
 *   ビルド時・実行時の両方に注入する。これは NODE_ENV と違い
 *   「どのデプロイ面か」を正確に表すので、こちらを一次情報にする。
 *   （本 repo では lib/rateLimit/store.ts / lib/sentry/options.ts が既に同じ判定を使う。）
 *
 * ── ポリシー ──────────────────────────────────────────────────────────────
 *
 *   VERCEL_ENV=production   → live のみ許可（sk_test_ は拒否）
 *   VERCEL_ENV=preview      → test のみ許可（sk_live_ は拒否）
 *   VERCEL_ENV=development  → test のみ許可（`vercel dev`）
 *   VERCEL_ENV 未設定       → NODE_ENV にフォールバック
 *                               production  → live のみ（非 Vercel の本番デプロイ）
 *                               それ以外    → test のみ（ローカル開発 / テスト）
 *
 *   ★ どの分岐でも「どちらのモードでも通る」経路は作らない。必ず一方だけを許可する
 *     （fail-closed）。未知の VERCEL_ENV 値は Vercel 由来として信用せず NODE_ENV へ倒す。
 *
 * ── 本 module の安全性 ────────────────────────────────────────────────────
 *   secret を **一切読まない**。key は引数で受け取り prefix だけを見る。実値・部分文字列も
 *   戻り値やエラーメッセージに含めない。純粋関数なので QA から直接 unit test できる
 *   （`import 'server-only'` を付けていないのはこのため。secret に触れないので安全）。
 */

export type StripeMode = 'test' | 'live';
export type StripeRuntimeEnv = 'production' | 'preview' | 'development';

/** key モードごとの secret key prefix。Stripe の仕様上この 2 つだけ。 */
export const STRIPE_SECRET_KEY_PREFIX: Record<StripeMode, string> = {
  live: 'sk_live_',
  test: 'sk_test_',
};

/** 判定に使う env の最小形。テストから注入できるよう明示的に受け取る。 */
export type StripeEnvInput = {
  VERCEL_ENV?: string | undefined;
  NODE_ENV?: string | undefined;
};

const VERCEL_ENVS: readonly string[] = ['production', 'preview', 'development'];

/**
 * 実行環境を決める。VERCEL_ENV が正規の 3 値なら最優先、それ以外は NODE_ENV。
 */
export function resolveStripeRuntimeEnv(env: StripeEnvInput): StripeRuntimeEnv {
  const vercelEnv = env.VERCEL_ENV;
  if (typeof vercelEnv === 'string' && VERCEL_ENVS.includes(vercelEnv)) {
    return vercelEnv as StripeRuntimeEnv;
  }
  // 非 Vercel（ローカル / 自前ホスティング）。本番ビルドは live を要求する
  // = 実運用の本番で test key が紛れても弾ける（旧挙動を保持）。
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}

/** その実行環境で **唯一許可される** key モード。 */
export function expectedStripeMode(runtimeEnv: StripeRuntimeEnv): StripeMode {
  return runtimeEnv === 'production' ? 'live' : 'test';
}

/** live モードで動くべき環境か（Stripe object の `livemode` 比較に使う）。 */
export function expectedStripeLivemode(runtimeEnv: StripeRuntimeEnv): boolean {
  return expectedStripeMode(runtimeEnv) === 'live';
}

export type StripeKeyCheck =
  | { ok: true; runtimeEnv: StripeRuntimeEnv; mode: StripeMode }
  | { ok: false; message: string };

/**
 * secret key が実行環境に対して正しいモードかを判定する。
 * key の実値は戻り値に **含めない**（prefix 名と環境名のみ）。
 */
export function checkStripeSecretKeyMode(
  key: string | undefined,
  env: StripeEnvInput,
): StripeKeyCheck {
  const runtimeEnv = resolveStripeRuntimeEnv(env);
  const mode = expectedStripeMode(runtimeEnv);
  const expectedPrefix = STRIPE_SECRET_KEY_PREFIX[mode];

  if (!key) {
    return { ok: false, message: 'STRIPE_SECRET_KEY is not set' };
  }
  if (!key.startsWith(expectedPrefix)) {
    return {
      ok: false,
      message:
        `STRIPE_SECRET_KEY must start with "${expectedPrefix}" in ${runtimeEnv} ` +
        `(VERCEL_ENV=${env.VERCEL_ENV ?? 'unset'}, NODE_ENV=${env.NODE_ENV ?? 'unset'}). ` +
        `${runtimeEnv} accepts ${mode} mode keys only.`,
    };
  }
  return { ok: true, runtimeEnv, mode };
}

// ── process.env を読む薄いラッパ（実行時用）──────────────────────────────

export function currentStripeRuntimeEnv(): StripeRuntimeEnv {
  return resolveStripeRuntimeEnv({
    VERCEL_ENV: process.env.VERCEL_ENV,
    NODE_ENV: process.env.NODE_ENV,
  });
}

export function currentExpectedStripeLivemode(): boolean {
  return expectedStripeLivemode(currentStripeRuntimeEnv());
}
