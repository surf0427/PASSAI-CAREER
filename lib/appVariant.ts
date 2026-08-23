/**
 * デプロイ種別（受験版 / 就活版 CAREER）の判定。
 *
 * ★ 現状この module は **どこからも import されていない**（受験版が別 repository へ
 *   分離され、共有 UI の variant 分岐が撤去されたため）。削除候補として残置している。
 *
 * 同一コードベースを 2 つの Vercel プロジェクトで配信していた時代の判定:
 *   - 受験版: passai.jp / www.passai.jp（総合型選抜・志望理由書 等）
 *   - 就活版: passaicareer.jp（本番 canonical。旧 deployment URL は
 *             passai-career.vercel.app で、Vercel 側に当面残る）
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
 *   2. hostname が CAREER の host（独自ドメイン `passaicareer.jp` / 旧 deployment URL や
 *      preview の `passai-career-*.vercel.app`）にあたる
 *      → env 未設定でもドメインだけで機能させるためのフォールバック。
 *        client でしか分からないため、呼び出し側で mount 後に評価する。
 *        ハイフンの有無で取りこぼさないよう `passai-?career` で判定する
 *        （独自ドメインはハイフン無し、Vercel の project 名はハイフン有り）。
 *
 * 受験版本番 host（passai.jp / www.passai.jp）は `passai-?career` に一致しないため、
 * 受験版デプロイの導線には一切影響しない。
 */

/** env による CAREER デプロイ判定（SSR 安全 / build 時 inline）。 */
export function isCareerVariantByEnv(): boolean {
  return process.env.NEXT_PUBLIC_APP_VARIANT === 'career';
}

/** hostname による CAREER デプロイ判定（client 専用のフォールバック）。 */
export function isCareerVariantByHostname(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  // passaicareer.jp（独自ドメイン）と passai-career*.vercel.app（旧/preview）の両方に一致させる。
  return /passai-?career/i.test(hostname);
}
