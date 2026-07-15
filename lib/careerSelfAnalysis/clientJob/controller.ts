// 自己分析まとめ生成 — client 追跡 controller（Step3 / members pilot 専用）。
//
// submit → (202) polling → completed/failed、POST 応答不明・reload・stale running・
// retryable failure・stale-response guard・multi-tab・cleanup を扱う。
// すべての副作用（fetch/clock/timer/storage/navigate/auth owner/finalize）を DI し、
// fake で決定論 QA する。React/DOM 非依存。
//
// 原則:
//   - client から user ID / idempotency key を request に足さない（server-authoritative）。
//   - client で lease 判定・二重実行判断をしない（server の claim / recoveryAction に従う）。
//   - stale reclaim は「同一 validated input の再 POST」で server に委ねる。
//   - raw 本文・result・error を pending へ保存しない。

import {
  MAX_ACTIVE_POLLS,
  MAX_ACTIVE_POLL_MS,
  MAX_TRANSPORT_RESUBMIT,
  MIN_POLL_MS,
  clampPollDelay,
  transportBackoffMs,
} from './constants';
import { computeClientFingerprint } from './fingerprint';
import {
  clearAllPending,
  clearPending,
  parsePending,
  readPending,
  writePending,
  type StorageLike,
} from './pendingStore';
import type {
  ActiveGenerationToken,
  FinalizeArgs,
  GenerationClientState,
  GenerationView,
  HttpResult,
  PendingSelfAnalysisJob,
  SelfAnalysisRequestBody,
} from './types';

export type TimerHandle = unknown;

export interface ControllerDeps {
  getOwnerScope: () => string | null;
  buildRequestBody: () => SelfAnalysisRequestBody | null;
  postGenerate: (body: SelfAnalysisRequestBody) => Promise<HttpResult>;
  getStatus: (jobId: string) => Promise<HttpResult>;
  finalize: (args: FinalizeArgs) => Promise<boolean>;
  navigate: () => void;
  storage: StorageLike;
  now: () => number;
  schedule: (ms: number, cb: () => void) => TimerHandle;
  cancel: (handle: TimerHandle) => void;
  onChange: (view: GenerationView) => void;
  promptRevision: string;
  outputSchemaRevision: string;
  validateResult?: (result: unknown) => boolean;
}

type SetStateOpts = { errorCode?: string | null; canRetry?: boolean; canRecheck?: boolean };

export class SelfAnalysisGenerationController {
  private readonly deps: ControllerDeps;
  private seq = 0;
  private activeToken: ActiveGenerationToken | null = null;
  private activeBody: SelfAnalysisRequestBody | null = null;
  private disposed = false;
  private timer: TimerHandle | null = null;
  private transportAttempts = 0;
  private pollCount = 0;
  private activeStartAt = 0;

