/**
 * PASSAI CAREER — Checkout / Portal の戻り先 origin 解決（server-only）。
 *
 * Stripe に渡す success_url / cancel_url / return_url の基点。
 *
 * 方針（受験版は `NEXT_PUBLIC_APP_URL ?? req.headers.get('origin')` をそのまま使うが、
 * CAREER では fallback 側を検証してから使う）:
 *   1. NEXT_PUBLIC_APP_URL が設定されていればそれを最優先（運用者が明示した正本）。
 *   2. 無ければ request の Origin header。ただし **http(s) スキームの妥当な URL の場合のみ**。
 *      `javascript:` 等のスキームや壊れた値は採用しない。
 *   3. どちらも駄目なら null（呼び出し側が 503 にする = fail-closed）。
 *
 * 戻り値は必ず末尾スラッシュ無しの origin 文字列（例: https://example.com）。
 * path は呼び出し側が組み立てる。ここで外部 URL が混ざっても、遷移先は Stripe の
 * 決済完了後 redirect のみで、自サイトの認証・権限判定には一切使わない。
 */

import 'server-only';

function normalizeOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin;
}

export function resolveCareerAppOrigin(req: Request): string | null {
  return (
    normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL) ??
    normalizeOrigin(req.headers.get('origin'))
  );
}
