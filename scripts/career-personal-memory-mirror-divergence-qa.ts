/*
 * scripts/career-personal-memory-mirror-divergence-qa.ts
 *
 * PASSAI CAREER — D-R2 closure の敵対的 trace（T1〜T10）。dev-only・DI fake・実 Supabase 非接続。
 *
 * 背景:
 *   本 QA は元々「D-R2 という限界を pin する」ためのものだった。
 *   source-sync veto（Option A）導入後は **限界が閉じたことを証明する** суite へ役割が変わっている。
 *
 * 守る契約:
 *   > server は「現在のユーザー状態と一致している」と証明できない Layer 1 / Personal Memory を
 *   > silently AI prompt へ載せない。
 *   fail-open は「古い personal data を使う」ではなく「**Personal Memory 無しで続行**」を意味する。
 *
 * T1  client newer / mirror older / memory older      → 古い memory が AI へ **届かない**
 * T2  client newer / mirror older / memory newer      → mirror への downgrade が起きない
 * T3  client deleted / mirror old / memory old        → 削除済みデータが AI へ **届かない**
 * T4  client == mirror / memory == mirror             → 正常に persisted memory が使える
 * T5  client == mirror / memory stale                 → request-local rebuild が働く
 * T6  mirror read error / truncated                   → stale memory を注入しない
 * T7  signal 偽造 / 破損                              → データ露出も権限昇格も起きない
 * T8  multi-device race                               → どの端末視点でも安全側
 * T9  out-of-order mirror write                       → 古い mirror を current と誤認しない
 * T10 feature flag OFF（安全な rollback）             → 既存挙動が維持される（D-R1 復活経路は無い）
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-personal-memory-mirror-divergence-qa.ts
 */

import {
  loadPersonalMemorySectionsForPrompt,
  type PersonalMemoryReadServerDeps,
} from '@/lib/careerMemory/persistence/personalMemoryReadServer.server';
import { buildPersonalMemoryReadGateConfig } from '@/lib/careerMemory/persistence/readGate';
import { projectSectionFromSource } from '@/lib/careerMemory/persistence/sourceProjection';
import { computeSourceSyncRevisions } from '@/lib/careerSourceSync/revision';
import {
  parseSourceSyncSignal,
  serializeSourceSyncSignal,
  EMPTY_SOURCE_SYNC_SIGNAL,
  type CareerSourceSyncSignal,
} from '@/lib/careerSourceSync/signal';
import {
  EMPTY_CAREER_SOURCE_BUNDLE,
  emptySourceStatuses,
  type CareerSourceBundle,
  type CareerSourceReadOutcome,
  type CareerSourceReadStatus,
} from '@/lib/careerSourceData/types';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

const UID = '11111111-1111-1111-1111-111111111111';

let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const mkLog = (id: string, createdAt: string, summary: string) =>
  ({ id, createdAt, userInput: '', result: { summary, strengths: ['計画性'] } } as unknown as CareerSelfAnalysisLog);

const OLD_MARKER = 'OLD_SOURCE_CONTENT';
const NEW_MARKER = 'NEW_SOURCE_CONTENT';

/** mirror が持っている古い状態。 */
const MIRROR_OLD: CareerSourceBundle = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  selfAnalysisLogs: [mkLog('sa-1', '2026-07-02T00:00:00.000Z', OLD_MARKER)],
};
/** localStorage 側の新しい状態。 */
const CLIENT_NEW: CareerSourceBundle = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  selfAnalysisLogs: [
    mkLog('sa-2', '2026-07-20T00:00:00.000Z', NEW_MARKER),
    mkLog('sa-1', '2026-07-02T00:00:00.000Z', OLD_MARKER),
  ],
};
/** localStorage 側で削除された状態。 */
const CLIENT_DELETED: CareerSourceBundle = { ...EMPTY_CAREER_SOURCE_BUNDLE, selfAnalysisLogs: [] };

const P_OLD = projectSectionFromSource('self_analysis', MIRROR_OLD)!;
const P_NEW = projectSectionFromSource('self_analysis', CLIENT_NEW)!;

const memRow = (p: typeof P_OLD) => ({
  section_key: 'self_analysis',
  schema_version: 1,
  source_revision: p.sourceRevision,
  source_updated_at: p.sourceUpdatedAt,
  generated_at: '2026-07-25T00:00:00.000Z',
  status: 'fresh',
  payload: p.section.payload,
});

/** その bundle を canonical として提示する client signal。 */
function syncOf(bundle: CareerSourceBundle): CareerSourceSyncSignal {
  return parseSourceSyncSignal(serializeSourceSyncSignal(computeSourceSyncRevisions(bundle)));
}

function sourceOutcome(
  bundle: CareerSourceBundle,
  status: CareerSourceReadStatus = 'ok',
): CareerSourceReadOutcome {
  const statuses = emptySourceStatuses();
  for (const k of Object.keys(statuses) as (keyof typeof statuses)[]) statuses[k] = status;
  return {
    bundle,
    meta: { outcome: status === 'error' ? 'error' : 'ok', statuses, durationMs: 0 },
  };
}

