/*
 * scripts/career-consent-proto-sequence-qa.ts
 *
 * PASSAI CAREER — Consent persistence prototype sequence + concurrency QA（P14-E・6-C）。
 *
 * subject-scoped monotonic sequence（advisory lock 相当の直列化）を検証し、
 * naked MAX+1（lock なし）が collision することで lock の必要性を示す。
 *
 * 使い方: npx tsx scripts/career-consent-proto-sequence-qa.ts
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

// grant/withdraw input（policy 検証を通すため grant は active version）。
function inp(subject: string, i: number): ProtoAppendInput {
  return {
    subjectUserId: subject, scope: UF, action: 'consent_granted',
    consentVersion: 1, noticeVersion: 'notice-dev-1', purposeVersion: 'purpose-dev-1',
    policyDigest: DIGEST, effectiveAt: iso(10), idempotencyKey: `idem-${subject}-${i}`,
  };
}

async function main() {
  console.log('[1] basic sequence');
  {
    const m = new LocalConsentLedgerModel();
    const r1 = await m.append(inp('u1', 1), NOW);
    check('first sequence = 1', r1.status === 'inserted' && r1.row.serverSequence === 1);
    const r2 = await m.append(inp('u1', 2), NOW);
    check('sequential append = 2', r2.status === 'inserted' && r2.row.serverSequence === 2);
  }

  console.log('[2] subject 独立 sequence');
  {
    const m = new LocalConsentLedgerModel();
    await m.append(inp('A', 1), NOW);
    await m.append(inp('A', 2), NOW);
    const b1 = await m.append(inp('B', 1), NOW);
    check('subject B は 1 から独立', b1.status === 'inserted' && b1.row.serverSequence === 1);
  }

  console.log('[3] duplicate/conflict は seq を消費しない');
  {
    const m = new LocalConsentLedgerModel();
    await m.append(inp('u1', 1), NOW); // seq 1
    await m.append(inp('u1', 1), NOW); // 同 key retry → duplicate（seq 消費なし）
    const next = await m.append(inp('u1', 2), NOW);
    check('duplicate retry 後の次 seq = 2（消費なし）', next.status === 'inserted' && next.row.serverSequence === 2);
  }

  console.log('[4] concurrency（並行 append・advisory lock 直列化）');
  {
    const m = new LocalConsentLedgerModel();
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_v, i) => m.append(inp('race', i), NOW)),
    );
    const seqs = results.filter((r) => r.status === 'inserted').map((r) => (r as { row: { serverSequence: number } }).row.serverSequence);
    const uniq = new Set(seqs);
    check(`並行 ${N} 件すべて inserted`, seqs.length === N);
    check('sequence が全て unique（collision なし）', uniq.size === N, `${uniq.size}/${N}`);
    check('sequence が 1..N を網羅（monotonic・gap なし）', Math.min(...seqs) === 1 && Math.max(...seqs) === N);
    check('最終 row count = N', m._allEventsForSubject('race').length === N);
  }

  console.log('[5] naked MAX+1（lock なし）は collision する → lock の必要性を実証');
  {
    const m = new LocalConsentLedgerModel();
    let violations = 0;
    const N = 30;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_v, i) => m.appendUnsafe(inp('unsafe', i), NOW)),
    );
    for (const r of results) if (r.status === 'rejected' && String(r.reason).includes('unique_violation')) violations += 1;
    check('naked MAX+1 は unique_violation を起こす（>=1）', violations >= 1, `violations=${violations}`);
    check('=> advisory lock 直列化が必須であることを実証', violations >= 1);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
