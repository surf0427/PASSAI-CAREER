/*
 * scripts/career-generation-job-step4-qa.ts
 *
 * PASSAI CAREER — Step4（統合デプロイ前レディネス）の決定論 QA。
 *
 * 目的:
 *   Step1–3 の server/client contract が「実コード同士で」噛み合うことを、外部 Claude API・
 *   本番 Supabase・実 DB を使わずに検証する。Step2/3 の個別 QA と違い、本 QA は
 *   **実 server レスポンス生成器（handleSelfAnalysisJobPost / mapOwnedJobToStatusResponse）**の
 *   出力をそのまま **実 client controller** へ流し込み、tier 跨ぎの union 消費を証明する。
 *
 * 検証区分:
 *   [A] POST response union を client parser が全ケース安全に消費できる
 *   [B] GET status response union を client parser が全ケース安全に消費できる
 *   [C] E2E fake flow（202→running→completed / 応答喪失再送 / reload resume / stale resubmit /
 *       fencing 拒否 / retry limit / logout / user switch / stale-response guard）
 *   [D] Durability / budget 不変条件（route maxDuration ↔ 定数 / 時間予算 / lease / clamp /
 *       未知 error_code / recoveryAction 未知値 / GET が write しない / raw 非保存 / key 非送信）
 *
 * 限界（明記・本 QA では扱わない）:
 *   - after() の Vercel 上 response 後継続保証 → Gate B（Vercel Preview）。
 *   - 実 Postgres の atomic claim / RLS / GRANT / fencing 実挙動 → Gate A（実 DB）。
 *   本 QA は fake provider/DB/clock/storage の in-memory 契約までを見る。
 *
 * 使い方: npx tsx scripts/career-generation-job-step4-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  handleSelfAnalysisJobPost,
  type AuthResolution,
  type JobPostDeps,
} from '../lib/careerSelfAnalysis/summaryJobService';
import { mapOwnedJobToStatusResponse } from '../lib/careerSelfAnalysis/summaryJobStatus';
import { SelfAnalysisGenerationController } from '../lib/careerSelfAnalysis/clientJob/controller';
import { keyForOwner, readPending } from '../lib/careerSelfAnalysis/clientJob/pendingStore';
import { computeClientFingerprint } from '../lib/careerSelfAnalysis/clientJob/fingerprint';
import {
  MAX_POLL_MS,
  MIN_POLL_MS,
  clampPollDelay,
} from '../lib/careerSelfAnalysis/clientJob/constants';
import {
  FINALIZATION_RESERVE_MS,
  LEASE_SECONDS,
  PREPARATION_BUDGET_MS,
  PROVIDER_DEADLINE_MS,
  ROUTE_MAX_DURATION_SECONDS,
  isRetryableErrorCode,
  timeBudgetIsConsistent,
} from '../lib/careerGenerationJob/constants';
import type {
  GenerationJobClaimResult,
} from '../lib/careerGenerationJob/types';
import type { SelfAnalysisSummaryInput } from '../lib/careerSelfAnalysis/summaryPrompt';
import type {
  HttpResult,
  SelfAnalysisRequestBody,
} from '../lib/careerSelfAnalysis/clientJob/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(title: string): void {
  console.log(`[${title}]`);
}
const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};

const ROOT = join(__dirname, '..');

// SECRET マーカー: pending / 送信 body に混入していないことの検出用。
const SECRET_NAME = 'SECRETNAME_DO_NOT_PERSIST';
const SECRET_ANSWER = 'SECRETANSWER_DO_NOT_PERSIST';

function validInput(): SelfAnalysisSummaryInput {
  return {
    profile: { name: SECRET_NAME } as SelfAnalysisSummaryInput['profile'],
    activity: { items: [{ id: '1' }] } as SelfAnalysisSummaryInput['activity'],
    values: null,
    userInput: '',
    conversation: [{ role: 'answer', content: SECRET_ANSWER }],
    pastSummaries: [],
  };
}
function emptyInput(): SelfAnalysisSummaryInput {
  return { profile: null, activity: null, values: null, userInput: '', conversation: [], pastSummaries: [] };
}
function validBody(): SelfAnalysisRequestBody {
  return validInput();
}

// ════════════════════════════════════════════════════════════════════
// 実 server POST 生成器を fake deps で駆動し、実レスポンス（status+body）を得る。
// ════════════════════════════════════════════════════════════════════
const ADMIN = { __admin: true };

interface ServerPostOverrides {
  globalPilot?: boolean;
  userPilot?: boolean;
  auth?: AuthResolution;
  admin?: { kind: 'ok'; admin: unknown } | { kind: 'unavailable' };
  claim?: GenerationJobClaimResult;
  job?: { errorCode: string | null; result: unknown } | null;
  input?: SelfAnalysisSummaryInput;
  legacyBody?: unknown;
  legacyStatus?: number;
}

async function runServerPost(o: ServerPostOverrides = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const deps: JobPostDeps = {
    isPilotEnabledGlobally: () => o.globalPilot ?? true,
    isPilotEnabledForUser: () => o.userPilot ?? true,
    resolveAuth: async () => o.auth ?? { kind: 'member', userId: 'u1' },
    getAdmin: () => o.admin ?? { kind: 'ok', admin: ADMIN },
    buildIdentity: () => ({
      idempotencyKey: 'idem', inputRevision: 'ir', promptRevision: 'pr',
      outputSchemaRevision: 'osr', model: 'm',
    }),
    claimJob: async () =>
      o.claim ?? { outcome: 'CLAIMED_NEW', jobId: 'j1', attemptToken: 't1', status: 'running', attemptCount: 1 },
    readJob: async () => {
      if (o.job === null) return null;
      const result = o.job ? o.job.result : { summary: 'ok' };
      const errorCode = o.job ? o.job.errorCode : null;
      return { id: 'j1', feature: 'self_analysis', operation: 'summary', status: 'completed', result, errorCode, attemptCount: 1, createdAt: '', updatedAt: '' };
    },
    schedule: () => {},
    runAttempt: async () => {},
    legacy: async () => Response.json(o.legacyBody ?? { result: { summary: 'legacy' } }, { status: o.legacyStatus ?? 200 }),
    allowDevUndefinedTableFallback: () => false,
  };
  const res = await handleSelfAnalysisJobPost(deps, o.input ?? validInput());
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body };
}

// ════════════════════════════════════════════════════════════════════
// client controller harness（fake env / storage / io）。
// ════════════════════════════════════════════════════════════════════
class FakeStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
  key(i: number): string | null { return Array.from(this.m.keys())[i] ?? null; }
  get length(): number { return this.m.size; }
}
interface Timer { id: number; at: number; cb: () => void }
class FakeEnv {
  now = 1_000;
  timers: Timer[] = [];
  private nextId = 1;
  schedule(ms: number, cb: () => void): number {
    const id = this.nextId++;
    this.timers.push({ id, at: this.now + ms, cb });
    return id;
  }
  cancel(id: unknown): void { this.timers = this.timers.filter((t) => t.id !== id); }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      const t = due[0];
      this.timers = this.timers.filter((x) => x.id !== t.id);
      this.now = Math.max(this.now, t.at);
      t.cb();
      await flush();
    }
    this.now = target;
  }
}

type ScriptItem = HttpResult | ((arg: unknown) => HttpResult);

interface Harness {
  c: SelfAnalysisGenerationController;
  env: FakeEnv;
  storage: FakeStorage;
  owner: { value: string | null };
  body: { value: SelfAnalysisRequestBody | null };
  post: ScriptItem[];
  get: ScriptItem[];
  postBodies: unknown[];
  finalizeArgs: unknown[];
  finalizeReturn: { value: boolean };
  counts: { post: number; get: number; nav: number; finalize: number };
  view: () => ReturnType<SelfAnalysisGenerationController['getView']>;
}

function mk(initialOwner: string | null = 'u1'): Harness {
  const env = new FakeEnv();
  const storage = new FakeStorage();
  const owner = { value: initialOwner };
  const body = { value: validBody() as SelfAnalysisRequestBody | null };
  const post: ScriptItem[] = [];
  const get: ScriptItem[] = [];
  const postBodies: unknown[] = [];
  const finalizeArgs: unknown[] = [];
  const finalizeReturn = { value: true };
  const counts = { post: 0, get: 0, nav: 0, finalize: 0 };
  const next = (arr: ScriptItem[], arg: unknown): HttpResult => {
    const item = arr.length > 1 ? (arr.shift() as ScriptItem) : arr[0];
    return typeof item === 'function' ? (item as (a: unknown) => HttpResult)(arg) : item;
  };
  const c = new SelfAnalysisGenerationController({
    getOwnerScope: () => owner.value,
    buildRequestBody: () => body.value,
    postGenerate: async (b) => { counts.post += 1; postBodies.push(b); return next(post, b); },
    getStatus: async (jobId) => { counts.get += 1; return next(get, jobId); },
    finalize: async (a) => { counts.finalize += 1; finalizeArgs.push(a); return finalizeReturn.value; },
    navigate: () => { counts.nav += 1; },
    storage,
    now: () => env.now,
    schedule: (ms, cb) => env.schedule(ms, cb),
    cancel: (h) => env.cancel(h),
    onChange: () => {},
    promptRevision: 'pr',
    outputSchemaRevision: 'osr',
    validateResult: (r) => !!r && typeof r === 'object',
  });
  return {
    c, env, storage, owner, body, post, get, postBodies, finalizeArgs, finalizeReturn, counts,
    view: () => c.getView(),
  };
}

// server レスポンスを client の HttpResult へ変換（transport 成功として渡す）。
function asHttp(server: { status: number; body: unknown }): HttpResult {
  return { kind: 'ok', status: server.status, body: server.body };
}

async function main() {
  // ══════════════════════════════════════════════════════════════════
  section('A. POST response union → 実 client controller が全ケース安全消費');
  // ══════════════════════════════════════════════════════════════════

  // A1. CLAIMED_NEW → 202 running → client は running + polling 予約。
  {
    const s = await runServerPost({ claim: { outcome: 'CLAIMED_NEW', jobId: 'jN', attemptToken: 't', status: 'running', attemptCount: 1 } });
    check('A1 server: CLAIMED_NEW → 202 running{jobId,retryAfterMs}',
      s.status === 202 && s.body?.status === 'running' && s.body?.jobId === 'jN' && typeof s.body?.retryAfterMs === 'number');
    const h = mk();
    h.post.push(asHttp(s));
    h.get.push({ kind: 'ok', status: 200, body: { status: 'running', jobId: 'jN', retryAfterMs: 1000, recoveryAction: 'poll' } });
    h.c.submit();
    await flush();
    check('A1 client: running 状態へ遷移', h.view().state === 'running');
    check('A1 client: pending に jobId 記録', readPending(h.storage, 'u1')?.jobId === 'jN');
  }

  // A2. ALREADY_RUNNING → 202 running。
  {
    const s = await runServerPost({ claim: { outcome: 'ALREADY_RUNNING', jobId: 'jR', attemptToken: null, status: 'running', attemptCount: 1 } });
    check('A2 server: ALREADY_RUNNING → 202 running', s.status === 202 && s.body?.status === 'running' && s.body?.jobId === 'jR');
    const h = mk();
    h.post.push(asHttp(s));
    h.get.push({ kind: 'ok', status: 200, body: { status: 'running', jobId: 'jR', retryAfterMs: 1000, recoveryAction: 'poll' } });
    h.c.submit();
    await flush();
    check('A2 client: running へ（jobId 採用）', h.view().state === 'running');
  }

  // A3. ALREADY_COMPLETED → 200 completed → client finalize + navigate。
  {
    const s = await runServerPost({ claim: { outcome: 'ALREADY_COMPLETED', jobId: 'jC', attemptToken: null, status: 'completed', attemptCount: 1 }, job: { errorCode: null, result: { summary: 'cached' } } });
    check('A3 server: ALREADY_COMPLETED → 200 completed{result}', s.status === 200 && s.body?.status === 'completed' && !!s.body?.result);
    const h = mk();
    h.post.push(asHttp(s));
    h.c.submit();
    await flush();
    check('A3 client: completed + finalize + navigate', h.view().state === 'completed' && h.counts.finalize === 1 && h.counts.nav === 1);
    check('A3 client: completed で pending 削除', readPending(h.storage, 'u1') === null);
  }

  // A4. FAILED_NON_RETRYABLE → 409 failed(non-retryable) → client failed / retry 不可。
  {
    const s = await runServerPost({ claim: { outcome: 'FAILED_NON_RETRYABLE', jobId: 'jF', attemptToken: null, status: 'failed', attemptCount: 2 }, job: { errorCode: 'SCHEMA_VALIDATION_FAILED', result: null } });
    check('A4 server: FAILED_NON_RETRYABLE → 409 failed retryable=false',
      s.status === 409 && s.body?.status === 'failed' && s.body?.retryable === false);
    const h = mk();
    h.post.push(asHttp(s));
    h.c.submit();
    await flush();
    check('A4 client: failed かつ retry 不可', h.view().state === 'failed' && h.view().canRetry === false);
  }

  // A5. RETRY_LIMIT_REACHED → 409 failed → retry ボタン非表示。
  {
    const s = await runServerPost({ claim: { outcome: 'RETRY_LIMIT_REACHED', jobId: 'jL', attemptToken: null, status: 'failed', attemptCount: 3 } });
    check('A5 server: RETRY_LIMIT_REACHED → 409 failed retryable=false',
      s.status === 409 && s.body?.errorCode === 'RETRY_LIMIT_REACHED' && s.body?.retryable === false);
    const h = mk();
    h.post.push(asHttp(s));
    h.c.submit();
    await flush();
    check('A5 client: failed / canRetry=false（retry ボタン非表示）', h.view().state === 'failed' && h.view().canRetry === false);
  }

  // A6. INVALID_INPUT（材料なし）→ 400 failed retryable=false → client failed 非 retry。
  {
    const s = await runServerPost({ input: emptyInput() });
    check('A6 server: 材料なし → 400 INVALID_INPUT retryable=false',
      s.status === 400 && s.body?.errorCode === 'INVALID_INPUT' && s.body?.retryable === false);
    const h = mk();
    h.post.push(asHttp(s));
    h.c.submit();
    await flush();
    check('A6 client: failed / retry 不可', h.view().state === 'failed' && h.view().canRetry === false);
  }

  // A7. storage unavailable → 503 retryable=true → client は transport 扱いで自動再送。
  {
    const s = await runServerPost({ admin: { kind: 'unavailable' } });
    check('A7 server: storage 不能 → 503 STORAGE_UNAVAILABLE retryable=true',
      s.status === 503 && s.body?.errorCode === 'GENERATION_JOB_STORAGE_UNAVAILABLE' && s.body?.retryable === true);
    const h = mk();
    // 初回 503 → 自動再送、2回目で 202 running。
    h.post.push(asHttp(s), { kind: 'ok', status: 202, body: { status: 'running', jobId: 'jS', retryAfterMs: 1000 } });
    h.get.push({ kind: 'ok', status: 200, body: { status: 'running', jobId: 'jS', retryAfterMs: 1000, recoveryAction: 'poll' } });
    h.c.submit();
    await flush();
    check('A7 client: 503 は failed 終端にせず reconnecting', h.view().state === 'reconnecting');
    await h.env.advance(20_000);
    check('A7 client: 自動再送で running へ回復', h.view().state === 'running' && h.counts.post >= 2);
  }

  // A8. auth 一時不能 → 503 retryable=true → transport 扱い。
  {
    const s = await runServerPost({ auth: { kind: 'auth_error' } });
    check('A8 server: auth_error → 503 AUTH_TEMPORARILY_UNAVAILABLE retryable=true',
      s.status === 503 && s.body?.errorCode === 'AUTH_TEMPORARILY_UNAVAILABLE' && s.body?.retryable === true);
    const h = mk();
    h.post.push(asHttp(s));
    h.c.submit();
    await flush();
    check('A8 client: reconnecting（自動 Claude 再実行はしない・failed 終端にしない）', h.view().state === 'reconnecting');
  }

  // A9. anonymous → legacy 同期 {result} → client は legacy completed として finalize。
  {
    const s = await runServerPost({ auth: { kind: 'anonymous' }, legacyBody: { result: { summary: 'legacy-ok' } } });
    check('A9 server: anonymous → legacy 200 {result}（status フィールドなし）',
      s.status === 200 && !!s.body?.result && s.body?.status === undefined);
    const h = mk();
    h.post.push(asHttp(s));
    h.c.submit();
    await flush();
    check('A9 client: legacy {result} を completed 消費（finalize+nav）', h.view().state === 'completed' && h.counts.finalize === 1);
  }

  // A10. 未知フィールド混入でも running を安全消費（前方互換）。
  {
    const h = mk();
    h.post.push({ kind: 'ok', status: 202, body: { status: 'running', jobId: 'jX', retryAfterMs: 1000, futureField: { nested: true }, extra: 42 } });
    h.get.push({ kind: 'ok', status: 200, body: { status: 'running', jobId: 'jX', retryAfterMs: 1000, recoveryAction: 'poll' } });
    h.c.submit();
    await flush();
    check('A10 client: 未知フィールドがあっても running を安全消費', h.view().state === 'running');
  }

  // A11. required field 欠落（result なし completed）は completed 扱いしない。
  {
    const h = mk();
    h.post.push({ kind: 'ok', status: 200, body: { status: 'completed', jobId: 'jM' } }); // result 欠落
    h.c.submit();
    await flush();
    check('A11 client: result 欠落 completed は navigate せず SCHEMA_VALIDATION_FAILED',
      h.view().state === 'failed' && h.view().errorCode === 'SCHEMA_VALIDATION_FAILED' && h.counts.nav === 0);
  }

  // A12. 完全に壊れた body（status も result も無し）→ PARSE_FAILED（クラッシュしない）。
  {
    const h = mk();
    h.post.push({ kind: 'ok', status: 200, body: { unexpected: true } });
    h.c.submit();
    await flush();
    check('A12 client: 未知形状 body は PARSE_FAILED（安全終端・非クラッシュ）',
      h.view().state === 'failed' && h.view().errorCode === 'PARSE_FAILED');
  }

  // ══════════════════════════════════════════════════════════════════
  section('B. GET status union（実 mapper 出力）→ client poll parser が全ケース安全消費');
  // ══════════════════════════════════════════════════════════════════

  const NOW = 100_000;
  const startRunning = (h: Harness) => {
    h.post.push({ kind: 'ok', status: 202, body: { status: 'running', jobId: 'jP', retryAfterMs: 1000 } });
    h.c.submit();
  };

  // B1. 実 mapper: not-found(null) → 404 → client reconnecting + pending 維持。
  {
    const m = mapOwnedJobToStatusResponse(null, 'jP', NOW);
    check('B1 mapper: null → 404 not_found', m.httpStatus === 404 && m.body.status === 'not_found');
    const h = mk();
    startRunning(h);
    await flush();
    h.get.push(asHttp({ status: m.httpStatus, body: m.body }));
    await h.env.advance(1_100);
    check('B1 client: 404 → reconnecting / pending 維持', h.view().state === 'reconnecting' && readPending(h.storage, 'u1') !== null);
  }

  // B2. 実 mapper: running(lease 有効) → 200 poll → client は poll 継続。
  {
    const m = mapOwnedJobToStatusResponse(
      { status: 'running', result: null, errorCode: null, leaseExpiresAt: new Date(NOW + 60_000).toISOString() }, 'jP', NOW);
    check('B2 mapper: lease 有効 → running recoveryAction=poll', m.body.status === 'running' && m.body.recoveryAction === 'poll');
    const h = mk();
    startRunning(h);
    await flush();
    h.get.push(asHttp({ status: m.httpStatus, body: m.body }),
      { kind: 'ok', status: 200, body: { status: 'completed', jobId: 'jP', result: { summary: 'done' } } });
    await h.env.advance(1_100);
    check('B2 client: poll 継続（running のまま次 poll 予約）', h.view().state === 'running');
  }

  // B3. 実 mapper: running(lease 失効) → resubmit → client は同一 body を再 POST。
  {
    const m = mapOwnedJobToStatusResponse(
      { status: 'running', result: null, errorCode: null, leaseExpiresAt: new Date(NOW - 1).toISOString() }, 'jP', NOW);
    check('B3 mapper: lease 失効 → recoveryAction=resubmit / retryAfterMs=0', m.body.recoveryAction === 'resubmit' && m.body.retryAfterMs === 0);
    const h = mk();
    startRunning(h);
    await flush();
    const postCountBefore = h.counts.post;
    h.get.push(asHttp({ status: m.httpStatus, body: m.body }));
    h.post.push({ kind: 'ok', status: 202, body: { status: 'running', jobId: 'jP', retryAfterMs: 1000 } });
    await h.env.advance(1_100);
    check('B3 client: resubmit で同一 body を再 POST（server が reclaim 判断）', h.counts.post === postCountBefore + 1);
  }

  // B4. 実 mapper: completed → 200 completed → client finalize + navigate。
  {
    const m = mapOwnedJobToStatusResponse(
      { status: 'completed', result: { summary: 'ok' }, errorCode: null }, 'jP', NOW);
    check('B4 mapper: completed → result 返却', m.body.status === 'completed' && !!m.body.result);
    const h = mk();
    startRunning(h);
    await flush();
    h.get.push(asHttp({ status: m.httpStatus, body: m.body }));
    await h.env.advance(1_100);
    check('B4 client: poll completed → finalize + navigate', h.view().state === 'completed' && h.counts.nav === 1);
  }

  // B5. 実 mapper: failed retryable → 200 failed retryable=true → client 手動 retry 可。
  {
    const m = mapOwnedJobToStatusResponse(
      { status: 'failed', result: null, errorCode: 'PROVIDER_TIMEOUT' }, 'jP', NOW);
    check('B5 mapper: retryable 失敗 → retryable=true', m.body.status === 'failed' && m.body.retryable === true);
    const h = mk();
    startRunning(h);
    await flush();
    h.get.push(asHttp({ status: m.httpStatus, body: m.body }));
    await h.env.advance(1_100);
    check('B5 client: failed かつ手動 retry 可（自動 Claude 再実行なし）', h.view().state === 'failed' && h.view().canRetry === true);
  }

  // B6. 実 mapper: failed non-retryable → retryable=false → retry 不可。
  {
    const m = mapOwnedJobToStatusResponse(
      { status: 'failed', result: null, errorCode: 'PARSE_FAILED' }, 'jP', NOW);
    check('B6 mapper: non-retryable → retryable=false', m.body.retryable === false);
    const h = mk();
    startRunning(h);
    await flush();
    h.get.push(asHttp({ status: m.httpStatus, body: m.body }));
    await h.env.advance(1_100);
    check('B6 client: failed / retry 不可', h.view().state === 'failed' && h.view().canRetry === false);
  }

  // B7. GET 401（session 喪失）→ reconnecting + pending 維持 + poll 停止。
  {
    const h = mk();
    startRunning(h);
    await flush();
    h.get.push({ kind: 'ok', status: 401, body: { error: 'LOGIN_REQUIRED' } });
    await h.env.advance(1_100);
    check('B7 client: 401 → reconnecting / pending 維持 / poll 停止',
      h.view().state === 'reconnecting' && readPending(h.storage, 'u1') !== null && h.env.timers.length === 0);
  }

  // B8. GET malformed（status 文字列でない）→ reconnecting（安全）。
  {
    const h = mk();
    startRunning(h);
    await flush();
    h.get.push({ kind: 'ok', status: 200, body: { garbage: true } });
    await h.env.advance(1_100);
    check('B8 client: malformed 200 → reconnecting（completed/failed 断定しない）', h.view().state === 'reconnecting');
  }

  // B9. recoveryAction 未知値 → resubmit しない（poll へフォールバック）。
  {
    const h = mk();
    startRunning(h);
    await flush();
    const postBefore = h.counts.post;
    h.get.push({ kind: 'ok', status: 200, body: { status: 'running', jobId: 'jP', retryAfterMs: 1000, recoveryAction: 'DEMOLISH' } });
    await h.env.advance(1_100);
    check('B9 client: recoveryAction 未知値では再送しない（poll 継続）', h.counts.post === postBefore && h.view().state === 'running');
  }

  // ══════════════════════════════════════════════════════════════════
  section('C. E2E fake flow（統合シナリオ）');
  // ══════════════════════════════════════════════════════════════════

  // C1. new → 202 → running → poll completed（正常経路）。completed は 1 回だけ保存/遷移。
  {
    const h = mk();
    h.post.push({ kind: 'ok', status: 202, body: { status: 'running', jobId: 'jc1', retryAfterMs: 1000 } });
    h.get.push(
      { kind: 'ok', status: 200, body: { status: 'running', jobId: 'jc1', retryAfterMs: 1000, recoveryAction: 'poll' } },
      { kind: 'ok', status: 200, body: { status: 'completed', jobId: 'jc1', result: { summary: 'ok' } } },
    );
    h.c.submit();
    await flush();
    await h.env.advance(5_000);
    check('C1: 202→running→completed で finalize=1 / navigate=1（重複なし）',
      h.view().state === 'completed' && h.counts.finalize === 1 && h.counts.nav === 1);
  }

  // C2. POST 応答喪失（transport_error）→ 同一 body 再送（server-authoritative idempotency に委譲）。
  {
    const h = mk();
    h.post.push({ kind: 'transport_error' }, { kind: 'ok', status: 202, body: { status: 'running', jobId: 'jc2', retryAfterMs: 1000 } });
    h.get.push({ kind: 'ok', status: 200, body: { status: 'running', jobId: 'jc2', retryAfterMs: 1000, recoveryAction: 'poll' } });
    h.c.submit();
    await flush();
    check('C2a: 応答喪失直後は reconnecting / pending は jobId=null unknown',
      h.view().state === 'reconnecting' && readPending(h.storage, 'u1')?.jobId === null);
    await h.env.advance(5_000);
    check('C2b: 同一 body で再送し running へ', h.counts.post >= 2 && h.view().state === 'running');
    const bodies = h.postBodies as SelfAnalysisRequestBody[];
    check('C2c: 再送 body は初回と同一入力（fingerprint 一致）',
      computeClientFingerprint(bodies[0]) === computeClientFingerprint(bodies[1]));
  }

  // C3. reload → pending(jobId あり) → GET resume → completed。
  {
    const h = mk();
    h.post.push({ kind: 'ok', status: 202, body: { status: 'running', jobId: 'jc3', retryAfterMs: 1000 } });
    h.get.push({ kind: 'ok', status: 200, body: { status: 'running', jobId: 'jc3', retryAfterMs: 1000, recoveryAction: 'poll' } });
    h.c.submit();
    await flush();
    check('C3a: submit 後 pending に jobId=jc3', readPending(h.storage, 'u1')?.jobId === 'jc3');
    // 「reload」を別 controller で再現（同一 storage / owner）。
    const h2 = mk();
    // storage を引き継ぐ。
    h2.storage.m = h.storage.m;
    h2.get.push({ kind: 'ok', status: 200, body: { status: 'completed', jobId: 'jc3', result: { summary: 'resumed' } } });
    h2.c.resumeFromMount();
    await flush();
    await h2.env.advance(2_000);
    check('C3b: reload 後 GET resume で completed 回収（POST 追加なし）',
      h2.view().state === 'completed' && h2.counts.post === 0 && h2.counts.finalize === 1);
  }

  // C4. stale lease → GET resubmit → POST reclaim → completed。
  {
    const h = mk();
    h.post.push(
      { kind: 'ok', status: 202, body: { status: 'running', jobId: 'jc4', retryAfterMs: 1000 } },
      { kind: 'ok', status: 202, body: { status: 'running', jobId: 'jc4', retryAfterMs: 1000 } }, // reclaim 再 POST
    );
    h.get.push(
      { kind: 'ok', status: 200, body: { status: 'running', jobId: 'jc4', retryAfterMs: 0, recoveryAction: 'resubmit' } },
      { kind: 'ok', status: 200, body: { status: 'completed', jobId: 'jc4', result: { summary: 'reclaimed' } } },
    );
    h.c.submit();
    await flush();
    await h.env.advance(10_000);
    check('C4: stale resubmit→再POST(reclaim)→completed', h.view().state === 'completed' && h.counts.post === 2);
  }

  // C5. retryable failure → 手動 retry → completed。
  {
    const h = mk();
    h.post.push(
      { kind: 'ok', status: 202, body: { status: 'running', jobId: 'jc5', retryAfterMs: 1000 } },
      { kind: 'ok', status: 202, body: { status: 'running', jobId: 'jc5', retryAfterMs: 1000 } },
    );
    h.get.push(
      { kind: 'ok', status: 200, body: { status: 'failed', jobId: 'jc5', errorCode: 'PROVIDER_TIMEOUT', retryable: true } },
      { kind: 'ok', status: 200, body: { status: 'completed', jobId: 'jc5', result: { summary: 'retried' } } },
    );
    h.c.submit();
    await flush();
    await h.env.advance(2_000);
    check('C5a: retryable failed で手動 retry 可', h.view().state === 'failed' && h.view().canRetry === true);
    h.c.retry();
    await flush();
    await h.env.advance(2_000);
    check('C5b: retry → completed', h.view().state === 'completed');
  }

  // C6. logout → pending 全削除 + poll 停止。
  {
    const h = mk();
    h.post.push({ kind: 'ok', status: 202, body: { status: 'running', jobId: 'jc6', retryAfterMs: 1000 } });
    h.get.push({ kind: 'ok', status: 200, body: { status: 'running', jobId: 'jc6', retryAfterMs: 5000, recoveryAction: 'poll' } });
    h.c.submit();
    await flush();
    check('C6a: submit 後 pending あり / timer あり', readPending(h.storage, 'u1') !== null);
    h.c.onLogout();
    await flush();
    check('C6b: logout で pending 削除 + timer 停止 + idle',
      readPending(h.storage, 'u1') === null && h.env.timers.length === 0 && h.view().state === 'idle');
  }

  // C7. user switch → 旧 owner の pending を新 owner が採用しない。
  {
    const h = mk('u1');
    h.post.push({ kind: 'ok', status: 202, body: { status: 'running', jobId: 'jc7', retryAfterMs: 1000 } });
    h.c.submit();
    await flush();
    check('C7a: u1 の pending 記録あり', readPending(h.storage, 'u1')?.jobId === 'jc7');
    // owner を u2 に切替えて resume。
    h.owner.value = 'u2';
    h.body.value = validBody();
    const getBefore = h.counts.get;
    h.c.resumeFromMount();
    await flush();
    await h.env.advance(3_000);
    check('C7b: u2 は u1 の job を採用せず GET しない / idle',
      h.counts.get === getBefore && h.view().state === 'idle');
  }

  // C8. 旧 poll 応答（stale-response guard）→ 新結果を上書きしない。
  {
    const h = mk();
    // getStatus は解決を遅延させ、その間に submit を再実行して token を無効化する。
    let releaseOld: ((r: HttpResult) => void) | null = null;
    const c = new SelfAnalysisGenerationController({
      getOwnerScope: () => 'u1',
      buildRequestBody: () => validBody(),
      postGenerate: async () => ({ kind: 'ok', status: 202, body: { status: 'running', jobId: 'old', retryAfterMs: 1000 } }),
      getStatus: async () => new Promise<HttpResult>((res) => { releaseOld = res; }),
      finalize: async () => { h.counts.finalize += 1; return true; },
      navigate: () => { h.counts.nav += 1; },
      storage: h.storage, now: () => h.env.now,
      schedule: (ms, cb) => h.env.schedule(ms, cb), cancel: (x) => h.env.cancel(x),
      onChange: () => {}, promptRevision: 'pr', outputSchemaRevision: 'osr',
      validateResult: (r) => !!r && typeof r === 'object',
    });
    c.submit();
    await flush();
    await h.env.advance(1_100); // poll 発火 → getStatus pending（releaseOld セット）
    // 新しい submit で token を回す。
    c.submit();
    await flush();
    // 旧 poll をここで completed で解決させる。
    if (releaseOld) (releaseOld as (r: HttpResult) => void)({ kind: 'ok', status: 200, body: { status: 'completed', jobId: 'old', result: { summary: 'STALE' } } });
    await flush();
    check('C8: 旧 poll 応答は stale-response guard で破棄（finalize/navigate されない）',
      h.counts.finalize === 0 && h.counts.nav === 0);
  }

  // C9. 保存失敗 → pending を残す / navigate しない / SAVE_FAILED。
  {
    const h = mk();
    h.finalizeReturn.value = false;
    h.post.push({ kind: 'ok', status: 200, body: { status: 'completed', jobId: 'jc9', result: { summary: 'ok' } } });
    h.c.submit();
    await flush();
    check('C9: 保存失敗 → pending 維持 / navigate なし / failed(SAVE_FAILED, retry 可)',
      readPending(h.storage, 'u1') !== null && h.counts.nav === 0 && h.view().state === 'failed' && h.view().errorCode === 'SAVE_FAILED' && h.view().canRetry === true);
  }

  // ══════════════════════════════════════════════════════════════════
  section('D. Durability / budget 不変条件（cross-file・static）');
  // ══════════════════════════════════════════════════════════════════

  // D1. route の maxDuration リテラルが ROUTE_MAX_DURATION_SECONDS と一致。
  {
    const routeSrc = readFileSync(join(ROOT, 'app/api/career/self-analysis/route.ts'), 'utf8');
    const m = routeSrc.match(/export\s+const\s+maxDuration\s*=\s*(\d+)/);
    const literal = m ? Number(m[1]) : NaN;
    check('D1: route maxDuration リテラル === ROUTE_MAX_DURATION_SECONDS',
      literal === ROUTE_MAX_DURATION_SECONDS, `literal=${literal} const=${ROUTE_MAX_DURATION_SECONDS}`);
  }

  // D2. 時間予算不変条件（provider+prep+reserve ≤ maxDuration かつ lease > maxDuration）。
  {
    const sum = PROVIDER_DEADLINE_MS + PREPARATION_BUDGET_MS + FINALIZATION_RESERVE_MS;
    check('D2a: provider+prep+reserve ≤ route maxDuration', sum <= ROUTE_MAX_DURATION_SECONDS * 1000, `sum=${sum}`);
    check('D2b: LEASE_SECONDS > route maxDuration（境界 reclaim 競合回避）', LEASE_SECONDS > ROUTE_MAX_DURATION_SECONDS);
    check('D2c: timeBudgetIsConsistent() === true', timeBudgetIsConsistent() === true);
  }

  // D3. client は server lease 定数を複製していない。
  {
    const clientConst = readFileSync(join(ROOT, 'lib/careerSelfAnalysis/clientJob/constants.ts'), 'utf8');
    check('D3: client constants に LEASE_SECONDS の複製がない', !/LEASE_SECONDS/.test(clientConst));
  }

  // D4. clampPollDelay は不正 retryAfterMs を安全域へ clamp。
  {
    check('D4a: 負値 → MIN', clampPollDelay(-5) === MIN_POLL_MS);
    check('D4b: 過大 → MAX', clampPollDelay(10 ** 9) === MAX_POLL_MS);
    check('D4c: NaN → MIN', clampPollDelay(NaN) === MIN_POLL_MS);
    check('D4d: Infinity（非有限）→ MIN（安全側）', clampPollDelay(Infinity) === MIN_POLL_MS);
    check('D4e: 非数値 → MIN', clampPollDelay('soon') === MIN_POLL_MS);
    check('D4f: 正常値は保持', clampPollDelay(3000) === 3000);
  }

  // D5. 未知 error_code は非 retryable（自動再送しない）。
  {
    check('D5a: 未知コードは isRetryableErrorCode=false', isRetryableErrorCode('SOMETHING_NEW') === false);
    check('D5b: retryable allowlist は true', isRetryableErrorCode('PROVIDER_TIMEOUT') === true);
    check('D5c: nonretryable は false', isRetryableErrorCode('SCHEMA_VALIDATION_FAILED') === false);
  }

  // D6. GET status route は claim/write（rpc/insert/update）をしない。
  {
    const getSrc = readFileSync(join(ROOT, 'app/api/career/self-analysis/job/route.ts'), 'utf8');
    check('D6a: GET route に .rpc( がない', !/\.rpc\(/.test(getSrc));
    check('D6b: GET route に .insert( がない', !/\.insert\(/.test(getSrc));
    check('D6c: GET route に .update( がない', !/\.update\(/.test(getSrc));
  }

  // D7. pending に raw 本文（profile/activity/conversation の secret）が保存されない。
  {
    const h = mk();
    h.post.push({ kind: 'ok', status: 202, body: { status: 'running', jobId: 'jd7', retryAfterMs: 1000 } });
    h.c.submit();
    await flush();
    const raw = h.storage.getItem(keyForOwner('u1')) ?? '';
    check('D7a: pending raw に profile secret が含まれない', !raw.includes(SECRET_NAME));
    check('D7b: pending raw に conversation secret が含まれない', !raw.includes(SECRET_ANSWER));
    const parsed = JSON.parse(raw);
    const allowedKeys = ['version', 'ownerScope', 'jobId', 'clientFingerprint', 'requestState', 'createdAt', 'lastCheckedAt', 'promptRevision', 'outputSchemaRevision'].sort();
    check('D7c: pending のキーは許可 9 フィールドのみ',
      JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(allowedKeys), Object.keys(parsed).sort().join(','));
    check('D7d: pending に result / error / prompt本文 / token フィールドがない',
      !('result' in parsed) && !('error' in parsed) && !('errorCode' in parsed) && !('attemptToken' in parsed) && !('idempotencyKey' in parsed));
  }

  // D8. client は POST body に idempotency key / user id を付けない（server-authoritative）。
  {
    const h = mk();
    h.post.push({ kind: 'ok', status: 202, body: { status: 'running', jobId: 'jd8', retryAfterMs: 1000 } });
    h.c.submit();
    await flush();
    const sent = h.postBodies[0] as Record<string, unknown>;
    const keys = Object.keys(sent).sort();
    check('D8a: 送信 body に idempotencyKey がない', !('idempotencyKey' in sent) && !('idempotency_key' in sent));
    check('D8b: 送信 body に userId がない', !('userId' in sent) && !('user_id' in sent));
    check('D8c: 送信 body は入力フィールドのみ',
      JSON.stringify(keys) === JSON.stringify(['activity', 'conversation', 'pastSummaries', 'profile', 'userInput', 'values'].sort()), keys.join(','));
  }

  // D9. completed は 1 度だけ finalize / navigate（重複 poll でも二重発火しない）。
  {
    const h = mk();
    h.post.push({ kind: 'ok', status: 202, body: { status: 'running', jobId: 'jd9', retryAfterMs: 1000 } });
    h.get.push({ kind: 'ok', status: 200, body: { status: 'completed', jobId: 'jd9', result: { summary: 'ok' } } });
    h.c.submit();
    await flush();
    await h.env.advance(2_000);
    // completed 後に追加 poll / recheck が来ても再発火しない。
    h.c.recheck();
    await flush();
    await h.env.advance(2_000);
    check('D9: completed 後 recheck しても finalize/navigate は各 1 回', h.counts.finalize === 1 && h.counts.nav === 1);
  }

  // ── 結果集計 ─────────────────────────────────────────────────────
  if (failures > 0) {
    console.error(`\ncareer-generation-job-step4-qa: ${failures} FAIL`);
    process.exit(1);
  }
  console.log('\ncareer-generation-job-step4-qa: ALL PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
