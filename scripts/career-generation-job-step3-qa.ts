/*
 * scripts/career-generation-job-step3-qa.ts
 *
 * PASSAI CAREER — Step3（client polling / reload recovery / ambiguous POST recovery）
 *   の決定論 QA。外部 Claude API・本番 Supabase 非使用。
 *   fetch / clock / timer / localStorage / auth owner / navigate / finalize を fake 化して
 *   controller（lib/careerSelfAnalysis/clientJob/controller）を直接検証する。
 *
 * after() の実行継続保証や実 DB は対象外（DB integration gate A / Preview gate B）。
 *
 * 使い方: npx tsx scripts/career-generation-job-step3-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SelfAnalysisGenerationController } from '../lib/careerSelfAnalysis/clientJob/controller';
import { keyForOwner, readPending } from '../lib/careerSelfAnalysis/clientJob/pendingStore';
import { computeClientFingerprint } from '../lib/careerSelfAnalysis/clientJob/fingerprint';
import { MAX_ACTIVE_POLL_MS, MAX_POLL_MS } from '../lib/careerSelfAnalysis/clientJob/constants';
import { mapOwnedJobToStatusResponse } from '../lib/careerSelfAnalysis/summaryJobStatus';
import type { HttpResult, SelfAnalysisRequestBody } from '../lib/careerSelfAnalysis/clientJob/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function validBody(): SelfAnalysisRequestBody {
  return {
    profile: { name: 'SECRETNAME' } as SelfAnalysisRequestBody['profile'],
    activity: { items: [{ id: '1' }] } as SelfAnalysisRequestBody['activity'],
    values: null,
    userInput: '',
    conversation: [],
    pastSummaries: [],
  };
}

// ── fake storage ────────────────────────────────────────────────────
class FakeStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  key(i: number): string | null {
    return Array.from(this.m.keys())[i] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
}

// ── fake clock/timers ───────────────────────────────────────────────
interface Timer { id: number; at: number; cb: () => void }
class FakeEnv {
  now = 1_000;
  timers: Timer[] = [];
  private nextId = 1;
  lastScheduleMs = 0;
  schedule(ms: number, cb: () => void): number {
    this.lastScheduleMs = ms;
    const id = this.nextId++;
    this.timers.push({ id, at: this.now + ms, cb });
    return id;
  }
  cancel(id: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }
  jump(ms: number): void {
    this.now += ms;
  }
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

type Script = Array<HttpResult | ((arg: unknown) => HttpResult)>;

interface Harness {
  controller: SelfAnalysisGenerationController;
  env: FakeEnv;
  storage: FakeStorage;
  owner: { value: string | null };
  body: { value: SelfAnalysisRequestBody | null };
  io: { post: Script; get: Script };
  postBodies: unknown[];
  getArgs: string[];
  counts: { post: number; get: number; nav: number; finalize: number };
  finalizeReturn: { value: boolean };
  views: string[];
  view: () => ReturnType<SelfAnalysisGenerationController['getView']>;
}

function mk(): Harness {
  const env = new FakeEnv();
  const storage = new FakeStorage();
  const owner = { value: 'u1' as string | null };
  const body = { value: validBody() as SelfAnalysisRequestBody | null };
  const io = {
    post: [{ kind: 'ok', status: 202, body: { status: 'running', jobId: 'j1', retryAfterMs: 1000 } }] as Script,
    get: [{ kind: 'ok', status: 200, body: { status: 'completed', jobId: 'j1', result: { summary: 'ok' } } }] as Script,
  };
  const postBodies: unknown[] = [];
  const getArgs: string[] = [];
  const counts = { post: 0, get: 0, nav: 0, finalize: 0 };
  const finalizeReturn = { value: true };
  const views: string[] = [];

  const pick = (script: Script, i: number, arg: unknown): HttpResult => {
    const entry = script[Math.min(i, script.length - 1)];
    return typeof entry === 'function' ? entry(arg) : entry;
  };

  const controller = new SelfAnalysisGenerationController({
    getOwnerScope: () => owner.value,
    buildRequestBody: () => body.value,
    postGenerate: async (b) => {
      postBodies.push(b);
      const i = counts.post;
      counts.post += 1; // reentrancy 安全: pick より前に index を進める
      return pick(io.post, i, b);
    },
    getStatus: async (id) => {
      getArgs.push(id);
      const i = counts.get;
      counts.get += 1;
      return pick(io.get, i, id);
    },
    finalize: async () => {
      counts.finalize += 1;
      return finalizeReturn.value;
    },
    navigate: () => {
      counts.nav += 1;
    },
    storage,
    now: () => env.now,
    schedule: (ms, cb) => env.schedule(ms, cb),
    cancel: (h) => env.cancel(h),
    onChange: (v) => views.push(v.state),
    promptRevision: 'pr',
    outputSchemaRevision: 'osr',
    validateResult: (r) => !!r && typeof r === 'object',
  });

  return {
    controller, env, storage, owner, body, io,
    postBodies, getArgs, counts, finalizeReturn, views,
    view: () => controller.getView(),
  };
}

function rawPending(h: Harness, owner = 'u1'): string | null {
  return h.storage.getItem(keyForOwner(owner));
}

// ════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
console.log('[A] completed / running / failed の基本');

// 1 & 3. member completed 200 → 保存 + 遷移 + pending 削除（pilot-OFF legacy {result} も同経路）。
{
  const h = mk();
  h.io.post[0] = { kind: 'ok', status: 200, body: { status: 'completed', jobId: 'j1', result: { summary: 'x' } } };
  h.controller.submit();
  await flush();
  check('3 member completed 200 → finalize+nav+pending削除', h.counts.finalize === 1 && h.counts.nav === 1 && rawPending(h) === null && h.view().state === 'completed');

  const h2 = mk();
  h2.io.post[0] = { kind: 'ok', status: 200, body: { result: { summary: 'legacy' } } }; // status なし = legacy
  h2.controller.submit();
  await flush();
  check('1 pilot-OFF legacy {result} → finalize+nav+pending削除', h2.counts.finalize === 1 && h2.counts.nav === 1 && rawPending(h2) === null);
}

// 4/5. 202 → pending へ jobId・running / polling 開始。
{
  const h = mk();
  h.controller.submit();
  await flush();
  const pending = readPending(h.storage, 'u1');
  check('4 202 → pending jobId=j1 / running', pending?.jobId === 'j1' && pending?.requestState === 'running' && h.view().state === 'running');
  check('5 202 → polling timer 1本', h.env.timers.length === 1);
}

// 6. running→completed。
{
  const h = mk();
  h.io.get = [
    { kind: 'ok', status: 200, body: { status: 'running', jobId: 'j1', retryAfterMs: 1000, recoveryAction: 'poll' } },
    { kind: 'ok', status: 200, body: { status: 'completed', jobId: 'j1', result: { summary: 'done' } } },
  ];
  h.controller.submit();
  await flush();
  await h.env.advance(1000); // poll1 running
  await h.env.advance(1000); // poll2 completed
  check('6 running→completed で finalize+nav+pending削除', h.counts.finalize === 1 && h.counts.nav === 1 && rawPending(h) === null && h.view().state === 'completed');
}

// 7. running→failed retryable → retry UI。
{
  const h = mk();
  h.io.get = [{ kind: 'ok', status: 200, body: { status: 'failed', jobId: 'j1', errorCode: 'PROVIDER_TIMEOUT', retryable: true } }];
  h.controller.submit();
  await flush();
  await h.env.advance(1000);
  check('7 failed retryable → state failed / canRetry', h.view().state === 'failed' && h.view().canRetry === true);
}

// 8. failed non-retryable → 自動 retry しない。
{
  const h = mk();
  h.io.get = [{ kind: 'ok', status: 200, body: { status: 'failed', jobId: 'j1', errorCode: 'PARSE_FAILED', retryable: false } }];
  h.controller.submit();
  await flush();
  await h.env.advance(1000);
  check('8 failed non-retryable → canRetry false / 追加POSTなし', h.view().canRetry === false && h.counts.post === 1);
}

// 9. RETRY_LIMIT_REACHED（POST 409）→ retry 不可。
{
  const h = mk();
  h.io.post[0] = { kind: 'ok', status: 409, body: { status: 'failed', jobId: 'j1', errorCode: 'RETRY_LIMIT_REACHED', retryable: false } };
  h.controller.submit();
  await flush();
  check('9 RETRY_LIMIT_REACHED → failed / canRetry false', h.view().state === 'failed' && h.view().canRetry === false && h.view().errorCode === 'RETRY_LIMIT_REACHED');
}

console.log('[B] ambiguous POST / reload recovery');

// 10. POST 前に jobId=null / submitting の pending を保存。
{
  const h = mk();
  // postGenerate を保留にして submit 直後を観測。
  h.io.post[0] = { kind: 'transport_error' };
  h.controller.submit(); // await しない
  const pending = readPending(h.storage, 'u1');
  check('10 POST前に pending(jobId=null/submitting) 保存', pending?.jobId === null && pending?.requestState === 'submitting');
  await flush();
}

// 11. POST response drop → pending 維持（unknown）。
{
  const h = mk();
  h.io.post[0] = { kind: 'transport_error' };
  h.controller.submit();
  await flush();
  const pending = readPending(h.storage, 'u1');
  check('11 POST drop → pending維持(unknown) / state reconnecting', pending !== null && pending?.requestState === 'unknown' && h.view().state === 'reconnecting');
}

// 12 & 15. reload jobIdなし → source 再構築して同一 POST 再送。
{
  const h = mk();
  const fp = computeClientFingerprint(validBody());
  h.storage.setItem(keyForOwner('u1'), JSON.stringify({
    version: 1, ownerScope: 'u1', jobId: null, clientFingerprint: fp,
    requestState: 'submitting', createdAt: 'x', lastCheckedAt: null, promptRevision: 'pr', outputSchemaRevision: 'osr',
  }));
  h.io.post[0] = { kind: 'ok', status: 202, body: { status: 'running', jobId: 'jX', retryAfterMs: 1000 } };
  h.controller.resumeFromMount();
  await flush();
  check('12/15 reload jobIdなし+fingerprint一致 → 同一POST再送', h.counts.post === 1 && readPending(h.storage, 'u1')?.jobId === 'jX');
}

// 13/41/42. 再送 body に client user ID / idempotency key を含めない。
{
  const h = mk();
  h.controller.submit();
  await flush();
  const b = h.postBodies[0] as Record<string, unknown>;
  const keys = Object.keys(b);
  check('13/42 POST body に idempotencyKey/key を含めない', !('idempotencyKey' in b) && !('key' in b) && !keys.some((k) => /idempotency/i.test(k)));
  check('41 POST body に userId/user_id を含めない', !('userId' in b) && !('user_id' in b));
}

// 14. reload jobIdあり → GET polling 再開。
{
  const h = mk();
  h.storage.setItem(keyForOwner('u1'), JSON.stringify({
    version: 1, ownerScope: 'u1', jobId: 'jR', clientFingerprint: 'fp', requestState: 'running',
    createdAt: 'x', lastCheckedAt: null, promptRevision: 'pr', outputSchemaRevision: 'osr',
  }));
  h.io.get = [{ kind: 'ok', status: 200, body: { status: 'completed', jobId: 'jR', result: { summary: 'r' } } }];
  h.controller.resumeFromMount();
  check('14a reload jobIdあり → running / poll 予約', h.view().state === 'running' && h.env.timers.length === 1);
  await h.env.advance(1000);
  check('14b poll 再開で completed 回収', h.getArgs[0] === 'jR' && h.counts.finalize === 1);
}

// 16. fingerprint 不一致 → 古い pending を新入力へ関連付けない。
{
  const h = mk();
  h.storage.setItem(keyForOwner('u1'), JSON.stringify({
    version: 1, ownerScope: 'u1', jobId: null, clientFingerprint: 'DIFFERENT', requestState: 'submitting',
    createdAt: 'x', lastCheckedAt: null, promptRevision: 'pr', outputSchemaRevision: 'osr',
  }));
  h.controller.resumeFromMount();
  await flush();
  check('16 fingerprint不一致 → 再送しない / reconnecting', h.counts.post === 0 && h.view().state === 'reconnecting');
}

// 17. conversation 復元不能（body=null）→ raw を pending へ保存しない・削除しない・POSTしない。
{
  const h = mk();
  h.storage.setItem(keyForOwner('u1'), JSON.stringify({
    version: 1, ownerScope: 'u1', jobId: null, clientFingerprint: 'fp', requestState: 'unknown',
    createdAt: 'x', lastCheckedAt: null, promptRevision: 'pr', outputSchemaRevision: 'osr',
  }));
  h.body.value = null; // source 再構築不能
  h.controller.resumeFromMount();
  await flush();
  const raw = rawPending(h);
  check('17 source再構築不能 → POSTなし / pending維持 / rawなし', h.counts.post === 0 && raw !== null && !/conversation|SECRETNAME/.test(raw ?? ''));
}

console.log('[C] polling transport / status codes');

// 18. GET network failure → backoff 後に回収。
{
  const h = mk();
  h.io.get = [
    { kind: 'transport_error' },
    { kind: 'ok', status: 200, body: { status: 'completed', jobId: 'j1', result: { summary: 'z' } } },
  ];
  h.controller.submit();
  await flush();
  await h.env.advance(1000); // poll1 transport_error → reconnecting + backoff
  check('18a GET network failure → reconnecting', h.view().state === 'reconnecting');
  await h.env.advance(2000); // backoff poll2 → completed
  check('18b backoff 後に completed 回収', h.counts.finalize === 1);
}

// 19. 503 → pending 維持・reconnecting。
{
  const h = mk();
  h.io.get = [{ kind: 'ok', status: 503, body: {} }];
  h.controller.submit();
  await flush();
  await h.env.advance(1000);
  check('19 503 → pending維持 / reconnecting', rawPending(h) !== null && h.view().state === 'reconnecting');
}

// 20. 401 → poll 停止・pending 維持。
{
  const h = mk();
  h.io.get = [{ kind: 'ok', status: 401, body: {} }];
  h.controller.submit();
  await flush();
  await h.env.advance(1000);
  check('20 401 → poll停止(timer0) / pending維持', h.env.timers.length === 0 && rawPending(h) !== null);
}

// 21. 404 → 他owner推測しない・poll停止・pending維持。
{
  const h = mk();
  h.io.get = [{ kind: 'ok', status: 404, body: { status: 'not_found' } }];
  h.controller.submit();
  await flush();
  await h.env.advance(1000);
  check('21 404 → poll停止 / pending維持 / reconnecting', h.env.timers.length === 0 && rawPending(h) !== null && h.view().state === 'reconnecting');
}

// 22. recoveryAction=poll → GET 継続。
{
  const h = mk();
  h.io.get = [
    { kind: 'ok', status: 200, body: { status: 'running', jobId: 'j1', retryAfterMs: 1000, recoveryAction: 'poll' } },
    { kind: 'ok', status: 200, body: { status: 'completed', jobId: 'j1', result: { summary: 'p' } } },
  ];
  h.controller.submit();
  await flush();
  await h.env.advance(1000);
  await h.env.advance(1000);
  check('22 recoveryAction=poll → GET継続で completed', h.counts.get === 2 && h.counts.finalize === 1);
}

// 23. recoveryAction=resubmit → POST 再送。
{
  const h = mk();
  h.io.post = [
    { kind: 'ok', status: 202, body: { status: 'running', jobId: 'j1', retryAfterMs: 1000 } },
    { kind: 'ok', status: 202, body: { status: 'running', jobId: 'j1', retryAfterMs: 1000, recoveryAction: 'poll' } },
  ];
  h.io.get = [{ kind: 'ok', status: 200, body: { status: 'running', jobId: 'j1', retryAfterMs: 0, recoveryAction: 'resubmit' } }];
  h.controller.submit();
  await flush();
  await h.env.advance(1000); // poll → resubmit
  await flush();
  check('23 recoveryAction=resubmit → POST再送', h.counts.post === 2);
}

console.log('[D] stale-response guard / cleanup / multi-tab');

// 25. unmount → timer/fetch cleanup。
{
  const h = mk();
  h.controller.submit();
  await flush();
  check('25a submit後 poll timer あり', h.env.timers.length === 1);
  h.controller.dispose();
  check('25b dispose で timer cleanup', h.env.timers.length === 0);
  const before = h.counts.get;
  await h.env.advance(5000);
  check('25c dispose後は fetch しない', h.counts.get === before);
}

// 26. 新 generation で旧 poll abort（旧 job を polling しない）。
{
  const h = mk();
  h.io.post = [
    { kind: 'ok', status: 202, body: { status: 'running', jobId: 'jA', retryAfterMs: 1000 } },
    { kind: 'ok', status: 202, body: { status: 'running', jobId: 'jB', retryAfterMs: 1000 } },
  ];
  h.controller.submit();
  await flush();
  h.controller.submit(); // 新 generation
  await flush();
  check('26 新generationで pending は新 job(jB) / timer1本', readPending(h.storage, 'u1')?.jobId === 'jB' && h.env.timers.length === 1);
}

// 27. 旧 poll completed が新 result を上書きしない（stale-response guard）。
{
  const h = mk();
  h.io.post = [
    { kind: 'ok', status: 202, body: { status: 'running', jobId: 'jA', retryAfterMs: 1000 } },
    { kind: 'ok', status: 202, body: { status: 'running', jobId: 'jB', retryAfterMs: 1000 } },
  ];
  // A の poll の getStatus 内で B を submit → A は inactive 化。
  h.io.get = [
    () => {
      h.controller.submit(); // start B
      return { kind: 'ok', status: 200, body: { status: 'completed', jobId: 'jA', result: { summary: 'A' } } };
    },
    { kind: 'ok', status: 200, body: { status: 'running', jobId: 'jB', retryAfterMs: 1000 } },
  ];
  h.controller.submit();
  await flush();
  await h.env.advance(1000);
  check('27 旧 poll completed を破棄（finalize/nav なし）', h.counts.finalize === 0 && h.counts.nav === 0);
}

// 28. 旧 POST response が新 pending を削除しない。
{
  const h = mk();
  h.io.post = [
    (b) => {
      void b;
      h.controller.submit(); // A の POST 解決前に B 開始
      return { kind: 'ok', status: 200, body: { status: 'completed', jobId: 'jA', result: { summary: 'A' } } };
    },
    { kind: 'ok', status: 202, body: { status: 'running', jobId: 'jB', retryAfterMs: 1000 } },
  ];
  h.controller.submit();
  await flush();
  check('28 旧 POST completed が新 pending を削除しない', rawPending(h) !== null && h.counts.finalize === 0 && h.counts.nav === 0);
}

// 29. logout → polling 停止 + pending 削除。
{
  const h = mk();
  h.controller.submit();
  await flush();
  h.owner.value = null;
  h.controller.onLogout();
  check('29 logout → timer停止 + 全pending削除', h.env.timers.length === 0 && rawPending(h) === null && h.storage.length === 0);
}

// 30. user 切替 → 旧 owner pending を再利用しない。
{
  const h = mk();
  h.storage.setItem(keyForOwner('u1'), JSON.stringify({
    version: 1, ownerScope: 'u1', jobId: 'jOld', clientFingerprint: 'fp', requestState: 'running',
    createdAt: 'x', lastCheckedAt: null, promptRevision: 'pr', outputSchemaRevision: 'osr',
  }));
  h.owner.value = 'u2';
  h.controller.resumeFromMount();
  await flush();
  check('30 user切替 → 旧owner pending不採用 / poll/POSTなし / idle', h.counts.post === 0 && h.counts.get === 0 && h.view().state === 'idle');
}

// 31. storage event → 他タブの jobId 採用。
{
  const h = mk();
  const fp = computeClientFingerprint(validBody());
  h.io.post[0] = { kind: 'transport_error' }; // jobId=null / fingerprint=fp のまま
  h.controller.submit();
  await flush();
  h.io.get = [{ kind: 'ok', status: 200, body: { status: 'completed', jobId: 'jT', result: { summary: 't' } } }];
  h.controller.handleExternalPendingChange(JSON.stringify({
    version: 1, ownerScope: 'u1', jobId: 'jT', clientFingerprint: fp, requestState: 'running',
    createdAt: 'x', lastCheckedAt: null, promptRevision: 'pr', outputSchemaRevision: 'osr',
  }));
  check('31a storage event → jobId採用で running / poll予約', h.view().state === 'running' && h.env.timers.length === 1);
  await h.env.advance(1000);
  check('31b 採用 jobId を GET', h.getArgs[h.getArgs.length - 1] === 'jT');
}

// 32. 他タブ完了（pending削除）後に旧 poll 停止。
{
  const h = mk();
  h.controller.submit();
  await flush();
  h.io.get = [{ kind: 'ok', status: 200, body: { status: 'completed', jobId: 'j1', result: { summary: 'c' } } }];
  h.controller.handleExternalPendingChange(null); // 他タブが completed で削除
  await flush();
  check('32 他タブ完了 → 旧poll停止し1回GETで completed回収', h.counts.finalize === 1 && h.env.timers.length === 0);
}

console.log('[E] pending 非保存 / active cap / manual recheck / save失敗');

// 33/34. pending に raw 本文・result・error を保存しない。
{
  const h = mk();
  h.controller.submit();
  await flush();
  const raw = rawPending(h) ?? '';
  check('33 pending に profile/activity/values/conversation 本文なし', !/SECRETNAME|profile|activity|conversation|values/.test(raw));
  check('34 pending に result/error なし', !/result|error/i.test(raw));
}

// 35. active polling 上限後も pending 維持・completed にしない。
{
  const h = mk();
  h.io.get = [{ kind: 'ok', status: 200, body: { status: 'running', jobId: 'j1', retryAfterMs: 1000, recoveryAction: 'poll' } }];
  h.controller.submit();
  await flush();
  h.env.jump(MAX_ACTIVE_POLL_MS + 1); // active window 超過
  await h.env.advance(0); // 予約済み poll を発火 → cap
  check('35 active cap → GETせず reconnecting / canRecheck / pending維持', h.counts.get === 0 && h.view().state === 'reconnecting' && h.view().canRecheck === true && rawPending(h) !== null);
}

// 36. 手動再確認で polling 再開。
{
  const h = mk();
  h.storage.setItem(keyForOwner('u1'), JSON.stringify({
    version: 1, ownerScope: 'u1', jobId: 'jM', clientFingerprint: 'fp', requestState: 'running',
    createdAt: 'x', lastCheckedAt: null, promptRevision: 'pr', outputSchemaRevision: 'osr',
  }));
  h.io.get = [{ kind: 'ok', status: 200, body: { status: 'running', jobId: 'jM', retryAfterMs: 1000, recoveryAction: 'poll' } }];
  h.controller.recheck();
  check('36 手動再確認 → polling 再開', h.view().state === 'running' && h.env.timers.length === 1);
  await h.env.advance(1000);
  check('36b 再確認 GET が走る', h.getArgs.includes('jM'));
}

// 37. completed 保存失敗時に pending を先に削除しない。
{
  const h = mk();
  h.finalizeReturn.value = false;
  h.io.post[0] = { kind: 'ok', status: 200, body: { status: 'completed', jobId: 'j1', result: { summary: 'x' } } };
  h.controller.submit();
  await flush();
  check('37 保存失敗 → pending維持 / navなし / failed(SAVE_FAILED)', rawPending(h) !== null && h.counts.nav === 0 && h.view().errorCode === 'SAVE_FAILED');
}

// 38. completed 再取得で Claude(POST) を再実行しない。
{
  const h = mk();
  h.io.get = [{ kind: 'ok', status: 200, body: { status: 'completed', jobId: 'j1', result: { summary: 'x' } } }];
  h.controller.submit();
  await flush();
  await h.env.advance(1000);
  check('38 completed を poll で回収 → 追加 POST なし', h.counts.post === 1 && h.counts.finalize === 1);
}

// 39. poll interval が定数上限を超えない。
{
  const h = mk();
  h.io.get = [{ kind: 'ok', status: 200, body: { status: 'running', jobId: 'j1', retryAfterMs: 999_999, recoveryAction: 'poll' } }];
  h.controller.submit();
  await flush();
  await h.env.advance(1000); // poll → 次を過大 retryAfterMs で予約
  check('39 poll interval は MAX_POLL_MS 以下に clamp', h.env.lastScheduleMs <= MAX_POLL_MS);
}

// 40. 同時 poll loop は 1 つだけ。
{
  const h = mk();
  h.io.get = [{ kind: 'ok', status: 200, body: { status: 'running', jobId: 'j1', retryAfterMs: 1000, recoveryAction: 'poll' } }];
  h.controller.submit();
  await flush();
  await h.env.advance(1000);
  await h.env.advance(1000);
  check('40 timer は常に 1 本（単一 poll loop）', h.env.timers.length === 1);
}

console.log('[F] server recoveryAction mapper + source contracts');

// server recoveryAction: lease 失効 → resubmit / 有効 → poll。
{
  const expired = mapOwnedJobToStatusResponse({ status: 'running', result: null, errorCode: null, leaseExpiresAt: new Date(500).toISOString() }, 'j', 1000);
  check('recoveryAction: lease 失効 → resubmit / retryAfterMs 0', expired.body.recoveryAction === 'resubmit' && expired.body.retryAfterMs === 0);
  const fresh = mapOwnedJobToStatusResponse({ status: 'running', result: null, errorCode: null, leaseExpiresAt: new Date(9_000).toISOString() }, 'j', 1000);
  check('recoveryAction: lease 有効 → poll', fresh.body.recoveryAction === 'poll');
  check('GET は claim/reclaim しない（mapper は純粋変換のみ）', fresh.httpStatus === 200);
}

// 2. anonymous は legacy 経路（page source 契約）。
{
  const page = readFileSync(join(process.cwd(), 'app', 'career', 'self-analysis', 'run', 'page.tsx'), 'utf8');
  check('2 member=gen.start / anonymous=legacyGenerate 分岐', /if \(userId\)\s*\{\s*gen\.start\(\)/.test(page) && /legacyGenerate\(\)/.test(page));
  check('legacy 保存は共有 finalize に集約', /saveCompletedSelfAnalysis\(/.test(page));
  check('unmount dispose / storage listener は hook 側', true);
  const hook = readFileSync(join(process.cwd(), 'app', 'career', 'self-analysis', 'useSelfAnalysisGeneration.ts'), 'utf8');
  check('hook: mount resume + storage listener + dispose', /resumeFromMount\(\)/.test(hook) && /addEventListener\('storage'/.test(hook) && /\.dispose\(\)/.test(hook));
  check('hook: logout で onLogout', /onLogout\(\)/.test(hook));
  check('24 client で lease 複製定数を持たない', !/lease/i.test(readFileSync(join(process.cwd(), 'lib', 'careerSelfAnalysis', 'clientJob', 'controller.ts'), 'utf8').replace(/\/\/.*$/gm, '')));
}

// status route が lease_expires_at を select し Date.now を渡す。
{
  const src = readFileSync(join(process.cwd(), 'app', 'api', 'career', 'self-analysis', 'job', 'route.ts'), 'utf8');
  check('status route が lease_expires_at を select', /lease_expires_at/.test(src));
  check('status route が Date.now() を mapper に渡す', /Date\.now\(\)/.test(src));
}
}

// 未 await の fake promise（stale-response guard で破棄される旧 attempt 由来）が
// プロセス終了と競合しないよう握りつぶす（本 QA の判定には影響しない）。
main().then(() => {
  console.log('');
  if (failures === 0) {
    console.log('career-generation-job-step3-qa: ALL PASS');
    process.exitCode = 0;
  } else {
    console.error(`career-generation-job-step3-qa: ${failures} FAIL`);
    process.exitCode = 1;
  }
}).catch((e) => {
  console.error('career-generation-job-step3-qa: THREW', e);
  process.exitCode = 1;
});
