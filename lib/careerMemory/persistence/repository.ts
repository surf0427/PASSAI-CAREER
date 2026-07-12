// PASSAI CAREER — Personal Memory typed repository（P16-A Stage 2）。
//
// owner-scoped read / upsert / delete の抽象。RLS（auth.uid() = user_id）が owner 権限の最終権威で、
// 本層は既存 career mirror 規約（never-throw read / best-effort write / browser client null は no-op）に従う。
//
// 厳守:
//   - service role を使わない。raw SQL を使わない。
//   - 任意 userId をそのまま信用しない（RLS WITH CHECK が server 側で owner を強制。guest/no-env は skip）。
//   - Memory read 失敗で throw しない（AI 機能を止めない）。owner 検証失敗は fail-closed（他人行を返さない）。
//   - production callsite からはまだ呼ばない（scaffold）。
//
// テスト容易性のため、Supabase への依存は PersonalMemoryStore interface へ隔離する
//   （実装は createSupabasePersonalMemoryStore、テストは fake store を注入）。

'use client';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  validateCareerPersonalMemorySection,
  type ValidateReason,
} from './validate';
import type {
  CareerPersonalMemorySection,
  CareerPersonalMemorySectionKey,
} from './schema';

export const CAREER_PERSONAL_MEMORY_TABLE = 'career_personal_memory';

// read で受け取りうる行の最大数（MVP は 4 section だが防御的に上限を設ける）。
export const CAREER_PERSONAL_MEMORY_MAX_ROWS = 32;

// DB 行の raw 形（select して来る shape。検証前）。
export type CareerPersonalMemoryRawRow = {
  section_key: unknown;
  schema_version: unknown;
  source_revision: unknown;
  source_updated_at: unknown;
  generated_at: unknown;
  status: unknown;
  payload: unknown;
};

// upsert に渡す行（writer が組む。payload は validated section から）。
export type CareerPersonalMemoryUpsertRow = {
  user_id: string;
  section_key: CareerPersonalMemorySectionKey;
  schema_version: number;
  source_revision: string;
  source_updated_at: string | null;
  generated_at: string;
  status: 'fresh' | 'stale' | 'failed';
  payload: CareerPersonalMemorySection['payload'];
};

export type StoreSelectResult = { rows: CareerPersonalMemoryRawRow[] | null; error: unknown };
export type StoreWriteResult = { error: unknown };

// Supabase 依存を隔離する最小 interface（fake で差し替え可能）。
export interface PersonalMemoryStore {
  selectSections(userId: string, sectionKeys: string[]): Promise<StoreSelectResult>;
  upsertSection(row: CareerPersonalMemoryUpsertRow): Promise<StoreWriteResult>;
  deleteSection(userId: string, sectionKey: string): Promise<StoreWriteResult>;
}

// 実 Supabase client を PersonalMemoryStore へ包む（RLS が owner を担保）。
export function createSupabasePersonalMemoryStore(client: SupabaseClient): PersonalMemoryStore {
  const SELECT_COLS =
    'section_key,schema_version,source_revision,source_updated_at,generated_at,status,payload';
  return {
    async selectSections(userId, sectionKeys) {
      try {
        const { data, error } = await client
          .from(CAREER_PERSONAL_MEMORY_TABLE)
          .select(SELECT_COLS)
          .eq('user_id', userId)
          .in('section_key', sectionKeys)
          .limit(CAREER_PERSONAL_MEMORY_MAX_ROWS);
        return { rows: (data as CareerPersonalMemoryRawRow[] | null) ?? null, error };
      } catch (error) {
        return { rows: null, error };
      }
    },
    async upsertSection(row) {
      try {
        const { error } = await client
          .from(CAREER_PERSONAL_MEMORY_TABLE)
          .upsert(row, { onConflict: 'user_id,section_key' });
        return { error };
      } catch (error) {
        return { error };
      }
    },
    async deleteSection(userId, sectionKey) {
      try {
        const { error } = await client
          .from(CAREER_PERSONAL_MEMORY_TABLE)
          .delete()
          .eq('user_id', userId)
          .eq('section_key', sectionKey);
        return { error };
      } catch (error) {
        return { error };
      }
    },
  };
}

