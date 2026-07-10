/**
 * Consent Ledger — in-memory repository（P14-C・synthetic 専用）。
 *
 * 決定論的（Date.now / Math.random を使わない）。append-only。history を消さない。
 * Supabase / localStorage / service-role へは接続しない（synthetic QA でのみ使用）。
 */

import { classifyIdempotency } from './idempotency';
import { validateOrdering } from './ledger';
import { deriveConsentState } from './reducer';
import { buildConsentReceipt } from './receipt';
import type {
  AppendResult,
  ConsentLedgerRepository,
  ConsentProvenance,
} from './repository';
import type {
  ConsentLedgerEvent,
  ConsentReceipt,
  ConsentScope,
  DerivedConsentState,
  IdempotencyClassification,
} from '@/types/careerConsent';

export function createInMemoryConsentLedgerRepository(): ConsentLedgerRepository {
  const store = new Map<string, ConsentLedgerEvent[]>();

  const eventsOf = (subjectId: string): ConsentLedgerEvent[] => store.get(subjectId) ?? [];

  return {
    append(event: ConsentLedgerEvent, now: number): AppendResult {
      const subjectId = event.subjectUserId;
      if (typeof subjectId !== 'string' || subjectId === '') {
        return { ok: false, reason: 'invalid_event' };
      }
      const existing = eventsOf(subjectId);

      // terminal: account 削除後の grant / reconfirm を拒否。
      const derived = deriveConsentState({ events: existing, now });
      if (
        derived.accountStatus === 'deleted' &&
        (event.action === 'consent_granted' || event.action === 'consent_reconfirmed')
      ) {
        return { ok: false, reason: 'account_deleted_terminal' };
      }

      // idempotency 分類。
      const klass = classifyIdempotency({ existingEvents: existing, candidate: event });
      if (klass === 'duplicate') return { ok: true, event, deduped: true }; // 二重化しない
      if (klass === 'conflict') return { ok: false, reason: 'idempotency_conflict' };

      // sequence conflict（同一 sequence・異なる payload）を拒否。
      const ordering = validateOrdering([...existing, event], now);
      if (ordering.issues.includes('conflicting_sequence')) {
        return { ok: false, reason: 'sequence_conflict' };
      }

      store.set(subjectId, [...existing, event]);
      return { ok: true, event };
    },

    listForSubject(subjectId: string): ConsentLedgerEvent[] {
      return [...eventsOf(subjectId)];
    },

    listForSubjectScope(subjectId: string, scope: ConsentScope): ConsentLedgerEvent[] {
      // scope は ConsentScope（account sentinel ではない）ため account 系 event は自然に除外される。
      return eventsOf(subjectId).filter((e) => e.scope === scope);
    },

    getDerivedState(subjectId: string, now: number): DerivedConsentState {
      return deriveConsentState({ events: eventsOf(subjectId), now });
    },

    verifyIdempotency(subjectId: string, candidate: ConsentLedgerEvent): IdempotencyClassification {
      return classifyIdempotency({ existingEvents: eventsOf(subjectId), candidate });
    },

    getReceipt(subjectId: string, now: number): ConsentReceipt {
      return buildConsentReceipt({ state: deriveConsentState({ events: eventsOf(subjectId), now }) });
    },

    getProvenance(subjectId: string, now: number): ConsentProvenance {
      const events = eventsOf(subjectId);
      const derived = deriveConsentState({ events, now });
      const latestSequence = events.reduce<number | null>(
        (max, e) => (max === null || e.serverSequence > max ? e.serverSequence : max),
        null,
      );
      return {
        subjectPresent: events.length > 0,
        eventCount: events.length,
        latestSequence,
        accountStatus: derived.accountStatus,
      };
    },
  };
}
