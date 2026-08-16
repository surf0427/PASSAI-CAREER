/**
 * Company Prefetch — provider 出力 → Official Fact への写像（pure・決定論・never-throw）。
 *
 * 契約:
 *   - すべての fact は `sourceUrl` を伴う（出典の無い fact を作れない形にする）。
 *   - `confidence` は取得方法から決定論で導く（**AI に自己申告させない**）。
 *   - 値が無いものは fact を **作らない**（null を「不明という事実」として保存しない）。
 *   - 言い換え・要約をしない（原文の表記をそのまま値にする）。
 *
 * ★ この module は AI 生成物を扱わない。derived（AI 要約）は別経路・別テーブル。
 */

import type {
  CompanyFactKey,
  CompanyFactValue,
  CompanyFactExtractionMethod,
  DraftOfficialCompanyFact,
} from '@/types/careerCompanyOfficial';
import { COMPANY_FACT_KEY_GROUP } from '@/types/careerCompanyOfficial';
import { CONFIDENCE_BY_METHOD } from './constants';
import type { ExtractedCompanyProfile } from './extraction';
import { findRawExcerpt } from './extraction';
import type { DiscoveredPages } from './domainVerification';
import type { JsonLdOrganization } from './htmlText';
import type { RegistryCompanyCandidate } from './providers/types';

type FactInput = {
  key: CompanyFactKey;
  value: string | number | readonly string[] | null | undefined;
  sourceUrl: string;
  method: CompanyFactExtractionMethod;
  fetchedAt: string;
  unit?: string;
  asOf?: string | null;
  rawExcerpt?: string | null;
};

/** 値が「保存に値する」か（空・空配列は fact にしない）。 */
function hasValue(value: FactInput['value']): value is string | number | readonly string[] {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) && value.length > 0;
}

/** 1 件の fact を組む（値が無ければ null）。 */
function buildFact(input: FactInput): DraftOfficialCompanyFact | null {
  if (!hasValue(input.value)) return null;
  if (typeof input.sourceUrl !== 'string' || input.sourceUrl.trim() === '') return null;

  const factValue: CompanyFactValue = { value: input.value };
  if (input.unit) factValue.unit = input.unit;
  if (input.asOf) factValue.asOf = input.asOf;
  if (input.rawExcerpt) factValue.rawExcerpt = input.rawExcerpt;

  return {
    companyId: '', // 呼び出し側（job service）が確定 companyId を差し込む。
    factGroup: COMPANY_FACT_KEY_GROUP[input.key],
    factKey: input.key,
    factValue,
    extractionMethod: input.method,
    confidence: CONFIDENCE_BY_METHOD[input.method],
    fetchedAt: input.fetchedAt,
    sourceUrl: input.sourceUrl.trim(),
  };
}

function collect(inputs: readonly (DraftOfficialCompanyFact | null)[]): DraftOfficialCompanyFact[] {
  return inputs.filter((f): f is DraftOfficialCompanyFact => f !== null);
}

// ── identity group（公的 registry 由来・AI 不使用）────────────────────
/**
 * registry candidate → identity facts。
 * `extraction_method='structured_api'`（最も高い confidence）。
 */
export function buildIdentityFacts(
  candidate: RegistryCompanyCandidate,
  sourceUrl: string,
  fetchedAt: string,
): DraftOfficialCompanyFact[] {
  const base = { sourceUrl, method: 'structured_api' as const, fetchedAt };
  return collect([
    buildFact({ ...base, key: 'corporateNumber', value: candidate.corporateNumber }),
    buildFact({ ...base, key: 'legalName', value: candidate.legalName }),
    buildFact({ ...base, key: 'legalNameKana', value: candidate.legalNameKana }),
    buildFact({ ...base, key: 'legalNameEn', value: candidate.legalNameEn }),
    buildFact({ ...base, key: 'headquartersPrefecture', value: candidate.prefecture }),
    buildFact({ ...base, key: 'headquartersAddress', value: candidate.address }),
    buildFact({ ...base, key: 'registrationStatus', value: candidate.registrationStatus }),
  ]);
}

// ── profile group（公式サイトの構造化データ由来・AI 不使用）─────────────
/**
 * JSON-LD Organization → profile facts。
 * `extraction_method='html_structured'`（LLM より高い confidence）。
 *
 * ★ JSON-LD で取れた項目は LLM 抽出より優先する（同 key があれば LLM 側を採用しない）。
 */
export function buildJsonLdFacts(
  org: JsonLdOrganization | null,
  sourceUrl: string,
  fetchedAt: string,
): DraftOfficialCompanyFact[] {
  if (!org) return [];
  const base = { sourceUrl, method: 'html_structured' as const, fetchedAt };
  const address = [org.addressRegion, org.addressLocality, org.streetAddress]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join('');
  return collect([
    buildFact({ ...base, key: 'legalName', value: org.legalName ?? org.name }),
    buildFact({ ...base, key: 'foundedYear', value: org.foundingDate }),
    buildFact({ ...base, key: 'employeeCount', value: org.numberOfEmployees }),
    buildFact({ ...base, key: 'headquartersAddress', value: address }),
    buildFact({ ...base, key: 'businessDescription', value: org.description }),
  ]);
}

/**
 * verified official domain → profile facts（URL 自体が事実）。
 * domain 検証を通ったときだけ呼ぶ（未検証ドメインを officialDomain として保存しない）。
 */
