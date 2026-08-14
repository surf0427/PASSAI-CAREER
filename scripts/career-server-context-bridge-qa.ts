/*
 * scripts/career-server-context-bridge-qa.ts
 *
 * PASSAI CAREER — NEXT-6: client bridge 退役（purpose 単位の server-driven base context）QA。
 *   dev-only・DI fake・実 Supabase 非接続。
 *
 * 何を守るか:
 *   [1] flag parse: 未設定 / 空 / 不正 / 未知 purpose は **default OFF**（誤って全 purpose が有効化されない）。
 *   [2] 採否判定（純関数）: flag OFF / Source 読めない / Source 空 → 従来の request body 経路。
 *   [3] loader: flag OFF の purpose では Source read を **1 回も呼ばない**（I/O ゼロ）。
 *   [4] loader: flag ON + Source ok + 実データあり → server source を返す。
 *   [5] loader: flag ON でも read error / truncated / 空 → null（request body へ fallback）。
 *   [6] loader: never-throw。
 *   [7] byte parity: 同じ base データなら「request body 経路」と「server source 経路」で
 *       生成される面接 system prompt が **1 byte も違わない**（経路差で prompt が変わらない）。
 *   [8] 静的 guard: 3 route が共有 resolver 経由になっており、直接 b.profile を prompt へ渡していない。
 *   [9] 静的 guard: server loader が service role を使わない。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-server-context-bridge-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decideBaseContextSource,
  isServerContextEnabledForPurpose,
  parseServerContextPurposes,
  BASE_CONTEXT_SOURCE_KINDS,
} from '@/lib/careerServerContext/baseContextPolicy';
import {
  loadServerBaseContext,
  type ServerBaseContextDeps,
} from '@/lib/careerServerContext/baseContext.server';
import {
  emptySourceStatuses,
  EMPTY_CAREER_SOURCE_BUNDLE,
  type CareerSourceBundle,
  type CareerSourceKind,
  type CareerSourceReadOutcome,
  type CareerSourceReadStatus,
} from '@/lib/careerSourceData/types';
import { buildInterviewBaseSystem } from '@/app/api/career/interview/interviewPrompt';
import { computeSourceSyncRevisions } from '@/lib/careerSourceSync/revision';
import {
  parseSourceSyncSignal,
  serializeSourceSyncSignal,
  EMPTY_SOURCE_SYNC_SIGNAL,
} from '@/lib/careerSourceSync/signal';

const ROOT = process.cwd();
const CANARY_UID = '11111111-1111-1111-1111-111111111111';
let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const PROFILE = {
  name: '山田太郎', grade: 'B3', graduationYear: '2027',
  preferences: [{ university: '東京大学', faculty: '工学部' }],
  targetIndustries: ['IT'], targetJobs: ['エンジニア'], strengths: ['実行力'],
};
const ACTIVITY = { focusedActivities: [{ title: '長期インターン', role: 'リーダー' }] };
const VALUES = {
  selections: {
    priorities: ['成長'], avoidances: [], industries: ['IT'], jobTypes: [],
    workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [],
  },
  notes: {
    priorities: '', avoidances: '', industries: '', jobTypes: '',
    workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '',
  },
  overallNote: '',
};

const BUNDLE = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  profile: PROFILE,
  activity: ACTIVITY,
  values: VALUES,
} as unknown as CareerSourceBundle;

function outcomeWith(
  bundle: CareerSourceBundle,
  status: CareerSourceReadStatus = 'ok',
): CareerSourceReadOutcome {
  const statuses = emptySourceStatuses();
  for (const k of BASE_CONTEXT_SOURCE_KINDS) statuses[k] = status;
  return {
    bundle,
    meta: { outcome: status === 'error' ? 'error' : 'ok', statuses, durationMs: 0 },
  };
}

// D-R2: 「client canonical == mirror」を証明する signal（bundle から生成）。
function syncOf(bundle: CareerSourceBundle) {
  return parseSourceSyncSignal(
    serializeSourceSyncSignal(computeSourceSyncRevisions(bundle, BASE_CONTEXT_SOURCE_KINDS)),
  );
}
const VERIFIED = () => syncOf(BUNDLE);

function deps(opts: {
  enabled?: boolean;
  outcome?: CareerSourceReadOutcome | 'throw';
  spy: { loads: number; kinds: CareerSourceKind[] };
}): ServerBaseContextDeps {
  const { enabled = true, outcome, spy } = opts;
  return {
    loadCanaryConfig: () => ({
      purposes: enabled ? (['interview_practice'] as const) : [],
      valid: true,
      userIds: [CANARY_UID],
    }),
    loadSources: async (kinds, authorize) => {
      spy.loads++;
      spy.kinds = [...kinds];
      if (outcome === 'throw') throw new Error('boom');
      // reader の authorize hook を模す（canary user なら通す）。
      if (authorize && !authorize(CANARY_UID)) {
        const statuses = emptySourceStatuses();
        return { bundle: EMPTY_CAREER_SOURCE_BUNDLE, meta: { outcome: 'unauthorized', statuses, durationMs: 0 } };
      }
      return outcome ?? outcomeWith(BUNDLE);
    },
  };
}

async function main() {
  console.log('[1] flag parse は default OFF / 未知 purpose を無視');
  {
    check(parseServerContextPurposes(undefined).length === 0, '未設定 → 空');
    check(parseServerContextPurposes('').length === 0, '空文字 → 空');
    check(parseServerContextPurposes('   ').length === 0, '空白のみ → 空');
    check(parseServerContextPurposes('*').length === 0, "'*' はワイルドカードにならない");
    check(parseServerContextPurposes('bogus,interview_practicex').length === 0, '未知 purpose を無視');
    check(parseServerContextPurposes('interview_practice').join(',') === 'interview_practice', '既知 purpose を許可');
    check(
      parseServerContextPurposes(' interview_practice , consultation , interview_practice ').join(',') ===
        'interview_practice,consultation',
      'trim + 重複除去',
    );
    check(!isServerContextEnabledForPurpose('consultation', ['interview_practice']), '未 opt-in purpose は false');
  }

  console.log('[2] 採否判定（純関数）');
  {
    const ok = emptySourceStatuses();
    for (const k of BASE_CONTEXT_SOURCE_KINDS) ok[k] = 'ok';
    check(decideBaseContextSource(false, ok, true, true).reason === 'flag_off', 'flag OFF → flag_off');
    check(decideBaseContextSource(true, ok, false, true).reason === 'source_empty', '実データ無し → source_empty');
    check(decideBaseContextSource(true, ok, true, false).reason === 'sync_unverified', '同期未証明 → sync_unverified（bridge へ）');
    check(decideBaseContextSource(true, ok, true, true).useServerSource, '全 ok + データあり + 証明済み → server source');
    for (const bad of ['error', 'truncated', 'skipped'] as const) {
      const st = { ...ok, values: bad };
      check(!decideBaseContextSource(true, st, true, true).useServerSource, `values=${bad} → 採用しない`);
    }
  }

  console.log('[3] flag OFF の purpose では Source read を呼ばない');
  {
    const spy = { loads: 0, kinds: [] as CareerSourceKind[] };
    const r = await loadServerBaseContext('interview_practice', VERIFIED(), deps({ enabled: false, spy }));
    check(r.context === null && r.reason === 'flag_off', 'null / flag_off');
    check(spy.loads === 0, 'Source read 0 回（I/O ゼロ）');
  }

  console.log('[4] flag ON + Source ok → server source を返す');
  {
    const spy = { loads: 0, kinds: [] as CareerSourceKind[] };
    const r = await loadServerBaseContext('interview_practice', VERIFIED(), deps({ spy }));
    check(r.context !== null && r.reason === 'server_source', 'server source を返す');
    check(spy.kinds.sort().join(',') === 'activity,profile,values', `読む Source = ${spy.kinds.join(',')}`);
    check(JSON.stringify(r.context?.profile) === JSON.stringify(PROFILE), 'profile が Layer 1 由来');
  }

  console.log('[5] flag ON でも read error / truncated / 空 → request body へ fallback');
  {
    for (const status of ['error', 'truncated'] as const) {
      const spy = { loads: 0, kinds: [] as CareerSourceKind[] };
      const r = await loadServerBaseContext('interview_practice', VERIFIED(), deps({ spy, outcome: outcomeWith(BUNDLE, status) }));
      check(r.context === null && r.reason === 'source_unavailable', `${status} → null / source_unavailable`);
    }
    // client も空（＝同期は取れている）で mirror も空 → source_empty。
    const spy = { loads: 0, kinds: [] as CareerSourceKind[] };
    const r = await loadServerBaseContext(
      'interview_practice',
      syncOf(EMPTY_CAREER_SOURCE_BUNDLE),
      deps({ spy, outcome: outcomeWith(EMPTY_CAREER_SOURCE_BUNDLE) }),
    );
    check(r.context === null && r.reason === 'source_empty', '空 Source（client も空）→ null / source_empty');

    // ★ D-R2: client にデータがあるのに mirror が空（＝mirror 未同期 / 削除未反映）→ sync_unverified。
    const spy2 = { loads: 0, kinds: [] as CareerSourceKind[] };
    const r2 = await loadServerBaseContext(
      'interview_practice',
      VERIFIED(),
      deps({ spy: spy2, outcome: outcomeWith(EMPTY_CAREER_SOURCE_BUNDLE) }),
    );
    check(r2.context === null && r2.reason === 'sync_unverified', 'client≠mirror → sync_unverified（bridge へ fallback）');

    // ★ D-R2: signal 未提示（旧 client）→ sync_unverified（server Source を使わない）。
    const spy3 = { loads: 0, kinds: [] as CareerSourceKind[] };
    const r3 = await loadServerBaseContext(
      'interview_practice',
      EMPTY_SOURCE_SYNC_SIGNAL,
      deps({ spy: spy3 }),
    );
    check(r3.context === null && r3.reason === 'sync_unverified', 'signal 未提示 → sync_unverified');
  }

  console.log('[6] never-throw');
  {
    const spy = { loads: 0, kinds: [] as CareerSourceKind[] };
    const r = await loadServerBaseContext('interview_practice', VERIFIED(), deps({ spy, outcome: 'throw' }));
    check(r.context === null, 'throw → null（従来経路へ fallback）');
  }

  console.log('[7] byte parity: request body 経路と server source 経路の prompt が同一');
  {
    const common = {
      selfAnalysis: null, es: null, matching: null, consultationInsights: null,
      companyResearch: null, target: null, interviewType: 'real' as const, userInput: '',
    };
    const fromBody = buildInterviewBaseSystem({
      profile: PROFILE, activity: ACTIVITY, values: VALUES, ...common,
    } as unknown as Parameters<typeof buildInterviewBaseSystem>[0]);

    const spy = { loads: 0, kinds: [] as CareerSourceKind[] };
    const server = await loadServerBaseContext('interview_practice', VERIFIED(), deps({ spy }));
    const fromServer = buildInterviewBaseSystem({
      profile: server.context?.profile ?? null,
      activity: server.context?.activity ?? null,
      values: server.context?.values ?? null,
      ...common,
    } as unknown as Parameters<typeof buildInterviewBaseSystem>[0]);

    check(fromBody === fromServer, `byte parity（body=${fromBody.length}B / server=${fromServer.length}B）`);
    check(fromBody.length > 0, 'prompt が空でない（比較が空文字同士でない）');
  }

  console.log('[8] 静的 guard: 3 route が共有 resolver 経由');
  {
    for (const rel of [
      'app/api/career/interview/start/route.ts',
      'app/api/career/interview/turn/route.ts',
      'app/api/career/interview/complete/route.ts',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      // Batch 2: 共有 resolver は resolveInterviewContextInputs（base + cross-feature）。
      check(/resolveInterviewContextInputs\(/.test(src), `${rel} が共有 resolver を使う`);
      check(/profile:\s*ctx\.profile/.test(src), `${rel} が resolver 由来を prompt へ渡す`);
      check(!/profile:\s*b\.profile/.test(src), `${rel} が request body を直接渡さない`);
      // cross-feature bridge も resolver 経由になっていること（Batch 2 の退役対象）。
      for (const f of ['selfAnalysis', 'es', 'matching', 'consultationInsights']) {
        check(!new RegExp(`${f}:\\s*b\\.${f}`).test(src), `${rel} が ${f} を body から直接渡さない`);
      }
    }
  }

  console.log('[9] 静的 guard: server loader の安全境界');
  {
    const src = readFileSync(join(ROOT, 'lib/careerServerContext/baseContext.server.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(/^import 'server-only';$/m.test(code), "import 'server-only' がある");
    check(!/serviceRole|SERVICE_ROLE/.test(code), 'service role を使わない（D-L7）');
    check(/loadCareerSourceData/.test(code), 'Layer 1 の単一 reader を再利用する');
    check(!/careerEvents|EventSignal/.test(code), 'Event Log / Event Signal を混ぜない（D-L3）');
  }

  console.log('');
  console.log(failures === 0 ? 'career-server-context-bridge-qa: ALL PASS' : `career-server-context-bridge-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
