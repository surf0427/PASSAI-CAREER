/**
 * PASSAI CAREER — Stripe 戻り先 origin の **純粋な**決定ポリシー。
 *
 * server-only な I/O（next/headers・process.env・Request）を含まない。理由:
 *   - 「決済後にどの host へ返すか」は認証セッションの継続性を左右する critical path で、
 *     静的検査ではなく **実際の入力で unit test** できる必要がある
 *     （host がズレると cookie が付かず、決済成功後に再ログインを要求してしまう）。
 *   - QA script（tsx 直実行）から `import 'server-only'` 無しで検証するため。
 *
 * 実行時の薄いラッパは lib/careerBilling/origin.ts。
 */

export function normalizeOrigin(raw: string | null | undefined): string | null {
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

/** localhost / ループバックか（ここだけ http を既定にする）。 */
function isLoopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

/** host header 値（`example.com` / `example.com:3000`）から origin 文字列を組む。 */
export function originFromHost(
  host: string | null | undefined,
  forwardedProto: string | null | undefined,
): string | null {
  if (!host) return null;
  // 複数プロキシを経ると `a, b` のようにカンマ区切りになる。最初の値が client に最も近い。
  const first = host.split(',')[0]?.trim();
  if (!first) return null;
  const proto =
    forwardedProto?.split(',')[0]?.trim() || (isLoopbackHost(first) ? 'http' : 'https');
  return normalizeOrigin(`${proto}://${first}`);
}

export type CareerOriginInput = {
  /** platform（Vercel edge 等）が付ける転送元 host。client からは詐称できない。 */
  forwardedHost?: string | null;
  /** 素の Host header（forwardedHost が無い環境用）。 */
  host?: string | null;
  forwardedProto?: string | null;
  /** 運用者が明示した canonical origin（NEXT_PUBLIC_APP_URL）。fallback として使う。 */
  configuredAppUrl?: string | null;
};

/**
 * Stripe の success_url / cancel_url / return_url の基点を決める。
 *
 * 優先順位:
 *   1. この request を実際に配信した host（= その browser が auth cookie を持つ host）
 *   2. 運用者が明示した canonical origin
 *   3. どちらも無ければ null（呼び出し側が 503 = fail-closed）
 *
 * ★ client 申告の `Origin` header は入力に含めない（偽装可能なため）。
 */
export function resolveCareerOriginFromHeaders(
  input: CareerOriginInput,
): string | null {
  return (
    originFromHost(input.forwardedHost, input.forwardedProto) ??
    originFromHost(input.host, input.forwardedProto) ??
    normalizeOrigin(input.configuredAppUrl)
  );
}
