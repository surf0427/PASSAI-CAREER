/**
 * Company Prefetch — 実 deps の組み立て（server-only・配線のみ・判定を書かない）。
 *
 * `prefetchJobService.ts` は純粋な分岐だけを持ち、副作用はすべて deps 経由で受け取る。
 * 本 module がその deps を実装で埋める **唯一の場所**（route は組み立てを持たない）。
 *
 * ★ ここに判定ロジックを書き足さないこと。書くなら pure module 側へ。
 */

import 'server-only';

import { anthropic, extractJson } from '@/lib/ai';
import { fetchOfficialSiteRaw } from './providers/officialSite.server';
import { extractJsonLdOrganization } from './htmlText';
import { createCompanySearchProvider } from './providers/searchProvider.server';
import { createCorporateRegistryProvider } from './providers/corporateRegistry.server';
import {
  attachCorporateNumber,
  claimCompanyEnrichmentJob,
  failCompanyEnrichmentJob,
  finishCompanyEnrichmentJob,
  insertFacts,
  insertSources,
  loadLatestFetchedAtByGroup,
} from './repository.server';
import { buildCompanyEnrichmentIdentity } from './idempotency';
import {
  COMPANY_EXTRACTION_MODEL,
  EXTRACTION_MAX_TOKENS,
  MAX_EXTRACTION_INPUT_CHARS,
  SINGLE_FETCH_TIMEOUT_MS,
} from './constants';
import { COMPANY_EXTRACTION_SYSTEM, normalizeExtractedProfile } from './extraction';
import { isCompanyPrefetchExternalFetchEnabled } from './flags.server';
import type { PrefetchDeps, SiteDocument } from './prefetchJobService';
import { getCareerServiceRoleSupabaseClient } from '@/lib/careerSupabase/serviceRoleClient';
import { findCompanyCandidates, registerCompany } from '@/lib/careerCompanyIdentity/repository.server';
import { buildCompanyResolveResult } from '@/lib/careerCompanyIdentity/resolution';
import { devWarn } from '@/lib/devLog';

/**
 * LLM 抽出（**抽出器としてのみ**）。
 *
 * ★ prompt は「本文に書かれている値だけを JSON で返す」契約
 *   （`COMPANY_EXTRACTION_SYSTEM`）。生成・推測・要約を禁じている。
 *   ただし prompt 指示は担保にならないため、呼び出し側が
 *   `rejectUngroundedValues` で **原文との突き合わせ**を必ず行う。
 *
 * ANTHROPIC_API_KEY 未設定・失敗・parse 不能はすべて null（＝ profile facts 無し）。
 * identity facts は別経路なので、ここが null でも job は partial として成立する。
 */
async function extractProfileWithLlm(sourceText: string): Promise<unknown | null> {
  const text = typeof sourceText === 'string' ? sourceText.slice(0, MAX_EXTRACTION_INPUT_CHARS) : '';
  if (text.trim() === '') return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;

  try {
    const message = await anthropic.messages.create(
      {
        model: COMPANY_EXTRACTION_MODEL,
        max_tokens: EXTRACTION_MAX_TOKENS,
        // 抽出は決定論であるべき（同じ本文からは同じ値）。
        temperature: 0,
        system: COMPANY_EXTRACTION_SYSTEM,
        messages: [
          {
            role: 'user',
            content: ['── 公式サイト本文 ──', text, '', '上記の本文から、指定の JSON 形式で抽出してください。'].join(
              '\n',
            ),
          },
        ],
      },
      { signal: AbortSignal.timeout(SINGLE_FETCH_TIMEOUT_MS * 4) },
    );

    if (message.stop_reason === 'max_tokens') return null;
    const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';
    if (raw.trim() === '') return null;
    return JSON.parse(extractJson(raw));
  } catch (err) {
    devWarn('[companyPrefetch] extraction failed', err instanceof Error ? err.name : 'unknown');
    return null;
  }
}

/**
 * 実装済み deps を組む。
 *
 * ★ `admin`（service_role）は **prefetch 実行時にだけ**生成する。
 *   env 未設定なら例外になるので、呼び出し側は try で受けて no-op へ倒す。
 */
export function buildCompanyPrefetchDeps(): PrefetchDeps {
  const admin = getCareerServiceRoleSupabaseClient();
  const registry = createCorporateRegistryProvider();
  const search = createCompanySearchProvider();

  return {
    now: () => new Date().toISOString(),
    externalFetchEnabled: isCompanyPrefetchExternalFetchEnabled,

    registry,
    search,

    async fetchSite(url: string): Promise<{ ok: true; document: SiteDocument } | { ok: false }> {
      const res = await fetchOfficialSiteRaw(url);
      if (res.status === 'failed') return { ok: false };
      const d = res.document;
      return {
        ok: true,
        document: {
          url: d.url,
          text: d.text,
          title: d.title,
          links: d.links,
          // JSON-LD だけは生 HTML が要るのでここで抽出し、HTML 自体は捨てる。
          jsonLd: extractJsonLdOrganization(d.html),
          source: d.source,
        },
      };
    },

    async extractProfile(sourceText: string) {
      const raw = await extractProfileWithLlm(sourceText);
      return raw === null ? null : normalizeExtractedProfile(raw);
    },

    // ★ 既存 Company Identity をそのまま再利用（無改修）。
    registerCompany: (displayName, aliases) => registerCompany(displayName, [...aliases]),

    /**
     * 既存企業への紐付けのみ（新規作成しない）。
     * 公的 registry で裏が取れないときの経路であり、free-text だけで
     * 全ユーザー共有テーブルへ行を作らせないための境界。
     */
    async resolveExistingCompany(rawName: string) {
      const candidates = await findCompanyCandidates(rawName);
      if (candidates === null || candidates.length === 0) return null;
      const resolved = buildCompanyResolveResult(rawName, candidates);
      // ★ ambiguous / unresolved は確定しない（既存不変条件をそのまま踏襲）。
      if (resolved.status !== 'resolved') return null;
      return { companyId: resolved.companyId, displayName: resolved.displayName };
    },

    loadFreshness: (companyId) => loadLatestFetchedAtByGroup(admin, companyId),
    claimJob: (identity) => claimCompanyEnrichmentJob(admin, identity),
    insertSources: (companyId, sources) => insertSources(admin, companyId, sources),
    insertFacts: (facts, map) => insertFacts(admin, facts, map),
    finishJob: (args) => finishCompanyEnrichmentJob(admin, args),
    failJob: (args) => failCompanyEnrichmentJob(admin, args),
    attachCorporateNumber: (companyId, corporateNumber) =>
      attachCorporateNumber(admin, companyId, corporateNumber),

    buildIdentity: (companyId) => buildCompanyEnrichmentIdentity({ companyId }),

    // 観測は enum + 件数のみ（企業名 / URL / 本文 / prompt を出さない）。
    log: (event) => devWarn('[companyPrefetch]', event.stage, event.outcome, event.count ?? 0),
  };
}
