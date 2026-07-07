/**
 * デプロイ種別（受験版 / 就活版 CAREER）の判定。
 *
 * 同一コードベースを 2 つの Vercel プロジェクトで配信している:
 *   - 受験版: passai.jp / www.passai.jp（総合型選抜・志望理由書 等）
 *   - 就活版: passai-career.vercel.app（PASSAI CAREER。将来は独自ドメイン）
 *
 * ルート `/` の LP と共有 Header は両デプロイで同じものを描画するため、
 * 「ログイン」「PASSAIを始める」等の**共有 UI の導線をデプロイごとに出し分ける**
 * 必要がある。CAREER デプロイでは受験版ログイン（/login → /home → /input/basic）に
 * 落とさず、CAREER 側（/career/*）へ誘導する。
 *
 * 判定順（どちらか true なら CAREER デプロイ扱い）:
 *   1. env `NEXT_PUBLIC_APP_VARIANT === 'career'`
 *      → CAREER の Vercel プロジェクトに設定する。build 時 inline されるため
 *        SSR / 初回描画から確定でき、導線のちらつきが出ない（推奨）。
 *   2. hostname に 'passai-career' を含む
 *      → env 未設定でも vercel ドメインで機能させるためのフォールバック。
 *        client でしか分からないため、呼び出し側で mount 後に評価する。
 *
 * 受験版本番 host（passai.jp）は 'passai-career' を含まないため、受験版デプロイの
 * 導線には一切影響しない。
 */

/** env による CAREER デプロイ判定（SSR 安全 / build 時 inline）。 */
export function isCareerVariantByEnv(): boolean {
  return process.env.NEXT_PUBLIC_APP_VARIANT === 'career';
}

/** hostname による CAREER デプロイ判定（client 専用のフォールバック）。 */
export function isCareerVariantByHostname(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  return hostname.includes('passai-career');
}