  private state: GenerationClientState = 'idle';
  private errorCode: string | null = null;
  private canRetry = false;
  private canRecheck = false;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
  }

  // ── public API ────────────────────────────────────────────────────
  getView(): GenerationView {
    return { state: this.state, canRetry: this.canRetry, canRecheck: this.canRecheck, errorCode: this.errorCode };
  }

  /** 新規 submission（member のみ）。 */
  submit(): void {
    this.clearTimer();
    const owner = this.deps.getOwnerScope();
    if (!owner) {
      this.setState('failed', { errorCode: 'AUTH_TEMPORARILY_UNAVAILABLE', canRetry: true });
      return;
    }
    const body = this.deps.buildRequestBody();
    if (!body) {
      this.setState('failed', { errorCode: 'INVALID_INPUT' });
      return;
    }
    const fp = computeClientFingerprint(body);
    this.transportAttempts = 0;
    this.pollCount = 0;
    this.activeStartAt = this.deps.now();
    this.activeBody = body;
    const token = this.newToken(owner, fp, null);
    // POST 前 pending（jobId=null / submitting）: 応答受信前 reload でも未確定として復旧。
    writePending(this.deps.storage, {
      version: 1,
      ownerScope: owner,
      jobId: null,
      clientFingerprint: fp,
      requestState: 'submitting',
      createdAt: this.iso(),
      lastCheckedAt: null,
      promptRevision: this.deps.promptRevision,
      outputSchemaRevision: this.deps.outputSchemaRevision,
    });
    this.setState('submitting');
    void this.postOnce(token);
  }

  /** ユーザー retry（同一 source を再 validate + fingerprint 確認して再送）。 */
  retry(): void {
    this.submit();
  }

  /** 手動「処理状況を再確認」。 */
  recheck(): void {
    this.resumeFromMount();
  }

  /** mount 時の復帰（pending から poll 再開 or 再 POST）。 */
  resumeFromMount(): void {
    this.clearTimer();
    const owner = this.deps.getOwnerScope();
    if (!owner) return; // owner 不明では polling を開始しない
    const pending = readPending(this.deps.storage, owner);
    if (!pending) {
      this.setState('idle');
      return;
    }
    this.transportAttempts = 0;
    this.pollCount = 0;
    this.activeStartAt = this.deps.now();

    if (pending.jobId) {
      // reload + jobId あり → GET polling 再開。
      const token = this.newToken(owner, pending.clientFingerprint, pending.jobId);
      this.activeBody = this.deps.buildRequestBody(); // resubmit 用（復元不能なら null）
      this.setState('running', { canRecheck: true });
      this.startPolling(token, MIN_POLL_MS);
      return;
    }

    // jobId なし（submitting/unknown のまま reload）。
    const body = this.deps.buildRequestBody();
    if (!body) {
      // source 再構築不能（例: conversation 復元不能）→ pending 削除せず案内。
      // raw conversation を pending へ複製保存しない（何もしない）。
      this.setState('reconnecting', { canRecheck: true });
      return;
    }
    const fp = computeClientFingerprint(body);
    if (fp !== pending.clientFingerprint) {
      // 入力が変わっている → 古い pending を新入力へ関連付けない。
      this.setState('reconnecting', { canRecheck: true });
      return;
    }
    this.activeBody = body;
    const token = this.newToken(owner, fp, null);
    this.setState('reconnecting');
    void this.postOnce(token);
  }

  /** 他タブの pending 変更（storage event）。 */
  handleExternalPendingChange(rawNewValue: string | null): void {
    const owner = this.deps.getOwnerScope();
    if (!owner) return;
    if (rawNewValue === null) {
      // 他タブが pending 削除（completed）→ 実行中 poll を止め、1 回 GET で completed 回収。
      const token = this.activeToken;
      if (token && token.jobId) {
        this.clearTimer();
        void this.pollOnce(token);
      }
      return;
    }
    const p = parsePending(rawNewValue, owner);
    if (!p || !p.jobId) return;
    const token = this.activeToken;
    if (token && token.clientFingerprint === p.clientFingerprint && !token.jobId) {
      // 同一 owner + fingerprint で他タブが jobId 確定 → 採用して polling。
      token.jobId = p.jobId;
      this.setState('running');
      this.startPolling(token, MIN_POLL_MS);
    }
  }

  /** logout: polling 停止 + 全 owner pending 削除。 */
  onLogout(): void {
    this.invalidate();
    clearAllPending(this.deps.storage);
    this.setState('idle');
  }

  /** component unmount: timer/fetch を無効化。 */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  // ── internal ──────────────────────────────────────────────────────
  private invalidate(): void {
    this.clearTimer();
    this.activeToken = null;
    this.activeBody = null;
    this.seq += 1; // in-flight 応答を無効化
  }

  private newToken(ownerScope: string, fp: string, jobId: string | null): ActiveGenerationToken {
    this.seq += 1;
    const token: ActiveGenerationToken = { sequence: this.seq, ownerScope, clientFingerprint: fp, jobId };
    this.activeToken = token;
    return token;
  }

  private isActive(token: ActiveGenerationToken): boolean {
    return (
      !this.disposed &&
      this.activeToken === token &&
      token.sequence === this.seq &&
      token.ownerScope === this.deps.getOwnerScope()
    );
  }

  private async postOnce(token: ActiveGenerationToken): Promise<void> {
    const body = this.activeBody;
    if (!body) return;
    const res = await this.deps.postGenerate(body);
    if (!this.isActive(token)) return; // stale / owner 変化 / disposed → 破棄
    if (res.kind === 'transport_error') {
      this.onPostTransportError(token);
      return;
    }
    this.transportAttempts = 0;
    this.handleResponseBody(res.status, res.body, token, 'post');
  }

  private onPostTransportError(token: ActiveGenerationToken): void {
    // POST 応答不明 → pending を unknown / jobId=null で維持。
    this.patchPending(token, { requestState: 'unknown', jobId: null });
    this.setState('reconnecting', { canRecheck: true });
    if (this.transportAttempts < MAX_TRANSPORT_RESUBMIT) {
      const delay = transportBackoffMs(this.transportAttempts++);
      this.scheduleTimer(delay, () => {
        if (this.isActive(token)) void this.postOnce(token);
      });
    }
    // 上限到達時は pending 維持のまま手動再確認へ（reconnecting のまま）。
  }

  private handleResponseBody(
    status: number,
    rawBody: unknown,
    token: ActiveGenerationToken,
    source: 'post' | 'poll',
  ): void {
    const b = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
    if (typeof b.status === 'string') {
      if (b.status === 'completed') {
        void this.finalizeCompleted(b.result, token);
        return;
      }
      if (b.status === 'running') {
        const jobId = typeof b.jobId === 'string' ? b.jobId : null;
        if (!jobId) {
          this.setState('reconnecting', { canRecheck: true });
          return;
        }
        token.jobId = jobId;
        this.patchPending(token, { requestState: 'running', jobId });
        this.setState('running');
        this.startPolling(token, clampPollDelay(b.retryAfterMs));
        return;
      }
      if (b.status === 'failed') {
        this.handleFailed(status, b, token, source);
        return;
      }
      this.setState('reconnecting', { canRecheck: true });
      return;
    }
    // legacy completed（status なし・result あり）: pilot OFF member。
    if ('result' in b) {
      void this.finalizeCompleted(b.result, token);
      return;
    }
    this.setState('failed', { errorCode: 'PARSE_FAILED' });
  }

  private handleFailed(
    httpStatus: number,
    b: Record<string, unknown>,
    token: ActiveGenerationToken,
    source: 'post' | 'poll',
  ): void {
    const errorCode = typeof b.errorCode === 'string' ? b.errorCode : 'UNKNOWN';
    const retryable = b.retryable === true;
    // POST-time の infra 5xx retryable（storage/auth unavailable）は transport 的に扱う。
    if (source === 'post' && httpStatus >= 500 && retryable) {
      this.onPostTransportError(token);
      return;
    }
    this.clearTimer();
    // generation retryable failure → 手動 retry（自動 Claude 再実行はしない）。
    // non-retryable（RETRY_LIMIT_REACHED / INVALID_INPUT / parse 等）→ retry 不可。
    this.setState('failed', { errorCode, canRetry: retryable, canRecheck: false });
  }

  private startPolling(token: ActiveGenerationToken, firstDelayMs: number): void {
    this.pollCount = 0;
    this.scheduleTimer(firstDelayMs, () => {
      void this.pollOnce(token);
    });
  }

  private async pollOnce(token: ActiveGenerationToken): Promise<void> {
    if (!this.isActive(token) || !token.jobId) return;
    // active polling 上限: pending を消さず・completed にせず・新 attempt もせず「再確認」へ。
    if (this.pollCount >= MAX_ACTIVE_POLLS || this.deps.now() - this.activeStartAt >= MAX_ACTIVE_POLL_MS) {
      this.setState('reconnecting', { canRecheck: true });
      return;
    }
    this.pollCount += 1;
    const res = await this.deps.getStatus(token.jobId);
    if (!this.isActive(token)) return;
    this.patchPending(token, { lastCheckedAt: this.iso() });
    if (res.kind === 'transport_error') {
      this.setState('reconnecting', { canRecheck: true });
      const delay = transportBackoffMs(this.transportAttempts++);
      this.scheduleTimer(delay, () => void this.pollOnce(token));
      return;
    }
    this.transportAttempts = 0;
    this.handlePollResponse(res.status, res.body, token);
  }

  private handlePollResponse(status: number, rawBody: unknown, token: ActiveGenerationToken): void {
    if (status === 401) {
      // session 喪失 → poll 停止・pending 維持。
      this.clearTimer();
      this.setState('reconnecting', { errorCode: 'AUTH_TEMPORARILY_UNAVAILABLE', canRecheck: true });
      return;
    }
    if (status === 404) {
      // 他 owner / not-found を区別しない。poll 停止・pending 維持。
      this.clearTimer();
      this.setState('reconnecting', { canRecheck: true });
      return;
    }
    if (status === 503) {
      this.setState('reconnecting', { canRecheck: true });
      const delay = transportBackoffMs(this.transportAttempts++);
      this.scheduleTimer(delay, () => void this.pollOnce(token));
      return;
    }
    const b = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
    if (status === 200 && typeof b.status === 'string') {
      if (b.status === 'completed') {
        void this.finalizeCompleted(b.result, token);
        return;
      }
      if (b.status === 'failed') {
        this.handleFailed(200, b, token, 'poll');
        return;
      }
      if (b.status === 'running') {
        if (b.recoveryAction === 'resubmit') {
          void this.resubmit(token);
          return;
        }
        this.setState('running', { canRecheck: true });
        this.scheduleTimer(clampPollDelay(b.retryAfterMs), () => void this.pollOnce(token));
        return;
      }
    }
    this.setState('reconnecting', { canRecheck: true });
  }

  private async resubmit(token: ActiveGenerationToken): Promise<void> {
    // stale reclaim: 同一 body を再 POST。lease 判定・reclaim 可否は server が決める。
    if (!this.activeBody) {
      this.setState('reconnecting', { canRecheck: true });
      return;
    }
    this.setState('reconnecting');
    await this.postOnce(token);
  }

  private async finalizeCompleted(result: unknown, token: ActiveGenerationToken): Promise<void> {
    if (!this.isActive(token)) return; // stale-response guard
    if (!this.validate(result)) {
      this.clearTimer();
      this.setState('failed', { errorCode: 'SCHEMA_VALIDATION_FAILED' });
      return;
    }
    this.clearTimer();
    let ok = false;
    try {
      ok = await this.deps.finalize({
        result,
        ownerScope: token.ownerScope,
        clientFingerprint: token.clientFingerprint,
        jobId: token.jobId,
      });
    } catch {
      ok = false;
    }
    if (!this.isActive(token)) return; // await 中に owner 変化 → 破棄
    if (ok) {
      clearPending(this.deps.storage, token.ownerScope);
      this.setState('completed');
      this.deps.navigate();
    } else {
      // 保存失敗 → pending を先に消さない（server completed は再取得可能）。
      this.setState('failed', { errorCode: 'SAVE_FAILED', canRetry: true, canRecheck: true });
    }
  }

  private validate(result: unknown): boolean {
    if (this.deps.validateResult) return this.deps.validateResult(result);
    return !!result && typeof result === 'object';
  }

  private patchPending(token: ActiveGenerationToken, patch: Partial<PendingSelfAnalysisJob>): void {
    const owner = token.ownerScope;
    const cur = readPending(this.deps.storage, owner);
    const base: PendingSelfAnalysisJob = cur ?? {
      version: 1,
      ownerScope: owner,
      jobId: token.jobId,
      clientFingerprint: token.clientFingerprint,
      requestState: 'submitting',
      createdAt: this.iso(),
      lastCheckedAt: null,
      promptRevision: this.deps.promptRevision,
      outputSchemaRevision: this.deps.outputSchemaRevision,
    };
    writePending(this.deps.storage, { ...base, ...patch, ownerScope: owner, version: 1 });
  }

  private setState(state: GenerationClientState, o: SetStateOpts = {}): void {
    this.state = state;
    this.errorCode = o.errorCode ?? null;
    this.canRetry = o.canRetry ?? false;
    this.canRecheck = o.canRecheck ?? false;
    this.deps.onChange(this.getView());
  }

  private scheduleTimer(ms: number, cb: () => void): void {
    this.clearTimer(); // 同時に複数 timer/poll loop を持たない
    this.timer = this.deps.schedule(ms, () => {
      this.timer = null;
      cb();
    });
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.deps.cancel(this.timer);
      this.timer = null;
    }
  }

  private iso(): string {
    return new Date(this.deps.now()).toISOString();
  }
}
