// PASSAI CAREER — Personal Memory deterministic shadow writer scaffold（P16-A Stage 3）。
//
// 責務: Source → section builder → revision → payload validation → 既存 revision と compare-and-set →
//   changed のみ upsert → typed result。best-effort・never-throw・Source 機能を失敗させない。
//
// ★ 本モジュールは production の feature save callsite から **まだ呼ばれない**（呼び出しが無いこと自体が
//   default OFF）。writer flag / env flag も追加しない。session 解決は呼び出し側（将来）で行い、本層は
//   store / userId / current（prior read）/ now（generatedAt）を **注入**で受ける（決定的・テスト容易）。
//
// 非対応（境界）: Event Signal / prompt / external AI / env 直参照 / Supabase 実接続。

import {
  upsertCareerPersonalMemorySection,
  type PersonalMemoryStore,
} from './repository';
import type { SectionRebuildResult } from './rebuild';
import {
  decideWrite,
  type CurrentMemoryMeta,
} from './state';
import type { ValidateReason } from './validate';
import type { CareerPersonalMemorySectionKey } from './schema';

export type ShadowWriteResult =
  | { sectionKey: CareerPersonalMemorySectionKey; status: 'written'; sourceRevision: string }
  | { sectionKey: CareerPersonalMemorySectionKey; status: 'skipped'; reason: 'guest' | 'no_store' | 'unchanged' | 'stale_write' }
  | { sectionKey: CareerPersonalMemorySectionKey; status: 'rejected'; reason: ValidateReason }
  | { sectionKey: CareerPersonalMemorySectionKey; status: 'failed'; reason: 'store_error' };

export type ShadowWriteParams = {
  store: PersonalMemoryStore | null;
  userId: string | null;
  built: SectionRebuildResult;
  // 直前 read で得た現在行メタ（無ければ null＝missing）。
  current: CurrentMemoryMeta;
  // 生成時刻（generatedAt）。呼び出し側が注入する（Date.now を本層で呼ばない＝決定的・テスト容易）。
  now: string;
};

// 1 section を shadow write（compare-and-set・idempotent・stale overwrite / out-of-order 防止）。
export async function shadowWriteSection(params: ShadowWriteParams): Promise<ShadowWriteResult> {
  const { store, userId, built, current, now } = params;
  const sectionKey = built.section.sectionKey;

  if (!store) return { sectionKey, status: 'skipped', reason: 'no_store' };
  if (!userId) return { sectionKey, status: 'skipped', reason: 'guest' };

  // compare-and-set: 変化なし / より新しい write が既にある → 書かない。
  const decision = decideWrite(current, built.sourceRevision, now);
  if (!decision.write) return { sectionKey, status: 'skipped', reason: decision.reason };

  // repository が payload を再検証（rejected は書かない）+ best-effort upsert（never-throw）。
  const outcome = await upsertCareerPersonalMemorySection(store, userId, {
    section: built.section,
    sourceRevision: built.sourceRevision,
    sourceUpdatedAt: built.sourceUpdatedAt,
    generatedAt: now,
    status: 'fresh',
  });

  switch (outcome.status) {
    case 'written':
      return { sectionKey, status: 'written', sourceRevision: built.sourceRevision };
    case 'rejected':
      return { sectionKey, status: 'rejected', reason: outcome.reason };
    case 'failed':
      return { sectionKey, status: 'failed', reason: 'store_error' };
    case 'skipped':
      return { sectionKey, status: 'skipped', reason: outcome.reason };
  }
}

// 複数 section を独立に shadow write（partial failure は section 単位で分離）。
//   currents: sectionKey → 現在行メタ（無い section は missing）。
export async function shadowWriteSections(params: {
  store: PersonalMemoryStore | null;
  userId: string | null;
  builts: readonly SectionRebuildResult[];
  currents: Partial<Record<CareerPersonalMemorySectionKey, CurrentMemoryMeta>>;
  now: string;
}): Promise<ShadowWriteResult[]> {
  const results: ShadowWriteResult[] = [];
  for (const built of params.builts) {
    const current = params.currents[built.section.sectionKey] ?? null;
    // 各 section は独立（1 つ失敗しても他へ伝播しない）。
    results.push(
      await shadowWriteSection({
        store: params.store,
        userId: params.userId,
        built,
        current,
        now: params.now,
      }),
    );
  }
  return results;
}
