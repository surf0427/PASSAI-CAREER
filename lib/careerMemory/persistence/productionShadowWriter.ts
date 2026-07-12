// PASSAI CAREER — Personal Memory production shadow-write coordinator（P16-D）。
//
// 責務: flag 確認 → authenticated member 確認 → browser Supabase store 生成 → compare-and-set 用に
//   現在行メタのみ read → shadow writer 実行 → typed outcome。**public boundary は never-throw / best-effort**。
//
// ★ 境界:
//   - Personal Memory の read は **compare-and-set（write 調整）専用**。prompt / Orchestrator / renderer では
//     使わない（本モジュールは prompt を生成しない・Orchestrator を import しない）。
//   - guest / no-env / no-client は write しない（fail-safe）。arbitrary userId を信用しない（session 由来のみ。
//     さらに RLS WITH CHECK が server 側で owner を強制）。service role を使わない。
//   - Event Signal / Event Log を記録しない。raw Source / payload / PII を console へ出さない。retry loop なし。
//   - この coordinator は Source データを **load しない**（load + build は呼び出し側 app 層の責務）。lib→app 依存を作らない。
//   - 依存（flag / session / store / now）は注入可能（DI）＝実 Supabase 非接続で QA できる。default は実依存。

'use client';

import { isCareerPersonalMemoryShadowWriteEnabled } from './shadowWriteFlag';
import {
  createSupabasePersonalMemoryStore,
  readCareerPersonalMemorySections,
  type PersonalMemoryStore,
} from './repository';
import { shadowWriteSection } from './shadowWriter';
import type { SectionRebuildResult } from './rebuild';
import type { CurrentMemoryMeta } from './state';
// 認証 / browser client は同じ lib 層（lib/careerSupabase）。lib→lib で静的 import 可（lib→app 依存ではない）。
import { resolveCareerSession } from '@/lib/careerSupabase/auth';
import { getCareerBrowserSupabaseClient } from '@/lib/careerSupabase/browserClient';

// public outcome（best-effort 結果。UI へ出さない・観測用のみ）。
export type ProductionShadowWriteOutcome =
  | 'disabled'
  | 'guest'
  | 'no_client'
  | 'written'
  | 'unchanged'
  | 'stale_write'
  | 'invalid'
  | 'failed';

// authenticated session 解決の最小結果（lib/careerSupabase/auth の CareerSessionResult 部分集合）。
export type ShadowWriteSession =
  | { kind: 'member'; userId: string }
  | { kind: 'guest' }
  | { kind: 'no-env' };

// 注入可能な依存（QA では fake を差し替える）。
export type ShadowWriteDeps = {
  isEnabled: () => boolean;
  resolveSession: () => Promise<ShadowWriteSession>;
  createStore: () => PersonalMemoryStore | null;
  now: () => string;
};

function mapOutcome(
  result: Awaited<ReturnType<typeof shadowWriteSection>>,
): ProductionShadowWriteOutcome {
  switch (result.status) {
    case 'written':
      return 'written';
    case 'rejected':
      return 'invalid';
    case 'failed':
      return 'failed';
    case 'skipped':
      // guest / no_store は coordinate 側で前段 return 済み。ここでは unchanged / stale_write のみ想定。
      return result.reason === 'stale_write' ? 'stale_write' : 'unchanged';
  }
}

// built section を owner へ shadow write する（never-throw・best-effort）。
export async function coordinateShadowWrite(
  built: SectionRebuildResult,
  deps: ShadowWriteDeps = realShadowWriteDeps,
): Promise<ProductionShadowWriteOutcome> {
  try {
    if (!deps.isEnabled()) return 'disabled';
    const session = await deps.resolveSession();
    if (session.kind !== 'member') return 'guest';
    const store = deps.createStore();
    if (!store) return 'no_client';
    const userId = session.userId;

    // compare-and-set 用に現在行メタのみ read（prompt 経路では使わない）。
    const rows = await readCareerPersonalMemorySections(store, userId, [built.section.sectionKey]);
    const row = rows[0];
    const current: CurrentMemoryMeta = row
      ? {
          schemaVersion: row.schemaVersion,
          sourceRevision: row.sourceRevision,
          status: row.status,
          sourceUpdatedAt: row.sourceUpdatedAt,
          generatedAt: row.generatedAt,
        }
      : null;

    const result = await shadowWriteSection({ store, userId, built, current, now: deps.now() });
    return mapOutcome(result);
  } catch {
    // never-throw: 予期せぬ失敗でも Source 保存・UI へ影響させない。
    return 'failed';
  }
}

// 実依存（app 層から呼ぶときの既定）。member session と browser client（owner-scoped・RLS 権威）から store を作る。
export const realShadowWriteDeps: ShadowWriteDeps = {
  isEnabled: isCareerPersonalMemoryShadowWriteEnabled,
  resolveSession: async (): Promise<ShadowWriteSession> => {
    const s = await resolveCareerSession();
    if (s.kind === 'member') return { kind: 'member', userId: s.userId };
    if (s.kind === 'no-env') return { kind: 'no-env' };
    return { kind: 'guest' };
  },
  createStore: (): PersonalMemoryStore | null => {
    const client = getCareerBrowserSupabaseClient();
    return client ? createSupabasePersonalMemoryStore(client) : null;
  },
  now: () => new Date().toISOString(),
};
