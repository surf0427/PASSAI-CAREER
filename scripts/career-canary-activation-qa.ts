/*
 * scripts/career-canary-activation-qa.ts
 *
 * PASSAI CAREER — Canary activation traces C1〜C12（dev-only・DI fake・実 Supabase 非接続）。
 *
 * 守る invariant:
 *   canary user AND purpose enabled AND Source-Sync verified
 *     → server-derived context を使ってよい
 *   それ以外はすべて existing bridge / no-memory へ安全に fallback する。
 *   「Source-Sync unverified なのに古い mirror data を使う」は絶対に起きない。
 *
 * C1  canary + synced            → server context used
 * C2  non-canary user            → existing bridge（table read ゼロ）
 * C3  canary + sync mismatch     → veto → bridge fallback
 * C4  canary + absent signal     → bridge fallback
 * C5  canary + unreadable mirror → bridge fallback
 * C6  purpose disabled           → legacy behavior（I/O ゼロ）
 * C7  Personal Memory master OFF → Memory read I/O ゼロ
 * C8  forged user identity       → client は canary identity を選べない
 * C9  memory stale + source verified → request-local rebuild
 * C10 memory unavailable         → stale personal memory なしで安全に継続
 * C11 all flags OFF              → 既存 production 挙動と互換
 * C12 other purposes             → 誤って有効化されない
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-canary-activation-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadServerBaseContext,
  type ServerBaseContextDeps,
} from '@/lib/careerServerContext/baseContext.server';
import {
  buildServerContextCanaryConfig,
  isServerContextCanaryUser,
  isServerContextPurposeEnabled,
} from '@/lib/careerServerContext/canaryGate';
import { loadCareerSourceData } from '@/lib/careerSourceData/serverReader.server';
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
import { CAREER_CONTEXT_PURPOSES } from '@/lib/careerContext/purpose';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

const ROOT = process.cwd();
const CANARY = '11111111-1111-1111-1111-111111111111';
const OTHER = '99999999-9999-9999-9999-999999999999';

let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// ── fixtures ───────────────────────────────────────────────────────
const PROFILE = { name: '山田太郎', grade: 'B3', preferences: [{ university: '東京大学' }] };
const BUNDLE = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  profile: PROFILE,
  activity: { focusedActivities: [{ title: 'インターン' }] },
  values: {
    selections: { priorities: ['成長'], avoidances: [], industries: [], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] },
    notes: { priorities: '', avoidances: '', industries: '', jobTypes: '', workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '' },
    overallNote: '',
  },
  selfAnalysisLogs: [
    { id: 'sa-1', createdAt: '2026-07-02T00:00:00.000Z', userInput: '', result: { summary: 'SYNCED' } } as unknown as CareerSelfAnalysisLog,
  ],
} as unknown as CareerSourceBundle;

const DIVERGED = {
  ...BUNDLE,
  profile: { ...PROFILE, grade: 'B4' },
} as unknown as CareerSourceBundle;

const syncOf = (b: CareerSourceBundle): CareerSourceSyncSignal =>
  parseSourceSyncSignal(serializeSourceSyncSignal(computeSourceSyncRevisions(b)));

function sourceOutcome(
  bundle: CareerSourceBundle,
  status: CareerSourceReadStatus = 'ok',
): CareerSourceReadOutcome {
  const statuses = emptySourceStatuses();
  for (const k of Object.keys(statuses) as (keyof typeof statuses)[]) statuses[k] = status;
  return { bundle, meta: { outcome: status === 'error' ? 'error' : 'ok', statuses, durationMs: 0 } };
}

type Spy = { loads: number; authorized: boolean | null; tableReads: number };

/** reader の authorize hook を忠実に模した server context deps。 */
function ctxDeps(opts: {
  purposeOn?: boolean;
  allowlist?: readonly string[];
  requestUser?: string;
  bundle?: CareerSourceBundle;
  status?: CareerSourceReadStatus;
  spy: Spy;
}): ServerBaseContextDeps {
  const {
    purposeOn = true, allowlist = [CANARY], requestUser = CANARY,
    bundle = BUNDLE, status = 'ok', spy,
  } = opts;
  return {
    loadCanaryConfig: () => buildServerContextCanaryConfig(
      purposeOn ? ['interview_practice'] : [],
      allowlist.join(','),
    ),
    loadSources: async (kinds, authorize) => {
      spy.loads++;
      // 実 reader と同じ順序: auth → authorize → table read。
      if (authorize) {
        const ok = authorize(requestUser);
        spy.authorized = ok;
        if (!ok) {
          return {
            bundle: EMPTY_CAREER_SOURCE_BUNDLE,
            meta: { outcome: 'unauthorized', statuses: emptySourceStatuses(), durationMs: 0 },
          };
        }
      }
      spy.tableReads += kinds.length;
      return sourceOutcome(bundle, status);
    },
  };
}
const newSpy = (): Spy => ({ loads: 0, authorized: null, tableReads: 0 });

