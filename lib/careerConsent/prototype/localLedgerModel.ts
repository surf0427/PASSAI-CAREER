/**
 * Consent Persistence — LOCAL PROTOTYPE reference model（P14-E・pure・synthetic 専用）。
 *
 * supabase/prototype/consent_local_prototype.sql の意味論を **忠実に** TypeScript で再現する。
 * live Postgres が本環境に無く production 接続は禁止のため、DB 制約（append-only / advisory-lock
 * seq / UNIQUE / RLS / idempotency / withdrawal outbox の atomicity）を本モデルで検証する。
 *
 * 重要な非目標: 本モデルは production 実装ではない。source of truth は append-only event 列で、
 * current state は P14-C reducer で導出する（materialized state を持たない）。
 *
 * このファイルは **pure**（`server-only` を import しない）ため QA から import 可能。
 * production adapter（server-only）は localRepositoryAdapter.ts。
 */

import { deriveConsentState } from '@/lib/careerConsent/reducer';
import { buildConsentReceipt } from '@/lib/careerConsent/receipt';
import { DEFAULT_CONSENT_MANIFEST } from '@/lib/careerConsent/policy';
import type {
  ConsentActorType,
  ConsentLedgerEvent,
  ConsentReceipt,
  ConsentScope,
  LedgerScope,
} from '@/types/careerConsent';

// ── 型 ─────────────────────────────────────────────────────────────
/** 内部行（ledger event + prototype 追加列）。 */
export type ProtoLedgerRow = ConsentLedgerEvent & {
  payloadDigest: string;
  purposeVersion: string | null;
};

export type ProtoAppendInput = {
  subjectUserId: string;
  scope: LedgerScope;
  action: ConsentLedgerEvent['action'];
  consentVersion?: number | null;
  noticeVersion?: string | null;
  purposeVersion?: string | null;
  policyDigest?: string | null;
  effectiveAt: string;
  sourceSurface?: string;
  actorType?: ConsentActorType;
  idempotencyKey: string;
};

export type ProtoAppendOutcome =
  | { status: 'inserted'; row: ProtoLedgerRow }
  | { status: 'duplicate'; row: ProtoLedgerRow }
  | { status: 'conflict'; reason: 'idempotency_conflict' }
  | { status: 'rejected'; reason: 'missing_idempotency_key' | 'future_effective_timestamp' | 'policy_invalid' | 'account_deleted_terminal' };

export type ProtoActor =
  | { role: 'anon' }
  | { role: 'authenticated'; userId: string }
  | { role: 'batch' }
  | { role: 'server' };

export type LedgerReadResult =
  | { ok: true; rows: ProtoLedgerRow[] }
  | { ok: false; reason: 'anon_denied' | 'not_authorized_for_raw_ledger' };

export type EligibilityProjectionRow = {
  subjectUserId: string; // batch 内部のみ
  scope: ConsentScope;
  state: string;
  activeVersion: number | null;
  grantedAt: string | null;
  withdrawnAt: string | null;
  deletionState: 'active' | 'deletion_pending' | 'deleted';
  lastSequence: number | null;
  calculatedAt: string;
};

export type ProtoPolicy = {
  scope: ConsentScope;
  consentVersion: number;
  noticeVersion: string;
  purposeVersion: string;
  policyDigest: string;
  active: boolean;
  legalReviewStatus: 'REQUIRED' | 'PENDING' | 'NOT_REQUIRED';
};

export type WithdrawalOutboxRow = {
  outboxId: string;
  subjectUserId: string;
  scope: LedgerScope;
  consentEventId: string;
  status: 'pending' | 'processed' | 'failed';
  attempts: number;
  openBucketRecomputeRequested: boolean;
  eligibilityInvalidationRequested: boolean;
  cacheInvalidationRequested: boolean;
};

// canonical payload digest（server が算出する想定。client 値は信頼しない）。
function computePayloadDigest(input: ProtoAppendInput): string {
  return JSON.stringify([
    input.scope,
    input.action,
    input.consentVersion ?? null,
    input.noticeVersion ?? null,
    input.policyDigest ?? null,
    input.effectiveAt,
  ]);
}

