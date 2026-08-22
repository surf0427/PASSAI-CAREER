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
import {
  decideRegistration,
  selectAttachableAliases,
  type AliasOccupancy,
  type CompanyIdentityMatch,
} from './registration';
import { CAREER_COMPANY_IDENTITY_TABLES } from '@/types/careerCompanyIdentity';
import type { CompanyRegisterResult } from '@/types/careerCompanyIdentity';
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
 *
 * @param clientOverride 明示的に使う Supabase client（**request 文脈の外**から呼ぶ operator script 用）。
 *   既定（未指定）は従来どおり cookie ベースの user-scoped client で、app 側 caller の挙動は不変。
 *   `cookies()` は request 文脈が無いと throw するため、script からは service role client を渡す。
 */
export async function findCompanyCandidates(
  rawName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clientOverride?: any,
): Promise<CompanyMasterRecord[] | null> {
  const normalized = normalizeCompanyName(rawName);
  if (normalized === '') return [];

  try {
    const client = clientOverride ?? (await getCareerServerSupabaseClient());
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

/**
 * normalized token に **完全一致**する企業を集める（登録の重複防止の中核）。
 *
 * ★ Phase 1: `master.normalized_name` **だけでなく** `aliases.normalized_alias` も見る。
 *   これが無いと `任天堂`（既存）に対して `Nintendo` が別企業として作られる。
 *
 * 戻り値 null = 取得失敗（呼び出し側は「登録しない」へ倒す。重複を作るより何もしない方が安全）。
 */
async function findMatchesByNormalizedToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  token: string,
): Promise<CompanyIdentityMatch[] | null> {
  const [byName, byAlias] = await Promise.all([
    admin.from(MASTER).select('company_id, display_name').eq('normalized_name', token),
    admin.from(ALIASES).select('company_id').eq('normalized_alias', token),
  ]);

  if (byName.error) {
    devWarn('[companyIdentity] exact lookup error', byName.error);
    return null;
  }
  // ★ alias 側が引けなかったら「重複なし」と誤判定しうるため、失敗は失敗として扱う。
  if (byAlias.error) {
    devWarn('[companyIdentity] alias lookup error', byAlias.error);
    return null;
  }

  const matches = new Map<string, CompanyIdentityMatch>();
  for (const row of (byName.data ?? []) as Array<{
    company_id: string;
    display_name: string | null;
  }>) {
    if (typeof row?.company_id !== 'string') continue;
    matches.set(row.company_id, {
      companyId: row.company_id,
      displayName: typeof row.display_name === 'string' ? row.display_name : '',
    });
  }

  // alias 経由でだけ当たった企業は表示名を持たないので、まとめて引き直す。
  const aliasOnlyIds = Array.from(
    new Set(
      ((byAlias.data ?? []) as Array<{ company_id: string }>)
        .map((r) => r?.company_id)
        .filter((id): id is string => typeof id === 'string' && !matches.has(id)),
    ),
  );
  if (aliasOnlyIds.length > 0) {
    const { data, error } = await admin
      .from(MASTER)
      .select('company_id, display_name')
      .in('company_id', aliasOnlyIds);
    if (error) {
      devWarn('[companyIdentity] alias owner lookup error', error);
      return null;
    }
    for (const row of (data ?? []) as Array<{ company_id: string; display_name: string | null }>) {
      if (typeof row?.company_id !== 'string') continue;
      matches.set(row.company_id, {
        companyId: row.company_id,
        displayName: typeof row.display_name === 'string' ? row.display_name : '',
      });
    }
  }

  return Array.from(matches.values());
}

/**
 * 指定 token 群を既に占有している企業を引く（alias 保存前の衝突判定用）。
 *
 * master.normalized_name と aliases.normalized_alias の **両方**を見る。
 * 失敗時は null（呼び出し側は alias を保存しない＝安全側）。
 */
async function loadAliasOccupancy(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  tokens: readonly string[],
): Promise<AliasOccupancy | null> {
  if (tokens.length === 0) return new Map<string, string>();
  const list = tokens as string[];

  const [byName, byAlias] = await Promise.all([
    admin.from(MASTER).select('company_id, normalized_name').in('normalized_name', list),
    admin.from(ALIASES).select('company_id, normalized_alias').in('normalized_alias', list),
  ]);
  if (byName.error || byAlias.error) {
    devWarn('[companyIdentity] occupancy lookup error', byName.error ?? byAlias.error);
    return null;
  }

  const occupancy = new Map<string, string>();
  for (const row of (byName.data ?? []) as Array<{
    company_id: string;
    normalized_name: string | null;
  }>) {
    if (typeof row?.normalized_name === 'string' && typeof row.company_id === 'string') {
      if (!occupancy.has(row.normalized_name)) occupancy.set(row.normalized_name, row.company_id);
    }
  }
  for (const row of (byAlias.data ?? []) as Array<{
    company_id: string;
    normalized_alias: string | null;
  }>) {
    if (typeof row?.normalized_alias === 'string' && typeof row.company_id === 'string') {
      if (!occupancy.has(row.normalized_alias)) occupancy.set(row.normalized_alias, row.company_id);
    }
  }
  return occupancy;
}

/**
 * 別表記を company へ保存する（best-effort）。
 *
 * ★ 他社が占有している token は **黙って落とす**（奪わない・merge しない・登録自体は成功させる）。
 * ★ alias は補助情報なので、保存に失敗しても企業登録の成否には影響させない。
 */
async function attachAliases(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  companyId: string,
  ownNormalizedName: string,
  rawAliases: readonly string[],
): Promise<void> {
  if (!Array.isArray(rawAliases) || rawAliases.length === 0) return;

  // 衝突判定に使う token を先に作る（server 側で正規化。client 申告は使わない）。
  const tokens = Array.from(
    new Set(
      rawAliases
        .filter((a): a is string => typeof a === 'string')
        .map((a) => normalizeCompanyName(a))
        .filter((t) => t !== ''),
    ),
  );
  if (tokens.length === 0) return;

  const occupancy = await loadAliasOccupancy(admin, tokens);
  if (occupancy === null) return; // 判定できないなら保存しない（安全側）。

  const attachable = selectAttachableAliases({
    companyId,
    ownNormalizedName,
    rawAliases,
    occupancy,
  });
  if (attachable.length === 0) return;

  const { error } = await admin.from(ALIASES).insert(
    attachable.map((a) => ({
      company_id: companyId,
      alias: a.alias,
      normalized_alias: a.normalizedAlias,
      alias_kind: 'alias',
    })),
  );
  if (error) devWarn('[companyIdentity] alias insert error', error);
}

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
): Promise<CompanyRegisterResult | null> {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (name === '') return null;
  const normalizedName = normalizeCompanyName(name);
  if (normalizedName === '') return null;

  try {
    const admin = getCareerServiceRoleSupabaseClient();

    // ── 既存判定（★ alias 込み）───────────────────────────────────
    const matches = await findMatchesByNormalizedToken(admin, normalizedName);
    if (matches === null) return null; // 判定できない → 何もしない（重複を作らない）。

    const decision = decideRegistration(matches);

    // ★ 複数社に一致 → 確定しない。ユーザーへ候補を返す（自動 merge / 自動選択の禁止）。
    if (decision.kind === 'ambiguous') {
      return { status: 'ambiguous', candidates: decision.candidates };
    }

    // 既存企業に寄せる（新規作成しない）。入力された別表記は、衝突しなければ追加する。
    if (decision.kind === 'existing') {
      await attachAliases(admin, decision.companyId, normalizedName, aliases);
      return {
        status: 'registered',
        companyId: decision.companyId,
        displayName: decision.displayName !== '' ? decision.displayName : name,
        created: false,
      };
    }

    // ── 新規作成 ─────────────────────────────────────────────────
    const companyId = `cmp_${crypto.randomUUID()}`;
    const { error } = await admin.from(MASTER).insert({
      company_id: companyId,
      display_name: name,
      normalized_name: normalizedName,
    });
    if (error) {
      // 競合（同時登録）は既存を引き直して返す。★ 二重作成へは絶対に倒さない。
      const retry = await findMatchesByNormalizedToken(admin, normalizedName);
      if (retry !== null) {
        const retryDecision = decideRegistration(retry);
        if (retryDecision.kind === 'ambiguous') {
          return { status: 'ambiguous', candidates: retryDecision.candidates };
        }
        if (retryDecision.kind === 'existing') {
          return {
            status: 'registered',
            companyId: retryDecision.companyId,
            displayName: retryDecision.displayName !== '' ? retryDecision.displayName : name,
            created: false,
          };
        }
      }
      devWarn('[companyIdentity] insert error', error);
      return null;
    }

    await attachAliases(admin, companyId, normalizedName, aliases);
    return { status: 'registered', companyId, displayName: name, created: true };
  } catch (err) {
    devWarn('[companyIdentity] register threw', err);
    return null;
  }
}
