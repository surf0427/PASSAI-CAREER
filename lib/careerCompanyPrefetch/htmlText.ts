/**
 * Company Prefetch — HTML → text / 構造抽出（pure・決定論・never-throw・I/O ゼロ）。
 *
 * 責務は「取得した HTML から、決定論で読める部分を読む」ことだけ。
 *   - script / style / noscript / template を落とす
 *   - タグを剥がして本文テキストにする（上限付き）
 *   - <title> を取り出す（official domain の検証に使う）
 *   - 絶対 URL のリンクとそのラベルを取り出す（採用 / IR / ニュース入口の検出に使う）
 *   - JSON-LD（schema.org Organization）を取り出す（**AI 不要の構造化事実**）
 *
 * ★ ここでは何も推測しない。読めなかったものは空 / null。
 * ★ HTML 全文は返さない・保存しない（上限を掛けた text だけを返す）。
 */

/** HTML entity の最小 decode（外部依存を増やさない）。 */
function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    })
    .replace(/&amp;/g, '&');
}

/** 表示に関与しない要素を丸ごと落とす。 */
function stripNonContentElements(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * HTML を本文テキストへ落とす（上限付き）。
 *
 * ブロック要素の境界で改行を入れる（`会社概要` と `設立 1946年` が連結して
 * 抽出値の検証を壊さないようにする）。
 */
export function htmlToText(html: string, maxChars = 20_000): string {
  if (typeof html !== 'string' || html === '') return '';
  try {
    let s = stripNonContentElements(html);
    // ブロック境界 → 改行。
    s = s.replace(/<\/?(p|div|section|article|li|tr|br|h[1-6]|table|dt|dd|header|footer|nav)\b[^>]*>/gi, '\n');
    // セル境界 → 全角コロン相当の区切り（「従業員数」「1,234名」を隣接させる）。
    s = s.replace(/<\/?(td|th|dl)\b[^>]*>/gi, '\t');
    s = s.replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s);
    s = s
      .split('\n')
      .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
      .filter((line) => line !== '')
      .join('\n');
    return s.length > maxChars ? s.slice(0, maxChars) : s;
  } catch {
    return '';
  }
}

/** <title> を取り出す（無ければ ''）。 */
export function extractTitle(html: string): string {
  if (typeof html !== 'string') return '';
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return '';
  return decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
}

/** `<meta name="..." content="...">` / `og:*` の値を引く。 */
export function extractMetaContent(html: string, nameOrProperty: string): string {
  if (typeof html !== 'string' || html === '') return '';
  const escaped = nameOrProperty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${escaped}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  }
  return '';
}

export type ExtractedLink = { href: string; label: string };

/**
 * `<a href>` を絶対 URL 化して取り出す（同一 origin 優先ではなく全件返す。選別は呼び出し側）。
 * `baseUrl` からの相対解決に失敗したリンクは捨てる。
 */
export function extractLinks(html: string, baseUrl: string, maxLinks = 300): ExtractedLink[] {
  if (typeof html !== 'string' || html === '') return [];
  const out: ExtractedLink[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < maxLinks) {
    const rawHref = m[1].trim();
    if (rawHref === '' || /^(javascript|mailto|tel|data):/i.test(rawHref)) continue;
    let href: string;
    try {
      href = new URL(rawHref, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    const label = decodeEntities(m[2].replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    out.push({ href, label });
  }
  return out;
}

/**
 * JSON-LD の Organization を取り出す（**AI 不要の構造化事実**）。
 *
 * schema.org/Organization は `name` / `url` / `foundingDate` / `numberOfEmployees` /
 * `address` などを持つ。取れた場合は `html_structured` として LLM より高い confidence を付ける。
 */
export type JsonLdOrganization = {
  name: string | null;
  url: string | null;
  legalName: string | null;
  foundingDate: string | null;
  numberOfEmployees: string | null;
  addressLocality: string | null;
  addressRegion: string | null;
  streetAddress: string | null;
  description: string | null;
};

function pickString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object') {
    const v = (value as Record<string, unknown>).value ?? (value as Record<string, unknown>)['@value'];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** `@type` が Organization 系か（Corporation / LocalBusiness 等も含む）。 */
function isOrganizationType(type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some(
    (t) => typeof t === 'string' && /(organization|corporation|localbusiness|company)/i.test(t),
  );
}

/** 入れ子の @graph / 配列を平坦化して Organization を探す。 */
function findOrganizationNode(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || !node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findOrganizationNode(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (isOrganizationType(obj['@type'])) return obj;
  if (obj['@graph']) return findOrganizationNode(obj['@graph'], depth + 1);
  return null;
}

export function extractJsonLdOrganization(html: string): JsonLdOrganization | null {
  if (typeof html !== 'string' || html === '') return null;
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const org = findOrganizationNode(parsed);
    if (!org) continue;

    const address = (org.address && typeof org.address === 'object' ? org.address : {}) as Record<
      string,
      unknown
    >;

    return {
      name: pickString(org.name),
      url: pickString(org.url),
      legalName: pickString(org.legalName),
      foundingDate: pickString(org.foundingDate),
      numberOfEmployees: pickString(org.numberOfEmployees),
      addressLocality: pickString(address.addressLocality),
      addressRegion: pickString(address.addressRegion),
      streetAddress: pickString(address.streetAddress),
      description: pickString(org.description),
    };
  }
  return null;
}