function deps(
  memoryRows: unknown[],
  source: CareerSourceReadOutcome,
  opts: { enabled?: boolean; rebuild?: boolean } = {},
): PersonalMemoryReadServerDeps {
  const { enabled = true, rebuild = true } = opts;
  return {
    isEnabled: () => enabled,
    loadGateConfig: () => buildPersonalMemoryReadGateConfig('true', UID),
    loadSourceConfig: () => ({ rebuildOnStaleEnabled: rebuild }),
    loadSources: async () => source,
    now: () => 0,
    createReader: async () => ({
      async getUserId() { return UID; },
      async selectSections() { return { rows: memoryRows, error: null }; },
    }),
  };
}

async function run(
  memoryRows: unknown[],
  source: CareerSourceReadOutcome,
  signal: CareerSourceSyncSignal,
  opts: { enabled?: boolean; rebuild?: boolean } = {},
) {
  const r = await loadPersonalMemorySectionsForPrompt('consultation', signal, deps(memoryRows, source, opts));
  const section = r.sections.find((s) => s.sectionKey === 'self_analysis');
  return {
    origin: r.meta.origins.self_analysis,
    veto: r.meta.vetoed.self_analysis,
    read: r.meta.read,
    hasSection: !!section,
    content: section ? JSON.stringify(section.payload) : '',
    all: JSON.stringify(r.sections),
  };
}

