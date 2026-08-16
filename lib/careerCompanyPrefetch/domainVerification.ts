/**
 * Company Prefetch — official domain の検証（pure・決定論・never-throw・I/O ゼロ）。
 *
 * ★ 最重要の設計判断: **「検索結果の 1 位だから公式」とは絶対に扱わない。**
 *   検索順位は企業の同一性を保証しない（採用媒体・まとめサイト・競合・同名他社が上位に来る）。
 *   誤ったドメインを official と認定すると、その後に取得する会社概要が **丸ごと別企業の情報**に
 *   なり、全ユーザー共有テーブルへ入る。訂正手段が in-app に無い以上、ここは fail-closed。
 *
 * 検証は「候補ページを実際に取得して、企業名がページ側にも現れるか」で行う。
 * 一致の根拠が弱いものは採用しない（unverified のまま先へ進ませない）。
 */

import type { CompanyFactExtractionMethod } from '@/types/careerCompanyOfficial';

/** ドメイン候補の除外リスト（企業の公式サイトではありえない host）。 */
const NON_OFFICIAL_HOST_PATTERNS: readonly RegExp[] = [
  // 就活 / 求人 / 口コミ媒体
  /(^|\.)rikunabi\.com$/i,
  /(^|\.)mynavi\.jp$/i,
  /(^|\.)doda\.jp$/i,
  /(^|\.)en-japan\.com$/i,
  /(^|\.)openwork\.jp$/i,
  /(^|\.)vorkers\.com$/i,
  /(^|\.)indeed\.com$/i,
  /(^|\.)wantedly\.com$/i,
  /(^|\.)green-japan\.com$/i,
  /(^|\.)type\.jp$/i,
  /(^|\.)onecareer\.jp$/i,
  /(^|\.)gaishishukatsu\.com$/i,
  // 百科事典 / SNS / まとめ
  /(^|\.)wikipedia\.org$/i,
  /(^|\.)wikiwand\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)note\.com$/i,
  /(^|\.)ameblo\.jp$/i,
  /(^|\.)hatenablog\.com$/i,
  // 企業情報まとめ / 与信
  /(^|\.)baseconnect\.in$/i,
  /(^|\.)alarmbox\.jp$/i,
  /(^|\.)houjin\.jp$/i,
  /(^|\.)catr\.jp$/i,
  // 検索エンジン / ポータル
  /(^|\.)google\.[a-z.]+$/i,
  /(^|\.)yahoo\.co\.jp$/i,
  /(^|\.)bing\.com$/i,
];

/** 公式サイトとして採用してはいけない host か。 */
export function isNonOfficialHost(host: string): boolean {
  const h = typeof host === 'string' ? host.trim().toLowerCase() : '';
  if (h === '') return true;
  return NON_OFFICIAL_HOST_PATTERNS.some((re) => re.test(h));
}

/** 検証に使う名前の集合（登記名 / 表示名 / 英語名 / 旧商号）。 */
export type CompanyNameSet = {
  displayName: string;
  legalName: string | null;
  legalNameEn: string | null;
  formerNames: readonly string[];
};

export type DomainVerdict = {
  /** 採用してよいか。 */
  verified: boolean;
  /** 判定根拠（固定 enum。ログに出せる）。 */
  reason:
    | 'name_in_title'
    | 'name_in_jsonld'
    | 'name_in_body'
    | 'non_official_host'
    | 'name_not_found'
    | 'empty_input';
  /** 0..1。fact の confidence 算出に使う。 */
  score: number;
  /** 一致の取得方法（jsonld 一致なら構造化扱いにできる）。 */
  method: CompanyFactExtractionMethod;
};

/** 比較用に記号・空白を落とす（表記ゆれの吸収。script は跨がない）。 */
function toComparable(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　・･,，.。()（）「」『』【】\-—–_/|]/g, '');
}

/** 名前集合を比較用トークンへ（空・極端に短いものは除外）。 */
function buildNameTokens(names: CompanyNameSet): string[] {
  const raw = [names.displayName, names.legalName, names.legalNameEn, ...names.formerNames];
  const tokens = raw
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    .map(toComparable)
    // 2 文字以下の名前で本文一致を判定すると誤検出だらけになる（「NEC」は 3 文字なので残る）。
    .filter((n) => n.length >= 3);
  return Array.from(new Set(tokens));
}

/**
 * 候補ページが「その企業の公式サイト」かを判定する（pure）。
 *
 * 判定の強さ（強い順）:
 *   1. JSON-LD Organization の name / legalName が一致  → 最も強い（構造化された自己申告）
 *   2. <title> に企業名が含まれる                        → 強い
 *   3. 本文に企業名が含まれる                            → 弱い（採用可だが confidence を下げる）
 *
 * どれにも当たらなければ **採用しない**。
 */
