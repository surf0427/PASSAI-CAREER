/*
 * scripts/career-consent-ordering-qa.ts
 *
 * PASSAI CAREER — Consent Ledger server-authoritative ordering QA（P14-C・D. Ordering）。
 *
 * 何を守るか（P14-C §8 / §22-D）:
 *   - serverSequence 順で状態導出（client timestamp 非権威）。
 *   - 入力順が shuffle されても結果不変（serverSequence で整列）。
 *   - duplicate sequence（同一 payload）は致命でない / conflicting sequence は invalid。
 *   - 非有限 sequence / future effective timestamp を検知。
 *
 * 使い方: npx tsx scripts/career-consent-ordering-qa.ts
 */

import { validateOrdering } from '@/lib/careerConsent/ledger';
import { deriveConsentState } from '@/lib/careerConsent/reducer';
import { grant, withdraw, iso, NOW, UF } from './fixtures/careerConsentFixtures';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('[1] valid monotonic');
{
  const ev = [grant('u1', { seq: 1, effectiveAt: iso(20) }), withdraw('u1', { seq: 2, effectiveAt: iso(10) })];
  check('valid → ok', validateOrdering(ev, NOW).ok === true);
}

console.log('[2] client timestamp 非権威 / 入力順非依存');
{
  // serverSequence: grant=1(古い effective), withdraw=2。ただし effectiveAt を逆転させても
  // serverSequence が権威なので withdraw が後。さらに入力配列も shuffle。
  const g = grant('u1', { seq: 1, effectiveAt: iso(5) }); // grant の effective は新しい
  const w = withdraw('u1', { seq: 2, effectiveAt: iso(20) }); // withdraw の effective は古い
  const ordered = deriveConsentState({ events: [g, w], now: NOW });
  const shuffled = deriveConsentState({ events: [w, g], now: NOW });
  check('serverSequence 権威で withdraw が後 → withdrawn', ordered.byScope[UF].status === 'withdrawn');
  check('入力順 shuffle でも同結果', shuffled.byScope[UF].status === ordered.byScope[UF].status);
}

console.log('[3] duplicate / conflicting sequence');
{
  const dupSame = [grant('u1', { seq: 1, effectiveAt: iso(20) }), grant('u1', { seq: 1, effectiveAt: iso(20) })];
  const vd = validateOrdering(dupSame, NOW);
  check('同一 seq・同一 payload → duplicate_sequence（致命でない）', vd.issues.includes('duplicate_sequence') && vd.ok === true);

  const conflict = [grant('u1', { seq: 1, effectiveAt: iso(20) }), withdraw('u1', { seq: 1, effectiveAt: iso(10) })];
  const vc = validateOrdering(conflict, NOW);
  check('同一 seq・異なる payload → conflicting_sequence（invalid）', vc.issues.includes('conflicting_sequence') && vc.ok === false);
}

console.log('[4] invalid sequence / future timestamp');
{
  const nonFinite = [grant('u1', { seq: Number.NaN, effectiveAt: iso(10) })];
  check('非有限 sequence → non_finite_sequence / invalid', validateOrdering(nonFinite, NOW).issues.includes('non_finite_sequence'));

  const future = [grant('u1', { seq: 1, effectiveAt: new Date(NOW + 86400000).toISOString() })];
  const vf = validateOrdering(future, NOW);
  check('future effective → future_effective_timestamp / invalid', vf.issues.includes('future_effective_timestamp') && vf.ok === false);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
