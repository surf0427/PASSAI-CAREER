/*
 * scripts/career-consent-receipt-qa.ts
 *
 * PASSAI CAREER — Consent receipt QA（P14-C・G. Receipt）。
 *
 * 何を守るか（P14-C §12 / §22-G）:
 *   - current status / version / grant・withdrawal timestamp / reconsent required / normal features unaffected。
 *   - internal ledger event ID / idempotency key / server sequence / raw user ID / IP を含まない。
 *   - raw policy text を含まない。
 *
 * 使い方: npx tsx scripts/career-consent-receipt-qa.ts
 */

import { buildConsentReceipt } from '@/lib/careerConsent/receipt';
import { deriveConsentState } from '@/lib/careerConsent/reducer';
import { RECEIPT_FORBIDDEN_FIELDS } from '@/types/careerConsent';
import { grant, withdraw, superseded, iso, NOW, UF } from './fixtures/careerConsentFixtures';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function collectKeys(obj: unknown, keys: string[]): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { for (const v of obj) collectKeys(v, keys); return; }
  for (const [k, v] of Object.entries(obj)) { keys.push(k); collectKeys(v, keys); }
}

const state = deriveConsentState({
  events: [grant('u1secret', { seq: 1, effectiveAt: iso(20), idempotencyKey: 'idem-secret' }), superseded('u1secret', { seq: 2, effectiveAt: iso(10) })],
  now: NOW,
});
const receipt = buildConsentReceipt({ state });
const ufEntry = receipt.entries.find((e) => e.scope === UF)!;

console.log('[1] public fields');
{
  check('scope status あり', typeof ufEntry.status === 'string');
  check('consent version あり', ufEntry.consentVersion === 1);
  check('grantedAt あり', ufEntry.grantedAt !== null);
  check('reconsentRequired が反映（superseded→outdated）', ufEntry.status === 'version_outdated' && ufEntry.reconsentRequired === true);
  check('normalFeaturesUnaffected=true', ufEntry.normalFeaturesUnaffected === true);
  check('currentPolicyVersion（development）あり', typeof ufEntry.currentPolicyVersion === 'string' && ufEntry.currentPolicyVersion.startsWith('p14c'));
  check('accountStatus あり', receipt.accountStatus === 'active');
}

console.log('[2] leakage');
{
  const keys: string[] = [];
  collectKeys(receipt, keys);
  for (const bad of RECEIPT_FORBIDDEN_FIELDS) {
    check(`receipt に ${bad} を含まない`, !keys.includes(bad));
  }
  const json = JSON.stringify(receipt);
  check('subject user id 値が漏れない', !json.includes('u1secret'));
  check('idempotency key 値が漏れない', !json.includes('idem-secret'));
  check('ledgerEventId 値が漏れない', !json.includes('le-u1secret'));
  check('server sequence が key として無い', !keys.includes('serverSequence'));
}

console.log('[3] withdrawal 反映');
{
  const s = deriveConsentState({ events: [grant('u2', { seq: 1, effectiveAt: iso(20) }), withdraw('u2', { seq: 2, effectiveAt: iso(10) })], now: NOW });
  const r = buildConsentReceipt({ state: s });
  const e = r.entries.find((x) => x.scope === UF)!;
  check('withdrawn status + withdrawnAt', e.status === 'withdrawn' && e.withdrawnAt !== null);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
