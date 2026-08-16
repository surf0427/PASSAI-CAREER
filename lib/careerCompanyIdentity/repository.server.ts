/**
 * Company Identity — 永続化層（server-only・薄い adapter）。
 *
 * ★ 企業判定ロジックは **一切書かない**。ここがやるのは
 *     「DB から候補を絞って `CompanyMasterRecord[]` に写す」
 *     「新規企業を 1 件書く」
 *   だけで、正規化 / 解決 / 曖昧判定は `lib/careerCompanyKnowledge/identity.ts` が行う。
 *
 * 権威区分: `global_shared_server_authoritative`（全ユーザー共有の非個人データ）。
 *   - read : authenticated の RLS SELECT（user-scoped server client）
 *   - write : service_role（企業マスタは client から直接書かせない）
 *
 * never-throw。env 未設定 / 失敗時は null を返し、呼び出し側は free-text へ倒す。
 */

import 'server-only';

import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import { getCareerServiceRoleSupabaseClient } from '@/lib/careerSupabase/serviceRoleClient';
import { normalizeCompanyName } from '@/lib/careerCompanyKnowledge/identity';
import { CAREER_COMPANY_IDENTITY_TABLES } from '@/types/careerCompanyIdentity';
import type { CompanyMasterRecord } from '@/types/careerCompanyKnowledge';
import { devWarn } from '@/lib/devLog';

const MASTER = CAREER_COMPANY_IDENTITY_TABLES.master;
const ALIASES = CAREER_COMPANY_IDENTITY_TABLES.aliases;

/** prefilter で拾う最大企業数（純関数へ渡す候補の上限）。 */
export const COMPANY_PREFILTER_LIMIT = 20;

type MasterRow = {
  company_id: string;
  display_name: string | null;
  legal_name: string | null;
  normalized_name: string | null;
  corporate_group_id: string | null;
  parent_id: string | null;
};

type AliasRow = {
  company_id: string;
  alias: string | null;
  alias_kind: string | null;
};

/** ILIKE のワイルドカードを無害化する（ユーザー入力をそのままパターンに使わない）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** master 行 + alias 行 → 既存純関数が食える `CompanyMasterRecord`。 */
function toMasterRecords(
  masterRows: readonly MasterRow[],
  aliasRows: readonly AliasRow[],
): CompanyMasterRecord[] {
  const aliasesById = new Map<string, string[]>();
  const historicalById = new Map<string, string[]>();
  for (const a of aliasRows) {
    if (!a || typeof a.company_id !== 'string' || typeof a.alias !== 'string') continue;
    const bucket = a.alias_kind === 'historical_name' ? historicalById : aliasesById;
    const list = bucket.get(a.company_id);
    if (list) list.push(a.alias);
    else bucket.set(a.company_id, [a.alias]);
  }

  return masterRows
    .filter((r) => r && typeof r.company_id === 'string')
    .map((r) => {
      const displayName = typeof r.display_name === 'string' ? r.display_name : '';
      const record: CompanyMasterRecord = {
        companyId: r.company_id,
        displayName,
        normalizedName:
          typeof r.normalized_name === 'string' && r.normalized_name !== ''
            ? r.normalized_name
            : normalizeCompanyName(displayName),
        aliases: aliasesById.get(r.company_id) ?? [],
        corporateGroupId: typeof r.corporate_group_id === 'string' ? r.corporate_group_id : null,
      };
      if (typeof r.legal_name === 'string' && r.legal_name !== '') record.legalName = r.legal_name;
      if (typeof r.parent_id === 'string') record.parentId = r.parent_id;
      const historical = historicalById.get(r.company_id);
      if (historical && historical.length > 0) record.historicalNames = historical;
      return record;
    });
}

/** 指定 companyId 群の master + alias を取得して record 化する。 */
async function loadRecordsByIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  companyIds: readonly string[],
): Promise<CompanyMasterRecord[]> {
  if (companyIds.length === 0) return [];
  const [masterRes, aliasRes] = await Promise.all([
    client
      .from(MASTER)
      .select('company_id, display_name, legal_name, normalized_name, corporate_group_id, parent_id')
      .in('company_id', companyIds as string[]),
    client.from(ALIASES).select('company_id, alias, alias_kind').in('company_id', companyIds as string[]),
  ]);
  if (masterRes.error) {
    devWarn('[companyIdentity] master select error', masterRes.error);
    return [];
  }
  // alias は取れなくても致命ではない（別名なしとして扱う）。
  const aliasRows: AliasRow[] = aliasRes.error ? [] : ((aliasRes.data ?? []) as AliasRow[]);
  return toMasterRecords((masterRes.data ?? []) as MasterRow[], aliasRows);
}

/**
 * free-text 企業名から **候補**を絞る（DB prefilter）。
 *
 * ★ ここでは解決しない。完全一致 / 曖昧 / 未解決の判定は呼び出し側が
 *   既存 `resolveCompany(rawName, candidates)` に委ねる。
 *
 * 戻り値 null = 利用不可（env 未設定 / 取得失敗）→ 呼び出し側は free-text へ倒す。
 */