async function main() {
  console.log('[C1] canary user + purpose enabled + sync verified → server context used');
  {
    const spy = newSpy();
    const r = await loadServerBaseContext('interview_practice', syncOf(BUNDLE), ctxDeps({ spy }));
    check(r.reason === 'server_source' && r.context !== null, `server context 採用（got ${r.reason}）`);
    check(spy.authorized === true, 'canary user は authorize を通る');
    check(JSON.stringify(r.context?.profile) === JSON.stringify(PROFILE), 'Layer 1 由来の profile が使われる');
  }

  console.log('[C2] non-canary user → existing bridge（table read ゼロ）');
  {
    const spy = newSpy();
    const r = await loadServerBaseContext(
      'interview_practice', syncOf(BUNDLE), ctxDeps({ spy, requestUser: OTHER }),
    );
    check(r.context === null && r.reason === 'user_not_canary', `bridge fallback（got ${r.reason}）`);
    check(spy.authorized === false, 'authorize が deny');
    check(spy.tableReads === 0, '★ table read ゼロ（canary 外は Layer 1 を読まない）');
  }

  console.log('[C3] canary + sync mismatch → veto → bridge fallback');
  {
    const spy = newSpy();
    // client は BUNDLE を申告、mirror は DIVERGED（別内容）。
    const r = await loadServerBaseContext(
      'interview_practice', syncOf(BUNDLE), ctxDeps({ spy, bundle: DIVERGED }),
    );
    check(r.context === null && r.reason === 'sync_unverified', `veto → bridge（got ${r.reason}）`);
  }

  console.log('[C4] canary + absent signal → bridge fallback');
  {
    const spy = newSpy();
    const r = await loadServerBaseContext(
      'interview_practice', EMPTY_SOURCE_SYNC_SIGNAL, ctxDeps({ spy }),
    );
    check(r.context === null && r.reason === 'sync_unverified', `claim なし → bridge（got ${r.reason}）`);
  }

  console.log('[C5] canary + unreadable mirror → bridge fallback');
  {
    for (const status of ['error', 'truncated'] as const) {
      const spy = newSpy();
      const r = await loadServerBaseContext(
        'interview_practice', syncOf(BUNDLE), ctxDeps({ spy, status }),
      );
      check(r.context === null && r.reason === 'source_unavailable', `${status} → bridge（got ${r.reason}）`);
    }
  }

  console.log('[C6] purpose disabled → legacy behavior（I/O ゼロ）');
  {
    const spy = newSpy();
    const r = await loadServerBaseContext(
      'interview_practice', syncOf(BUNDLE), ctxDeps({ spy, purposeOn: false }),
    );
    check(r.context === null && r.reason === 'flag_off', `flag_off（got ${r.reason}）`);
    check(spy.loads === 0, '★ Source read を 1 回も呼ばない');
  }

  console.log('[C7] Personal Memory master OFF → Memory read I/O ゼロ');
  {
    let createReader = 0;
    let loadSources = 0;
    const deps: PersonalMemoryReadServerDeps = {
      isEnabled: () => false,
      loadGateConfig: () => buildPersonalMemoryReadGateConfig('true', CANARY),
      loadSourceConfig: () => ({ rebuildOnStaleEnabled: true }),
      loadSources: async () => { loadSources++; return sourceOutcome(BUNDLE); },
      now: () => 0,
      createReader: async () => { createReader++; return null; },
    };
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', syncOf(BUNDLE), deps);
    check(r.sections.length === 0 && r.meta.read === 'skipped', 'Memory 無しで継続');
    check(createReader === 0 && loadSources === 0, '★ client 生成も Source read も 0 回');
  }

  console.log('[C8] forged user identity → client は canary identity を選べない');
  {
    // 実 reader は authorize へ **server auth 由来 userId のみ**を渡す。
    const src = readFileSync(join(ROOT, 'lib/careerSourceData/serverReader.server.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(/const userId = await reader\.getUserId\(\);/.test(code), 'userId は reader.getUserId() のみ');
    check(/authorize\(userId\)/.test(code), 'authorize には auth 由来 userId だけを渡す');
    check(!/authorize\((?!userId\))/.test(code), 'authorize に他の値を渡す経路が無い');
    check(!/req\.|request\.|body\./.test(code), 'reader が request body を参照しない');

    // gate 自体も client 値では通らない（allowlist exact match）。
    const cfg = buildServerContextCanaryConfig(['interview_practice'], CANARY);
    check(!isServerContextCanaryUser(OTHER, cfg), '別 UUID は deny');
    check(!isServerContextCanaryUser('', cfg), '空文字は deny');
    check(!isServerContextCanaryUser(`${CANARY} `, cfg), 'trailing space は deny（exact match）');
    check(!isServerContextCanaryUser(CANARY.slice(0, 8), cfg), 'substring は deny');
    check(isServerContextCanaryUser(CANARY, cfg), 'exact 一致のみ allow');

    // allowlist 未設定 / 不正 → 全 deny。
    check(!isServerContextCanaryUser(CANARY, buildServerContextCanaryConfig(['interview_practice'], undefined)), '未設定 → 誰も許可しない');
    check(!isServerContextCanaryUser(CANARY, buildServerContextCanaryConfig(['interview_practice'], '')), '空 → 誰も許可しない');
    check(!isServerContextCanaryUser(CANARY, buildServerContextCanaryConfig(['interview_practice'], 'not-a-uuid')), '不正 → 全体 deny');
    check(!isServerContextCanaryUser(CANARY, buildServerContextCanaryConfig(['interview_practice'], '*')), 'wildcard は許可しない');
  }

  console.log('[C9] memory stale but source verified → request-local rebuild');
  {
    const P = projectSectionFromSource('self_analysis', BUNDLE)!;
    const staleRow = {
      section_key: 'self_analysis', schema_version: 1,
      source_revision: 'v1:content:stale000', source_updated_at: P.sourceUpdatedAt,
      generated_at: '2026-07-25T00:00:00.000Z', status: 'fresh', payload: P.section.payload,
    };
    const deps: PersonalMemoryReadServerDeps = {
      isEnabled: () => true,
      loadGateConfig: () => buildPersonalMemoryReadGateConfig('true', CANARY),
      loadSourceConfig: () => ({ rebuildOnStaleEnabled: true }),
      loadSources: async () => sourceOutcome(BUNDLE),
      now: () => 0,
      createReader: async () => ({
        async getUserId() { return CANARY; },
        async selectSections() { return { rows: [staleRow], error: null }; },
      }),
    };
    const r = await loadPersonalMemorySectionsForPrompt('consultation', syncOf(BUNDLE), deps);
    check(r.meta.origins.self_analysis === 'rebuilt', `rebuild される（got ${r.meta.origins.self_analysis}）`);
  }

  console.log('[C10] memory unavailable → stale personal memory なしで安全に継続');
  {
    const deps: PersonalMemoryReadServerDeps = {
      isEnabled: () => true,
      loadGateConfig: () => buildPersonalMemoryReadGateConfig('true', CANARY),
      loadSourceConfig: () => ({ rebuildOnStaleEnabled: true }),
      loadSources: async () => sourceOutcome(BUNDLE, 'error'),
      now: () => 0,
      createReader: async () => ({
        async getUserId() { return CANARY; },
        async selectSections() { return { rows: null, error: { message: 'db down' } }; },
      }),
    };
    const r = await loadPersonalMemorySectionsForPrompt('consultation', syncOf(BUNDLE), deps);
    check(r.sections.length === 0, 'Memory 無しで継続（throw しない）');
    check(!JSON.stringify(r.sections).includes('SYNCED'), 'stale content が漏れない');
  }

  console.log('[C11] all flags OFF → 既存 production 挙動と互換');
  {
    const spy = newSpy();
    // purpose 未 opt-in かつ allowlist 空 = 現在の production 既定。
    const r = await loadServerBaseContext(
      'interview_practice', syncOf(BUNDLE), ctxDeps({ spy, purposeOn: false, allowlist: [] }),
    );
    check(r.context === null && r.reason === 'flag_off', 'server context を使わない');
    check(spy.loads === 0, 'Layer 1 read ゼロ');

    // env 未設定時の実 config も default deny であること。
    const envCfg = buildServerContextCanaryConfig([], undefined);
    check(!isServerContextPurposeEnabled('interview_practice', envCfg), '未設定 → purpose OFF');
    check(!isServerContextCanaryUser(CANARY, envCfg), '未設定 → user OFF');
  }

  console.log('[C12] other purposes → 誤って有効化されない');
  {
    const cfg = buildServerContextCanaryConfig(['interview_practice'], CANARY);
    for (const p of CAREER_CONTEXT_PURPOSES) {
      const enabled = isServerContextPurposeEnabled(p, cfg);
      check(
        p === 'interview_practice' ? enabled : !enabled,
        `${p}: ${p === 'interview_practice' ? '有効' : '無効のまま'}`,
      );
    }
    // 有効化されていない purpose では Source read を行わない。
    const spy = newSpy();
    const r = await loadServerBaseContext('consultation', syncOf(BUNDLE), ctxDeps({ spy }));
    check(r.reason === 'flag_off' && spy.loads === 0, 'consultation は I/O ゼロで flag_off');
  }

  console.log('[C13] 静的 guard: default OFF / 自動 ON が無い');
  {
    for (const rel of [
      'lib/careerServerContext/canaryGate.ts',
      'lib/careerServerContext/canaryGate.server.ts',
      'lib/careerServerContext/baseContext.server.ts',
    ]) {
      const code = readFileSync(join(ROOT, rel), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      check(!/NODE_ENV\s*[!=]==?\s*['"]production/.test(code), `${rel}: development 自動 ON が無い`);
      // gate 判定関数が「無条件 true」を返していないこと（default-ON の混入検知）。
      check(!/return\s+true\s*;\s*\n\s*\}/.test(code), `${rel}: 無条件 true を返す gate が無い`);
      check(!/\|\|\s*true\b/.test(code), `${rel}: '|| true' で gate を骨抜きにしていない`);
      check(!/serviceRole|SERVICE_ROLE/.test(code), `${rel}: service role を使わない`);
    }
    // reader の authorize は optional だが、server context は必ず渡す。
    const ctx = readFileSync(join(ROOT, 'lib/careerServerContext/baseContext.server.ts'), 'utf8');
    check(/isServerContextCanaryUser\(userId, canary\)/.test(ctx), 'server context は必ず canary gate を渡す');
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-canary-activation-qa: ALL PASS'
      : `career-canary-activation-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void loadCareerSourceData; // 型参照のみ（実 reader は本 QA では呼ばない）
main();
