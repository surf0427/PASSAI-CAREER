/*
 * scripts/career-consent-reducer-qa.ts
 *
 * PASSAI CAREER — Consent Ledger reducer + versioning QA（P14-C・B. Reducer / C. Version）。
 *
 * 何を守るか（P14-C §10 / §11 / §22-B / §22-C）:
 *   - never_granted / active / withdrawn / version_outdated / deletion_pending / deleted / invalid。
 *   - scope 独立（user-facing active でも AI は never_granted）。
 *   - withdrawal 後の再同意で active へ復帰。
 *   - current version のみ active / outdated は inactive / superseded 後は reconsent 必須。
 *   - scope ごとの version 分離 / version 自動昇格なし。
 *   - account deletion は terminal・削除後 grant を拒否。
 *
 * 使い方: npx tsx scripts/career-consent-reducer-qa.ts
 */

import { deriveConsentState } from '@/lib/careerConsent/reducer';
import { grant, withdraw, reconfirm, superseded, deletionRequested, deleted, iso, NOW, UF, AI } from './fixtures/careerConsentFixtures';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const st = (events: Parameters<typeof deriveConsentState>[0]['events']) => deriveConsentState({ events, now: NOW });

console.log('[1] basic states');
{
  check('no events → never_granted', st([]).byScope[UF].status === 'never_granted');
  check('grant → active', st([grant('u1', { seq: 1, effectiveAt: iso(20) })]).byScope[UF].status === 'active');
  check('grant→withdraw → withdrawn', st([grant('u1', { seq: 1, effectiveAt: iso(20) }), withdraw('u1', { seq: 2, effectiveAt: iso(10) })]).byScope[UF].status === 'withdrawn');
}

console.log('[2] scope independence');
{
  const s = st([grant('u1', { seq: 1, scope: UF, effectiveAt: iso(20) })]);
  check('user-facing active', s.byScope[UF].status === 'active');
  check('AI は never_granted（独立）', s.byScope[AI].status === 'never_granted');

  const s2 = st([
    grant('u1', { seq: 1, scope: UF, effectiveAt: iso(20) }),
    grant('u1', { seq: 2, scope: AI, consentVersion: 1, noticeVersion: 'notice-dev-1', policyDigest: 'sha256:dev-ai_context_aggregated_insight', effectiveAt: iso(19) }),
    withdraw('u1', { seq: 3, scope: UF, effectiveAt: iso(10) }),
  ]);
  check('UF withdrawn だが AI は active（独立 withdrawal）', s2.byScope[UF].status === 'withdrawn' && s2.byScope[AI].status === 'active');
}

console.log('[3] withdrawal 後の再同意');
{
  const s = st([
    grant('u1', { seq: 1, effectiveAt: iso(30) }),
    withdraw('u1', { seq: 2, effectiveAt: iso(20) }),
    grant('u1', { seq: 3, effectiveAt: iso(10) }),
  ]);
  check('withdraw 後 grant → active に復帰', s.byScope[UF].status === 'active');
  check('withdrawnAt が解消される', s.byScope[UF].withdrawnAt === null);
}

console.log('[4] versioning');
{
  const outdated = st([grant('u1', { seq: 1, consentVersion: 0, effectiveAt: iso(20) })]);
  check('outdated version grant → version_outdated', outdated.byScope[UF].status === 'version_outdated');
  check('reconsentRequired=true', outdated.byScope[UF].reconsentRequired === true);

  const superNoReconfirm = st([grant('u1', { seq: 1, effectiveAt: iso(20) }), superseded('u1', { seq: 2, effectiveAt: iso(10) })]);
  check('superseded 後 reconfirm なし → version_outdated', superNoReconfirm.byScope[UF].status === 'version_outdated');

  const superReconfirm = st([grant('u1', { seq: 1, effectiveAt: iso(20) }), superseded('u1', { seq: 2, effectiveAt: iso(15) }), reconfirm('u1', { seq: 3, effectiveAt: iso(10) })]);
  check('superseded 後 reconfirm あり → active', superReconfirm.byScope[UF].status === 'active');

  // version 自動昇格なし: 旧 version grant は current と一致しない限り active にならない。
  check('version 自動昇格なし', st([grant('u1', { seq: 1, consentVersion: 0, effectiveAt: iso(5) })]).byScope[UF].status !== 'active');
}

console.log('[5] account deletion terminal');
{
  const pending = st([grant('u1', { seq: 1, effectiveAt: iso(20) }), deletionRequested('u1', { seq: 2, effectiveAt: iso(10) })]);
  check('deletion requested → account_deletion_pending（全 scope）', pending.byScope[UF].status === 'account_deletion_pending' && pending.accountStatus === 'deletion_pending');

  const del = st([grant('u1', { seq: 1, effectiveAt: iso(20) }), deleted('u1', { seq: 2, effectiveAt: iso(10) })]);
  check('deleted → account_deleted（terminal）', del.byScope[UF].status === 'account_deleted' && del.accountStatus === 'deleted');

  const grantAfterDelete = st([deleted('u1', { seq: 1, effectiveAt: iso(20) }), grant('u1', { seq: 2, effectiveAt: iso(10) })]);
  check('deleted 後 grant は active にしない', grantAfterDelete.byScope[UF].status === 'account_deleted');

  const grantAfterPending = st([deletionRequested('u1', { seq: 1, effectiveAt: iso(20) }), grant('u1', { seq: 2, effectiveAt: iso(10) })]);
  check('deletion pending 後 grant も active にしない', grantAfterPending.byScope[UF].status === 'account_deletion_pending');
}

console.log('[6] invalid ledger');
{
  // conflicting sequence（同一 seq・異なる payload）。
  const invalid = st([grant('u1', { seq: 1, effectiveAt: iso(20) }), withdraw('u1', { seq: 1, effectiveAt: iso(10) })]);
  check('conflicting sequence → invalid_ledger', invalid.byScope[UF].status === 'invalid_ledger' && invalid.invalidLedger === true);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
