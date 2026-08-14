// PASSAI CAREER — Personal Memory invalidation on Source reset/delete（NEXT-5 / Data Spine）。
//
// 責務: Layer 1 Source が **リセット / 削除** されたとき、その Source を由来とする Layer 2 section が
//   「黙って使える状態のまま残らない」ようにする。
//
// 二重の防御:
//   1) server 側（NEXT-3）: server 再算出 revision が変わるため、古い section は自動的に stale 判定になり
//      prompt へ載らない。これが correctness の主権威。
//   2) client 側（本 module）: reset を実行した端末が **永続 row を実際に消す**。cross-device / legacy 経路 /
//      将来の別 consumer でも古い payload が残らないようにする（best-effort・冪等）。
//
// 厳守:
//   - 判定は純関数（sectionsAffectedBySourceReset）。I/O は既存 repository の deleteSection のみ再利用する
//     （新しい writer / 別 store を作らない）。
//   - never-throw / best-effort。UI・Source 保存の成功条件にしない。
//   - service role を使わない。userId は session 由来のみ（RLS が最終権威）。
//   - Event Log / Event Signal を触らない・記録しない（D-L3）。

'use client';

import type { CareerSourceKind } from '@/lib/careerSourceData/types';
import { SECTION_SOURCE_KINDS } from './sourceProjection';
import {
  CAREER_PERSONAL_MEMORY_SECTION_KEYS,
  type CareerPersonalMemorySectionKey,
} from './schema';
import {
  createSupabasePersonalMemoryStore,
  type PersonalMemoryStore,
} from './repository';
import { resolveCareerSession } from '@/lib/careerSupabase/auth';
import { getCareerBrowserSupabaseClient } from '@/lib/careerSupabase/browserClient';
import {
  deleteCareerSourceMirrors,
  type MirrorDeleteReport,
} from '@/lib/careerSourceData/mirrorDelete';

/**
 * reset/delete された Source 集合から、無効化すべき Layer 2 section を導く（純関数）。
 * ★ 由来 Source を **1 つでも** 失った section は無効化対象（部分的に古い payload を残さない）。
 */
export function sectionsAffectedBySourceReset(
  resetKinds: readonly CareerSourceKind[],
): CareerPersonalMemorySectionKey[] {
  const reset = new Set<CareerSourceKind>(resetKinds);
  if (reset.size === 0) return [];
  return CAREER_PERSONAL_MEMORY_SECTION_KEYS.filter((section) =>
    (SECTION_SOURCE_KINDS[section] ?? []).some((kind) => reset.has(kind)),
  );
}

export type PersonalMemoryInvalidationOutcome =
  | { status: 'skipped'; reason: 'no_sections' | 'guest' | 'no_client' }
  | { status: 'done'; invalidated: CareerPersonalMemorySectionKey[]; failed: CareerPersonalMemorySectionKey[] };

export type InvalidationSession =
  | { kind: 'member'; userId: string }
  | { kind: 'guest' }
  | { kind: 'no-env' };

export type PersonalMemoryInvalidationDeps = {
  resolveSession: () => Promise<InvalidationSession>;
  createStore: () => PersonalMemoryStore | null;
};

export const realInvalidationDeps: PersonalMemoryInvalidationDeps = {
  resolveSession: async (): Promise<InvalidationSession> => {
    const s = await resolveCareerSession();
    if (s.kind === 'member') return { kind: 'member', userId: s.userId };
    if (s.kind === 'no-env') return { kind: 'no-env' };
    return { kind: 'guest' };
  },
  createStore: (): PersonalMemoryStore | null => {
    const client = getCareerBrowserSupabaseClient();
    return client ? createSupabasePersonalMemoryStore(client) : null;
  },
};

/**
 * Source reset/delete に応じて owner の Personal Memory section を削除する（never-throw・冪等）。
 *
 * ★ 「stale へ更新」ではなく **削除** を選ぶ理由:
 *   - 行が消えれば read 側は missing になり、Layer 1 から rebuild される（NEXT-4）。
 *   - status 更新は payload を残すため、legacy 経路や将来の別 consumer から見えてしまう余地が残る。
 *   - 削除は冪等で、部分失敗しても server 側 revision 判定が safety net として機能する。
 *
 * flag には依存しない（shadow-write が OFF でも、既に書かれた古い row は消す必要がある）。
 */
