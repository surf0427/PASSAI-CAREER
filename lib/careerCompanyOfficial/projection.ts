/**
 * Company Data Spine — DB 行 → consumer 向け projection（pure・決定論・never-throw・I/O ゼロ）。
 *
 * 責務:
 *   - 同一 `fact_key` の複数世代から **最新 1 件**を選ぶ（履歴は消さず、読むときに畳む）
 *   - 値を表示用文字列へ整形する（★ 言い換え・要約はしない。配列は「、」で結合するだけ）
 *   - fact_group 別の鮮度を付ける（部分的に古い / 欠けている状態を消さずに運ぶ）
 *   - 出典 URL を一意化して並べる
 *
 * ★ AI 生成物（derived）はここに混ざらない。projection は official fact のみ。
 */

import type {
  CompanyFactGroup,
  CompanyFactGroupFreshness,
  CompanyFactKey,
  CompanyOfficialContext,
  CompanyOfficialFactView,
  CompanyFactExtractionMethod,
  CompanySourceType,
} from '@/types/careerCompanyOfficial';
import {
  COMPANY_FACT_KEY_GROUP,
  PREFETCH_FACT_GROUPS,
} from '@/types/careerCompanyOfficial';
import { classifyGroupFreshness } from './freshness';

/** DB から読んだ 1 行（join 済み）。 */
export type FactRow = {
  factKey: string;
  factGroup: string;
  factValue: unknown;
  sourceUrl: string;
  sourceType: string;
  extractionMethod: string;
  fetchedAt: string;
};

/** 表示用の値へ整形する（**要約・言い換えをしない**）。 */
export function formatFactValue(raw: unknown): { display: string; unit: string | null; asOf: string | null } {
  if (!raw || typeof raw !== 'object') return { display: '', unit: null, asOf: null };
  const v = raw as { value?: unknown; unit?: unknown; asOf?: unknown };

  let display = '';
  if (typeof v.value === 'string') display = v.value.trim();
  else if (typeof v.value === 'number' && Number.isFinite(v.value)) display = String(v.value);
  else if (Array.isArray(v.value)) {
    display = v.value
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim())
      .join('、');
  }

  return {
    display,
    unit: typeof v.unit === 'string' && v.unit.trim() !== '' ? v.unit.trim() : null,
    asOf: typeof v.asOf === 'string' && v.asOf.trim() !== '' ? v.asOf.trim() : null,
  };
}

function isKnownGroup(value: string): value is CompanyFactGroup {
  return value in
    ({ identity: 1, profile: 1, navigation: 1, ir: 1, recruiting: 1, news: 1 } as Record<string, number>);
}

function isKnownMethod(value: string): value is CompanyFactExtractionMethod {
  return value === 'structured_api' || value === 'html_structured' || value === 'llm_extraction';
}

function isKnownSourceType(value: string): value is CompanySourceType {
  return (
    value === 'corporate_registry' ||
    value === 'official_site' ||
    value === 'ir_document' ||
    value === 'press_release' ||
    value === 'job_posting' ||
    value === 'search_result'
  );
}

/**
 * 行群 → `CompanyOfficialContext`（pure）。
 *
 * @param rows 任意順でよい（本関数が fetchedAt 降順で畳む）。
 * @param nowIso 鮮度判定の基準時刻（関数内で now を読まない）。
 */
export function buildCompanyOfficialContext(params: {
  companyId: string;
  displayName: string;
  rows: readonly FactRow[];
  nowIso: string;
  /** 鮮度を評価する group（既定は prefetch 対象の 3 つ）。 */
  groups?: readonly CompanyFactGroup[];
}): CompanyOfficialContext {
  const { companyId, displayName, rows, nowIso } = params;
  const targetGroups = params.groups ?? PREFETCH_FACT_GROUPS;

  // fact_key ごとに最新 1 件へ畳む（履歴は DB に残したまま、読むときだけ現行値を採る）。
  const latestByKey = new Map<string, FactRow>();
  for (const row of rows) {
    if (!row || typeof row.factKey !== 'string' || typeof row.fetchedAt !== 'string') continue;
    const current = latestByKey.get(row.factKey);
    if (!current || row.fetchedAt > current.fetchedAt) latestByKey.set(row.factKey, row);
  }

  // group 別の最新取得時刻（鮮度判定の材料）。
  const latestByGroup = new Map<CompanyFactGroup, string>();
  for (const row of latestByKey.values()) {
    const group = isKnownGroup(row.factGroup)
      ? row.factGroup
      : COMPANY_FACT_KEY_GROUP[row.factKey as CompanyFactKey];
    if (!group) continue;
    const current = latestByGroup.get(group);
    if (!current || row.fetchedAt > current) latestByGroup.set(group, row.fetchedAt);
  }

  const groupStates: CompanyFactGroupFreshness[] = targetGroups.map((g) =>
    classifyGroupFreshness(g, latestByGroup.get(g) ?? null, nowIso),
  );
  const freshnessByGroup = new Map(groupStates.map((s) => [s.factGroup, s.freshness] as const));

  const facts: CompanyOfficialFactView[] = [];
  for (const row of latestByKey.values()) {
    const { display, unit, asOf } = formatFactValue(row.factValue);
    if (display === '') continue; // 空値を「不明という事実」として出さない。

    const group = isKnownGroup(row.factGroup)
      ? row.factGroup
      : COMPANY_FACT_KEY_GROUP[row.factKey as CompanyFactKey];
    if (!group) continue;

    facts.push({
      factKey: row.factKey as CompanyFactKey,
      factGroup: group,
      displayValue: display,
      unit,
      asOf,
      sourceUrl: typeof row.sourceUrl === 'string' ? row.sourceUrl : '',
      sourceType: isKnownSourceType(row.sourceType) ? row.sourceType : 'official_site',
      fetchedAt: row.fetchedAt,
      // group の鮮度をそのまま fact に写す（fact 単位で TTL を持たせない）。
      freshness: freshnessByGroup.get(group) ?? 'stale',
      extractionMethod: isKnownMethod(row.extractionMethod) ? row.extractionMethod : 'llm_extraction',
    });
  }

  // 決定論順（group → key）。QA と prompt の golden が順序に依存できる。
  facts.sort((a, b) =>
    a.factGroup === b.factGroup
      ? a.factKey.localeCompare(b.factKey)
      : a.factGroup.localeCompare(b.factGroup),
  );

  const sourceUrls = Array.from(
    new Set(facts.map((f) => f.sourceUrl).filter((u) => u !== '')),
  ).sort();

  const times = facts.map((f) => f.fetchedAt).sort();

  return {
    companyId,
    displayName,
    facts,
    groups: groupStates,
    sourceUrls,
    oldestFetchedAt: times[0] ?? null,
    newestFetchedAt: times[times.length - 1] ?? null,
  };
}