/**
 * DB を模した in-memory model。append は career_consent_append_prototype RPC を忠実に再現。
 */
export class LocalConsentLedgerModel {
  private events: ProtoLedgerRow[] = [];
  private outbox: WithdrawalOutboxRow[] = [];
  private policies: ProtoPolicy[] = [];
  private idCounter = 0;
  private locks = new Map<string, Promise<void>>();

  constructor() {
    this.seedActivePolicies();
  }

  /** P14-C DEFAULT_CONSENT_MANIFEST から active policy を seed（synthetic fixture）。 */
  private seedActivePolicies(): void {
    for (const scope of Object.keys(DEFAULT_CONSENT_MANIFEST) as ConsentScope[]) {
      const m = DEFAULT_CONSENT_MANIFEST[scope];
      this.policies.push({
        scope,
        consentVersion: m.requiredVersion,
        noticeVersion: m.noticeVersion,
        purposeVersion: m.purposeSummaryVersion,
        policyDigest: m.policyDigest,
        active: true,
        legalReviewStatus: 'REQUIRED',
      });
    }
  }

  // ── policy 操作（policy QA 用）──────────────────────────────────
  activePolicy(scope: ConsentScope): ProtoPolicy | undefined {
    return this.policies.find((p) => p.scope === scope && p.active);
  }
  supersede(scope: ConsentScope): void {
    for (const p of this.policies) if (p.scope === scope) p.active = false;
  }
  publishPolicy(p: ProtoPolicy): void {
    // scope ごと active 最大 1（部分 unique index の模倣）。
    if (p.active) for (const e of this.policies) if (e.scope === p.scope) e.active = false;
    this.policies.push({ ...p });
  }

