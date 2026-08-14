// PASSAI CAREER — Personal Memory server read path（P17-M1 → NEXT-3 / NEXT-4 で server-verified freshness 化）。
//
// 責務: prompt 用に owner-scoped で Personal Memory section を取得する server 経路。
//   auth（server 検証済み userId）→ read gate（master + canary）→ 永続 row select →
//   **Layer 1 Source を server から読んで expected revision を再算出**（NEXT-3）→ fresh のみ採用、
//   stale/missing は **request-local rebuild**（NEXT-4）→ prompt 可能な section を返す。
//   どの失敗でも AI route を壊さない **fail-open**（Memory 無しで従来 prompt）。
//
// 厳守（安全境界）:
//   - server-only（`import 'server-only'`）。browser bundle へ入れない。
//   - user ID は **必ず server auth（auth.getUser）から取得**。request body の userId を信用しない。
//     RLS（auth.uid()=user_id）が最終権威。service role を使わない（D-L7）。
//   - master flag OFF / gate deny / no-config / unauthenticated / table missing / network error /
//     invalid row のどの場合も **throw しない**（typed outcome）。retry しない。
//   - Memory 本文 / user 内容 / UUID / env 値を log しない。global / cross-user cache を持たない。
//   - 既存 readAdapter / validate / schema / rebuild を再利用（別系統の repository を重複実装しない）。
//   - Layer 3 Career Event / Event Signal は本経路に一切入らない（D-L3 の禁止辺）。
//
// ★ freshness の権威（NEXT-3 / D-R1 退役 → D-R2 closure）:
//   2 段階で検証する。**両方**通った section だけが prompt へ載る。
//     (1) sync 検証: client が申告した canonical revision == server が mirror から再算出した revision。
//         first-party client flow では、これは「server が見ている Layer 1 と、リクエスト端末が
//         申告した canonical に矛盾が無い」ことの検証である（client-provided claim であり
//         cryptographic proof ではない — signal.ts の trust model 参照）。
//         未提示 / 不一致 / 読取失敗はすべて veto（＝Memory 無しで続行）。
//     (2) memory 検証: 永続 row の source_revision == 検証済み Source からの projection revision。
//         不一致なら同じ検証済み Source から request-local rebuild する。
//   ★ D-R1（永続 status='fresh' を無検証で信じる旧挙動）へ戻す production 経路は **存在しない**
//     （2026-08-14 hardening / `D-S2` で削除）。安全な rollback は master flag を外して
//     Personal Memory 読取自体を止める（＝context を減らす）方向のみ。
//
// ★ rebuild（NEXT-4）:
//   stale / missing / invalid の section は、同じ Layer 1 Source から決定的に rebuild して
//   **その request 限りで** 使う。DB へは書き戻さない（second writer を作らない。write-back は H-3）。

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
import {
  projectSectionFromSource,
  sourceKindsForSections,
  SECTION_SOURCE_KINDS,
} from './sourceProjection';
import { loadPersonalMemoryServerSourceConfigFromEnv } from './serverSourceFlagConfig.server';
import type { PersonalMemoryServerSourceConfig } from './serverSourceFlag';
import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import { loadRequestSourceSnapshot } from '@/lib/careerSourceData/requestSnapshot.server';
import type {
  CareerSourceBundle,
  CareerSourceKind,
  CareerSourceReadOutcome,
} from '@/lib/careerSourceData/types';
// D-R2 closure: client canonical と mirror の一致検証（veto model・client 申告ベース）。
import { computeSourceSyncRevisions } from '@/lib/careerSourceSync/revision';
import {
  allSourcesVerified,
  summarizeVetoReason,
  verifySourceSync,
  EMPTY_SOURCE_SYNC_SIGNAL,
  type CareerSourceSyncSignal,
  type SourceSyncVerdict,
  type SourceSyncVerification,
} from '@/lib/careerSourceSync/signal';

