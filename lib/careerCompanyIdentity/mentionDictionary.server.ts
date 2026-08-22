/**
 * Company Identity — 自由文照合用の企業名辞書の読み出し（server-only・never-throw）。
 *
 * 役割:
 *   Company Master / Alias に **既に存在する**名前だけを、文字列照合用の token 集合として返す。
 *   新規企業を作らない・外部を叩かない・AI を使わない（読むだけ）。
 *
 * ★ 読み方の設計（将来 master が増えても壊さないために）:
 *   - 自由文照合は「文中に辞書語があるか」を見る処理なので、原理的に辞書側を持つ必要がある。
 *     したがって **1 リクエスト 1 クエリではなく、プロセス内 TTL キャッシュ**で償却する。
 *   - 行数に上限（`MAX_DICTIONARY_COMPANIES`）を置き、超える規模になったら
 *     全件ロードを続けずに **索引化（trie / inverted index / DB 側 full-text）へ移行する**判断ができるよう、
 *     上限到達を警告として観測できる形にする（黙って切り詰めて誤検出を増やさない）。
 *   - 新しいキャッシュ基盤（Redis 等）は入れない。プロセス内 Map + TTL のみ。
 *
 * ★ read は service_role を使わない。company master / alias は非個人データだが、
 *   既存 read 経路（user-scoped client）と同じ権限で読む。
 */

import 'server-only';

import { CAREER_COMPANY_IDENTITY_TABLES } from '@/types/careerCompanyIdentity';
import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import { devWarn } from '@/lib/devLog';
import {
  buildMentionTokens,
  type CompanyMentionDictionaryEntry,
} from './mentionMatch';

const MASTER = CAREER_COMPANY_IDENTITY_TABLES.master;
const ALIASES = CAREER_COMPANY_IDENTITY_TABLES.aliases;

/**
 * 全件ロードを続けてよい企業数の上限。
 *
 * 現状の master は 2 桁で、辞書は数十 KB にしかならない。数千社規模までは
 * TTL キャッシュ付きの全件ロードで十分に安い。ここを超えたら設計を変える合図として扱う
 * （超えた分は読まず、`truncated` で観測できるようにする）。
 */
export const MAX_DICTIONARY_COMPANIES = 5000;

/** キャッシュの寿命（ms）。企業マスタは分単位で変わるものではない。 */
export const DICTIONARY_TTL_MS = 5 * 60 * 1000;

export type CompanyMentionDictionary = {
  entries: readonly CompanyMentionDictionaryEntry[];
  /** 上限に当たって読み切れなかったか（索引化へ移行する判断材料）。 */
  truncated: boolean;
  /** 観測用: このロードで実際に発行した DB クエリ数（キャッシュヒット時は 0）。 */
  queries: number;
};

const EMPTY: CompanyMentionDictionary = { entries: [], truncated: false, queries: 0 };

type CacheSlot = { value: CompanyMentionDictionary; expiresAt: number };
let cache: CacheSlot | null = null;

/** テスト / QA からキャッシュを捨てるための seam（production では呼ばない）。 */
export function resetCompanyMentionDictionaryCache(): void {
  cache = null;
}

type MasterRow = { company_id: unknown; display_name: unknown; normalized_name: unknown };
type AliasRow = { company_id: unknown; alias: unknown };

/**
 * 企業名辞書を読む（never-throw / fail-open）。
 *
 * 失敗・未設定・未 provision はすべて空辞書に倒れる（＝ 自由文からの企業検出が起きないだけで、
 * 相談は従来どおり成立する）。
 *
 * @param nowMs 現在時刻（TTL 判定用。QA から固定値を渡せるようにする）
 */
export async function loadCompanyMentionDictionary(
  nowMs: number = Date.now(),
): Promise<CompanyMentionDictionary> {
  if (cache && cache.expiresAt > nowMs) {
    return { ...cache.value, queries: 0 };
  }

  try {
    const client = await getCareerServerSupabaseClient();
    if (!client) return EMPTY;

    const { data: masterData, error: masterError } = await client
      .from(MASTER)
      .select('company_id, display_name, normalized_name')
      .limit(MAX_DICTIONARY_COMPANIES + 1);
    if (masterError) {
      devWarn('[companyMention] master read error');
      return EMPTY;
    }

    const masterRows = (masterData ?? []) as MasterRow[];
    const truncated = masterRows.length > MAX_DICTIONARY_COMPANIES;
    if (truncated) {
      devWarn('[companyMention] dictionary truncated; switch to an index');
    }
    const rows = truncated ? masterRows.slice(0, MAX_DICTIONARY_COMPANIES) : masterRows;
    if (rows.length === 0) {
      const value: CompanyMentionDictionary = { entries: [], truncated, queries: 1 };
      cache = { value, expiresAt: nowMs + DICTIONARY_TTL_MS };
      return value;
    }

    // alias は取れなくても致命ではない（別名なしとして扱う。既存 loadRecordsByIds と同方針）。
    const { data: aliasData, error: aliasError } = await client
      .from(ALIASES)
      .select('company_id, alias')
      .limit(MAX_DICTIONARY_COMPANIES * 4);
    const aliasesById = new Map<string, string[]>();
    if (!aliasError) {
      for (const raw of (aliasData ?? []) as AliasRow[]) {
        if (typeof raw?.company_id !== 'string' || typeof raw?.alias !== 'string') continue;
        const list = aliasesById.get(raw.company_id);
        if (list) list.push(raw.alias);
        else aliasesById.set(raw.company_id, [raw.alias]);
      }
    }

    const entries: CompanyMentionDictionaryEntry[] = [];
    for (const row of rows) {
      if (typeof row?.company_id !== 'string' || row.company_id === '') continue;
      const displayName = typeof row.display_name === 'string' ? row.display_name : '';
      const normalizedName = typeof row.normalized_name === 'string' ? row.normalized_name : '';
      const tokens = buildMentionTokens({
        displayName,
        normalizedName,
        aliases: aliasesById.get(row.company_id) ?? [],
      });
      if (tokens.length === 0) continue;
      entries.push({ companyId: row.company_id, displayName, tokens });
    }

    const value: CompanyMentionDictionary = {
      entries,
      truncated,
      queries: aliasError ? 1 : 2,
    };
    cache = { value, expiresAt: nowMs + DICTIONARY_TTL_MS };
    return value;
  } catch (err) {
    devWarn('[companyMention] dictionary load threw', err instanceof Error ? err.name : 'unknown');
    return EMPTY;
  }
}
