/**
 * Company Fetch — SSRF guard の **純粋判定部**（pure・決定論・never-throw・I/O ゼロ）。
 *
 * なぜ独立 module か:
 *   本 repo にとって企業 enrichment は **初の outbound fetch** であり、
 *   「どの URL を取りに行ってよいか」の判定は全経路で 1 つでなければならない。
 *   I/O を含む `safeFetch.server.ts` から判定だけを切り出すことで、
 *   QA（tsx）が **ネットワーク無しで全分岐を決定論検証**できる。
 *
 * 脅威モデル:
 *   検索 provider の応答 URL は **ユーザー入力に由来する外部データ**であり、
 *   そのまま fetch すると server が任意の内部エンドポイントへ到達しうる
 *   （cloud metadata / localhost の管理 API / 内部 DB の HTTP interface）。
 *   よって「取りに行ってよい URL」を **allowlist 的に絞る**（deny list だけに頼らない）。
 *
 * ★ redirect 先も必ず本 module で再評価する（初回だけ検証する実装は guard を無効化する）。
 */

/** 拒否理由（自由文字列を使わない＝ログに出せる enum に閉じる）。 */
export type UrlGuardRejection =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'port_not_allowed'
  | 'host_empty'
  | 'host_is_ip_literal'
  | 'host_not_public'
  | 'credentials_in_url'
  | 'address_not_public';

export type UrlGuardResult =
  | { ok: true; url: URL; host: string; port: number }
  | { ok: false; reason: UrlGuardRejection };

/** http / https のみ。file: / ftp: / gopher: / data: 等は一切許可しない。 */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** 既定ポートと、企業サイトが実際に使う範囲だけを許可する。 */
const ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443, 8080, 8443]);

/**
 * 到達を禁止する host 名（IP literal 以外の経路）。
 * `.localhost` / `.internal` / `.local` などの内部専用 TLD も塞ぐ。
 */
const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
  '.in-addr.arpa',
  '.ip6.arpa',
];

const BLOCKED_HOST_EXACT: ReadonlySet<string> = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

/** IPv4 文字列を 4 オクテットへ（不正なら null）。 */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [
    number,
    number,
    number,
    number,
  ];
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts;
}

/**
 * IPv4 が「public に出て良くない」範囲か。
 *
 * 塞ぐもの: loopback / private / link-local（**169.254.169.254 の metadata を含む**） /
 *   CGNAT / benchmarking / multicast / reserved / broadcast / this-network。
 */
function isBlockedIpv4(parts: readonly [number, number, number, number]): boolean {
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 this-network
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local（cloud metadata）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 192 && b === 0) return true; // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51) return true; // 198.51.100/24 doc
  if (a === 203 && b === 0) return true; // 203.0.113/24 doc
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255
  return false;
}

/** IPv6 が loopback / unique-local / link-local / unspecified / IPv4-mapped-private か。 */
function isBlockedIpv6(raw: string): boolean {
  const host = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '::' || host === '::1') return true; // unspecified / loopback
  if (host.startsWith('fe80') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (/^f[cd]/.test(host)) return true; // fc00::/7 unique local
  if (host.startsWith('ff')) return true; // ff00::/8 multicast
  // IPv4-mapped（::ffff:10.0.0.1 等）は IPv4 側の規則で判定する。
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]);
    return v4 === null ? true : isBlockedIpv4(v4);
  }
  return false;
}

/** host が IP literal かどうか（IPv4 / bracket 付き IPv6）。 */
export function isIpLiteral(host: string): boolean {
  if (parseIpv4(host) !== null) return true;
  if (host.startsWith('[') && host.endsWith(']')) return true;
  // bracket 無しの IPv6（URL としては不正だが防御的に判定する）。
  return host.includes(':');
}

/**
 * 解決済み IP アドレスが到達禁止かを判定する（**DNS 解決後に必ず呼ぶ**）。
 *
 * host 名の見た目が公開ドメインでも、A レコードが 127.0.0.1 を指す
 * DNS rebinding 型の攻撃があるため、名前だけの判定では不十分。
 */
export function isBlockedAddress(address: string, family: 4 | 6): boolean {
  if (typeof address !== 'string' || address === '') return true;
  if (family === 4) {
    const v4 = parseIpv4(address);
    return v4 === null ? true : isBlockedIpv4(v4);
  }
  return isBlockedIpv6(address);
}

/** host 名が内部専用の形をしているか（DNS を引く前の足切り）。 */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '') return true;
  if (BLOCKED_HOST_EXACT.has(h)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix))) return true;
  // 単一ラベル（ドットを含まない）は内部名の可能性が高い。公開企業サイトには存在しない。
  if (!h.includes('.')) return true;
  return false;
}

/**
 * URL 文字列を検証して正規化する（**DNS 解決前**の判定すべて）。
 *
 * ここを通っただけでは fetch してよいことにならない。
 * `safeFetch.server.ts` が続けて DNS 解決 → `isBlockedAddress` を必ず行う。
 */
export function guardUrl(raw: string): UrlGuardResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'invalid_url' };
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: 'scheme_not_allowed' };
  }

  // URL 埋め込み credential（http://user:pass@host）は認証情報の漏洩経路になるため拒否。
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials_in_url' };
  }

  const host = url.hostname;
  if (host === '') return { ok: false, reason: 'host_empty' };

  // IP 直打ちは公開企業サイトの正当な形ではない。DNS を経ない到達経路を丸ごと塞ぐ。
  if (isIpLiteral(host)) return { ok: false, reason: 'host_is_ip_literal' };

  if (isBlockedHostname(host)) return { ok: false, reason: 'host_not_public' };

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || !ALLOWED_PORTS.has(port)) {
    return { ok: false, reason: 'port_not_allowed' };
  }

  return { ok: true, url, host, port };
}

// ── content-type ────────────────────────────────────────────────────
/**
 * 取得を許可する content-type（HTML / テキスト / JSON / CSV / XML のみ）。
 * ★ バイナリ（PDF / 画像 / octet-stream）は取得しない。IR PDF 解析は Phase 1 の対象外であり、
 *   ここを広げると size cap を抜けた重い取得が入り込む。
 */
const ALLOWED_CONTENT_TYPES: readonly string[] = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/json',
  'application/ld+json',
  // 公的 registry API の応答形式（CSV / XML）。
  'text/csv',
  'application/csv',
  'text/xml',
  'application/xml',
];

/** content-type ヘッダが許可対象か（charset 等のパラメータは無視する）。 */
export function isAllowedContentType(header: string | null): boolean {
  if (typeof header !== 'string' || header === '') return false;
  const mime = header.split(';')[0]?.trim().toLowerCase() ?? '';
  return ALLOWED_CONTENT_TYPES.includes(mime);
}

/** 観測・保存用の host（小文字化のみ。URL 全体はログに出さない）。 */
export function extractDomain(rawUrl: string): string {
  const guarded = guardUrl(rawUrl);
  return guarded.ok ? guarded.host.toLowerCase() : '';
}
