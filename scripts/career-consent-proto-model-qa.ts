/*
 * scripts/career-consent-proto-model-qa.ts
 *
 * PASSAI CAREER — Consent persistence prototype model QA（P14-E・6-B append-only / 6-D idempotency / 6-E policy）。
 *
 * localLedgerModel.ts が prototype SQL の意味論を満たすことを検証する。
 *
 * 使い方: npx tsx scripts/career-consent-proto-model-qa.ts
 */

import { LocalConsentLedgerModel, type ProtoAppendInput } from '@/lib/careerConsent/prototype/localLedgerModel';
import { deriveConsentState } from '@/lib/careerConsent/reducer';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const NOW = Date.parse('2026-07-10T00:00:00.000Z');
const DAY = 86400000;
const iso = (d: number) => new Date(NOW - d * DAY).toISOString();
const UF = 'user_facing_aggregated_insight';
const DIGEST_UF = 'sha256:dev-user_facing_aggregated_insight';

function grantInput(subject: string, over: Partial<ProtoAppendInput> = {}): ProtoAppendInput {
  return {
    subjectUserId: subject,
    scope: UF,
    action: 'consent_granted',
    consentVersion: 1,
    noticeVersion: 'notice-dev-1',
    purposeVersion: 'purpose-dev-1',
    policyDigest: DIGEST_UF,
    effectiveAt: iso(10),
    sourceSurface: 'settings',
    actorType: 'user',
    idempotencyKey: `idem-${subject}-grant`,
    ...over,
  };
}

async function main() {
  console.log('[1] append-only / correction');
  {
    const m = new LocalConsentLedgerModel();
    const r = await m.append(grantInput('u1'), NOW);
    check('grant inserted', r.status === 'inserted');
    // correction は UPDATE ではなく新 event で表現（model には mutation API が無い）。
    const corr = await m.append({ ...grantInput('u1', { idempotencyKey: 'idem-u1-corr', action: 'consent_reconfirmed', effectiveAt: iso(5) }) }, NOW);
    check('correction は新 event で append', corr.status === 'inserted');
    check('original event 不変（2 件）', m._allEventsForSubject('u1').length === 2);
    // model は event 配列に対する update/delete を公開しない（append-only）。
    check('mutation API を公開しない', typeof (m as unknown as { update?: unknown }).update === 'undefined' && typeof (m as unknown as { delete?: unknown }).delete === 'undefined');
  }

  console.log('[2] idempotency');
  {
    const m = new LocalConsentLedgerModel();
    const first = await m.append(grantInput('u1', { idempotencyKey: 'k1' }), NOW);
    const dup = await m.append(grantInput('u1', { idempotencyKey: 'k1' }), NOW); // same key / same payload
    check('same key/same payload → duplicate', dup.status === 'duplicate');
    check('duplicate は既存 event を返す', dup.status === 'duplicate' && dup.row.serverSequence === (first.status === 'inserted' ? first.row.serverSequence : -1));
    check('duplicate は新 row を作らない（1 件）', m._allEventsForSubject('u1').length === 1);

    const conflict = await m.append(grantInput('u1', { idempotencyKey: 'k1', effectiveAt: iso(3) }), NOW); // same key / diff payload
    check('same key/diff payload → conflict', conflict.status === 'conflict');
    check('conflict は新 row を作らない', m._allEventsForSubject('u1').length === 1);

    // different key / same payload → new。
    const m2 = new LocalConsentLedgerModel();
    await m2.append(grantInput('uX', { idempotencyKey: 'ka' }), NOW);
    const nk = await m2.append(grantInput('uX', { idempotencyKey: 'kb' }), NOW);
    check('diff key/same payload → new event', nk.status === 'inserted' && m2._allEventsForSubject('uX').length === 2);

    // subject A と B は同じ key を使える。
    const m3 = new LocalConsentLedgerModel();
    const a = await m3.append(grantInput('A', { idempotencyKey: 'shared' }), NOW);
    const b = await m3.append(grantInput('B', { idempotencyKey: 'shared' }), NOW);
    check('subject A/B は同一 key を独立使用可', a.status === 'inserted' && b.status === 'inserted');

    const empty = await m.append(grantInput('u1', { idempotencyKey: '' }), NOW);
    check('missing idempotency key → rejected', empty.status === 'rejected' && empty.reason === 'missing_idempotency_key');
  }

  console.log('[3] policy validation');
  {
    const m = new LocalConsentLedgerModel();
    const active = await m.append(grantInput('u1'), NOW);
    check('active version grant 成功', active.status === 'inserted');

    const unknownVer = await m.append(grantInput('u2', { consentVersion: 99 }), NOW);
    check('unknown version grant 拒否', unknownVer.status === 'rejected' && unknownVer.reason === 'policy_invalid');

    const badDigest = await m.append(grantInput('u3', { policyDigest: 'sha256:tampered' }), NOW);
    check('digest mismatch grant 拒否', badDigest.status === 'rejected' && badDigest.reason === 'policy_invalid');

    m.supersede(UF); // active policy を無効化
    const inactive = await m.append(grantInput('u4', { idempotencyKey: 'idem-u4-g' }), NOW);
    check('inactive policy grant 拒否', inactive.status === 'rejected' && inactive.reason === 'policy_invalid');

    // AI scope と UF scope の混同なし（AI digest で UF scope grant は不可）。
    const m2 = new LocalConsentLedgerModel();
    const cross = await m2.append(grantInput('u5', { policyDigest: 'sha256:dev-ai_context_aggregated_insight' }), NOW);
    check('AI digest で UF scope grant 拒否（scope 混同なし）', cross.status === 'rejected');

    // future effective 拒否。
    const future = await m2.append(grantInput('u6', { effectiveAt: new Date(NOW + DAY).toISOString(), idempotencyKey: 'idem-u6-f' }), NOW);
    check('future effective → rejected', future.status === 'rejected' && future.reason === 'future_effective_timestamp');
  }

  console.log('[4] account deletion terminal');
  {
    const m = new LocalConsentLedgerModel();
    await m.append({ subjectUserId: 'u1', scope: 'account', action: 'account_deleted', effectiveAt: iso(5), idempotencyKey: 'del-1' }, NOW);
    const afterDel = await m.append(grantInput('u1', { idempotencyKey: 'g-after-del' }), NOW);
    check('deleted 後 grant → rejected account_deleted_terminal', afterDel.status === 'rejected' && afterDel.reason === 'account_deleted_terminal');
  }

  console.log('[5] current state は ledger から再構築可能（materialized なし）');
  {
    const m = new LocalConsentLedgerModel();
    await m.append(grantInput('u1', { idempotencyKey: 'g1', effectiveAt: iso(20) }), NOW);
    await m.append({ subjectUserId: 'u1', scope: UF, action: 'consent_withdrawn', effectiveAt: iso(10), idempotencyKey: 'w1' }, NOW);
    const state = deriveConsentState({ events: m._allEventsForSubject('u1'), now: NOW });
    check('reducer で withdrawn を再構築', state.byScope[UF].status === 'withdrawn');
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
