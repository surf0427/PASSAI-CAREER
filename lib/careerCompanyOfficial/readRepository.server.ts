/**
 * Company Data Spine — Official Facts の読み出し（server-only・never-throw）。
 *
 * consumer（企業研究 / ES / 面接 / 志望動機 / Career AI）が **唯一**使う入口。
 * 各機能が独自に企業情報を取りに行かないための single source of truth。
 *
 * 状態写像（既存 context loader の思想に揃える）:
 *   read kill switch ON → disabled(flag_off)   ← ingest flag ではなく read 専用 switch
 *   env 未設定 / 未認証  → disabled(not_configured | unauthenticated)
 *   DDL 未適用（42P01） → unavailable(not_provisioned)   ← **エラーにしない**
 *   companyId 未解決     → unavailable(no_company)
 *   fact 0 件            → unavailable(no_facts)          ← empty を「事実が無い証拠」にしない
 *   全 group fresh       → ready
 *   一部 group 欠落      → partial
 *   TTL 超過             → stale（**読める**。stale-while-revalidate）
 *
 * ★ read は user-scoped client（RLS SELECT）で行う。service_role は使わない
 *   （企業データは非個人データだが、読み出しに admin 権限を持ち出さない）。
 */

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  CAREER_COMPANY_OFFICIAL_TABLES,
  type CompanyOfficialReadResult,
} from '@/types/careerCompanyOfficial';
import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import { findCompanyCandidates, findCompanyById } from '@/lib/careerCompanyIdentity/repository.server';
import { buildCompanyResolveResult } from '@/lib/careerCompanyIdentity/resolution';
// ★ read は ingest（prefetch）flag と分離する。取得を止めることと、取得済みの事実を
//   読むことは別の判断であり、後者は外部 I/O ゼロ・冪等な SELECT のみだから。
import { isCompanyOfficialReadEnabled } from './flags.server';
import { devWarn } from '@/lib/devLog';
import { summarizeFreshness } from './freshness';
import { buildCompanyOfficialContext, type FactRow } from './projection';

const FACTS = CAREER_COMPANY_OFFICIAL_TABLES.facts;
const SOURCES = CAREER_COMPANY_OFFICIAL_TABLES.sources;

/**
 * 1 企業あたり読む fact の上限（暴走防止。key 数の数倍で十分）。
 *
 * ★ fact は世代ごとに append される（上書き削除しない）ので、
 *   `COMPANY_FACT_KEYS` の数（61）× 数世代を覆う値にする。
 *   `fetched_at DESC` で読むため、最新世代は必ずこの窓に入る。
 */
const MAX_FACT_ROWS = 400;

function isUndefinedTable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === '42P01' ||
    (typeof e.message === 'string' && /relation .* does not exist/i.test(e.message))
  );
}

export type CompanyOfficialQuery = {
  /** 確定済み canonical company id（あれば最優先）。 */
  companyId?: string | null;
  /** free-text 企業名（companyId が無いときの解決に使う）。 */
  companyName?: string | null;
  /** 鮮度判定の基準時刻（route が渡す）。 */
  nowIso: string;
};

/**
 * companyId を決める。
 *
 * ★ `ambiguous` / `unresolved` は **解決しない**（既存 Company Identity の不変条件）。
 *   誤った企業の公式情報を prompt へ載せるくらいなら、載せない方が安全。
 */
async function resolveCompanyId(
  query: CompanyOfficialQuery,
): Promise<{ companyId: string; displayName: string } | null> {
  const explicit = typeof query.companyId === 'string' ? query.companyId.trim() : '';
  if (explicit !== '') {
    const record = await findCompanyById(explicit);
    if (record) return { companyId: record.companyId, displayName: record.displayName };
    return null;
  }

  const name = typeof query.companyName === 'string' ? query.companyName.trim() : '';
  if (name === '') return null;

  const candidates = await findCompanyCandidates(name);
  if (candidates === null || candidates.length === 0) return null;

  const resolved = buildCompanyResolveResult(name, candidates);
  if (resolved.status !== 'resolved') return null;
  return { companyId: resolved.companyId, displayName: resolved.displayName };
}

