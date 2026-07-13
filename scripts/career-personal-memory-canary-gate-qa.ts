/*
 * scripts/career-personal-memory-canary-gate-qa.ts
 *
 * PASSAI CAREER — P16-G: Personal Memory user/section-scoped canary gate QA（dev-only・オフライン）。
 *
 * 実 Supabase / 実 env / network を使わず、DI で以下を検証する:
 *   - config parser: default deny / malformed → 全体 deny / cap / whitespace / dedupe / wildcard・all 拒否。
 *   - pure gate: allowlisted×allowed のみ allow / exact match / substring 不可 / case 非破壊。
 *   - auth boundary: token→verified / missing・invalid・auth error・no-config → deny / body userId 非信用 /
 *     response は eligible のみ。
 *   - client resolver: true/false/timeout/network/401/403/500/malformed → 適切に false / never-throw。
 *   - write wiring: master OFF→resolver 0 / deny→Source load 0・write 0 / eligible→build 進行 /
 *     base-only→他 section write 0 / never-throw。
 *   - 静的: allowlist が client 層へ混入しない / console 非出力 / route response 契約 / prompt-Orchestrator 未配線。
 *
 * 使い方: npx tsx scripts/career-personal-memory-canary-gate-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseCanaryUserIds,
  parseCanarySections,
  buildCanaryConfig,
  evaluateCanaryGate,
  CAREER_CANARY_MAX_USER_IDS,
  type CanaryConfig,
} from '@/lib/careerMemory/persistence/canaryGate';
import {
  evaluateEligibility,
  type EligibilityDeps,
  type CanaryVerifyResult,
} from '@/lib/careerMemory/persistence/canaryEligibility';
import {
  resolveCanaryEligibility,
  type EligibilityClientDeps,
} from '@/lib/careerMemory/persistence/canaryEligibilityClient';
import {
  runGatedShadowWrite,
  shadowWriteBaseMemory,
  type ShadowWriteGateDeps,
} from '@/app/career/personalMemoryShadowWrite';
import { buildSelfAnalysisMemorySection, type SectionRebuildResult } from '@/lib/careerMemory/persistence/rebuild';

let failures = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) failures++; };
const cast = <T>(v: unknown): T => v as T;

// 合成 UUID（実ユーザーではない・任意の形式的 UUID）。
const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const U3 = '00000000-0000-4000-8000-000000000003';

async function main() {
  // narrowing helpers（valid のときのみ配列を返す。invalid は null）。
  const uids = (raw: unknown): readonly string[] | null => { const r = parseCanaryUserIds(raw); return r.valid ? r.userIds : null; };
  const secs = (raw: unknown): readonly string[] | null => { const r = parseCanarySections(raw); return r.valid ? r.sections : null; };

  console.log('[1] config parser: user ids');
  check(uids(undefined)?.length === 0, 'env absent → valid empty (deny)');
  check(uids('')?.length === 0, 'empty → valid empty (deny)');
  check(uids(U1)?.length === 1, 'single valid UUID');
  check(uids(`${U1},${U2}`)?.length === 2, 'multiple valid UUID');
  check(uids(`  ${U1} , ${U2}  `)?.length === 2, 'whitespace normalize');
  check(uids(`${U1},${U1}`)?.length === 1, 'duplicate normalize');
  check(parseCanaryUserIds(`${U1},not-a-uuid`).valid === false, 'malformed UUID 混入 → config 全体 deny');
  check(parseCanaryUserIds(123).valid === false, 'non-string → deny');
  {
    const many = Array.from({ length: CAREER_CANARY_MAX_USER_IDS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',');
    check(parseCanaryUserIds(many).valid === false, `cap 超過(${CAREER_CANARY_MAX_USER_IDS}) → deny`);
  }

  console.log('[2] config parser: sections');
  check(secs('base')?.length === 1, 'valid base section');
  check(secs('base,es')?.length === 2, '複数 valid section');
  check(secs('base,base')?.length === 1, 'section dedupe');
  check(parseCanarySections('base,presentation').valid === false, 'unknown section 混入 → 全体 deny');
  check(parseCanarySections('*').valid === false, 'wildcard 拒否');
  check(parseCanarySections('all').valid === false, "'all' 拒否");
  check(secs('')?.length === 0, 'empty → valid empty (deny)');

  console.log('[3] pure gate: exact match / default deny');
  const cfg = buildCanaryConfig(`${U1},${U2}`, 'base');
  check(cfg.valid === true, 'config valid');
  check(evaluateCanaryGate(U1, 'base', cfg) === true, 'allowlisted member + allowed base → allow');
  check(evaluateCanaryGate(U1, 'es', cfg) === false, 'allowlisted member + disallowed es → deny');
  check(evaluateCanaryGate(U3, 'base', cfg) === false, 'non-allowlisted member → deny');
  check(evaluateCanaryGate(null, 'base', cfg) === false, 'missing user → deny');
  check(evaluateCanaryGate(U1, 'presentation', cfg) === false, 'unknown section → deny');
  check(evaluateCanaryGate(U1, 'base', buildCanaryConfig(`${U1},bad`, 'base')) === false, 'invalid config → deny');
  check(evaluateCanaryGate(U1.slice(0, 20), 'base', cfg) === false, 'substring match 禁止（部分 UUID → deny）');
  // 英字入り UUID で case 非破壊を検証（parser は lowercase 化しない＝env と verified id を exact 比較）。
  const UHEX = 'aabbccdd-eeff-4a1b-8c2d-0123456789ab';
  const cfgHex = buildCanaryConfig(UHEX, 'base');
  check(evaluateCanaryGate(UHEX, 'base', cfgHex) === true, 'exact 一致（英字 UUID）→ allow');
  check(evaluateCanaryGate(UHEX.toUpperCase(), 'base', cfgHex) === false, 'case 変換した UUID は exact 不一致 → deny（UUID を壊さない）');
  check(evaluateCanaryGate(U1, 'base', { valid: false, userIds: [], sections: [] } as CanaryConfig) === false, 'config.valid=false → deny');

  console.log('[4] auth boundary: evaluateEligibility (DI verifyUser)');
  const cfgAllow: CanaryConfig = { valid: true, userIds: [U1], sections: ['base'] };
  const depsWith = (verify: CanaryVerifyResult | (() => Promise<CanaryVerifyResult>), config: CanaryConfig = cfgAllow): EligibilityDeps => ({
    verifyUser: typeof verify === 'function' ? verify : async () => verify,
    loadConfig: () => config,
  });
  check((await evaluateEligibility(depsWith({ kind: 'member', userId: U1 }), { section: 'base' })).eligible === true, 'valid token → verified member → eligible');
  check((await evaluateEligibility(depsWith({ kind: 'member', userId: U3 }), { section: 'base' })).eligible === false, 'verified but non-allowlisted → deny');
  check((await evaluateEligibility(depsWith({ kind: 'unauth' }), { section: 'base' })).eligible === false, 'missing/invalid token → deny');
  check((await evaluateEligibility(depsWith(async () => { throw new Error('auth'); }), { section: 'base' })).eligible === false, 'auth verification error → deny (never-throw)');
  check((await evaluateEligibility(depsWith({ kind: 'no-config' }), { section: 'base' })).eligible === false, 'server config missing → deny');
  check((await evaluateEligibility(depsWith({ kind: 'member', userId: U1 }), { section: 'nope' })).eligible === false, 'unknown section → deny');
  {
    // client 申告 userId を送っても信用しない: input に userId を混ぜても verifyUser の結果が権威。
    const spoof = cast<{ section: string }>({ section: 'base', userId: U1 });
    const r = await evaluateEligibility(depsWith({ kind: 'unauth' }), spoof);
    check(r.eligible === false, 'body userId を混ぜても verifyUser=unauth なら deny');
    check(Object.keys(r).length === 1 && 'eligible' in r, 'response は eligible のみ（userId/allowlist/token を含めない）');
  }

  console.log('[5] client resolver: never-throw / 全失敗 false');
  const mkRes = (ok: boolean, jsonVal: unknown, throwJson = false): Response => cast<Response>({ ok, json: async () => { if (throwJson) throw new Error('bad json'); return jsonVal; } });
  const baseClientDeps = (over: Partial<EligibilityClientDeps>): EligibilityClientDeps => ({
    getAccessToken: async () => 'tok',
    fetchFn: async () => mkRes(true, { eligible: true }),
    timeoutMs: 50,
    ...over,
  });
  let fetchCalls = 0;
  check((await resolveCanaryEligibility('base', baseClientDeps({ fetchFn: async () => mkRes(true, { eligible: true }) }))) === true, 'eligible true');
  check((await resolveCanaryEligibility('base', baseClientDeps({ fetchFn: async () => mkRes(true, { eligible: false }) }))) === false, 'eligible false');
  check((await resolveCanaryEligibility('base', baseClientDeps({ fetchFn: async () => { throw Object.assign(new Error('abort'), { name: 'AbortError' }); } }))) === false, 'timeout(abort) → false');
  check((await resolveCanaryEligibility('base', baseClientDeps({ fetchFn: async () => { throw new Error('network'); } }))) === false, 'network failure → false');
  check((await resolveCanaryEligibility('base', baseClientDeps({ fetchFn: async () => mkRes(false, { eligible: true }) }))) === false, '401/403/500 (res.ok=false) → false');
  check((await resolveCanaryEligibility('base', baseClientDeps({ fetchFn: async () => mkRes(true, null, true) }))) === false, 'malformed JSON → false');
  check((await resolveCanaryEligibility('base', baseClientDeps({ getAccessToken: async () => null, fetchFn: async () => { fetchCalls++; return mkRes(true, { eligible: true }); } }))) === false, 'no token → false');
  check(fetchCalls === 0, 'no token 時は endpoint を叩かない');
  check((await resolveCanaryEligibility('base', baseClientDeps({ getAccessToken: async () => { throw new Error('x'); } }))) === false, 'getAccessToken throw → false (never-throw)');
  check((await resolveCanaryEligibility('base', baseClientDeps({ fetchFn: async () => cast<Response>({ ok: true, json: async () => ({}) }) }))) === false, 'eligible 欠落 response → false');

  console.log('[6] write wiring: master flag / eligibility gate / section scope / never-throw');
  const built = buildSelfAnalysisMemorySection([]);
  function spyDeps(over: Partial<ShadowWriteGateDeps>) {
    const calls = { resolve: 0, load: 0, coord: 0 };
    const deps: ShadowWriteGateDeps = {
      isEnabled: () => true,
      resolveEligibility: async () => { calls.resolve++; return true; },
      loadAndBuild: () => { calls.load++; return built; },
      coordinate: async () => { calls.coord++; return 'written'; },
      ...over,
    };
    return { deps, calls };
  }
  // master flag OFF → sync return → resolver 0
  {
    const { deps, calls } = spyDeps({ isEnabled: () => false });
    shadowWriteBaseMemory(deps);
    await Promise.resolve();
    check(calls.resolve === 0 && calls.load === 0 && calls.coord === 0, 'master flag OFF → resolver 0 / Source load 0 / write 0');
  }
  // eligibility deny → Source load 0 / write 0
  {
    const { deps, calls } = spyDeps({ resolveEligibility: async () => { calls.resolve++; return false; } });
    await runGatedShadowWrite('base', deps);
    check(calls.load === 0 && calls.coord === 0, 'eligibility deny → Source load 0 / repository(coordinate) 0');
  }
  // eligible → build 経路進行
  {
    const { deps, calls } = spyDeps({});
    await runGatedShadowWrite('base', deps);
    check(calls.load === 1 && calls.coord === 1, 'eligible → loadAndBuild + coordinate 進行');
  }
  // base-only config 相当（resolve は section で分岐）→ 他 section write 0
  {
    let coord = 0;
    const deps: ShadowWriteGateDeps = {
      isEnabled: () => true,
      resolveEligibility: async (section) => section === 'base',
      loadAndBuild: () => built,
      coordinate: async () => { coord++; return 'written'; },
    };
    await runGatedShadowWrite('base', deps);
    const afterBase = coord;
    await runGatedShadowWrite('self_analysis', deps);
    await runGatedShadowWrite('es', deps);
    await runGatedShadowWrite('interview', deps);
    check(afterBase === 1 && coord === 1, 'base のみ eligible → self_analysis/es/interview は write 0');
  }
  // never-throw: resolve / coordinate が throw しても伝播しない
  {
    const deps: ShadowWriteGateDeps = {
      isEnabled: () => true,
      resolveEligibility: async () => { throw new Error('resolve'); },
      loadAndBuild: () => built,
      coordinate: async () => 'written',
    };
    let threw = false;
    try { await runGatedShadowWrite('base', deps); } catch { threw = true; }
    check(!threw, 'resolveEligibility throw でも runGatedShadowWrite は never-throw');
  }
  {
    const deps: ShadowWriteGateDeps = {
      isEnabled: () => true,
      resolveEligibility: async () => true,
      loadAndBuild: () => built,
      coordinate: async () => { throw new Error('coord'); },
    };
    let threw = false;
    try { await runGatedShadowWrite('base', deps); } catch { threw = true; }
    check(!threw, 'coordinate throw でも never-throw（Source 保存・UI 非影響）');
  }

  console.log('[7] static: allowlist が client 層へ混入しない / server-only / console 非出力');
  {
    const root = process.cwd();
    const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
    // client-importable な gate/resolver は server env / config.server を import しない。
    for (const rel of [
      'lib/careerMemory/persistence/canaryGate.ts',
      'lib/careerMemory/persistence/canaryEligibility.ts',
      'lib/careerMemory/persistence/canaryEligibilityClient.ts',
      'app/career/personalMemoryShadowWrite.ts',
    ]) {
      const src = read(rel);
      // import 行のみ走査（コメント内の "canaryConfig.server.ts の責務" 等に誤反応しないため）。
      const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
      check(importLines.filter((l) => /canaryConfig\.server/.test(l)).length === 0, `${rel}: server-only canaryConfig を import しない`);
      check(!/process\.env\.[A-Z].*CANARY|process\.env\[[^\]]*CANARY/.test(src), `${rel}: canary env を直接読まない`);
      check(!/console\.(log|warn|error|info)/.test(src), `${rel}: console 非出力`);
    }
    // config.server は server-only を宣言している。
    check(/import 'server-only'/.test(read('lib/careerMemory/persistence/canaryConfig.server.ts')), 'canaryConfig.server は server-only');
    // route response は eligible のみ（userId/allowlist/token/env を返さない）。
    const routeSrc = read('app/api/career/personal-memory/canary-eligibility/route.ts');
    check(/Response\.json\(\{\s*eligible/.test(routeSrc), 'route は { eligible } を返す');
    // Response.json を含む行のみ検査（コメントの説明文言に誤反応しない）。返却は eligible のみ。
    const responseLines = routeSrc.split('\n').filter((l) => /Response\.json/.test(l));
    check(responseLines.every((l) => !/userId|user_id|allowlist|access_token|token|payload/.test(l)), 'route の Response.json は allowlist/userId/token/payload を含めない');
    check(!/getServiceRoleSupabaseClient|serviceRole|CAREER_SUPABASE_SERVICE_ROLE_KEY/.test(routeSrc), 'route は service role を使わない');
    check(!/console\.(log|warn|error|info)/.test(routeSrc), 'route は console 非出力');
    // canary 層は prompt / Orchestrator を import しない。
    for (const rel of ['lib/careerMemory/persistence/canaryGate.ts', 'lib/careerMemory/persistence/canaryEligibility.ts', 'lib/careerMemory/persistence/canaryEligibilityClient.ts', 'app/api/career/personal-memory/canary-eligibility/route.ts']) {
      const importLines = read(rel).split('\n').filter((l) => /^\s*import\b/.test(l));
      check(importLines.filter((l) => /orchestrat|Prompt|prompt|readAdapter/.test(l)).length === 0, `${rel}: prompt/Orchestrator/readAdapter を import しない`);
    }
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-canary-gate-qa: ALL PASS' : `career-personal-memory-canary-gate-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
