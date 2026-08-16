/**
 * Context renderer — Company Data Spine の公式情報 → prompt block（pure・決定論・never-throw）。
 *
 * ★★ 本 renderer の最重要契約 ★★
 *   企業研究機能の設計思想（`docs/company_research/company_research_current_state.md`）は
 *   「AI は企業情報の生成者ではなく添削者」であり、`docs/principles/ai_policy.md` は
 *   「入力にない事実の創作」を禁じている。
 *
 *   したがって prompt では次の 3 つを **絶対に混ぜない**:
 *     [公式情報]                 出典 URL と取得日を伴う事実。AI はこれを根拠に言及してよい。
 *     [ユーザー自身の企業研究]   本人のメモ。「あなたの記述では」と扱う（別 block・別経路）。
 *     [AI による参考情報]        derived。断定させない（Phase 1 では出力しない）。
 *
 *   本 renderer が出すのは **[公式情報] block のみ**。
 *   ユーザーのメモや AI 派生物をここへ入れる経路は存在しない（型でも分離されている）。
 *
 * 出力は byte budget に収める。budget を超えたら **削る**（勝手に要約しない）。
 */

import type {
  CompanyFactKey,
  CompanyOfficialContext,
  CompanyOfficialFactView,
  CompanyOfficialReadResult,
} from '@/types/careerCompanyOfficial';
import { hasCompanyOfficialData } from '@/types/careerCompanyOfficial';

export type CompanyOfficialBlock = {
  text: string;
  used: boolean;
};

const EMPTY: CompanyOfficialBlock = { text: '', used: false };

/** prompt へ載せる最大バイト数（base context を圧迫しない範囲）。 */
export const COMPANY_OFFICIAL_MAX_BYTES = 1600;

/** 1 block に載せる fact の最大件数。 */
export const COMPANY_OFFICIAL_MAX_FACTS = 18;

/** この renderer を通す purpose（allowlist。他 purpose へは投入しない）。 */
export const COMPANY_OFFICIAL_PURPOSES: readonly string[] = ['company_research_review'];

/** fact_key → 日本語ラベル（表示のみ。値そのものは加工しない）。 */
const FACT_LABELS: Readonly<Record<CompanyFactKey, string>> = {
  corporateNumber: '法人番号',
  legalName: '正式名称',
  legalNameKana: '名称（カナ）',
  legalNameEn: '英文名称',
  headquartersPrefecture: '本社（都道府県）',
  headquartersAddress: '本社所在地',
  foundedYear: '設立',
  registrationStatus: '登記状態',
  officialDomain: '公式ドメイン',
  officialUrl: '公式サイト',
  aboutPageUrl: '会社概要ページ',
  industryLabel: '業種（自社表記）',
  businessDescription: '事業内容（公式サイトからの抜粋）',
  businessSegments: '事業セグメント',
  mainProducts: '主要製品・サービス',
  employeeCount: '従業員数',
  capital: '資本金',
  listingStatus: '上場区分',
  tickerCode: '証券コード',
  parentCompanyName: '親会社',
  corporateGroupLabel: '企業グループ',
  recruitUrl: '採用ページ',
  irUrl: 'IR ページ',
  newsroomUrl: 'ニュースリリース',
  midTermPlanUrl: '中期経営計画',
};

/** group ごとの表示順（identity → profile → navigation）。 */
const GROUP_ORDER: readonly string[] = ['identity', 'profile', 'navigation', 'ir', 'recruiting', 'news'];

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** ISO → 'YYYY-MM-DD'（取得日の表示。時刻までは出さない）。 */
function toDateLabel(iso: string): string {
  if (typeof iso !== 'string' || iso.length < 10) return '';
  return iso.slice(0, 10);
}

/** 1 件の fact 行。値 → 単位 → 基準日 → 鮮度の順で、すべて原文のまま並べる。 */
function renderFactLine(fact: CompanyOfficialFactView): string {
  const label = FACT_LABELS[fact.factKey] ?? fact.factKey;
  const unit = fact.unit ? ` ${fact.unit}` : '';
  const asOf = fact.asOf ? `（${fact.asOf}）` : '';
  // stale は隠さず明示する（古い情報を新しいものとして提示しない）。
  const staleMark = fact.freshness === 'stale' ? '［要再確認］' : '';
  return `- ${label}: ${fact.displayValue}${unit}${asOf}${staleMark}`;
}

