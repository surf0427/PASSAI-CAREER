// PASSAI CAREER — Personal Memory server read path（P17-M1 / Data Spine Layer 2 read pilot）。
//
// 責務: prompt 用に owner-scoped で Personal Memory section を **1 リクエスト 1 read** で取得する server 経路。
//   auth（server 検証済み userId）→ read gate（master + canary）→ 1 DB select（status=fresh）→ readAdapter で
//   validation → fresh section のみ返す。**fail-open**（どの失敗でも AI route を壊さず、Memory 無しで従来 prompt）。
//
// 厳守（本タスクの安全境界）:
//   - server-only（`import 'server-only'`）。browser bundle へ入れない。
//   - user ID は **必ず server auth（getCareerServerSupabaseClient().auth.getUser）から取得**。request body の
//     userId を信用しない・受け取らない。RLS（auth.uid()=user_id）が最終権威。service role を使わない。
//   - master flag OFF / gate deny / no-config / unauthenticated / table missing / network error / invalid row の
//     どの場合も **throw しない**（typed outcome）。retry しない。
//   - Memory 本文 / user 内容 / UUID / env 値を log しない。global / cross-user cache を持たない（毎回 request scope）。
//   - 既存 readAdapter / validate / schema を再利用（別系統の repository を重複実装しない）。fetch 結果の validation は
//     readAdapter（純関数）に委譲する（本層は fetch と合成のみ）。
//   - freshness の権威: 本 canary では DB 永続 status='fresh' を採用（server は全 Source 履歴を持たず端末側
//     expected revision を再算出できないため）。read pilot で prompt parity を観測してから rollout する。

import 'server-only';

import type { CareerContextPurpose } from '@/lib/careerContext/purpose';
import { personalMemorySectionsForPurpose } from '@/lib/careerMemory/personalMemoryPromptContext';
import type {
  CareerPersonalMemorySection,
  CareerPersonalMemorySectionKey,
} from './schema';
import { readPersonalMemorySection } from './readAdapter';
import {
  evaluatePersonalMemoryReadGate,
  type PersonalMemoryReadGateConfig,
} from './readGate';
import {
  isPersonalMemoryReadEnabled,
  loadPersonalMemoryReadGateConfigFromEnv,
} from './readGateConfig.server';
import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';

// table / select columns は DDL・repository.ts（'use client'）と一致させる（server から client module を import
//   しないため定数のみローカル宣言。値の drift は read-contract QA が parity assert する）。
const CAREER_PERSONAL_MEMORY_TABLE = 'career_personal_memory';
const SELECT_COLS =
  'section_key,schema_version,source_revision,source_updated_at,generated_at,status,payload';
// 防御的 row 上限（MVP 4 section だが UNIQUE(user_id,section_key) 前提で少数）。
const MAX_ROWS = 8;

export type PersonalMemoryReadGateStatus = 'disabled' | 'denied' | 'allowed';
export type PersonalMemoryReadStatus = 'skipped' | 'ok' | 'empty' | 'error';

// 観測用の安全 metadata のみ（Memory 本文 / UUID / env を含めない）。
export type PersonalMemoryReadMetaSafe = {
  gate: PersonalMemoryReadGateStatus;
  read: PersonalMemoryReadStatus;
  sectionCount: number;
  readDurationMs: number | null;
};

export type PersonalMemoryReadOutcome = {
  sections: CareerPersonalMemorySection[];
  meta: PersonalMemoryReadMetaSafe;
};

// server reader（1 client を auth と select で共有）。QA では fake を注入する。
export type PersonalMemoryServerReader = {
  getUserId: () => Promise<string | null>;
  selectFresh: (
    userId: string,
    sectionKeys: readonly CareerPersonalMemorySectionKey[],
  ) => Promise<{ rows: unknown[] | null; error: unknown }>;
};

export type PersonalMemoryReadServerDeps = {
  isEnabled: () => boolean;
  loadGateConfig: () => PersonalMemoryReadGateConfig;
  // client を 1 回生成して reader を返す（env 未設定 / 生成失敗は null）。
  createReader: () => Promise<PersonalMemoryServerReader | null>;
  // 観測用の経過時間計測（DI 可能・テストは固定値）。
  now: () => number;
};

function outcome(
  sections: CareerPersonalMemorySection[],
  gate: PersonalMemoryReadGateStatus,
  read: PersonalMemoryReadStatus,
  readDurationMs: number | null,
): PersonalMemoryReadOutcome {
  return { sections, meta: { gate, read, sectionCount: sections.length, readDurationMs } };
}

