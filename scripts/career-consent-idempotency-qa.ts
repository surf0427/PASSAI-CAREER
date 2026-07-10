/*
 * scripts/career-consent-idempotency-qa.ts
 *
 * PASSAI CAREER — Consent Ledger idempotency QA（P14-C・E. Idempotency）。
 *
 * 何を守るか（P14-C §9 / §22-E）:
 *   - same key / same payload → duplicate（二重化しない）。
 *   - same key / conflicting scope|version → conflict。
 *   - retry grant / withdrawal を二重計上しない（repository append）。
 *   - missing idempotency key → conflict（server 検証前提・信頼しない）。
 *   - idempotency key は receipt / aggregate へ出さない（別 QA と併せて内部専用）。
 *
 * 使い方: npx tsx scripts/career-consent-idempotency-qa.ts
 */

import { classifyIdempotency, dropIdempotentDuplicates } from '@/lib/careerConsent/idempotency';
import { createInMemoryConsentLedgerRepository } from '@/lib/careerConsent/inMemoryRepository';
import { grant, withdraw, iso, NOW, UF, AI } from './fixtures/careerConsentFixtures';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('[1] classify');
{
  const base = grant('u1', { seq: 1, effectiveAt: iso(20), idempotencyKey: 'k1' });
  check('未知 key → new', classifyIdempotency({ existingEvents: [], candidate: base }) === 'new');
  check('same key / same payload → duplicate', classifyIdempotency({ existingEvents: [base], candidate: grant('u1', { seq: 1, effectiveAt: iso(20), idempotencyKey: 'k1' }) }) === 'duplicate');
  check('same key / conflicting scope → conflict', classifyIdempotency({ existingEvents: [base], candidate: grant('u1', { seq: 1, scope: AI, effectiveAt: iso(20), idempotencyKey: 'k1' }) }) === 'conflict');
  check('same key / conflicting version → conflict', classifyIdempotency({ existingEvents: [base], candidate: grant('u1', { seq: 1, consentVersion: 2, effectiveAt: iso(20), idempotencyKey: 'k1' }) }) === 'conflict');
  check('missing key → conflict', classifyIdempotency({ existingEvents: [], candidate: grant('u1', { seq: 1, effectiveAt: iso(20), idempotencyKey: '' }) }) === 'conflict');
}

console.log('[2] dropIdempotentDuplicates');
{
  const events = [grant('u1', { seq: 1, effectiveAt: iso(20), idempotencyKey: 'k1' }), grant('u1', { seq: 1, effectiveAt: iso(20), idempotencyKey: 'k1' })];
  check('same key/same payload の retry → 1 件へ', dropIdempotentDuplicates(events).length === 1);
}

console.log('[3] repository retry（二重化しない）');
{
  const repo = createInMemoryConsentLedgerRepository();
  const g = grant('u1', { seq: 1, effectiveAt: iso(20), idempotencyKey: 'k1' });
  const r1 = repo.append(g, NOW);
  const r2 = repo.append(grant('u1', { seq: 2, effectiveAt: iso(20), idempotencyKey: 'k1' }), NOW); // 同 key retry
  check('初回 append ok', r1.ok === true);
  check('retry は deduped', r2.ok === true && r2.ok && r2.deduped === true);
  check('event count は 1（二重化なし）', repo.listForSubject('u1').length === 1);

  // withdrawal retry。
  repo.append(withdraw('u1', { seq: 3, effectiveAt: iso(10), idempotencyKey: 'kw' }), NOW);
  repo.append(withdraw('u1', { seq: 4, effectiveAt: iso(10), idempotencyKey: 'kw' }), NOW);
  check('withdrawal retry も 1 件（grant+withdraw=2）', repo.listForSubject('u1').length === 2);

  // conflict は reject。
  const rc = repo.append(grant('u1', { seq: 5, consentVersion: 9, effectiveAt: iso(20), idempotencyKey: 'k1' }), NOW);
  check('same key / conflicting payload → reject', rc.ok === false && !rc.ok && rc.reason === 'idempotency_conflict');
}

console.log('[4] scope 独立 idempotency');
{
  const repo = createInMemoryConsentLedgerRepository();
  repo.append(grant('u1', { seq: 1, scope: UF, effectiveAt: iso(20), idempotencyKey: 'uf' }), NOW);
  const ai = repo.append(grant('u1', { seq: 2, scope: AI, consentVersion: 1, noticeVersion: 'notice-dev-1', policyDigest: 'sha256:dev-ai_context_aggregated_insight', effectiveAt: iso(19), idempotencyKey: 'ai' }), NOW);
  check('別 scope は別 key で独立 append 可', ai.ok === true && repo.listForSubject('u1').length === 2);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
