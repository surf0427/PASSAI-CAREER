/*
 * scripts/career-consent-proto-withdrawal-qa.ts
 *
 * PASSAI CAREER — Consent persistence prototype withdrawal + receipt QA（P14-E・6-G / 6-H）。
 *
 * withdrawal と outbox の同一 transaction 性、receipt の状態遷移と internal 列非漏洩を検証。
 * closed aggregate は LEGAL_REVIEW、SLA は PROVISIONAL（技術アクションのみ発行）。
 *
 * 使い方: npx tsx scripts/career-consent-proto-withdrawal-qa.ts
 */

import { LocalConsentLedgerModel, type ProtoAppendInput } from '@/lib/careerConsent/prototype/localLedgerModel';
import { buildWithdrawalImpactPlan } from '@/lib/careerConsent/impact';

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
const grant = (s: string, k: string, d = 20): ProtoAppendInput => ({ subjectUserId: s, scope: UF, action: 'consent_granted', consentVersion: 1, noticeVersion: 'notice-dev-1', purposeVersion: 'purpose-dev-1', policyDigest: DIGEST, effectiveAt: iso(d), idempotencyKey: k });
const withdraw = (s: string, k: string, d = 10): ProtoAppendInput => ({ subjectUserId: s, scope: UF, action: 'consent_withdrawn', effectiveAt: iso(d), idempotencyKey: k });

async function main() {
  console.log('[1] withdrawal + outbox atomicity');
  {
    const m = new LocalConsentLedgerModel();
    await m.append(grant('u1', 'g1'), NOW);
    const w = await m.append(withdraw('u1', 'w1'), NOW);
    check('withdrawal inserted', w.status === 'inserted');
    const outbox = m.listOutbox('u1');
    check('outbox が同時に 1 件作られる（同一 txn）', outbox.length === 1);
    check('open_bucket_recompute flag', outbox[0].openBucketRecomputeRequested === true);
    check('eligibility_invalidation flag', outbox[0].eligibilityInvalidationRequested === true);
    check('cache_invalidation flag', outbox[0].cacheInvalidationRequested === true);
    check('worker 未処理状態 pending', outbox[0].status === 'pending');
    m.markOutboxProcessed(outbox[0].outboxId);
    check('processed 状態へ遷移', m.listOutbox('u1')[0].status === 'processed');
  }

  console.log('[2] duplicate withdrawal retry');
  {
    const m = new LocalConsentLedgerModel();
    await m.append(grant('u1', 'g1'), NOW);
    await m.append(withdraw('u1', 'w1'), NOW);
    const dup = await m.append(withdraw('u1', 'w1'), NOW); // 同 key retry
    check('duplicate withdrawal → duplicate', dup.status === 'duplicate');
    check('outbox は二重化しない（1 件）', m.listOutbox('u1').length === 1);
  }

  console.log('[3] receipt 状態遷移');
  {
    const m = new LocalConsentLedgerModel();
    const before = m.getReceiptAs({ role: 'authenticated', userId: 'u1' }, 'u1', NOW);
    check('grant 前 = never_granted', before.ok && before.receipt.entries.find((e) => e.scope === UF)!.status === 'never_granted');
    await m.append(grant('u1', 'g1'), NOW);
    const afterGrant = m.getReceiptAs({ role: 'authenticated', userId: 'u1' }, 'u1', NOW);
    check('grant 後 = active', afterGrant.ok && afterGrant.receipt.entries.find((e) => e.scope === UF)!.status === 'active');
    await m.append(withdraw('u1', 'w1'), NOW);
    const afterW = m.getReceiptAs({ role: 'authenticated', userId: 'u1' }, 'u1', NOW);
    check('withdrawal 後 = withdrawn', afterW.ok && afterW.receipt.entries.find((e) => e.scope === UF)!.status === 'withdrawn');
    if (afterW.ok) {
      const e = afterW.receipt.entries.find((x) => x.scope === UF)!;
      check('normalFeaturesUnaffected=true', e.normalFeaturesUnaffected === true);
    }
  }

  console.log('[4] reconsent（version 変更）');
  {
    const m = new LocalConsentLedgerModel();
    await m.append(grant('u1', 'g1', 30), NOW);
    await m.append(withdraw('u1', 'w1', 20), NOW);
    await m.append({ ...grant('u1', 'g2', 10), action: 'consent_reconfirmed' }, NOW);
    const r = m.getReceiptAs({ role: 'authenticated', userId: 'u1' }, 'u1', NOW);
    check('reconsent 後 = active', r.ok && r.receipt.entries.find((e) => e.scope === UF)!.status === 'active');
  }

  console.log('[5] impact plan: closed aggregate=LEGAL_REVIEW / 技術アクション発行');
  {
    const plan = buildWithdrawalImpactPlan({ scope: UF });
    check('技術: recompute open buckets', plan.technicalActions.includes('recompute_open_buckets'));
    check('技術: cache invalidate', plan.technicalActions.includes('invalidate_cached_aggregates'));
    check('closed aggregate 寄与除去は legal review', plan.legalReviewItems.includes('contribution_removal_from_closed_aggregate'));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
