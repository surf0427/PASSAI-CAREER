/*
 * scripts/career-personal-memory-invalidation-qa.ts
 *
 * PASSAI CAREER — NEXT-5: Source reset/delete に対する Personal Memory 無効化 QA
 * （dev-only・DI fake・実 Supabase 非接続）。
 *
 * 何を守るか:
 *   [1] 影響 section の導出（純関数）: reset した Source を由来に持つ section だけが対象。
 *   [2] guest / no-client → 何も削除しない（fail-safe）。
 *   [3] member → 影響 section を owner-scoped で delete する（冪等・別 user の row を触らない）。
 *   [4] 一部失敗しても他 section の削除を続け、never-throw。
 *   [5] server safety net: Source を全削除すると server 再算出 revision が変わり、
 *       古い永続 payload は fresh 判定されない（＝prompt へ載らない）。
 *   [6] server safety net: 空 Source から rebuild した section は prompt block が空になる
 *       （古い内容が rebuild 経由で復活しない）。
 *   [7] 静的 guard: invalidation が service role を使わず、新しい writer を作らない。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-personal-memory-invalidation-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  invalidatePersonalMemoryForSourceReset,
  resetCareerSourceData,
  sectionsAffectedBySourceReset,
  type CareerSourceResetDeps,
  type PersonalMemoryInvalidationDeps,
} from '@/lib/careerMemory/persistence/invalidation';
import type { MirrorDeleteReport } from '@/lib/careerSourceData/mirrorDelete';
import type { CareerSourceKind } from '@/lib/careerSourceData/types';
import type { PersonalMemoryStore } from '@/lib/careerMemory/persistence/repository';
import { projectSectionFromSource } from '@/lib/careerMemory/persistence/sourceProjection';
import { renderPersonalMemoryForPurpose } from '@/lib/careerMemory/personalMemoryPromptContext';
import { EMPTY_CAREER_SOURCE_BUNDLE, type CareerSourceBundle } from '@/lib/careerSourceData/types';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const UID = '11111111-1111-1111-1111-111111111111';

type DeleteCall = { userId: string; sectionKey: string };

function makeStore(calls: DeleteCall[], failOn: readonly string[] = []): PersonalMemoryStore {
  return {
    async selectSections() { return { rows: [], error: null }; },
    async upsertSection() { return { error: new Error('write not allowed in invalidation') }; },
    async deleteSection(userId, sectionKey) {
      calls.push({ userId, sectionKey });
      return { error: failOn.includes(sectionKey) ? new Error('delete failed') : null };
    },
  };
}

function deps(
  store: PersonalMemoryStore | null,
  session: Awaited<ReturnType<PersonalMemoryInvalidationDeps['resolveSession']>>,
): PersonalMemoryInvalidationDeps {
  return { resolveSession: async () => session, createStore: () => store };
}

async function main() {
  console.log('[1] 影響 section の導出（純関数）');
  {
    check(sectionsAffectedBySourceReset([]).join(',') === '', '空 → 対象なし');
    check(sectionsAffectedBySourceReset(['es']).join(',') === 'es', "es → ['es']");
    check(sectionsAffectedBySourceReset(['profile']).join(',') === 'base', "profile → ['base']");
    check(sectionsAffectedBySourceReset(['values']).join(',') === 'base', "values → ['base']（base は 3 Source のどれでも無効化）");
    check(
      sectionsAffectedBySourceReset(['profile', 'activity', 'values', 'self_analysis', 'es', 'interview']).sort().join(',') ===
        'base,es,interview,self_analysis',
      '全 Source reset → 全 4 section',
    );
    check(!sectionsAffectedBySourceReset(['interview']).includes('base'), 'interview reset で base を巻き込まない');
  }

  console.log('[2] guest / no-client → 何も削除しない');
  {
    const calls: DeleteCall[] = [];
    const guest = await invalidatePersonalMemoryForSourceReset(['es'], deps(makeStore(calls), { kind: 'guest' }));
    check(guest.status === 'skipped' && calls.length === 0, 'guest → skipped・delete 0 回');

    const noClient = await invalidatePersonalMemoryForSourceReset(['es'], deps(null, { kind: 'member', userId: UID }));
    check(noClient.status === 'skipped', 'no-client → skipped');

    const noSections = await invalidatePersonalMemoryForSourceReset([], deps(makeStore(calls), { kind: 'member', userId: UID }));
    check(noSections.status === 'skipped' && calls.length === 0, '対象 section なし → skipped・I/O ゼロ');
  }

  console.log('[3] member → 影響 section を owner-scoped で delete');
  {
    const calls: DeleteCall[] = [];
    const r = await invalidatePersonalMemoryForSourceReset(
      ['profile', 'self_analysis'],
      deps(makeStore(calls), { kind: 'member', userId: UID }),
    );
    check(r.status === 'done', "status === 'done'");
    check(calls.map((c) => c.sectionKey).sort().join(',') === 'base,self_analysis', `delete section = ${calls.map((c) => c.sectionKey).join(',')}`);
    check(calls.every((c) => c.userId === UID), '常に session userId で delete（他人の row を触らない）');

    // 冪等: 同じ reset をもう一度呼んでも安全（delete は存在しない行に対しても no-op）。
    const again = await invalidatePersonalMemoryForSourceReset(
      ['profile', 'self_analysis'],
      deps(makeStore([]), { kind: 'member', userId: UID }),
    );
    check(again.status === 'done', '再実行しても done（冪等）');
  }

  console.log('[4] 一部失敗しても継続し never-throw');
  {
    const calls: DeleteCall[] = [];
    const r = await invalidatePersonalMemoryForSourceReset(
      ['profile', 'es', 'interview'],
      deps(makeStore(calls, ['es']), { kind: 'member', userId: UID }),
    );
    check(r.status === 'done' && r.failed.join(',') === 'es', `failed = ${r.status === 'done' ? r.failed.join(',') : 'n/a'}`);
    check(r.status === 'done' && r.invalidated.sort().join(',') === 'base,interview', '他 section の削除は継続する');
    check(calls.length === 3, '3 section すべてに delete を試みる');
  }

  console.log('[5] server safety net: Source 全削除 → 古い revision は一致しない');
  {
    const before: CareerSourceBundle = {
      ...EMPTY_CAREER_SOURCE_BUNDLE,
      selfAnalysisLogs: [
        { id: 'sa-1', createdAt: '2026-07-02T00:00:00.000Z', userInput: '', result: { summary: '古い所感', strengths: ['計画性'] } } as unknown as CareerSelfAnalysisLog,
      ],
    };
    const beforeRev = projectSectionFromSource('self_analysis', before)!.sourceRevision;
    const afterRev = projectSectionFromSource('self_analysis', EMPTY_CAREER_SOURCE_BUNDLE)!.sourceRevision;
    check(beforeRev !== afterRev, 'Source 削除で revision が変わる（＝古い永続行は stale になる）');
  }

  console.log('[6] server safety net: 空 Source から rebuild した section は prompt に何も足さない');
  {
    const rebuilt = [
      projectSectionFromSource('base', EMPTY_CAREER_SOURCE_BUNDLE)!.section,
      projectSectionFromSource('self_analysis', EMPTY_CAREER_SOURCE_BUNDLE)!.section,
    ];
    const block = renderPersonalMemoryForPurpose('company_research_review', rebuilt).block;
    check(block === '', 'empty Source → prompt block は空（従来 prompt と byte 互換）');
  }

  console.log('[6b] reset coordinator: mirror delete 失敗を握りつぶさない（§9）');
  {
    const mkDeps = (mirror: MirrorDeleteReport, store: PersonalMemoryStore | null = makeStore([])): CareerSourceResetDeps => ({
      resolveSession: async () => ({ kind: 'member', userId: UID }),
      createStore: () => store,
      deleteMirrors: async () => mirror,
    });

    // 成功パス: mirror も memory も消えて fullyPropagated=true。
    const okCalls: DeleteCall[] = [];
    const ok = await resetCareerSourceData(['es'], mkDeps({ outcomes: [{ kind: 'es', ok: true }], hasFailure: false }, makeStore(okCalls)));
    check(ok.fullyPropagated, '全部成功 → fullyPropagated=true');
    check(okCalls.some((c) => c.sectionKey === 'es'), 'Personal Memory の es section も削除される');

    // mirror delete 失敗 → fullyPropagated=false（silent success にしない）。
    const failed = await resetCareerSourceData(
      ['es'],
      mkDeps({ outcomes: [{ kind: 'es', ok: false, reason: 'delete_failed' }], hasFailure: true }),
    );
    check(!failed.fullyPropagated, '★ mirror delete 失敗 → fullyPropagated=false（握りつぶさない）');
    check(failed.mirror.hasFailure, '失敗が report に残る');

    // memory delete 失敗も同様。
    const memFail = await resetCareerSourceData(
      ['es'],
      mkDeps({ outcomes: [{ kind: 'es', ok: true }], hasFailure: false }, makeStore([], ['es'])),
    );
    check(!memFail.fullyPropagated, 'memory delete 失敗 → fullyPropagated=false');

    // guest では mirror delete も guest 扱いで失敗を報告する（成功と偽らない）。
    const guest = await resetCareerSourceData(['es'], {
      resolveSession: async () => ({ kind: 'guest' }),
      createStore: () => makeStore([]),
      deleteMirrors: async (userId) => ({
        outcomes: [{ kind: 'es' as CareerSourceKind, ok: false, reason: 'guest' }],
        hasFailure: userId === null,
      }),
    });
    check(!guest.fullyPropagated, 'guest → fullyPropagated=false');
  }

  console.log('[7] 静的 guard: invalidation の安全境界');
  {
    const src = readFileSync(join(ROOT, 'lib/careerMemory/persistence/invalidation.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(!/serviceRole|SERVICE_ROLE/.test(code), 'service role を使わない（D-L7）');
    check(/createSupabasePersonalMemoryStore/.test(code), '既存 repository を再利用する（新 store を作らない）');
    check(!/upsertSection|shadowWriteSection/.test(code), 'write 経路を持たない（second writer を作らない）');
    check(!/careerEvents|EventSignal/.test(code), 'Event Log / Event Signal を触らない（D-L3）');
    check(/resolveCareerSession/.test(code), 'userId は session 由来のみ（任意 userId を受け取らない）');

    const mirror = readFileSync(join(ROOT, 'lib/careerSourceData/mirrorDelete.ts'), 'utf8');
    const mcode = mirror.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(!/serviceRole|SERVICE_ROLE/.test(mcode), 'mirror delete が service role を使わない');
    check(/\.eq\('user_id', userId\)/.test(mcode), 'mirror delete は常に owner-scoped');
    check(/hasFailure/.test(mcode), 'mirror delete が失敗を返す（silent swallow しない）');
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-invalidation-qa: ALL PASS' : `career-personal-memory-invalidation-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