  // ── per-subject 直列化（advisory_xact_lock の模倣）────────────────
  private async withSubjectLock<T>(subject: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.locks.get(subject) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.locks.set(
      subject,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // UNIQUE(subject, server_sequence) / UNIQUE(subject, idempotency_key) を強制。
  private enforceInsert(row: ProtoLedgerRow): void {
    const seqDup = this.events.some(
      (e) => e.subjectUserId === row.subjectUserId && e.serverSequence === row.serverSequence,
    );
    if (seqDup) throw new Error('unique_violation:server_sequence');
    const idemDup = this.events.some(
      (e) => e.subjectUserId === row.subjectUserId && e.idempotencyKey === row.idempotencyKey,
    );
    if (idemDup) throw new Error('unique_violation:idempotency_key');
    this.events.push(row);
  }

  private findByIdem(subject: string, key: string): ProtoLedgerRow | undefined {
    return this.events.find((e) => e.subjectUserId === subject && e.idempotencyKey === key);
  }

  private hasAccountDeleted(subject: string): boolean {
    return this.events.some((e) => e.subjectUserId === subject && e.action === 'account_deleted');
  }

  /**
   * RPC career_consent_append_prototype 相当（安全経路・advisory lock 直列化）。
   * @param now server 時刻（epoch ms）。recorded_at / future 判定に使う。
   */
  async append(input: ProtoAppendInput, now: number): Promise<ProtoAppendOutcome> {
    if (!input.idempotencyKey || input.idempotencyKey === '') {
      return { status: 'rejected', reason: 'missing_idempotency_key' };
    }
    const effMs = Date.parse(input.effectiveAt);
    if (Number.isNaN(effMs) || effMs > now) {
      return { status: 'rejected', reason: 'future_effective_timestamp' };
    }
    const payloadDigest = computePayloadDigest(input);

    // 冪等（lock 前の事前 SELECT。RPC と同順）。
    const existing = this.findByIdem(input.subjectUserId, input.idempotencyKey);
    if (existing) {
      return existing.payloadDigest === payloadDigest
        ? { status: 'duplicate', row: existing }
        : { status: 'conflict', reason: 'idempotency_conflict' };
    }

    // account 削除後の grant / reconfirm を terminal reject。
    if (
      (input.action === 'consent_granted' || input.action === 'consent_reconfirmed') &&
      this.hasAccountDeleted(input.subjectUserId)
    ) {
      return { status: 'rejected', reason: 'account_deleted_terminal' };
    }

    // grant / reconfirm は active policy と version + digest を照合。
    if (input.action === 'consent_granted' || input.action === 'consent_reconfirmed') {
      const scope = input.scope as ConsentScope;
      const p = this.activePolicy(scope);
      if (!p || p.consentVersion !== input.consentVersion || p.policyDigest !== input.policyDigest) {
        return { status: 'rejected', reason: 'policy_invalid' };
      }
    }

    return this.withSubjectLock(input.subjectUserId, () => {
      const maxSeq = this.events
        .filter((e) => e.subjectUserId === input.subjectUserId)
        .reduce((m, e) => (e.serverSequence > m ? e.serverSequence : m), 0);
      const seq = maxSeq + 1;
      const row: ProtoLedgerRow = {
        ledgerEventId: `pev-${++this.idCounter}`,
        subjectUserId: input.subjectUserId,
        scope: input.scope,
        action: input.action,
        consentVersion: input.consentVersion ?? null,
        noticeVersion: input.noticeVersion ?? null,
        policyDigest: input.policyDigest ?? null,
        serverSequence: seq,
        recordedAt: new Date(now).toISOString(), // server 生成（client 値を信頼しない）
        effectiveAt: input.effectiveAt,
        sourceSurface: input.sourceSurface ?? 'unspecified',
        idempotencyKey: input.idempotencyKey,
        actorType: input.actorType ?? 'user',
        legalReviewMarker: null,
        payloadDigest,
        purposeVersion: input.purposeVersion ?? null,
      };
      this.enforceInsert(row);
      // withdrawal は同一 critical section で outbox を追記（atomicity の模倣）。
      if (input.action === 'consent_withdrawn') {
        this.outbox.push({
          outboxId: `obx-${++this.idCounter}`,
          subjectUserId: input.subjectUserId,
          scope: input.scope,
          consentEventId: row.ledgerEventId,
          status: 'pending',
          attempts: 0,
          openBucketRecomputeRequested: true,
          eligibilityInvalidationRequested: true,
          cacheInvalidationRequested: true,
        });
      }
      return { status: 'inserted', row };
    });
  }

  /**
   * ⚠ 意図的に危険な naked MAX+1（lock なし）。concurrency QA で「lock が必要」を示すためだけに使う。
   * read と insert の間に await を挟み interleaving を起こす。production では決して使わない。
   */
  async appendUnsafe(input: ProtoAppendInput, now: number): Promise<ProtoAppendOutcome> {
    const payloadDigest = computePayloadDigest(input);
    const maxSeq = this.events
      .filter((e) => e.subjectUserId === input.subjectUserId)
      .reduce((m, e) => (e.serverSequence > m ? e.serverSequence : m), 0);
    await Promise.resolve(); // yield → 別 append が同じ maxSeq を読む余地を作る
    const row: ProtoLedgerRow = {
      ledgerEventId: `unsafe-${++this.idCounter}`,
      subjectUserId: input.subjectUserId,
      scope: input.scope,
      action: input.action,
      consentVersion: input.consentVersion ?? null,
      noticeVersion: input.noticeVersion ?? null,
      policyDigest: input.policyDigest ?? null,
      serverSequence: maxSeq + 1,
      recordedAt: new Date(now).toISOString(),
      effectiveAt: input.effectiveAt,
      sourceSurface: input.sourceSurface ?? 'unspecified',
      idempotencyKey: input.idempotencyKey,
      actorType: input.actorType ?? 'user',
      legalReviewMarker: null,
      payloadDigest,
      purposeVersion: input.purposeVersion ?? null,
    };
    this.enforceInsert(row); // UNIQUE(subject,seq) 違反で throw（= DB が守る最後の砦）
    return { status: 'inserted', row };
  }

  // ── access-control（RLS 模倣）─────────────────────────────────
  /** Ledger SELECT: owner のみ。other=空、anon=denied、batch/server=raw 不可。 */
  selectLedger(actor: ProtoActor, subject: string): LedgerReadResult {
    if (actor.role === 'anon') return { ok: false, reason: 'anon_denied' };
    if (actor.role === 'batch' || actor.role === 'server') {
      return { ok: false, reason: 'not_authorized_for_raw_ledger' };
    }
    // authenticated: owner のみ自分の行。other user は 0 件（RLS で見えない）。
    const rows = actor.userId === subject ? this.rowsForSubject(subject) : [];
    return { ok: true, rows };
  }

  private rowsForSubject(subject: string): ProtoLedgerRow[] {
    return this.events
      .filter((e) => e.subjectUserId === subject)
      .sort((a, b) => a.serverSequence - b.serverSequence);
  }

  private toLedgerEvents(subject: string): ConsentLedgerEvent[] {
    // ProtoLedgerRow は ConsentLedgerEvent の superset。reducer 用に構造的に渡す。
    return this.rowsForSubject(subject);
  }

  /** 導出 receipt（owner のみ）。internal 列は含めない（P14-C buildConsentReceipt）。 */
  getReceiptAs(actor: ProtoActor, subject: string, now: number): { ok: true; receipt: ConsentReceipt } | { ok: false; reason: string } {
    if (actor.role !== 'authenticated' || actor.userId !== subject) {
      return { ok: false, reason: 'not_owner' };
    }
    const state = deriveConsentState({ events: this.toLedgerEvents(subject), now });
    return { ok: true, receipt: buildConsentReceipt({ state }) };
  }

  /** active policy manifest read（anon 不可・authenticated は active のみ）。 */
  readManifest(actor: ProtoActor): { ok: true; policies: ProtoPolicy[] } | { ok: false; reason: string } {
    if (actor.role === 'anon') return { ok: false, reason: 'anon_denied' };
    return { ok: true, policies: this.policies.filter((p) => p.active).map((p) => ({ ...p })) };
  }

  /** aggregate eligibility fixed projection（batch executor のみ・raw history 非公開）。 */
  getEligibilityProjection(
    actor: ProtoActor,
    subject: string,
    now: number,
  ): { ok: true; rows: EligibilityProjectionRow[] } | { ok: false; reason: string } {
    if (actor.role !== 'batch') return { ok: false, reason: 'not_batch_executor' };
    const state = deriveConsentState({ events: this.toLedgerEvents(subject), now });
    const lastSequence = this.rowsForSubject(subject).reduce<number | null>(
      (m, e) => (m === null || e.serverSequence > m ? e.serverSequence : m),
      null,
    );
    const rows: EligibilityProjectionRow[] = (Object.keys(state.byScope) as ConsentScope[]).map((scope) => {
      const s = state.byScope[scope];
      return {
        subjectUserId: subject,
        scope,
        state: s.status,
        activeVersion: s.consentVersion,
        grantedAt: s.grantedAt,
        withdrawnAt: s.withdrawnAt,
        deletionState: state.accountStatus,
        lastSequence,
        calculatedAt: new Date(now).toISOString(),
      };
    });
    return { ok: true, rows };
  }

  // ── outbox（withdrawal QA）─────────────────────────────────────
  listOutbox(subject: string): WithdrawalOutboxRow[] {
    return this.outbox.filter((o) => o.subjectUserId === subject).map((o) => ({ ...o }));
  }
  markOutboxProcessed(outboxId: string): void {
    const o = this.outbox.find((x) => x.outboxId === outboxId);
    if (o) {
      o.status = 'processed';
      o.attempts += 1;
    }
  }

  // ── raw アクセサ（QA 内部の観測用。access-control を通さない生データ）──────
  _allEvents(): ProtoLedgerRow[] {
    return [...this.events];
  }
  _allEventsForSubject(subject: string): ProtoLedgerRow[] {
    return this.rowsForSubject(subject);
  }
}
