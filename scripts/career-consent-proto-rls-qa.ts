/*
 * scripts/career-consent-proto-rls-qa.ts
 *
 * PASSAI CAREER — Consent persistence prototype RLS/access QA（P14-E・6-F）。
 *
 * live Postgres が無いため、localLedgerModel の access-control 関数（RLS/privilege を忠実に模倣）で
 * owner / other / anon / batch executor の権限境界を検証する。DB 実施は staging で別途必要。
 *
 * 使い方: npx tsx scripts/career-consent-proto-rls-qa.ts
 */

import { LocalConsentLedgerModel, type ProtoAppendInput } from '@/lib/careerConsent/prototype/localLedgerModel';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const NOW = Date.parse('2026-07-10T00:00:00.000Z');
const iso = (d: number) => new Date(NOW - d * 86400000).toISOString();
const UF = 'user_facing_aggregated_insight';
const DIGEST = 'sha256:dev-user_facing_aggregated_insight';
function grant(subject: string, key: string): ProtoAppendInput {
  return { subjectUserId: subject, scope: UF, action: 'consent_granted', consentVersion: 1, noticeVersion: 'notice-dev-1', purposeVersion: 'purpose-dev-1', policyDigest: DIGEST, effectiveAt: iso(10), idempotencyKey: key };
}

async function main() {
  const m = new LocalConsentLedgerModel();
  await m.append(grant('owner1', 'k-owner1'), NOW);
  await m.append(grant('owner2', 'k-owner2'), NOW);

  console.log('[1] ledger SELECT RLS');
  {
    const own = m.selectLedger({ role: 'authenticated', userId: 'owner1' }, 'owner1');
    check('owner は自分の行を SELECT 可', own.ok && own.rows.length === 1);
    const other = m.selectLedger({ role: 'authenticated', userId: 'owner2' }, 'owner1');
    check('other user は owner1 の行を見られない（0 件）', other.ok && other.rows.length === 0);
    const anon = m.selectLedger({ role: 'anon' }, 'owner1');
    check('anon は denied', !anon.ok);
    const batchRaw = m.selectLedger({ role: 'batch' }, 'owner1');
    check('batch は raw ledger を読めない（projection 経由のみ）', !batchRaw.ok && batchRaw.reason === 'not_authorized_for_raw_ledger');
  }

  console.log('[2] direct mutation なし（append-only・RPC 経由のみ）');
  {
    const api = m as unknown as Record<string, unknown>;
    check('model に insert/update/delete 直接 API なし', typeof api.insert === 'undefined' && typeof api.update === 'undefined' && typeof api.delete === 'undefined');
    check('write は append（RPC 相当）のみ', typeof api.append === 'function');
  }

  console.log('[3] manifest read');
  {
    const authed = m.readManifest({ role: 'authenticated', userId: 'owner1' });
    check('authenticated は active manifest を読める', authed.ok && authed.policies.length > 0);
    check('active のみ返る（inactive 非公開）', authed.ok && authed.policies.every((p) => p.active));
    const anon = m.readManifest({ role: 'anon' });
    check('anon manifest は denied', !anon.ok);
  }

  console.log('[4] receipt access + internal 列除外');
  {
    const own = m.getReceiptAs({ role: 'authenticated', userId: 'owner1' }, 'owner1', NOW);
    check('owner は receipt を読める', own.ok);
    const other = m.getReceiptAs({ role: 'authenticated', userId: 'owner2' }, 'owner1', NOW);
    check('other user の receipt は不可', !other.ok);
    if (own.ok) {
      const json = JSON.stringify(own.receipt);
      for (const bad of ['owner1', 'ledgerEventId', 'idempotencyKey', 'serverSequence', 'payloadDigest', 'subjectUserId', 'recordedAt']) {
        check(`receipt に ${bad} が漏れない`, !json.includes(bad));
      }
    }
  }

  console.log('[5] aggregate projection（batch のみ・fixed・raw history 非公開）');
  {
    const ownerTry = m.getEligibilityProjection({ role: 'authenticated', userId: 'owner1' }, 'owner1', NOW);
    check('owner は projection を読めない', !ownerTry.ok);
    const batch = m.getEligibilityProjection({ role: 'batch' }, 'owner1', NOW);
    check('batch executor は projection を読める', batch.ok);
    if (batch.ok) {
      const keys = new Set(batch.rows.flatMap((r) => Object.keys(r)));
      const allowed = new Set(['subjectUserId', 'scope', 'state', 'activeVersion', 'grantedAt', 'withdrawnAt', 'deletionState', 'lastSequence', 'calculatedAt']);
      check('projection は fixed columns のみ', [...keys].every((k) => allowed.has(k)), [...keys].join(','));
      const json = JSON.stringify(batch.rows);
      for (const bad of ['idempotencyKey', 'payloadDigest', 'ledgerEventId', 'recordedAt', 'actorType', 'noticeVersion']) {
        check(`projection に ${bad}（raw history/内部）が無い`, !json.includes(bad));
      }
    }
  }

  console.log('[6] cross-user leakage なし');
  {
    const p = m.getEligibilityProjection({ role: 'batch' }, 'owner1', NOW);
    check('projection は要求 subject のみ', p.ok && p.rows.every((r) => r.subjectUserId === 'owner1'));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