// ── read（never-throw・検証済みのみ返す） ────────────────────────────────
export type CareerPersonalMemoryReadRow = {
  sectionKey: CareerPersonalMemorySectionKey;
  schemaVersion: number;
  sourceRevision: string;
  sourceUpdatedAt: string | null;
  generatedAt: string;
  status: 'fresh' | 'stale' | 'failed';
  section: CareerPersonalMemorySection;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// owner の指定 section 行を読み、runtime validation を通過した行だけ返す。
//   store/userId が無ければ（no-env / guest）安全に空配列。error / malformed も空配列（never-throw）。
export async function readCareerPersonalMemorySections(
  store: PersonalMemoryStore | null,
  userId: string | null,
  sectionKeys: readonly CareerPersonalMemorySectionKey[],
): Promise<CareerPersonalMemoryReadRow[]> {
  if (!store || !userId || sectionKeys.length === 0) return [];
  let result: StoreSelectResult;
  try {
    result = await store.selectSections(userId, [...sectionKeys]);
  } catch {
    return [];
  }
  if (result.error || !Array.isArray(result.rows)) return [];

  const out: CareerPersonalMemoryReadRow[] = [];
  const seen = new Set<string>();
  for (const raw of result.rows.slice(0, CAREER_PERSONAL_MEMORY_MAX_ROWS)) {
    if (!raw || typeof raw !== 'object') continue;
    const v = validateCareerPersonalMemorySection(
      raw.section_key,
      raw.schema_version,
      raw.payload,
    );
    if (!v.ok) continue; // invalid / unsupported version / forbidden / unknown section は skip
    // duplicate section は最初の 1 件のみ採用（防御。UNIQUE 制約があるので通常発生しない）。
    if (seen.has(v.section.sectionKey)) continue;
    const status = raw.status;
    if (status !== 'fresh' && status !== 'stale' && status !== 'failed') continue;
    seen.add(v.section.sectionKey);
    out.push({
      sectionKey: v.section.sectionKey,
      schemaVersion: v.section.schemaVersion,
      sourceRevision: str(raw.source_revision),
      sourceUpdatedAt: typeof raw.source_updated_at === 'string' ? raw.source_updated_at : null,
      generatedAt: str(raw.generated_at),
      status,
      section: v.section,
    });
  }
  return out;
}

// ── write（best-effort・validated payload のみ） ────────────────────────
export type PersonalMemoryWriteOutcome =
  | { status: 'written' }
  | { status: 'skipped'; reason: 'guest' | 'no_store' }
  | { status: 'rejected'; reason: ValidateReason }
  | { status: 'failed'; reason: 'store_error' };

export type CareerPersonalMemoryWriteInput = {
  section: CareerPersonalMemorySection;
  sourceRevision: string;
  sourceUpdatedAt: string | null;
  generatedAt: string;
  status: 'fresh' | 'stale' | 'failed';
};

// 1 section を owner-scoped upsert（never-throw）。validation 不通過は rejected（書かない）。
export async function upsertCareerPersonalMemorySection(
  store: PersonalMemoryStore | null,
  userId: string | null,
  input: CareerPersonalMemoryWriteInput,
): Promise<PersonalMemoryWriteOutcome> {
  if (!store) return { status: 'skipped', reason: 'no_store' };
  if (!userId) return { status: 'skipped', reason: 'guest' };

  // 二重の安全弁: 書く直前に payload を再検証（arbitrary JSON / forbidden key を通さない）。
  const v = validateCareerPersonalMemorySection(
    input.section.sectionKey,
    input.section.schemaVersion,
    input.section.payload,
  );
  if (!v.ok) return { status: 'rejected', reason: v.reason };

  const row: CareerPersonalMemoryUpsertRow = {
    user_id: userId,
    section_key: v.section.sectionKey,
    schema_version: v.section.schemaVersion,
    source_revision: input.sourceRevision,
    source_updated_at: input.sourceUpdatedAt,
    generated_at: input.generatedAt,
    status: input.status,
    payload: v.section.payload,
  };
  let res: StoreWriteResult;
  try {
    res = await store.upsertSection(row);
  } catch {
    return { status: 'failed', reason: 'store_error' };
  }
  if (res.error) return { status: 'failed', reason: 'store_error' };
  return { status: 'written' };
}
