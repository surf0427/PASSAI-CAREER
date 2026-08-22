/**
 * Company Identity — 自由文中の企業言及の検出（pure・決定論・never-throw）。
 *
 * ★ 本 module が「する」こと:
 *   既に Company Master / Alias に **存在する名前**が、ユーザーの発話中に現れているかを
 *   文字列として探すだけ。辞書に無い語は決して企業として扱わない。
 *
 * ★ 本 module が「しない」こと（設計の中核）:
 *   - LLM / NER / 外部検索で企業名を推測しない。
 *   - 類似度・編集距離で「たぶんこの会社」と決めない（完全一致のみ）。
 *   - identity を確定しない。確定は既存 `resolveCompany`（= buildCompanyResolveResult 経由）の責務で、
 *     本 module は「照合すべき surface」を返すところまで。
 *   - ブランド名 alias を推測生成しない（alias は DB にあるものだけ）。
 *
 * 誤検出防止（日本語で特に重要）:
 *   - 辞書 token は `normalizeCompanyName` 済みなので「株式会社」「会社」「グループ」等の
 *     法人格・一般語は token になりえない（正規化で落ちる / master に存在しない）。
 *   - token 長の下限を設ける（短名の暴発防止）。
 *   - ASCII のみの token は語境界を要求する（`one` が `everyone` に当たらない）。
 *   - 重なり合う match は **longest match wins**（「三井」が「三井住友銀行」を食わない）。
 */

import { normalizeCompanyName } from '@/lib/careerCompanyKnowledge/identity';

/** 辞書 1 件（master 1 行 + その別名。値はすべて正規化済み token）。 */
export type CompanyMentionDictionaryEntry = {
  companyId: string;
  displayName: string;
  /** 正規化済みの照合 token（display / normalized / alias 由来・空文字を含まない）。 */
  tokens: readonly string[];
};

/** 検出された言及 1 件。 */
export type CompanyMention = {
  companyId: string;
  displayName: string;
  /** 実際に文中で一致した正規化 token。identity 解決の入力にする。 */
  matchedToken: string;
  /** 折りたたみ後の本文における出現位置（発話順の決定に使う）。 */
  at: number;
};

/**
 * 照合 token の最小長。
 *
 * 2 文字以下は日本語でも英字でも一般語と衝突しやすい（「AI」「ONE」「三井」の「三」等）。
 * 既存 `verifyOfficialDomain` の name token も同じ理由で 3 文字未満を捨てている。
 */
export const MIN_MENTION_TOKEN_LENGTH = 3;

/** ASCII 英数のみの token かどうか（語境界を要求する対象）。 */
function isAsciiToken(token: string): boolean {
  return /^[a-z0-9][a-z0-9.\-&' ]*$/.test(token);
}

/** ASCII 英数字（語境界判定に使う）。 */
function isAsciiWordChar(ch: string | undefined): boolean {
  return typeof ch === 'string' && /[a-z0-9]/.test(ch);
}

/**
 * 本文を辞書 token と同じ土俵へ落とす。
 *
 * ★ `normalizeCompanyName` は「1 つの企業名」を正規化する関数であり、文章全体には使えない
 *   （前後の法人格を剥がすなど、文に対して意味を持たない処理が入る）。
 *   ここでは同関数の前段と同じ「幅の折りたたみ + 小文字化」だけを行う。
 *   ★ 文字数を変えない変換に限定すること（index が本文とずれると surface を復元できない）。
 */
export function foldMessageForMention(message: string): string {
  if (typeof message !== 'string') return '';
  return message.normalize('NFKC').toLowerCase();
}

/**
 * 自由文から「辞書に存在する企業名」の言及を検出する（pure）。
 *
 * 戻り値は **出現順**（同一企業は最初の 1 件のみ）。identity の確定は呼び出し側が
 * 既存 resolver へ委ねること（本関数は候補を返すだけ）。
 *
 * 同じ位置で複数企業の token が成立した場合（別企業が同じ別名を持つ等）は、
 * その位置の match を **捨てる**（曖昧なまま企業を選ばない）。
 */
export function detectCompanyMentions(
  message: string,
  dictionary: readonly CompanyMentionDictionaryEntry[],
  options: { max?: number } = {},
): CompanyMention[] {
  const max = options.max ?? Number.POSITIVE_INFINITY;
  const haystack = foldMessageForMention(message);
  if (haystack === '' || !Array.isArray(dictionary) || dictionary.length === 0) return [];

  // ── 1) 全 token の出現位置を集める ────────────────────────────────
  type Hit = { at: number; end: number; token: string; companyId: string; displayName: string };
  const hits: Hit[] = [];

  for (const entry of dictionary) {
    if (!entry || typeof entry.companyId !== 'string' || entry.companyId === '') continue;
    for (const token of entry.tokens) {
      if (typeof token !== 'string' || token.length < MIN_MENTION_TOKEN_LENGTH) continue;
      const ascii = isAsciiToken(token);
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(token, from);
        if (at < 0) break;
        from = at + 1;
        if (ascii) {
          // 語境界を要求する（`one` が `everyone` に当たらない）。
          const before = at > 0 ? haystack[at - 1] : undefined;
          const after = haystack[at + token.length];
          if (isAsciiWordChar(before) || isAsciiWordChar(after)) continue;
        }
        hits.push({ at, end: at + token.length, token, companyId: entry.companyId, displayName: entry.displayName });
      }
    }
  }
  if (hits.length === 0) return [];

  // ── 2) longest match wins（長い順 → 位置順で貪欲に確定し、重なりを捨てる）──
  hits.sort((a, b) => (b.end - b.at) - (a.end - a.at) || a.at - b.at || a.companyId.localeCompare(b.companyId));

  const taken: Array<{ at: number; end: number }> = [];
  const overlaps = (h: Hit) => taken.some((t) => h.at < t.end && t.at < h.end);
  const accepted: Hit[] = [];

  for (const hit of hits) {
    if (overlaps(hit)) continue;
    // ★ 同一 span を別企業も主張している場合は確定しない（曖昧なら使わない）。
    const rivals = hits.filter(
      (h) => h.at === hit.at && h.end === hit.end && h.companyId !== hit.companyId,
    );
    taken.push({ at: hit.at, end: hit.end });
    if (rivals.length > 0) continue;
    accepted.push(hit);
  }

  // ── 3) 出現順 + 企業単位で 1 件 ──────────────────────────────────
  accepted.sort((a, b) => a.at - b.at);
  const out: CompanyMention[] = [];
  const seen = new Set<string>();
  for (const hit of accepted) {
    if (seen.has(hit.companyId)) continue;
    seen.add(hit.companyId);
    out.push({ companyId: hit.companyId, displayName: hit.displayName, matchedToken: hit.token, at: hit.at });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * master 1 行分 → 照合 token 集合（pure）。
 *
 * token は既存 `normalizeCompanyName` を通したものだけ。法人格（株式会社 等）は
 * ここで落ちるため、「株式会社」単体が token になることはない。
 */
export function buildMentionTokens(input: {
  displayName: string;
  normalizedName: string;
  aliases?: readonly string[];
}): string[] {
  const raw = [input.displayName, input.normalizedName, ...(input.aliases ?? [])];
  const tokens = raw
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    .map((n) => normalizeCompanyName(n))
    .filter((n) => n.length >= MIN_MENTION_TOKEN_LENGTH);
  return Array.from(new Set(tokens));
}
