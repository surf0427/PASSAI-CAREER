/*
 * scripts/career-data-spine-hardening-qa.ts
 *
 * PASSAI CAREER — Hardening 受け入れテスト H1〜H8（2026-08-14）。
 *   dev-only・DI fake・実 Supabase 非接続。
 *
 * H1 forged sync signal      — 偽造で他人 data / RLS 迂回 / 権限昇格 / 露出拡大が起きない
 * H2 absent signal           — mirror 由来 Personal Memory / context を使わない
 * H3 malformed signal        — 安全に veto
 * H4 unsafe rollback         — D-R1 を再有効化する production 経路が存在しない
 * H5 safe rollback           — flag OFF で既存 bridge / no-memory 挙動が働く
 * H6 stale device write      — 古い端末が silently 危険な prompt 利用を作れない
 * H7 delayed write           — 遅延 write が新しい端末に stale を current と見せない
 * H8 multi-device            — 各端末は自分の claim が一致したときだけ mirror 由来 context を得る
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-data-spine-hardening-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadPersonalMemorySectionsForPrompt,
  type PersonalMemoryReadServerDeps,
} from '@/lib/careerMemory/persistence/personalMemoryReadServer.server';
import { buildPersonalMemoryReadGateConfig } from '@/lib/careerMemory/persistence/readGate';
import { buildPersonalMemoryServerSourceConfig } from '@/lib/careerMemory/persistence/serverSourceFlag';
import { projectSectionFromSource } from '@/lib/careerMemory/persistence/sourceProjection';
import { computeSourceSyncRevisions } from '@/lib/careerSourceSync/revision';
import {
  parseSourceSyncSignal,
  serializeSourceSyncSignal,
  EMPTY_SOURCE_SYNC_SIGNAL,
  type CareerSourceSyncSignal,
} from '@/lib/careerSourceSync/signal';
import { loadServerBaseContext } from '@/lib/careerServerContext/baseContext.server';
import {
  EMPTY_CAREER_SOURCE_BUNDLE,
  emptySourceStatuses,
  type CareerSourceBundle,
  type CareerSourceReadOutcome,
} from '@/lib/careerSourceData/types';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

const ROOT = process.cwd();
const UID = '11111111-1111-1111-1111-111111111111';

let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const mkLog = (id: string, createdAt: string, summary: string) =>
  ({ id, createdAt, userInput: '', result: { summary } } as unknown as CareerSelfAnalysisLog);

const MINE = 'MY_OWN_CONTENT';
const DEVICE_B_ONLY = 'DEVICE_B_CONTENT';

const MIRROR: CareerSourceBundle = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  selfAnalysisLogs: [mkLog('sa-1', '2026-07-02T00:00:00.000Z', MINE)],
};
const DEVICE_B: CareerSourceBundle = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  selfAnalysisLogs: [mkLog('sa-9', '2026-07-30T00:00:00.000Z', DEVICE_B_ONLY)],
};

const P = projectSectionFromSource('self_analysis', MIRROR)!;
const memRow = () => ({
  section_key: 'self_analysis', schema_version: 1,
  source_revision: P.sourceRevision, source_updated_at: P.sourceUpdatedAt,
  generated_at: '2026-07-25T00:00:00.000Z', status: 'fresh', payload: P.section.payload,
});

const syncOf = (b: CareerSourceBundle): CareerSourceSyncSignal =>
  parseSourceSyncSignal(serializeSourceSyncSignal(computeSourceSyncRevisions(b)));

function sourceOk(bundle: CareerSourceBundle): CareerSourceReadOutcome {
  const statuses = emptySourceStatuses();
  for (const k of Object.keys(statuses) as (keyof typeof statuses)[]) statuses[k] = 'ok';
  return { bundle, meta: { outcome: 'ok', statuses, durationMs: 0 } };
}

type Spy = { selects: Array<{ userId: string }> };
function deps(
  rows: unknown[],
  source: CareerSourceReadOutcome,
  spy: Spy,
  opts: { enabled?: boolean } = {},
): PersonalMemoryReadServerDeps {
  return {
    isEnabled: () => opts.enabled !== false,
    loadGateConfig: () => buildPersonalMemoryReadGateConfig('true', UID),
    loadSourceConfig: () => ({ rebuildOnStaleEnabled: true }),
    loadSources: async () => source,
    now: () => 0,
    createReader: async () => ({
      async getUserId() { return UID; },          // ★ owner は常に server auth 由来
      async selectSections(userId) { spy.selects.push({ userId }); return { rows, error: null }; },
    }),
  };
}

async function run(rows: unknown[], source: CareerSourceReadOutcome, signal: CareerSourceSyncSignal, opts: { enabled?: boolean } = {}) {
  const spy: Spy = { selects: [] };
  const r = await loadPersonalMemorySectionsForPrompt('consultation', signal, deps(rows, source, spy, opts));
  // ★ 検査対象は self_analysis section。base（profile/activity/values 由来）は本 fixture では
  //   client / mirror ともに空で一致するため verified になり、**空の** base section が rebuild される。
  //   空 base は renderPersonalMemoryForPurpose で空文字になる（別 QA で固定済み）ため、
  //   ここでは「対象 section が載らないこと」と「内容が漏れないこと」を精密に判定する。
  const target = r.sections.find((x) => x.sectionKey === 'self_analysis');
  return { r, spy, all: JSON.stringify(r.sections), hasTarget: !!target };
}

async function main() {
  console.log('[H1] forged sync signal — 露出拡大 / RLS 迂回 / 権限昇格が起きない');
  {
    // 攻撃者が「自分の mirror と一致する」token を偽造して veto を回避したケース。
    const { spy, all, hasTarget } = await run([memRow()], sourceOk(MIRROR), syncOf(MIRROR));
    check(hasTarget, '偽造一致で得られるのは自分自身の mirror 由来 Memory のみ');
    check(all.includes(MINE), '内容は自分の mirror 由来');
    check(!all.includes(DEVICE_B_ONLY), '他 source / 他端末の内容は混ざらない');
    check(spy.selects.every((s) => s.userId === UID), '★ select は常に server auth の userId（signal は selector でない）');

    // 他人の user を指す token は「存在しない」— signal に user 概念が無いことを型・実装で担保。
    const forgedOther = parseSourceSyncSignal(`v1:self_analysis=deadbeef`);
    const { spy: spy2 } = await run([memRow()], sourceOk(MIRROR), forgedOther);
    check(spy2.selects.every((s) => s.userId === UID), '偽造 token でも owner は変わらない');

    // 静的 guard: signal が user_id / selector / Layer4-5 に触れない。
    const sig = readFileSync(join(ROOT, 'lib/careerSourceSync/signal.ts'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(!/user_id|userId/.test(sig), 'signal.ts に user_id 概念が無い');
    check(!/\.eq\(|\.in\(|\.from\(/.test(sig), 'signal.ts が DB selector を作らない');
    check(!/careerAggregate|careerCompanyKnowledge/.test(sig), 'signal から Layer 4/5 へ到達しない');
  }

  console.log('[H2] absent signal — mirror 由来 Memory / context を使わない');
  {
    const { r, all, hasTarget } = await run([memRow()], sourceOk(MIRROR), EMPTY_SOURCE_SYNC_SIGNAL);
    check(!hasTarget && r.sections.length === 0, 'Personal Memory を使わない（全 section unclaimed）');
    check(r.meta.vetoed.self_analysis === 'unclaimed', "veto='unclaimed'");
    check(!all.includes(MINE), '内容が漏れない');

    // server base context も同様（bridge へ fallback）。
    const ctx = await loadServerBaseContext('interview_practice', EMPTY_SOURCE_SYNC_SIGNAL, {
      enabledPurposes: () => ['interview_practice'],
      loadSources: async () => sourceOk(MIRROR),
    });
    check(ctx.context === null && ctx.reason === 'sync_unverified', 'base context も veto → bridge fallback');
  }

  console.log('[H3] malformed signal — 安全に veto');
  {
    for (const raw of ['garbage', 'v9:self_analysis=aaaaaaaa', "v1:self_analysis=' OR 1=1--", 'v1:'.padEnd(900, 'a'), '', '   ']) {
      const { r, hasTarget } = await run([memRow()], sourceOk(MIRROR), parseSourceSyncSignal(raw));
      check(!hasTarget && r.sections.length === 0, `malformed "${raw.slice(0, 16)}" → veto`);
    }
  }

  console.log('[H4] ★ unsafe rollback — D-R1 を再有効化する production 経路が存在しない');
  {
    // config builder に freshness を切る余地が無い。
    for (const raw of [undefined, 'true', '1', 'yes', 'legacy', {}, 42]) {
      const cfg = buildPersonalMemoryServerSourceConfig(raw);
      check(Object.keys(cfg).join(',') === 'rebuildOnStaleEnabled', `config が rebuild flag のみ（input=${String(raw)}）`);
    }
    // production code / env に LEGACY_D_R1 が存在しない。
    const prodFiles = [
      'lib/careerMemory/persistence/personalMemoryReadServer.server.ts',
      'lib/careerMemory/persistence/serverSourceFlag.ts',
      'lib/careerMemory/persistence/serverSourceFlagConfig.server.ts',
      'lib/careerServerContext/baseContext.server.ts',
    ];
    for (const rel of prodFiles) {
      const code = readFileSync(join(ROOT, rel), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      check(!/LEGACY_D_R1/.test(code), `${rel}: LEGACY_D_R1 を読まない`);
      check(!/resolveLegacySections/.test(code), `${rel}: legacy resolver が無い`);
    }
    // docs が unsafe rollback を推奨していない。
    for (const rel of [
      'docs/career/data_spine/DATA_SPINE_STATE.md',
      'docs/career/data_spine/DATA_SPINE_DECISIONS.md',
      'docs/career/data_spine/DATA_SPINE_ARCHITECTURE.md',
    ]) {
      const doc = readFileSync(join(ROOT, rel), 'utf8');
      check(
        !/LEGACY_D_R1=true`?\s*(で|→)?\s*(旧|rollback)/.test(doc) || /削除|removed|禁止/.test(doc),
        `${rel}: legacy rollback を推奨していない`,
      );
    }
  }

  console.log('[H5] safe rollback — flag OFF で既存挙動が働く');
  {
    const { r, spy } = await run([memRow()], sourceOk(MIRROR), syncOf(MIRROR), { enabled: false });
    check(r.sections.length === 0 && r.meta.read === 'skipped', 'Memory read OFF → Memory 無しで継続');
    void 0;
    check(spy.selects.length === 0, 'OFF 時は DB read もしない');

    // server context OFF（purpose 未 opt-in）→ bridge。
    const ctx = await loadServerBaseContext('interview_practice', syncOf(MIRROR), {
      enabledPurposes: () => [],
      loadSources: async () => { throw new Error('must not be called'); },
    });
    check(ctx.context === null && ctx.reason === 'flag_off', 'server context OFF → bridge fallback（I/O ゼロ）');
  }

  console.log('[H6] stale device write — 古い端末が危険な prompt 利用を silently 作れない');
  {
    // mirror が Device B の stale write で巻き戻った想定。要求端末（A）は自分の状態を claim する。
    const { r, all, hasTarget } = await run([memRow()], sourceOk(DEVICE_B), syncOf(MIRROR));
    check(!hasTarget, '巻き戻った mirror の該当 section は使われない');
    check(r.meta.vetoed.self_analysis === 'mismatch', "veto='mismatch'");
    check(!all.includes(DEVICE_B_ONLY), '他端末由来の内容が prompt に載らない');
    console.log('  info  mirror write 自体の巻き戻りは構造的には防げていない（D-S3 既知限界）。');
    console.log('  info  read 側 veto により prompt 汚染は起きない（上記 assertion）。');
  }

  console.log('[H7] delayed write — 遅延 write が新しい端末へ stale を current と見せない');
  {
    // mirror が古い payload に上書きされた直後の request（端末は新しい state を claim）。
    const { r, hasTarget } = await run([memRow()], sourceOk(MIRROR), syncOf(DEVICE_B));
    check(!hasTarget, '遅延 write 後も claim 不一致で veto');
    check(r.meta.vetoed.self_analysis === 'mismatch', "veto='mismatch'");
  }

  console.log('[H8] multi-device — claim が一致した端末だけ mirror 由来 context を得る');
  {
    const match = await run([memRow()], sourceOk(MIRROR), syncOf(MIRROR));
    check(match.hasTarget, '一致端末 → context あり');
    const mismatch = await run([memRow()], sourceOk(MIRROR), syncOf(DEVICE_B));
    check(!mismatch.hasTarget, '不一致端末 → context 無し');
    check(!mismatch.all.includes(MINE), '不一致端末へ他状態の内容が渡らない');
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-data-spine-hardening-qa: ALL PASS'
      : `career-data-spine-hardening-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