export function verifyOfficialDomain(input: {
  host: string;
  title: string;
  bodyText: string;
  jsonLdNames: readonly (string | null)[];
  names: CompanyNameSet;
}): DomainVerdict {
  const { host, title, bodyText, jsonLdNames, names } = input;

  if (isNonOfficialHost(host)) {
    return { verified: false, reason: 'non_official_host', score: 0, method: 'html_structured' };
  }

  const tokens = buildNameTokens(names);
  if (tokens.length === 0) {
    return { verified: false, reason: 'empty_input', score: 0, method: 'html_structured' };
  }

  const jsonLd = toComparable(
    jsonLdNames.filter((n): n is string => typeof n === 'string').join(' '),
  );
  if (jsonLd !== '' && tokens.some((t) => jsonLd.includes(t))) {
    return { verified: true, reason: 'name_in_jsonld', score: 0.95, method: 'html_structured' };
  }

  const titleComparable = toComparable(typeof title === 'string' ? title : '');
  if (titleComparable !== '' && tokens.some((t) => titleComparable.includes(t))) {
    return { verified: true, reason: 'name_in_title', score: 0.85, method: 'html_structured' };
  }

  const bodyComparable = toComparable(typeof bodyText === 'string' ? bodyText.slice(0, 8000) : '');
  if (bodyComparable !== '' && tokens.some((t) => bodyComparable.includes(t))) {
    return { verified: true, reason: 'name_in_body', score: 0.6, method: 'html_structured' };
  }

  return { verified: false, reason: 'name_not_found', score: 0, method: 'html_structured' };
}

// ── 会社概要 / 採用 / IR ページの入口検出（pure）──────────────────────
/** リンクラベル / URL のパターンで入口ページを見つける。 */
const PAGE_PATTERNS: Readonly<
  Record<'about' | 'recruit' | 'ir' | 'news' | 'midTermPlan', { label: RegExp; href: RegExp }>
> = {
  about: {
    label: /(会社概要|企業情報|会社案内|company\s*profile|about\s*us|about)/i,
    href: /\/(company|about|corporate|profile|outline|gaiyou)(\/|$|\?|#)/i,
  },
  recruit: {
    label: /(採用|新卒|リクルート|careers?|recruit)/i,
    href: /\/(recruit|career|careers|saiyo|jobs|newgrads?)(\/|$|\?|#)/i,
  },
  ir: {
    label: /(ir情報|投資家|株主|investor)/i,
    href: /\/(ir|investor|investors)(\/|$|\?|#)/i,
  },
  news: {
    label: /(ニュース|プレスリリース|お知らせ|news|press)/i,
    href: /\/(news|press|release|topics|newsroom)(\/|$|\?|#)/i,
  },
  midTermPlan: {
    label: /(中期経営計画|中期計画|経営計画|mid[-\s]?term)/i,
    href: /\/(midterm|mid-term|chuki|management-plan)(\/|$|\?|#)/i,
  },
};

export type DiscoveredPages = {
  about: string | null;
  recruit: string | null;
  ir: string | null;
  news: string | null;
  midTermPlan: string | null;
};

/**
 * 公式サイトのトップページのリンク群から入口 URL を選ぶ（pure）。
 *
 * ★ 同一登録ドメイン配下のリンクだけを採用する（外部媒体の採用ページを
 *   「この企業の採用ページ」として保存しない）。
 */
export function discoverPages(
  links: readonly { href: string; label: string }[],
  officialHost: string,
): DiscoveredPages {
  const result: DiscoveredPages = {
    about: null,
    recruit: null,
    ir: null,
    news: null,
    midTermPlan: null,
  };
  if (!Array.isArray(links) || links.length === 0) return result;

  const baseHost = typeof officialHost === 'string' ? officialHost.toLowerCase() : '';
  if (baseHost === '') return result;
  // 登録ドメイン（末尾 2 ラベル）で比較し、www / ir / recruit 等のサブドメインを許容する。
  const registrable = baseHost.split('.').slice(-2).join('.');

  for (const key of Object.keys(PAGE_PATTERNS) as (keyof DiscoveredPages)[]) {
    const { label: labelRe, href: hrefRe } = PAGE_PATTERNS[key];
    // ラベル一致を優先し、無ければ URL 形状で拾う（決定論のため配列順を保つ）。
    const byLabel = links.find((l) => sameSite(l.href, registrable) && labelRe.test(l.label));
    if (byLabel) {
      result[key] = byLabel.href;
      continue;
    }
    const byHref = links.find((l) => sameSite(l.href, registrable) && hrefRe.test(l.href));
    if (byHref) result[key] = byHref.href;
  }

  return result;
}

/** URL が同一登録ドメイン配下か。 */
export function sameSite(href: string, registrableDomain: string): boolean {
  try {
    const host = new URL(href).hostname.toLowerCase();
    return host === registrableDomain || host.endsWith(`.${registrableDomain}`);
  } catch {
    return false;
  }
}