// table / select columns は DDL・repository.ts（'use client'）と一致させる（server から client module を import
//   しないため定数のみローカル宣言。値の drift は read-contract QA が parity assert する）。
const CAREER_PERSONAL_MEMORY_TABLE = 'career_personal_memory';
const SELECT_COLS =
  'section_key,schema_version,source_revision,source_updated_at,generated_at,status,payload';
// 防御的 row 上限（MVP 4 section だが UNIQUE(user_id,section_key) 前提で少数）。
const MAX_ROWS = 8;

export type PersonalMemoryReadGateStatus = 'disabled' | 'denied' | 'allowed';
export type PersonalMemoryReadStatus = 'skipped' | 'ok' | 'empty' | 'error';
// section が prompt へ載った経路（観測用）。
//   persisted: 永続 row が sync 検証済み Source の revision と一致した。
//   rebuilt  : 永続 row が stale/missing/invalid だったため検証済み Source から request-local に再構築。
export type PersonalMemorySectionOrigin = 'persisted' | 'rebuilt';

// 観測用の安全 metadata のみ（Memory 本文 / UUID / env を含めない）。
export type PersonalMemoryReadMetaSafe = {
  gate: PersonalMemoryReadGateStatus;
  read: PersonalMemoryReadStatus;
  sectionCount: number;
  readDurationMs: number | null;
  // NEXT-3: server 側 Layer 1 read の結果（'skipped' は D-R1 互換モード or 対象 Source なし）。
  sourceRead: CareerSourceReadOutcome['meta']['outcome'] | 'skipped';
  // NEXT-3/4: section 別の採用経路（section_key → origin）。
  origins: Readonly<Partial<Record<CareerPersonalMemorySectionKey, PersonalMemorySectionOrigin>>>;
  // D-R2: section 別の veto 理由（unreadable / unclaimed / mismatch）。PII を含まない enum のみ。
  vetoed: Readonly<Partial<Record<CareerPersonalMemorySectionKey, Exclude<SourceSyncVerdict, 'verified'>>>>;
};

export type PersonalMemoryReadOutcome = {
  sections: CareerPersonalMemorySection[];
  meta: PersonalMemoryReadMetaSafe;
};

// server reader（1 client を auth と select で共有）。QA では fake を注入する。
export type PersonalMemoryServerReader = {
  getUserId: () => Promise<string | null>;
  selectSections: (
    userId: string,
    sectionKeys: readonly CareerPersonalMemorySectionKey[],
  ) => Promise<{ rows: unknown[] | null; error: unknown }>;
};

export type PersonalMemoryReadServerDeps = {
  isEnabled: () => boolean;
  loadGateConfig: () => PersonalMemoryReadGateConfig;
  // NEXT-3: server-side freshness / rebuild の flag。
  loadSourceConfig: () => PersonalMemoryServerSourceConfig;
  // client を 1 回生成して reader を返す（env 未設定 / 生成失敗は null）。
  createReader: () => Promise<PersonalMemoryServerReader | null>;
  // NEXT-3: Layer 1 Source の owner-scoped server read（既定は careerSourceData の実 reader）。
  /** `req` は request-local snapshot の key（`D-S13`）。重複 Layer 1 read を避ける。 */
  loadSources: (
    kinds: readonly CareerSourceKind[],
    req?: Request,
  ) => Promise<CareerSourceReadOutcome>;
  // 観測用の経過時間計測（DI 可能・テストは固定値）。
  now: () => number;
};

function outcome(
  sections: CareerPersonalMemorySection[],
  gate: PersonalMemoryReadGateStatus,
  read: PersonalMemoryReadStatus,
  readDurationMs: number | null,
  sourceRead: PersonalMemoryReadMetaSafe['sourceRead'] = 'skipped',
  origins: PersonalMemoryReadMetaSafe['origins'] = {},
  vetoed: PersonalMemoryReadMetaSafe['vetoed'] = {},
): PersonalMemoryReadOutcome {
  return {
    sections,
    meta: {
      gate,
      read,
      sectionCount: sections.length,
      readDurationMs,
      sourceRead,
      origins,
      vetoed,
    },
  };
}