/** fact + source を join して読む。 */
async function loadFactRows(
  client: SupabaseClient,
  companyId: string,
): Promise<FactRow[] | 'not_provisioned' | 'error'> {
  const { data, error } = await client
    .from(FACTS)
    .select(
      `fact_key, fact_group, fact_value, extraction_method, fetched_at,
       ${SOURCES}!inner ( source_url, source_type )`,
    )
    .eq('company_id', companyId)
    .order('fetched_at', { ascending: false })
    .limit(MAX_FACT_ROWS);

  if (error) {
    if (isUndefinedTable(error)) return 'not_provisioned';
    devWarn('[companyOfficial] read error');
    return 'error';
  }

  const rows: FactRow[] = [];
  for (const raw of (data ?? []) as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const joined = r[SOURCES];
    const source = (Array.isArray(joined) ? joined[0] : joined) as
      | { source_url?: unknown; source_type?: unknown }
      | undefined;

    if (typeof r.fact_key !== 'string' || typeof r.fetched_at !== 'string') continue;

    rows.push({
      factKey: r.fact_key,
      factGroup: typeof r.fact_group === 'string' ? r.fact_group : '',
      factValue: r.fact_value,
      sourceUrl: typeof source?.source_url === 'string' ? source.source_url : '',
      sourceType: typeof source?.source_type === 'string' ? source.source_type : '',
      extractionMethod: typeof r.extraction_method === 'string' ? r.extraction_method : '',
      fetchedAt: r.fetched_at,
    });
  }
  return rows;
}

/**
 * Company Data Spine から公式情報を読む（never-throw）。
 *
 * ★ 呼び出し側は `hasCompanyOfficialData()` でのみ data を取り出す
 *   （unavailable / disabled を「情報が無いという証拠」として render できない）。
 */
export async function loadCompanyOfficialContext(
  query: CompanyOfficialQuery,
): Promise<CompanyOfficialReadResult> {
  // read kill switch が OFF のときは Supabase にも触れない（I/O ゼロ）。
  //   ★ ingest（CAREER_COMPANY_PREFETCH_ENABLED）とは独立。ingest を止めていても、
  //     既に保存済みの出典付き fact は prompt へ供給し続ける。
  if (!isCompanyOfficialReadEnabled()) return { status: 'disabled', reason: 'flag_off' };

  try {
    const client = await getCareerServerSupabaseClient();
    if (!client) return { status: 'disabled', reason: 'not_configured' };

    const { data: auth, error: authError } = await client.auth.getUser();
    if (authError || !auth?.user || auth.user.is_anonymous) {
      return { status: 'disabled', reason: 'unauthenticated' };
    }

    const company = await resolveCompanyId(query);
    if (!company) return { status: 'unavailable', reason: 'no_company' };

    const rows = await loadFactRows(client, company.companyId);
    if (rows === 'not_provisioned') return { status: 'unavailable', reason: 'not_provisioned' };
    if (rows === 'error') return { status: 'unavailable', reason: 'lookup_error' };
    if (rows.length === 0) return { status: 'unavailable', reason: 'no_facts' };

    const context = buildCompanyOfficialContext({
      companyId: company.companyId,
      displayName: company.displayName,
      rows,
      nowIso: query.nowIso,
    });

    if (context.facts.length === 0) return { status: 'unavailable', reason: 'no_facts' };

    const summary = summarizeFreshness(context.groups);
    if (summary === 'missing') return { status: 'unavailable', reason: 'no_facts' };
    if (summary === 'ready') return { status: 'ready', data: context };
    if (summary === 'partial') return { status: 'partial', data: context };
    return { status: 'stale', data: context };
  } catch (err) {
    devWarn('[companyOfficial] read threw', err instanceof Error ? err.name : 'unknown');
    return { status: 'unavailable', reason: 'lookup_error' };
  }
}