// 取得済み raw rows を readAdapter で検証し、fresh（usableForPrompt）な section のみ返す（純粋・never-throw）。
//   expected revision = 行自身の source_revision（DB 永続 status=fresh を freshness 権威にする canary 方針）。
//   readAdapter が payload / schema / section_key / status を検証し、invalid row を prompt から除外する。
function validateFreshRows(
  rows: unknown[] | null,
  sectionKeys: readonly CareerPersonalMemorySectionKey[],
): CareerPersonalMemorySection[] {
  if (!Array.isArray(rows)) return [];
  const wanted = new Set<string>(sectionKeys);
  const seen = new Set<string>();
  const out: CareerPersonalMemorySection[] = [];
  for (const raw of rows.slice(0, MAX_ROWS)) {
    if (!raw || typeof raw !== 'object') continue;
    const key = (raw as { section_key?: unknown }).section_key;
    if (typeof key !== 'string' || !wanted.has(key) || seen.has(key)) continue;
    const revision = (raw as { source_revision?: unknown }).source_revision;
    const updatedAt = (raw as { source_updated_at?: unknown }).source_updated_at;
    const res = readPersonalMemorySection(key as CareerPersonalMemorySectionKey, raw, {
      sourceRevision: typeof revision === 'string' ? revision : '',
      sourceUpdatedAt: typeof updatedAt === 'string' ? updatedAt : null,
    });
    if (res.usableForPrompt) {
      seen.add(key);
      out.push(res.section);
    }
  }
  return out;
}

// 実依存: career server client（anon + cookie/token・RLS 権威）で auth と owner-scoped select を行う。
const realDeps: PersonalMemoryReadServerDeps = {
  isEnabled: isPersonalMemoryReadEnabled,
  loadGateConfig: loadPersonalMemoryReadGateConfigFromEnv,
  now: () => Date.now(),
  createReader: async () => {
    const client = await getCareerServerSupabaseClient();
    if (!client) return null;
    return {
      async getUserId() {
        try {
          const { data, error } = await client.auth.getUser();
          if (error || !data?.user) return null;
          if (data.user.is_anonymous) return null; // member（非 anonymous）のみ
          return data.user.id;
        } catch {
          return null;
        }
      },
      async selectFresh(userId, sectionKeys) {
        try {
          const { data, error } = await client
            .from(CAREER_PERSONAL_MEMORY_TABLE)
            .select(SELECT_COLS)
            .eq('user_id', userId)
            .eq('status', 'fresh')
            .in('section_key', [...sectionKeys])
            .limit(MAX_ROWS);
          return { rows: (data as unknown[] | null) ?? null, error };
        } catch (error) {
          return { rows: null, error };
        }
      },
    };
  },
};

/**
 * purpose に必要な Personal Memory section を owner-scoped で読み、fresh section のみ返す（fail-open・never-throw）。
 * 追加 DB read は最大 1 回（select）。master OFF / 対象外 purpose / gate deny では **DB read も client 生成もしない**。
 */
export async function loadPersonalMemorySectionsForPrompt(
  purpose: CareerContextPurpose,
  deps: PersonalMemoryReadServerDeps = realDeps,
): Promise<PersonalMemoryReadOutcome> {
  try {
    const sectionKeys = personalMemorySectionsForPurpose(purpose);
    // 対象外 purpose → I/O ゼロ。
    if (sectionKeys.length === 0) return outcome([], 'disabled', 'skipped', null);
    // master flag OFF → 追加 I/O ゼロ（client も作らない）。
    if (!deps.isEnabled()) return outcome([], 'disabled', 'skipped', null);

    const reader = await deps.createReader();
    if (!reader) return outcome([], 'disabled', 'skipped', null); // no env / config

    const userId = await reader.getUserId();
    if (!userId) return outcome([], 'denied', 'skipped', null); // unauthenticated / anon

    const config = deps.loadGateConfig();
    if (!evaluatePersonalMemoryReadGate(userId, config)) {
      return outcome([], 'denied', 'skipped', null); // canary 対象外 → read しない
    }

    const started = deps.now();
    const { rows, error } = await reader.selectFresh(userId, sectionKeys);
    const durationMs = deps.now() - started;
    if (error) return outcome([], 'allowed', 'error', durationMs); // table missing / network 等 → fail-open

    const sections = validateFreshRows(rows, sectionKeys);
    return outcome(sections, 'allowed', sections.length > 0 ? 'ok' : 'empty', durationMs);
  } catch {
    // never-throw boundary: 何が起きても Memory 無しで従来 prompt を維持する。
    return outcome([], 'disabled', 'skipped', null);
  }
}