// raw rows を section_key で引ける map にする（重複は最初のみ・防御的に上限を掛ける）。
function indexRows(rows: unknown[] | null): Map<string, unknown> {
  const bySection = new Map<string, unknown>();
  if (!Array.isArray(rows)) return bySection;
  for (const raw of rows.slice(0, MAX_ROWS)) {
    if (!raw || typeof raw !== 'object') continue;
    const key = (raw as { section_key?: unknown }).section_key;
    if (typeof key !== 'string' || bySection.has(key)) continue;
    bySection.set(key, raw);
  }
  return bySection;
}

/**
 * NEXT-3/4 + D-R2 closure: **client canonical と server mirror の一致を検証できた section のみ** 採用し、
 * stale/missing は同じ（検証済みの）Source から request-local rebuild する。
 *
 * ★ D-R2 を閉じる判定順序（安全側から順に落とす）:
 *   1. sync verdict: 由来 Source すべてが `verified`（client 提示 revision == server 再算出 revision）か。
 *      `unreadable`（read 失敗 / truncated）・`unclaimed`（signal 未提示）・`mismatch`（乖離）はすべて **不採用**。
 *      → これにより「localStorage が新しく mirror が古い」「削除が mirror へ未反映」のケースで
 *        古い Memory / 古い mirror content が prompt へ載ることが **構造的に起きない**。
 *   2. expected = projectSectionFromSource(...).sourceRevision（＝検証済み Source からの決定的 projection）。
 *   3. 永続 row が expected と一致し validation を通れば採用（origin='persisted'）。
 *   4. 一致しない / 行が無い / invalid なら、**同じ検証済み Source** から作った payload を採用（origin='rebuilt'）。
 *      この rebuild は client canonical と一致することを 1 で検証済みなので downgrade にならない。
 *      rebuild が無効なら採用しない。
 *
 * ★ fail-open の意味: 「古い Personal Memory を使う」ではなく「**Personal Memory 無しで続行**」。
 */
function resolveServerDerivedSections(
  bySection: Map<string, unknown>,
  sectionKeys: readonly CareerPersonalMemorySectionKey[],
  sourceOutcome: CareerSourceReadOutcome,
  rebuildEnabled: boolean,
  verification: SourceSyncVerification,
): {
  sections: CareerPersonalMemorySection[];
  origins: Partial<Record<CareerPersonalMemorySectionKey, PersonalMemorySectionOrigin>>;
  vetoed: Partial<Record<CareerPersonalMemorySectionKey, Exclude<SourceSyncVerdict, 'verified'>>>;
} {
  const sections: CareerPersonalMemorySection[] = [];
  const origins: Partial<Record<CareerPersonalMemorySectionKey, PersonalMemorySectionOrigin>> = {};
  const vetoed: Partial<Record<CareerPersonalMemorySectionKey, Exclude<SourceSyncVerdict, 'verified'>>> = {};
  const bundle: CareerSourceBundle = sourceOutcome.bundle;

  for (const key of sectionKeys) {
    // 1) 由来 Source すべてが client canonical と一致することを検証できたか（D-S1 veto）。
    //    `verified` 以外は理由を問わずここで落とす（検証不能を fresh に落とさない）。
    const kinds = SECTION_SOURCE_KINDS[key] ?? [];
    if (!allSourcesVerified(verification, kinds)) {
      const reason = summarizeVetoReason(verification, kinds);
      if (reason) vetoed[key] = reason;
      continue;
    }

    // 2) Layer 1 からの決定的 projection（＝expected）。
    const projected = projectSectionFromSource(key, bundle);
    if (!projected) continue;

    // 3) 永続 row が expected と一致するか（readAdapter が payload/schema/status も検証）。
    const raw = bySection.get(key) ?? null;
    const res = readPersonalMemorySection(key, raw, {
      sourceRevision: projected.sourceRevision,
      sourceUpdatedAt: projected.sourceUpdatedAt,
    });
    if (res.usableForPrompt) {
      sections.push(res.section);
      origins[key] = 'persisted';
      continue;
    }

    // 4) stale / missing / invalid → request-local rebuild（DB へは書き戻さない）。
    if (!rebuildEnabled) continue;
    sections.push(projected.section);
    origins[key] = 'rebuilt';
  }
  return { sections, origins, vetoed };
}

