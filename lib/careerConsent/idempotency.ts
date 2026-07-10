/**
 * Consent Ledger — idempotency contract（P14-C）。
 *
 * 同じ操作の retry で複数 grant / withdrawal が作られないよう分類する。idempotency key は
 * subject + scope + operation 単位。P14-B の client_event_id とは別 domain の専用 key。
 *
 * P14-C 注記: client 生成 key を信頼できると扱わない。将来 server 側で検証・保存する前提。
 * pure・DB 非依存。
 */

import type {
  ConsentLedgerEvent,
  IdempotencyClassification,
} from '@/types/careerConsent';

// 冪等判定に用いる payload 署名（意味的 field のみ・idempotencyKey 自身は含めない）。
function opSignature(e: ConsentLedgerEvent): string {
  return JSON.stringify([e.subjectUserId, e.scope, e.action, e.consentVersion, e.noticeVersion, e.policyDigest, e.effectiveAt]);
}

/**
 * candidate event を既存 event 列に対して分類する（pure）。
 *   - 同一 idempotencyKey が無い → new
 *   - 同一 idempotencyKey かつ同一 payload → duplicate
 *   - 同一 idempotencyKey かつ異なる payload → conflict
 */
export function classifyIdempotency(input: {
  existingEvents: readonly ConsentLedgerEvent[];
  candidate: ConsentLedgerEvent;
}): IdempotencyClassification {
  const key = input.candidate.idempotencyKey;
  if (typeof key !== 'string' || key === '') {
    // key が無い candidate は new 扱いにせず conflict として弾く（server 検証前提）。
    return 'conflict';
  }
  const sameKey = input.existingEvents.filter((e) => e.idempotencyKey === key);
  if (sameKey.length === 0) return 'new';
  const candSig = opSignature(input.candidate);
  return sameKey.every((e) => opSignature(e) === candSig) ? 'duplicate' : 'conflict';
}

/** duplicate（同一 key・同一 payload）を除いた append 可能 event 列を返す（retry 二重化防止）。 */
export function dropIdempotentDuplicates(
  events: readonly ConsentLedgerEvent[],
): ConsentLedgerEvent[] {
  const seen = new Map<string, string>(); // idempotencyKey -> signature
  const out: ConsentLedgerEvent[] = [];
  for (const e of events) {
    if (typeof e.idempotencyKey !== 'string' || e.idempotencyKey === '') {
      out.push(e); // key 無しは dedup 対象にしない（ordering/reducer 側で扱う）
      continue;
    }
    const sig = seen.get(e.idempotencyKey);
    if (sig === undefined) {
      seen.set(e.idempotencyKey, JSON.stringify([e.scope, e.action, e.consentVersion, e.effectiveAt]));
      out.push(e);
    } else if (sig !== JSON.stringify([e.scope, e.action, e.consentVersion, e.effectiveAt])) {
      // 同一 key で conflict する payload は dedup せず残す（reducer/ordering が検知）。
      out.push(e);
    }
    // 同一 key・同一 payload は duplicate → drop（二重計上しない）。
  }
  return out;
}