export function buildDomainFacts(
  officialHost: string,
  officialUrl: string,
  aboutPageUrl: string | null,
  sourceUrl: string,
  fetchedAt: string,
): DraftOfficialCompanyFact[] {
  const base = { sourceUrl, method: 'html_structured' as const, fetchedAt };
  return collect([
    buildFact({ ...base, key: 'officialDomain', value: officialHost }),
    buildFact({ ...base, key: 'officialUrl', value: officialUrl }),
    buildFact({ ...base, key: 'aboutPageUrl', value: aboutPageUrl }),
  ]);
}

// ── navigation group（リンク検出由来・AI 不使用）──────────────────────
export function buildNavigationFacts(
  pages: DiscoveredPages,
  sourceUrl: string,
  fetchedAt: string,
): DraftOfficialCompanyFact[] {
  const base = { sourceUrl, method: 'html_structured' as const, fetchedAt };
  return collect([
    buildFact({ ...base, key: 'recruitUrl', value: pages.recruit }),
    buildFact({ ...base, key: 'irUrl', value: pages.ir }),
    buildFact({ ...base, key: 'newsroomUrl', value: pages.news }),
    buildFact({ ...base, key: 'midTermPlanUrl', value: pages.midTermPlan }),
  ]);
}

// ── profile group（LLM 抽出由来・**検証済みのみ**）─────────────────────
/**
 * 検証を通った抽出結果 → profile facts。
 *
 * ★ 前提: 呼び出し側が `rejectUngroundedValues` を通した profile だけを渡すこと
 *   （本 module は再検証しないが、`rawExcerpt` の生成時に原文を再探索するため、
 *   原文に無い値は excerpt が null になり、その事実がそのまま観測に残る）。
 */
export function buildExtractedProfileFacts(
  profile: ExtractedCompanyProfile,
  sourceText: string,
  sourceUrl: string,
  fetchedAt: string,
): DraftOfficialCompanyFact[] {
  const base = { sourceUrl, method: 'llm_extraction' as const, fetchedAt };
  const excerpt = (value: string | null): string | null =>
    value === null ? null : findRawExcerpt(value, sourceText);

  return collect([
    buildFact({ ...base, key: 'legalName', value: profile.legalName, rawExcerpt: excerpt(profile.legalName) }),
    buildFact({ ...base, key: 'industryLabel', value: profile.industryLabel, rawExcerpt: excerpt(profile.industryLabel) }),
    buildFact({
      ...base,
      key: 'businessDescription',
      value: profile.businessDescription,
      rawExcerpt: excerpt(profile.businessDescription),
    }),
    buildFact({ ...base, key: 'businessSegments', value: profile.businessSegments }),
    buildFact({ ...base, key: 'mainProducts', value: profile.mainProducts }),
    buildFact({
      ...base,
      key: 'employeeCount',
      value: profile.employeeCount,
      asOf: profile.employeeCountAsOf,
      rawExcerpt: excerpt(profile.employeeCount),
    }),
    buildFact({
      ...base,
      key: 'capital',
      value: profile.capital,
      asOf: profile.capitalAsOf,
      rawExcerpt: excerpt(profile.capital),
    }),
    buildFact({ ...base, key: 'foundedYear', value: profile.foundedYear, rawExcerpt: excerpt(profile.foundedYear) }),
    buildFact({
      ...base,
      key: 'headquartersAddress',
      value: profile.headquartersAddress,
      rawExcerpt: excerpt(profile.headquartersAddress),
    }),
    buildFact({ ...base, key: 'listingStatus', value: profile.listingStatus, rawExcerpt: excerpt(profile.listingStatus) }),
    buildFact({ ...base, key: 'tickerCode', value: profile.tickerCode, rawExcerpt: excerpt(profile.tickerCode) }),
    buildFact({
      ...base,
      key: 'parentCompanyName',
      value: profile.parentCompanyName,
      rawExcerpt: excerpt(profile.parentCompanyName),
    }),
    buildFact({
      ...base,
      key: 'corporateGroupLabel',
      value: profile.corporateGroupLabel,
      rawExcerpt: excerpt(profile.corporateGroupLabel),
    }),
  ]);
}

// ── 統合 ─────────────────────────────────────────────────────────────
/** 取得方法の優先順（同一 fact_key が競合したときに勝つ方）。 */
const METHOD_PRIORITY: Readonly<Record<CompanyFactExtractionMethod, number>> = {
  structured_api: 3,
  html_structured: 2,
  llm_extraction: 1,
};

/**
 * 複数 provider 由来の fact を **key 単位で 1 件に畳む**（pure・決定論）。
 *
 * ★ 優先順位: structured_api > html_structured > llm_extraction。
 *   公的 registry で取れた `legalName` を、LLM が公式サイトから読んだ値で上書きさせない。
 *   同じ method 同士なら先に来たものを採る（呼び出し側の配列順が決定論であること）。
 */
export function mergeFacts(
  companyId: string,
  groups: readonly (readonly DraftOfficialCompanyFact[])[],
): DraftOfficialCompanyFact[] {
  const byKey = new Map<CompanyFactKey, DraftOfficialCompanyFact>();

  for (const group of groups) {
    for (const fact of group) {
      const existing = byKey.get(fact.factKey);
      if (
        !existing ||
        METHOD_PRIORITY[fact.extractionMethod] > METHOD_PRIORITY[existing.extractionMethod]
      ) {
        byKey.set(fact.factKey, { ...fact, companyId });
      }
    }
  }

  // 決定論順（group → key）。QA が順序に依存できる。
  return Array.from(byKey.values()).sort((a, b) =>
    a.factGroup === b.factGroup
      ? a.factKey.localeCompare(b.factKey)
      : a.factGroup.localeCompare(b.factGroup),
  );
}