function sortFacts(facts: readonly CompanyOfficialFactView[]): CompanyOfficialFactView[] {
  return [...facts].sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.factGroup);
    const gb = GROUP_ORDER.indexOf(b.factGroup);
    if (ga !== gb) return ga - gb;
    return a.factKey.localeCompare(b.factKey);
  });
}

/**
 * `CompanyOfficialContext` → prompt block（pure）。
 *
 * 出力の構造:
 *   1. 見出し（**公式情報であること**と、取得日を明示）
 *   2. fact の列挙（値は原文のまま）
 *   3. 出典 URL
 *   4. 取り扱い注意書き（AI にこの block の役割を明示する）
 */
export function renderCompanyOfficialContext(
  context: CompanyOfficialContext,
  opts: { maxBytes?: number; maxFacts?: number; stale?: boolean } = {},
): CompanyOfficialBlock {
  try {
    if (!context || !Array.isArray(context.facts) || context.facts.length === 0) return EMPTY;

    const maxFacts = opts.maxFacts ?? COMPANY_OFFICIAL_MAX_FACTS;
    const maxBytes = opts.maxBytes ?? COMPANY_OFFICIAL_MAX_BYTES;

    const asOf = toDateLabel(context.newestFetchedAt ?? '');
    const staleNote = opts.stale ? '・一部は取得から時間が経過しています' : '';
    const header = `【公式情報（出典付き・${asOf || '取得日不明'}時点${staleNote}）: ${context.displayName}】`;

    const factLines = sortFacts(context.facts).slice(0, maxFacts).map(renderFactLine);

    const sourceLines =
      context.sourceUrls.length > 0
        ? [`出典: ${context.sourceUrls.slice(0, 4).join(' / ')}`]
        : [];

    // ★ AI にこの block の扱いを明示する。ここが「添削者」思想との接合部。
    const usageNote = [
      '※ 上記は公式サイト・公的登記など一次情報から取得した事実です（AI が生成した情報ではありません）。',
      '※ ユーザー本人の企業研究メモとは別物です。本人のメモを評価する際の照合材料として使い、',
      '　 ここに無い事実を補って断定しないでください。取得時点以降に変わっている可能性があります。',
    ];

    const build = (lines: readonly string[]): string =>
      [header, ...lines, ...sourceLines, ...usageNote].join('\n');

    let text = build(factLines);
    if (byteLength(text) <= maxBytes) return { text, used: true };

    // budget 超過 → **要約せずに件数を削る**（勝手に言い換えない）。
    for (let keep = factLines.length - 1; keep >= 1; keep -= 1) {
      text = build(factLines.slice(0, keep));
      if (byteLength(text) <= maxBytes) return { text, used: true };
    }
    return EMPTY;
  } catch {
    return EMPTY;
  }
}

/**
 * 読み出し結果 → prompt block（consumer が呼ぶ唯一の入口）。
 *
 * ★ `unavailable` / `disabled` は **必ず空文字**。
 *   「情報が取得できなかった」ことを prompt に書くと、AI がそれを
 *   「その企業には情報が無い」という負の事実として扱いうる。
 */
export function renderCompanyOfficialForPurpose(
  purpose: string,
  result: CompanyOfficialReadResult | null | undefined,
  opts: { maxBytes?: number; maxFacts?: number } = {},
): CompanyOfficialBlock {
  try {
    if (!result) return EMPTY;
    if (!COMPANY_OFFICIAL_PURPOSES.includes(purpose)) return EMPTY;
    if (!hasCompanyOfficialData(result)) return EMPTY;
    return renderCompanyOfficialContext(result.data, {
      ...opts,
      stale: result.status === 'stale',
    });
  } catch {
    return EMPTY;
  }
}
