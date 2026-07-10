/**
 * Consent Persistence — LOCAL PROTOTYPE repository adapter（P14-E・server-only）。
 *
 * P14-C repository interface の責務を、local reference model（localLedgerModel.ts）へ接続する。
 * **production 実装ではない**。production Supabase / service-role / API へは接続しない。
 *
 * 境界:
 *   - `import 'server-only'`: client bundle へ混入したら build error。
 *   - browser / matching / AI route から import しない（static guard で検査）。
 *   - generic service-role reader にしない（receipt は owner-scoped path、batch は projection のみ）。
 *   - **write は server-authoritative**: client 供給 server_sequence を受け取らず model が採番する
 *     （P14-D 是正: client-supplied seq を権威にしない）。
 */

import 'server-only';

import { buildAccountDeletionImpactPlan, buildWithdrawalImpactPlan } from '@/lib/careerConsent/impact';
import { classifyIdempotency } from '@/lib/careerConsent/idempotency';
import type {
  LocalConsentLedgerModel,
  ProtoAppendInput,
  ProtoAppendOutcome,
  ProtoLedgerRow,
  EligibilityProjectionRow,
} from './localLedgerModel';
import type {
  AccountDeletionImpactPlan,
  ConsentLedgerEvent,
  ConsentReceipt,
  ConsentScope,
  DerivedConsentState,
  IdempotencyClassification,
  WithdrawalImpactPlan,
} from '@/types/careerConsent';
import { deriveConsentState } from '@/lib/careerConsent/reducer';

export type AdapterError =
  | { retryable: false; kind: 'not_owner' | 'policy_invalid' | 'idempotency_conflict' | 'rejected' }
  | { retryable: true; kind: 'transient' };

/**
 * local prototype 用 server-only adapter。認証は server route が担う前提で、
 * 呼び出し側は「auth 済みの subject」を渡す（client の subject 主張は route が検証済み）。
 */
export class LocalConsentRepositoryAdapter {
  constructor(private readonly model: LocalConsentLedgerModel) {}

  /** server-authoritative append（seq は model が採番。client seq を受け取らない）。 */
  async append(input: ProtoAppendInput, now: number): Promise<ProtoAppendOutcome> {
    return this.model.append(input, now);
  }

  /** owner の全 event（server route が owner auth を保持している前提）。 */
  listForSubject(subjectUserId: string): ProtoLedgerRow[] {
    const res = this.model.selectLedger({ role: 'authenticated', userId: subjectUserId }, subjectUserId);
    return res.ok ? res.rows : [];
  }

  listForScope(subjectUserId: string, scope: ConsentScope): ProtoLedgerRow[] {
    return this.listForSubject(subjectUserId).filter((e) => e.scope === scope);
  }

  getDerivedState(subjectUserId: string, now: number): DerivedConsentState {
    const events = this.listForSubject(subjectUserId) as unknown as ConsentLedgerEvent[];
    return deriveConsentState({ events, now });
  }

  getReceipt(subjectUserId: string, now: number): ConsentReceipt | null {
    const res = this.model.getReceiptAs({ role: 'authenticated', userId: subjectUserId }, subjectUserId, now);
    return res.ok ? res.receipt : null;
  }

  verifyIdempotency(subjectUserId: string, candidate: ConsentLedgerEvent): IdempotencyClassification {
    const existing = this.listForSubject(subjectUserId) as unknown as ConsentLedgerEvent[];
    return classifyIdempotency({ existingEvents: existing, candidate });
  }

  detectConflict(subjectUserId: string, candidate: ConsentLedgerEvent): boolean {
    return this.verifyIdempotency(subjectUserId, candidate) === 'conflict';
  }

  requestWithdrawalImpact(scope: ConsentScope): WithdrawalImpactPlan {
    return buildWithdrawalImpactPlan({ scope });
  }

  requestDeletionImpact(): AccountDeletionImpactPlan {
    return buildAccountDeletionImpactPlan();
  }

  /** aggregate batch 用 fixed projection（raw ledger history は渡さない・batch 境界のみ）。 */
  getAggregateEligibilityProjection(subjectUserId: string, now: number): EligibilityProjectionRow[] {
    const res = this.model.getEligibilityProjection({ role: 'batch' }, subjectUserId, now);
    return res.ok ? res.rows : [];
  }
}
