/**
 * PASSAI CAREER — この deployment が **公開してよい path** の allowlist（pure / 判定のみ）。
 *
 * ── なぜ必要か ────────────────────────────────────────────────────────
 *   この repository には受験版（総合型選抜・推薦入試対策）の app surface が
 *   まるごと残っており、build 成果物にも含まれる:
 *     /pricing（Basic ¥2,980 / Premium ¥4,980 の購入 CTA つき）/ /home / /mypage /
 *     /essay / /statement / /tutor / /account / /input/basic / /login /
 *     /api/billing/*（受験版 Stripe）… など。
 *   一方この deployment が販売しているのは **PASSAI CAREER（¥3,000/月・単一プラン）だけ**。
 *   同一ドメイン上に別商品の paywall が公開されていると、
 *     - 訪問者が誤って別商品の購入画面に到達する
 *     - 特商法表記（/legal/commerce）が指す商品と食い違う
 *   ため、公開 request からは到達不能にする。
 *
 * ── 方式（allowlist / fail-closed）────────────────────────────────────
 *   受験版 route を列挙して塞ぐ denylist にはしない。route を 1 本足し忘れただけで
 *   穴が開く（＝今回の事故と同じ再発の仕方をする）ため、
 *   **「CAREER と共通ページだけ通す」allowlist** にして、知らない path は既定で 404 にする。
 *
 * ★ これは deployment の公開面の境界であり、**認可判定ではない**。
 *   ユーザーごとの権利判定（ログイン / 契約）は従来どおり
 *   lib/careerRouting/serverState.ts と lib/careerBilling/aiAccess.ts が唯一の判定者。
 * ★ 受験版のコード・route・API は削除しない（この repo から消す STEP ではない）。
 *   公開面から見えなくするだけで、コードは温存する。
 * ★ pure（env / I/O / server-only を持たない）。proxy から呼べること、
 *   単体で検証できることが条件。
 */

/** 完全一致で通す path。 */
const ALLOWED_EXACT: readonly string[] = [
  // PASSAI CAREER のランディングページ（app/page.tsx）。
  '/',
  // 事業者・法務まわりの共通公開ページ（CAREER の footer から必ずリンクされる）。
  //   ★ /legal/commerce はこの deployment の商品（PASSAI CAREER）の法定表示。
  '/about',
  '/contact',
  '/terms',
  '/privacy',
];

/** この prefix 配下をすべて通す（`/x` 完全一致と `/x/...` の両方）。 */
const ALLOWED_PREFIXES: readonly string[] = [
  // CAREER の画面と API（本体）。
  '/career',
  '/api/career',
  // 共通法務ページ（/legal/commerce ほか）。
  '/legal',
  // Vercel Cron の実行先。CRON_SECRET で認証される非公開の運用 endpoint であり、
  // ブラウズされる product surface ではない。CAREER の GD cleanup もここに含まれるため
  // 塞がない（塞ぐと期限切れ room が回収されなくなる）。
  '/api/cron',
  // Next.js の内部配信物。matcher 側でも除外しているが、二重に守っておく
  // （matcher を編集したときに JS / 画像ごと 404 にして全画面を壊さないため）。
  '/_next',
];

/**
 * この deployment の公開面として通してよい path か。
 *
 * @param pathname `URL.pathname`（query / hash を含まない）。
 */
export function isAllowedCareerDeploymentPath(pathname: string): boolean {
  // 末尾スラッシュを正規化する（'/about/' と '/about' を同じ扱いにする）。
  const path =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.replace(/\/+$/, '')
      : pathname;

  if (ALLOWED_EXACT.includes(path)) return true;

  return ALLOWED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix + '/'),
  );
}

/** その path が API（JSON を期待する呼び出し）か。404 の返し方を分けるために使う。 */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}