// 実依存: career server client（anon + cookie/token・RLS 権威）で auth と owner-scoped select を行う。
const realDeps: PersonalMemoryReadServerDeps = {
  isEnabled: isPersonalMemoryReadEnabled,
  loadGateConfig: loadPersonalMemoryReadGateConfigFromEnv,
  loadSourceConfig: loadPersonalMemoryServerSourceConfigFromEnv,
  loadSources: (kinds, req) => loadRequestSourceSnapshot(kinds, req),
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
      async selectSections(userId, sectionKeys) {
        try {
          // ★ NEXT-3: status で絞らない。freshness は server 再算出 revision で判定するため、
          //   stale/failed 行も読んで「stale と判定して rebuild へ回す」。
          const { data, error } = await client
            .from(CAREER_PERSONAL_MEMORY_TABLE)
            .select(SELECT_COLS)
            .eq('user_id', userId)
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
 * purpose に必要な Personal Memory section を owner-scoped で読み、prompt 可能な section のみ返す
 * （fail-open・never-throw）。master OFF / 対象外 purpose / gate deny では **DB read も client 生成もしない**。
 */
export async function loadPersonalMemorySectionsForPrompt(
  purpose: CareerContextPurpose,
  /**
   * D-R2: route が request header から parse した client canonical revision（veto 専用）。
   * 未指定 = claim なし ⇒ 全 section veto（Memory 無しで従来 prompt）。**安全側の既定**。
   */
  syncSignal: CareerSourceSyncSignal = EMPTY_SOURCE_SYNC_SIGNAL,
  deps: PersonalMemoryReadServerDeps = realDeps,
  /**
   * `D-S13`: request-local Layer 1 snapshot の key。同じ request で Server Context resolver が
   * 既に読んだ kind を **再 read しない**ために渡す。未指定なら従来どおり単独 read。
   */
  req?: Request,
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

    const sourceConfig = deps.loadSourceConfig();
    const started = deps.now();

    // 永続 Memory と Layer 1 Source を並列に読む（片方の失敗は他方を巻き込まない）。
    //   ★ Source read は **常に** 行う。これを飛ばす経路（旧 D-R1）は存在しない。
    const [memoryRes, sourceOutcome] = await Promise.all([
      reader.selectSections(userId, sectionKeys),
      deps.loadSources(sourceKindsForSections(sectionKeys), req),
    ]);
    const durationMs = deps.now() - started;

    const sourceRead = sourceOutcome.meta.outcome;

    // 永続 read 自体が失敗しても、Source が読めていれば rebuild で救える（fail-open の質を上げる）。
    const bySection = memoryRes.error ? new Map<string, unknown>() : indexRows(memoryRes.rows);

    // client canonical revision と server 再算出 revision を照合（veto 専用）。
    //   server 側 revision は **読めた mirror から** 算出する。client 値は selector にも
    //   content の権威にも使わない（signal.ts の trust model 参照）。
    const verification = verifySourceSync(
      syncSignal,
      computeSourceSyncRevisions(sourceOutcome.bundle, sourceKindsForSections(sectionKeys)),
      sourceOutcome.meta.statuses,
    );
    const resolved = resolveServerDerivedSections(
      bySection,
      sectionKeys,
      sourceOutcome,
      sourceConfig.rebuildOnStaleEnabled,
      verification,
    );

    if (resolved.sections.length === 0 && memoryRes.error && sourceRead !== 'ok') {
      return outcome([], 'allowed', 'error', durationMs, sourceRead, {}, resolved.vetoed);
    }
    return outcome(
      resolved.sections,
      'allowed',
      resolved.sections.length > 0 ? 'ok' : 'empty',
      durationMs,
      sourceRead,
      resolved.origins,
      resolved.vetoed,
    );
  } catch {
    // never-throw boundary: 何が起きても Memory 無しで従来 prompt を維持する。
    return outcome([], 'disabled', 'skipped', null);
  }
}