export async function invalidatePersonalMemoryForSourceReset(
  resetKinds: readonly CareerSourceKind[],
  deps: PersonalMemoryInvalidationDeps = realInvalidationDeps,
): Promise<PersonalMemoryInvalidationOutcome> {
  try {
    const sections = sectionsAffectedBySourceReset(resetKinds);
    if (sections.length === 0) return { status: 'skipped', reason: 'no_sections' };

    const session = await deps.resolveSession();
    if (session.kind !== 'member') return { status: 'skipped', reason: 'guest' };

    const store = deps.createStore();
    if (!store) return { status: 'skipped', reason: 'no_client' };

    const invalidated: CareerPersonalMemorySectionKey[] = [];
    const failed: CareerPersonalMemorySectionKey[] = [];
    for (const section of sections) {
      try {
        const res = await store.deleteSection(session.userId, section);
        if (res.error) failed.push(section);
        else invalidated.push(section);
      } catch {
        failed.push(section);
      }
    }
    return { status: 'done', invalidated, failed };
  } catch {
    // never-throw: reset 操作そのものを壊さない。
    return { status: 'skipped', reason: 'no_client' };
  }
}


// ── Source reset coordinator（D-R2 closure / §9 reset semantics） ─────────────

export type CareerSourceResetReport = {
  /** Layer 1 mirror 削除の結果（失敗は握りつぶさず返す）。 */
  mirror: MirrorDeleteReport;
  /** Layer 2 Personal Memory 無効化の結果。 */
  memory: PersonalMemoryInvalidationOutcome;
  /**
   * 呼び出し側（UI）が「完全に消えた」と表示してよいか。
   * false の場合は **silent success にしてはいけない**（再試行 or 明示的な警告が必要）。
   *
   * ★ ただし false でも AI が古いデータを見ることはない:
   *   source-sync veto により client canonical（空）と mirror（残存）が不一致になり、
   *   Personal Memory / server context は使用されない（QA T3 が固定）。
   */
  fullyPropagated: boolean;
};

export type CareerSourceResetDeps = PersonalMemoryInvalidationDeps & {
  deleteMirrors: (
    userId: string | null,
    kinds: readonly CareerSourceKind[],
  ) => Promise<MirrorDeleteReport>;
};

export const realSourceResetDeps: CareerSourceResetDeps = {
  ...realInvalidationDeps,
  deleteMirrors: (userId, kinds) => deleteCareerSourceMirrors(userId, kinds),
};

/**
 * Source reset/delete の後始末を 1 箇所に集約する（never-throw）。
 *
 * 順序:
 *   1. Layer 1 mirror を owner-scoped で削除（失敗は report に残す。**握りつぶさない**）。
 *   2. Layer 2 Personal Memory の該当 section 行を削除。
 *
 * ★ 将来 reset UI を追加するときは **必ず本関数を通す** こと。
 *   localStorage を消すだけの実装にすると、mirror にゴミが残り
 *   （read 安全性は veto が守るが）ストレージ衛生とユーザー期待が壊れる。
 */
export async function resetCareerSourceData(
  resetKinds: readonly CareerSourceKind[],
  deps: CareerSourceResetDeps = realSourceResetDeps,
): Promise<CareerSourceResetReport> {
  const emptyMirror: MirrorDeleteReport = { outcomes: [], hasFailure: false };
  try {
    const session = await deps.resolveSession();
    const userId = session.kind === 'member' ? session.userId : null;
    const mirror = resetKinds.length > 0
      ? await deps.deleteMirrors(userId, resetKinds)
      : emptyMirror;
    const memory = await invalidatePersonalMemoryForSourceReset(resetKinds, deps);
    const memoryOk = memory.status === 'done' ? memory.failed.length === 0 : memory.status === 'skipped';
    return { mirror, memory, fullyPropagated: !mirror.hasFailure && memoryOk };
  } catch {
    // never-throw: reset 操作そのものを壊さない。ただし「完全反映」とは報告しない。
    return {
      mirror: emptyMirror,
      memory: { status: 'skipped', reason: 'no_client' },
      fullyPropagated: false,
    };
  }
}