export async function findCompanyCandidates(
  rawName: string,
): Promise<CompanyMasterRecord[] | null> {
  const normalized = normalizeCompanyName(rawName);
  if (normalized === '') return [];

  try {
    const client = await getCareerServerSupabaseClient();
    if (!client) return null;

    const pattern = `%${escapeLike(normalized)}%`;
    const [byName, byAlias] = await Promise.all([
      client
        .from(MASTER)
        .select('company_id')
        .ilike('normalized_name', pattern)
        .limit(COMPANY_PREFILTER_LIMIT),
      client
        .from(ALIASES)
        .select('company_id')
        .ilike('normalized_alias', pattern)
        .limit(COMPANY_PREFILTER_LIMIT),
    ]);

    if (byName.error) {
      devWarn('[companyIdentity] prefilter error', byName.error);
      return null;
    }

    const ids = new Set<string>();
    for (const row of (byName.data ?? []) as Array<{ company_id: string }>) {
      if (typeof row?.company_id === 'string') ids.add(row.company_id);
    }
    if (!byAlias.error) {
      for (const row of (byAlias.data ?? []) as Array<{ company_id: string }>) {
        if (typeof row?.company_id === 'string') ids.add(row.company_id);
      }
    }

    return await loadRecordsByIds(client, Array.from(ids).slice(0, COMPANY_PREFILTER_LIMIT));
  } catch (err) {
    devWarn('[companyIdentity] prefilter threw', err);
    return null;
  }
}

/** companyId から 1 件引く（企業詳細ページ / 表示名の再取得用）。 */
export async function findCompanyById(companyId: string): Promise<CompanyMasterRecord | null> {
  if (typeof companyId !== 'string' || companyId.trim() === '') return null;
  try {
    const client = await getCareerServerSupabaseClient();
    if (!client) return null;
    const records = await loadRecordsByIds(client, [companyId.trim()]);
    return records[0] ?? null;
  } catch (err) {
    devWarn('[companyIdentity] findById threw', err);
    return null;
  }
}

/** 同一 normalized name の既存企業を service_role で探す（登録の重複防止に使う）。 */
async function findExactByNormalizedName(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  normalizedName: string,
): Promise<{ company_id: string; display_name: string | null } | null> {
  const { data, error } = await admin
    .from(MASTER)
    .select('company_id, display_name')
    .eq('normalized_name', normalizedName)
    .limit(1);
  if (error) {
    devWarn('[companyIdentity] exact lookup error', error);
    return null;
  }
  const rows = (data ?? []) as Array<{ company_id: string; display_name: string | null }>;
  return rows[0] ?? null;
}

export type RegisterCompanyResult = {
  companyId: string;
  displayName: string;
  created: boolean;
};

/**
 * 企業を登録する（server-only / service_role）。
 *
 * ★ 重複防止: 同一 `normalized_name` の企業が既にあれば **新規作成せず既存 ID を返す**
 *   （created:false）。同じ企業が乱立しないための唯一のガード。
 *
 * ★ `normalized_name` は **server が displayName から再計算**する（client 申告を信用しない）。
 */
export async function registerCompany(
  displayName: string,
  aliases: readonly string[] = [],
): Promise<RegisterCompanyResult | null> {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (name === '') return null;
  const normalizedName = normalizeCompanyName(name);
  if (normalizedName === '') return null;

  try {
    const admin = getCareerServiceRoleSupabaseClient();

    const existing = await findExactByNormalizedName(admin, normalizedName);
    if (existing) {
      return {
        companyId: existing.company_id,
        displayName:
          typeof existing.display_name === 'string' && existing.display_name !== ''
            ? existing.display_name
            : name,
        created: false,
      };
    }

    const companyId = `cmp_${crypto.randomUUID()}`;
    const { error } = await admin.from(MASTER).insert({
      company_id: companyId,
      display_name: name,
      normalized_name: normalizedName,
    });
    if (error) {
      // 競合（同時登録）は既存を引き直して返す。二重作成しない。
      const retry = await findExactByNormalizedName(admin, normalizedName);
      if (retry) {
        return {
          companyId: retry.company_id,
          displayName:
            typeof retry.display_name === 'string' && retry.display_name !== ''
              ? retry.display_name
              : name,
          created: false,
        };
      }
      devWarn('[companyIdentity] insert error', error);
      return null;
    }

    const aliasRows = Array.from(
      new Map(
        aliases
          .filter((a): a is string => typeof a === 'string' && a.trim() !== '')
          .map((a) => [normalizeCompanyName(a), a.trim()] as const)
          .filter(([norm]) => norm !== '' && norm !== normalizedName),
      ),
    ).map(([norm, alias]) => ({
      company_id: companyId,
      alias,
      normalized_alias: norm,
      alias_kind: 'alias',
    }));
    if (aliasRows.length > 0) {
      const { error: aliasError } = await admin.from(ALIASES).insert(aliasRows);
      // alias は補助情報。失敗しても企業登録自体は成立させる。
      if (aliasError) devWarn('[companyIdentity] alias insert error', aliasError);
    }

    return { companyId, displayName: name, created: true };
  } catch (err) {
    devWarn('[companyIdentity] register threw', err);
    return null;
  }
}
