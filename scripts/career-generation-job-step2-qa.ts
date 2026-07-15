/*
 * scripts/career-generation-job-step2-qa.ts
 *
 * PASSAI CAREER — Step2（route 202化 / after background / status endpoint）の
 *   決定論 QA。外部 Claude API・本番 DB・secret 非使用。repository / provider /
 *   scheduler / auth はすべて DI した fake で検証する。
 *
 * 限界（明記）:
 *   - after() の Vercel 上での response 後継続保証は unit test では証明しない。
 *     ここでは「scheduler へ Promise が登録され、response がそれを await しない」ことまでを検証する。
 *   - owner scope / RLS / GRANT の実 DB 強制は DB integration gate（別 gate）で検証する。
 *     本 QA は service の owner 条件受け渡しと status endpoint の source 契約までを見る。
 *
 * 使い方: npx tsx scripts/career-generation-job-step2-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  handleSelfAnalysisJobPost,
  type AuthResolution,
  type JobPostDeps,
} from '../lib/careerSelfAnalysis/summaryJobService';
import {
  runSelfAnalysisGenerationAttempt,
  type RunAttemptDeps,
} from '../lib/careerSelfAnalysis/summaryJobAttempt';
import { mapOwnedJobToStatusResponse } from '../lib/careerSelfAnalysis/summaryJobStatus';
import { GenerationJobStorageError } from '../lib/careerGenerationJob/errors';
import { ROUTE_MAX_DURATION_SECONDS, timeBudgetIsConsistent } from '../lib/careerGenerationJob/constants';
import type { SelfAnalysisSummaryInput } from '../lib/careerSelfAnalysis/summaryPrompt';
import type {
  GenerationJobClaimResult,
  GenerationJobCompleteArgs,
  GenerationJobFailArgs,
} from '../lib/careerGenerationJob/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const ADMIN = { __admin: true };

function validInput(): SelfAnalysisSummaryInput {
  return {
    profile: { name: 'テスト太郎' } as SelfAnalysisSummaryInput['profile'],
    activity: { items: [{ id: '1' }] } as SelfAnalysisSummaryInput['activity'],
    values: null,
    userInput: '',
    conversation: [],
    pastSummaries: [],
  };
}
function emptyInput(): SelfAnalysisSummaryInput {
  return { profile: null, activity: null, values: null, userInput: '', conversation: [], pastSummaries: [] };
}

interface HandlerOverrides {
  globalPilot?: boolean;
  userPilot?: boolean;
  auth?: AuthResolution;
  admin?: { kind: 'ok'; admin: unknown } | { kind: 'unavailable' };
  claim?: GenerationJobClaimResult;
  claimThrows?: unknown;
  job?: { errorCode: string | null; result: unknown } | null;
  readThrows?: unknown;
  allowDevFallback?: boolean;
  runSchedule?: boolean;
}

function makeHandlerDeps(o: HandlerOverrides = {}) {
  const state = {
    legacy: 0, schedule: 0, runAttempt: 0, claim: 0, read: 0,
    scheduledTasks: [] as Array<() => Promise<void>>,
    runAttemptParams: [] as Array<Record<string, unknown>>,
  };
  const deps: JobPostDeps = {
    isPilotEnabledGlobally: () => o.globalPilot ?? true,
    isPilotEnabledForUser: () => o.userPilot ?? true,
    resolveAuth: async () => o.auth ?? { kind: 'member', userId: 'u1' },
    getAdmin: () => o.admin ?? { kind: 'ok', admin: ADMIN },
    buildIdentity: () => ({
      idempotencyKey: 'idem', inputRevision: 'ir', promptRevision: 'pr',
      outputSchemaRevision: 'osr', model: 'm',
    }),
    claimJob: async () => {
      state.claim += 1;
      if (o.claimThrows) throw o.claimThrows;
      return o.claim ?? { outcome: 'CLAIMED_NEW', jobId: 'job1', attemptToken: 'tok1', status: 'running', attemptCount: 1 };
    },
    readJob: async () => {
      state.read += 1;
      if (o.readThrows) throw o.readThrows;
      return o.job === undefined ? null : (o.job as never);
    },
    schedule: (task) => {
      state.schedule += 1;
      state.scheduledTasks.push(task);
      if (o.runSchedule) void task();
    },
    runAttempt: async (_admin, params) => {
      state.runAttempt += 1;
      state.runAttemptParams.push(params as unknown as Record<string, unknown>);
    },
    legacy: async () => {
      state.legacy += 1;
      return Response.json({ legacy: true }, { status: 200 });
    },
    allowDevUndefinedTableFallback: () => o.allowDevFallback ?? false,
  };
  return { deps, state };
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
console.log('[A] POST orchestration');

{
  // 1. pilot OFF → legacy only
  const { deps, state } = makeHandlerDeps({ globalPilot: false });
  const res = await handleSelfAnalysisJobPost(deps, validInput());
  const b = await body(res);
  check('1 pilot OFF → legacy のみ（claim/schedule 0）', b.legacy === true && state.legacy === 1 && state.claim === 0 && state.schedule === 0);
}
{
  // 2. anonymous → legacy
  const { deps, state } = makeHandlerDeps({ auth: { kind: 'anonymous' } });
  const res = await handleSelfAnalysisJobPost(deps, validInput());
  check('2 明確な anonymous → legacy（claim 0）', (await body(res)).legacy === true && state.legacy === 1 && state.claim === 0);
}
{
  // 3. auth error はanonymous扱いしない
  const { deps, state } = makeHandlerDeps({ auth: { kind: 'auth_error' } });
  const res = await handleSelfAnalysisJobPost(deps, validInput());
  const b = await body(res);
  check('3 auth error → 503 AUTH_TEMPORARILY_UNAVAILABLE retryable（legacy 0）',
    res.status === 503 && b.errorCode === 'AUTH_TEMPORARILY_UNAVAILABLE' && b.retryable === true && state.legacy === 0 && state.claim === 0);
}
{
  // 4. member + storage(admin) failure → Claude 0 / legacy 0
  const { deps, state } = makeHandlerDeps({ admin: { kind: 'unavailable' } });
  const res = await handleSelfAnalysisJobPost(deps, validInput());
  const b = await body(res);
  check('4 admin 取得失敗 → 503 GENERATION_JOB_STORAGE_UNAVAILABLE（schedule/runAttempt/legacy 0）',
    res.status === 503 && b.errorCode === 'GENERATION_JOB_STORAGE_UNAVAILABLE' && state.schedule === 0 && state.runAttempt === 0 && state.legacy === 0);

  // 4b. claim が DB_ERROR throw → 同様
  const t = makeHandlerDeps({ claimThrows: new GenerationJobStorageError('DB_ERROR', 'x') });
  const res2 = await handleSelfAnalysisJobPost(t.deps, validInput());
  check('4b claim DB_ERROR → 503（schedule 0 / legacy 0）',
    res2.status === 503 && (await body(res2)).errorCode === 'GENERATION_JOB_STORAGE_UNAVAILABLE' && t.state.schedule === 0 && t.state.legacy === 0);
}
{
  // 5. undefined table + pilot ON（dev fallback OFF）→ Claude 0
  const { deps, state } = makeHandlerDeps({ claimThrows: new GenerationJobStorageError('UNDEFINED_TABLE', 'x') });
  const res = await handleSelfAnalysisJobPost(deps, validInput());
  check('5 undefined table + pilot ON → 503（legacy silent fallback しない）',
    res.status === 503 && (await body(res)).errorCode === 'GENERATION_JOB_STORAGE_UNAVAILABLE' && state.legacy === 0 && state.schedule === 0);

  // 5b. dev fallback ON（非prod想定）→ legacy 許可
  const t = makeHandlerDeps({ claimThrows: new GenerationJobStorageError('UNDEFINED_TABLE', 'x'), allowDevFallback: true });
  const res2 = await handleSelfAnalysisJobPost(t.deps, validInput());
  check('5b dev fallback flag ON のときだけ legacy 許可', (await body(res2)).legacy === true && t.state.legacy === 1);
}
{
  // 6. CLAIMED_NEW → schedule 1 / 202
  const { deps, state } = makeHandlerDeps({ claim: { outcome: 'CLAIMED_NEW', jobId: 'jN', attemptToken: 'tN', status: 'running', attemptCount: 1 } });
  const res = await handleSelfAnalysisJobPost(deps, validInput());
  const b = await body(res);
  check('6 CLAIMED_NEW → 202 running / schedule 1', res.status === 202 && b.status === 'running' && b.jobId === 'jN' && b.retryAfterMs === 1000 && state.schedule === 1);
}
{
  // 7. CLAIMED_RETRY → schedule 1 / 202
  const { deps, state } = makeHandlerDeps({ claim: { outcome: 'CLAIMED_RETRY', jobId: 'jR', attemptToken: 'tR', status: 'running', attemptCount: 2 } });
  const res = await handleSelfAnalysisJobPost(deps, validInput());
  check('7 CLAIMED_RETRY → 202 running / schedule 1', res.status === 202 && (await body(res)).status === 'running' && state.schedule === 1);
}
{
  // 8. ALREADY_RUNNING → schedule 0 / 202
  const { deps, state } = makeHandlerDeps({ claim: { outcome: 'ALREADY_RUNNING', jobId: 'jA', attemptToken: null, status: 'running', attemptCount: 1 } });
  const res = await handleSelfAnalysisJobPost(deps, validInput());
  check('8 ALREADY_RUNNING → 202 / schedule 0', res.status === 202 && (await body(res)).status === 'running' && state.schedule === 0);
}
{
  // 9. ALREADY_COMPLETED → schedule 0 / cached 200
  const { deps, state } = makeHandlerDeps({
    claim: { outcome: 'ALREADY_COMPLETED', jobId: 'jC', attemptToken: null, status: 'completed', attemptCount: 1 },
    job: { errorCode: null, result: { summary: 'cached' } },
  });
  const res = await handleSelfAnalysisJobPost(deps, validInput());
  const b = await body(res);
  check('9 ALREADY_COMPLETED → 200 cached result / schedule 0',
    res.status === 200 && b.status === 'completed' && (b.result as { summary?: string }).summary === 'cached' && state.schedule === 0 && state.read === 1);
}
{
  // 10. FAILED_NON_RETRYABLE → schedule 0 / errorCode from read
  const { deps, state } = makeHandlerDeps({
    claim: { outcome: 'FAILED_NON_RETRYABLE', jobId: 'jF', attemptToken: null, status: 'failed', attemptCount: 1 },
    job: { errorCode: 'PARSE_FAILED', result: null },
  });
  const res = await handleSelfAnalysisJobPost(deps, validInput());
  const b = await body(res);
  check('10 FAILED_NON_RETRYABLE → 409 / errorCode PARSE_FAILED / retryable false / schedule 0',
    res.status === 409 && b.status === 'failed' && b.errorCode === 'PARSE_FAILED' && b.retryable === false && state.schedule === 0);
}
{
  // 11. RETRY_LIMIT_REACHED → schedule 0
  const { deps, state } = makeHandlerDeps({ claim: { outcome: 'RETRY_LIMIT_REACHED', jobId: 'jL', attemptToken: null, status: 'failed', attemptCount: 3 } });
  const res = await handleSelfAnalysisJobPost(deps, validInput());
  const b = await body(res);
  check('11 RETRY_LIMIT_REACHED → 409 / RETRY_LIMIT_REACHED / retryable false / schedule 0',
    res.status === 409 && b.errorCode === 'RETRY_LIMIT_REACHED' && b.retryable === false && state.schedule === 0);
}
{
  // 12. response が provider 完了を await しない（schedule 登録のみで即返す）
  const { deps, state } = makeHandlerDeps({ runSchedule: false });
  const res = await handleSelfAnalysisJobPost(deps, validInput());
  check('12a response は 202 で即返る（runAttempt 未起動）', res.status === 202 && state.runAttempt === 0 && state.scheduledTasks.length === 1);
  await state.scheduledTasks[0]();
  check('12b 登録済み task を後で実行すると runAttempt が走る', state.runAttempt === 1);
}
{
  // 27. background callback に client 指定 key を渡さない
  const { deps, state } = makeHandlerDeps({});
  await handleSelfAnalysisJobPost(deps, validInput());
  await state.scheduledTasks[0]();
  const p = state.runAttemptParams[0];
  const keys = Object.keys(p).sort().join(',');
  check('27 runAttempt params は userId/jobId/attemptToken/validatedInput のみ', keys === 'attemptToken,jobId,userId,validatedInput');
  const vi = p.validatedInput as Record<string, unknown>;
  check('27b validatedInput に idempotency/key を含めない', !('idempotencyKey' in vi) && !('key' in vi));
}
{
  // 28. member path で INVALID_INPUT は legacy に落ちない
  const { deps, state } = makeHandlerDeps({});
  const res = await handleSelfAnalysisJobPost(deps, emptyInput());
  check('28 member + 材料なし → 400 INVALID_INPUT（legacy/claude 0）',
    res.status === 400 && (await body(res)).errorCode === 'INVALID_INPUT' && state.legacy === 0 && state.claim === 0 && state.schedule === 0);
}

// ════════════════════════════════════════════════════════════════════
console.log('[B] background attempt (runAttempt)');

const VALID_JSON = JSON.stringify({ summary: 'これは自己分析の要約です。', strengths: ['継続力'] });

interface AttemptOverrides {
  providerResult?: { text: string; stopReason: string | null };
  providerThrows?: unknown;
  completeApplied?: boolean;
  failApplied?: boolean;
}
function makeAttemptDeps(o: AttemptOverrides = {}) {
  const state = {
    provider: 0,
    complete: [] as GenerationJobCompleteArgs[],
    fail: [] as GenerationJobFailArgs[],
    logs: [] as unknown[],
  };
  let t = 0;
  const deps: RunAttemptDeps = {
    provider: {
      generate: async () => {
        state.provider += 1;
        if (o.providerThrows) throw o.providerThrows;
        return o.providerResult ?? { text: VALID_JSON, stopReason: null };
      },
    },
    completeJob: async (a) => { state.complete.push(a); return { applied: o.completeApplied ?? true }; },
    failJob: async (a) => { state.fail.push(a); return { applied: o.failApplied ?? true }; },
    createSignal: () => new AbortController().signal,
    now: () => (t += 100),
    log: (e) => state.logs.push(e),
  };
  return { deps, state };
}
const attemptParams = { userId: 'u1', jobId: 'j1', attemptToken: 'tok', validatedInput: validInput() };

{
  // 13. success → fenced complete
  const { deps, state } = makeAttemptDeps({});
  await runSelfAnalysisGenerationAttempt(deps, attemptParams);
  check('13 provider 成功 → completeJob 1 / failJob 0',
    state.complete.length === 1 && state.fail.length === 0 && state.complete[0].jobId === 'j1' && state.complete[0].attemptToken === 'tok');
}
{
  // 14. provider timeout → fenced fail PROVIDER_TIMEOUT
  const { deps, state } = makeAttemptDeps({ providerThrows: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
  await runSelfAnalysisGenerationAttempt(deps, attemptParams);
  check('14 provider timeout → failJob PROVIDER_TIMEOUT', state.fail.length === 1 && state.fail[0].errorCode === 'PROVIDER_TIMEOUT' && state.complete.length === 0);
}
{
  // 15. 429 → PROVIDER_RATE_LIMITED
  const { deps, state } = makeAttemptDeps({ providerThrows: Object.assign(new Error('rate'), { status: 429 }) });
  await runSelfAnalysisGenerationAttempt(deps, attemptParams);
  check('15 429 → PROVIDER_RATE_LIMITED', state.fail[0]?.errorCode === 'PROVIDER_RATE_LIMITED');
}
{
  // 16. 5xx → PROVIDER_5XX
  const { deps, state } = makeAttemptDeps({ providerThrows: Object.assign(new Error('boom'), { status: 503 }) });
  await runSelfAnalysisGenerationAttempt(deps, attemptParams);
  check('16 5xx → PROVIDER_5XX', state.fail[0]?.errorCode === 'PROVIDER_5XX');
}
{
  // 17. parse failure（両 attempt）→ PARSE_FAILED / provider 2 回
  const { deps, state } = makeAttemptDeps({ providerResult: { text: 'これはJSONではない', stopReason: null } });
  await runSelfAnalysisGenerationAttempt(deps, attemptParams);
  check('17 parse 失敗 → PARSE_FAILED / provider 2 回（内部 temp0 再試行）', state.fail[0]?.errorCode === 'PARSE_FAILED' && state.provider === 2);
}
{
  // 18. validation failure（空出力）→ SCHEMA_VALIDATION_FAILED / provider 1 回
  const { deps, state } = makeAttemptDeps({ providerResult: { text: '{}', stopReason: null } });
  await runSelfAnalysisGenerationAttempt(deps, attemptParams);
  check('18 空出力 → SCHEMA_VALIDATION_FAILED / provider 1 回', state.fail[0]?.errorCode === 'SCHEMA_VALIDATION_FAILED' && state.provider === 1);
  // 18b. truncation → OUTPUT_TRUNCATED
  const t = makeAttemptDeps({ providerResult: { text: VALID_JSON, stopReason: 'max_tokens' } });
  await runSelfAnalysisGenerationAttempt(t.deps, attemptParams);
  check('18b max_tokens → OUTPUT_TRUNCATED', t.state.fail[0]?.errorCode === 'OUTPUT_TRUNCATED');
}
{
  // 19. raw provider error が DB 引数・log に載らない
  const secret = 'SENSITIVE-PII-token-9999';
  const { deps, state } = makeAttemptDeps({ providerThrows: Object.assign(new Error(secret), { status: 500, stack: `at x ${secret}` }) });
  await runSelfAnalysisGenerationAttempt(deps, attemptParams);
  const failStr = JSON.stringify(state.fail);
  const logStr = JSON.stringify(state.logs);
  check('19 failJob 引数に raw message が含まれない', !failStr.includes(secret) && state.fail[0].errorCode === 'PROVIDER_5XX');
  check('19b log に raw message が含まれない', !logStr.includes(secret));
  const failKeys = Object.keys(state.fail[0]).sort().join(',');
  check('19c failJob 引数は allowlist フィールドのみ', failKeys === 'attemptToken,errorCode,jobId,providerDurationMs,totalDurationMs,userId');
}
{
  // 20. complete applied=false → 旧 attempt として破棄（throw しない）
  const { deps, state } = makeAttemptDeps({ completeApplied: false });
  await runSelfAnalysisGenerationAttempt(deps, attemptParams);
  const log = state.logs[0] as { stage: string; applied: boolean };
  check('20 complete applied=false を破棄（例外なし・log applied=false）', state.complete.length === 1 && log.stage === 'complete' && log.applied === false);
}
{
  // 21. fail applied=false → 旧 attempt として破棄
  const { deps, state } = makeAttemptDeps({ providerThrows: Object.assign(new Error('x'), { status: 500 }), failApplied: false });
  await runSelfAnalysisGenerationAttempt(deps, attemptParams);
  const log = state.logs[0] as { stage: string; applied: boolean };
  check('21 fail applied=false を破棄（例外なし・log applied=false）', state.fail.length === 1 && log.stage === 'fail' && log.applied === false);
}
{
  // 25. ttft_ms を偽造しない（complete/fail 引数に ttft を含めない）
  const { deps, state } = makeAttemptDeps({});
  await runSelfAnalysisGenerationAttempt(deps, attemptParams);
  const keys = Object.keys(state.complete[0]);
  check('25 complete 引数に ttft を含めない', !keys.some((k) => /ttft/i.test(k)));
}

// ════════════════════════════════════════════════════════════════════
console.log('[C] status mapper + constants');
{
  // 24 / status contract
  check('status null → 404 not_found', mapOwnedJobToStatusResponse(null, 'j').httpStatus === 404);
  const run = mapOwnedJobToStatusResponse({ status: 'running', result: null, errorCode: null }, 'j');
  check('running → 200 running（result/errorCode なし）', run.httpStatus === 200 && run.body.status === 'running' && !('result' in run.body) && !('errorCode' in run.body));
  const done = mapOwnedJobToStatusResponse({ status: 'completed', result: { summary: 'ok' }, errorCode: null }, 'j');
  check('completed → 200 result', done.body.status === 'completed' && (done.body.result as { summary?: string }).summary === 'ok');
  const failR = mapOwnedJobToStatusResponse({ status: 'failed', result: null, errorCode: 'PROVIDER_TIMEOUT' }, 'j');
  check('24 failed retryable は allowlist 由来（PROVIDER_TIMEOUT→true）', failR.body.retryable === true);
  const failN = mapOwnedJobToStatusResponse({ status: 'failed', result: null, errorCode: 'PARSE_FAILED' }, 'j');
  check('24b failed non-retryable（PARSE_FAILED→false）', failN.body.retryable === false);

  // 26. 時間予算不変条件
  check('26 time budget consistent（deadline+prep+reserve<=max, lease>max）', timeBudgetIsConsistent());
}

// ════════════════════════════════════════════════════════════════════
console.log('[D] status endpoint source contract (owner scope)');
{
  const src = readFileSync(join(process.cwd(), 'app', 'api', 'career', 'self-analysis', 'job', 'route.ts'), 'utf8');
  check('22 status は user_id で owner 制限', /\.eq\('user_id', userId\)/.test(src));
  check('22b status は id=jobId で絞る', /\.eq\('id', jobId\)/.test(src));
  check('23 client 指定 user ID を受け取らない（searchParams から userId を読まない）', !/searchParams\.get\('userId'\)/.test(src));
  check('23b user_id は auth.getUser 由来', /auth\.getUser\(\)/.test(src) && /data\.user\.id/.test(src));
  check('auth 失敗と未ログインを分離（AUTH_TEMPORARILY_UNAVAILABLE と LOGIN_REQUIRED）',
    /AUTH_TEMPORARILY_UNAVAILABLE/.test(src) && /LOGIN_REQUIRED/.test(src));
  check('他 owner / not found を同一 404 に寄せる', /notFound\(\)/.test(src));
}

// ════════════════════════════════════════════════════════════════════
console.log('[E] route.ts wiring source contract');
{
  const src = readFileSync(join(process.cwd(), 'app', 'api', 'career', 'self-analysis', 'route.ts'), 'utf8');
  check('runtime=nodejs 明示', /export const runtime = 'nodejs'/.test(src));
  // Next segment config は静的リテラル必須。値が constants と一致することを QA で担保。
  const mdMatch = src.match(/export const maxDuration = (\d+)/);
  check('maxDuration リテラル明示', !!mdMatch);
  check('maxDuration が ROUTE_MAX_DURATION_SECONDS と一致', !!mdMatch && Number(mdMatch[1]) === ROUTE_MAX_DURATION_SECONDS);
  check('after() scheduler を使用', /after\(task\)/.test(src) && /from 'next\/server'/.test(src));
  check('legacy へ silent fallback は dev flag ガード', /allowDevUndefinedTableFallback/.test(src));
  check('member 認証は getServerSupabaseClient 由来', /getServerSupabaseClient/.test(src));
  check('job write は service-role admin', /getServiceRoleSupabaseClient/.test(src));
}
}

main().then(() => {
  console.log('');
  if (failures === 0) {
    console.log('career-generation-job-step2-qa: ALL PASS');
    process.exit(0);
  } else {
    console.error(`career-generation-job-step2-qa: ${failures} FAIL`);
    process.exit(1);
  }
}).catch((e) => {
  console.error('career-generation-job-step2-qa: THREW', e);
  process.exit(1);
});