async function main() {
  console.log('[T1] client newer / mirror older / memory older → 古い memory を AI へ載せない');
  {
    const r = await run([memRow(P_OLD)], sourceOutcome(MIRROR_OLD), syncOf(CLIENT_NEW));
    check(!r.hasSection, 'section が prompt に載らない');
    check(r.veto === 'mismatch', `veto 理由 = mismatch（got ${r.veto}）`);
    check(!r.all.includes(OLD_MARKER), '古い内容が一切漏れない');
  }

  console.log('[T2] client newer / mirror older / memory newer → mirror への downgrade が起きない');
  {
    const r = await run([memRow(P_NEW)], sourceOutcome(MIRROR_OLD), syncOf(CLIENT_NEW));
    check(!r.hasSection, 'downgrade された section が載らない');
    check(!r.all.includes(OLD_MARKER), '古い mirror content へ downgrade しない');
    check(r.veto === 'mismatch', 'veto 理由 = mismatch');
  }

  console.log('[T3] client deleted / mirror old / memory old → 削除済みデータが AI へ届かない');
  {
    const r = await run([memRow(P_OLD)], sourceOutcome(MIRROR_OLD), syncOf(CLIENT_DELETED));
    check(!r.hasSection, '削除済み section が載らない');
    check(!r.all.includes(OLD_MARKER), '★ 削除済みデータが復活しない（旧 D-R2 Case B）');
    check(r.veto === 'mismatch', 'veto 理由 = mismatch');
  }

  console.log('[T4] client == mirror / memory == mirror → 正常に persisted memory が使える');
  {
    const r = await run([memRow(P_OLD)], sourceOutcome(MIRROR_OLD), syncOf(MIRROR_OLD));
    check(r.hasSection, 'section が載る（機能が死んでいない）');
    check(r.origin === 'persisted', `origin='persisted'（got ${r.origin}）`);
    check(r.content.includes(OLD_MARKER), '同期済み内容が prompt に載る');
  }

  console.log('[T5] client == mirror / memory stale → request-local rebuild が働く');
  {
    const staleRow = { ...memRow(P_OLD), source_revision: 'v1:content:stale000' };
    const r = await run([staleRow], sourceOutcome(MIRROR_OLD), syncOf(MIRROR_OLD));
    check(r.origin === 'rebuilt', `origin='rebuilt'（got ${r.origin}）`);
    check(
      JSON.stringify(JSON.parse(r.content)) === JSON.stringify(P_OLD.section.payload),
      'rebuild 結果は検証済み Source からの決定的 projection と一致',
    );
    // 行が無い場合も rebuild される。
    const r2 = await run([], sourceOutcome(MIRROR_OLD), syncOf(MIRROR_OLD));
    check(r2.origin === 'rebuilt', 'missing → rebuild');
  }

  console.log('[T6] mirror read error / truncated → stale memory を注入しない');
  {
    for (const status of ['error', 'truncated'] as const) {
      // signal は一致していても、read できていないので使わない。
      const r = await run([memRow(P_OLD)], sourceOutcome(MIRROR_OLD, status), syncOf(MIRROR_OLD));
      check(!r.hasSection, `status=${status} → section なし`);
      check(r.veto === 'unreadable', `status=${status} → veto='unreadable'`);
    }
  }

  console.log('[T7] signal 偽造 / 破損 → データ露出も権限昇格も起きない');
  {
    // (a) 未提示（旧 client / header 剥がし）→ unclaimed veto。
    const none = await run([memRow(P_OLD)], sourceOutcome(MIRROR_OLD), EMPTY_SOURCE_SYNC_SIGNAL);
    check(!none.hasSection && none.veto === 'unclaimed', '未提示 → unclaimed veto');

    // (b) 出鱈目な revision → mismatch veto。
    const forged = parseSourceSyncSignal('v1:self_analysis=deadbeef,profile=deadbeef,activity=deadbeef,values=deadbeef,es=deadbeef,interview=deadbeef');
    const bad = await run([memRow(P_OLD)], sourceOutcome(MIRROR_OLD), forged);
    check(!bad.hasSection && bad.veto === 'mismatch', '出鱈目 revision → mismatch veto');

    // (c) 破損 / 注入文字列 → 空 signal 扱い（veto）。
    for (const raw of ["v1:self_analysis=' OR 1=1--", 'v9:self_analysis=aaaaaaaa', 'garbage', '']) {
      const r = await run([memRow(P_OLD)], sourceOutcome(MIRROR_OLD), parseSourceSyncSignal(raw));
      check(!r.hasSection, `破損入力 "${raw.slice(0, 18)}" → section なし`);
    }

    // (d) ★ 最重要: 偽造が「成功」しても得られるのは **自分自身の mirror 由来 memory** だけ。
    //     他人のデータへは到達しない（owner は server auth + RLS が決める。signal は selector でない）。
    const matched = await run([memRow(P_OLD)], sourceOutcome(MIRROR_OLD), syncOf(MIRROR_OLD));
    check(
      matched.hasSection && matched.content.includes(OLD_MARKER) && !matched.content.includes(NEW_MARKER),
      '一致時に得られるのは自分の mirror 由来 memory のみ（権限昇格なし）',
    );
  }

  console.log('[T8] multi-device race → どの端末視点でも安全側');
  {
    // Device A: localStorage rev10 / Device B: rev8 / mirror: rev9
    const DEVICE_A = CLIENT_NEW;                       // 新しい
    const DEVICE_B = CLIENT_DELETED;                   // 遅れている（別状態）
    const MIRROR = MIRROR_OLD;                         // その中間

    const a = await run([memRow(P_OLD)], sourceOutcome(MIRROR), syncOf(DEVICE_A));
    check(!a.hasSection, 'Device A（進んでいる）→ memory 不使用');

    const b = await run([memRow(P_OLD)], sourceOutcome(MIRROR), syncOf(DEVICE_B));
    check(!b.hasSection, 'Device B（遅れている）→ memory 不使用');

    // mirror が Device A へ追いついた後は A のみ使える（B は依然 veto）。
    const mirrorSynced = sourceOutcome(DEVICE_A);
    const rowForA = {
      ...memRow(P_NEW),
      source_revision: projectSectionFromSource('self_analysis', DEVICE_A)!.sourceRevision,
      payload: projectSectionFromSource('self_analysis', DEVICE_A)!.section.payload,
    };
    const a2 = await run([rowForA], mirrorSynced, syncOf(DEVICE_A));
    check(a2.hasSection && a2.origin === 'persisted', '同期後の Device A → memory 使用可');
    const b2 = await run([rowForA], mirrorSynced, syncOf(DEVICE_B));
    check(!b2.hasSection, '同期後も Device B → veto（他端末の状態を押し付けない）');
    check(!b2.all.includes(NEW_MARKER), 'Device B へ他端末由来の内容が漏れない');
  }

  console.log('[T9] out-of-order mirror write → 古い mirror を current と誤認しない');
  {
    // client は最新、mirror は古い write に巻き戻った状態。
    const r = await run([memRow(P_NEW)], sourceOutcome(MIRROR_OLD), syncOf(CLIENT_NEW));
    check(!r.hasSection, '巻き戻った mirror では memory を使わない');
    check(!r.all.includes(OLD_MARKER), '巻き戻った内容が prompt へ載らない');
    // mirror が追いついたら使える（自己修復）。
    const ok = await run([memRow(P_NEW)], sourceOutcome(CLIENT_NEW), syncOf(CLIENT_NEW));
    check(ok.hasSection && ok.origin === 'persisted', 'mirror 追いつき後は自己修復して使える');
  }

  console.log('[T10] feature flag OFF（安全な rollback）→ 既存挙動が維持される');
  {
    // ★ D-S2: 推奨 rollback は「Personal Memory read を止める」= context を減らす方向のみ。
    //   D-R1（無検証で古い Memory を使う）へ戻す経路は存在しない。
    const r = await run([memRow(P_OLD)], sourceOutcome(MIRROR_OLD), syncOf(MIRROR_OLD), { enabled: false });
    check(!r.hasSection, 'master OFF → Memory 無し（従来 prompt）');
    check(r.read === 'skipped', "read === 'skipped'");
    check(!r.all.includes(OLD_MARKER), 'OFF 時に古い内容が漏れることもない');

    // rebuild OFF でも「古い Memory を使う」側へは倒れない。
    const r2 = await run(
      [memRow(P_OLD)], sourceOutcome(CLIENT_NEW), syncOf(CLIENT_NEW), { rebuild: false },
    );
    check(!r2.hasSection, 'rebuild OFF + stale memory → Memory 無し（degradation to less context）');
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-personal-memory-mirror-divergence-qa: ALL PASS'
      : `career-personal-memory-mirror-divergence-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
