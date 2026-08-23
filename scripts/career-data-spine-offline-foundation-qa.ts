/*
 * scripts/career-data-spine-offline-foundation-qa.ts
 *
 * PASSAI CAREER — Data Spine Offline Foundation 統合 QA（P17-A §10）。
 *
 * 検証範囲（production 非接続・synthetic のみ）:
 *   [A] Shared Context Source contract（1-7）
 *   [B] Layer 4 read repository / ETL / rare-category / privacy（8-18）
 *   [C] Layer 5 company knowledge domain（19-34）
 *   [D] Loader / production isolation static guard（35-46）
 *
 * 既存 Orchestrator byte-identical / prompt golden / Layer 4 QA / Personal Memory QA（47-50）は
 * 既存 npm script（qa:careerAggregateSeries 等）で別途検証する（本 runner の対象外）。
 *
 * 使い方: npx tsx scripts/career-data-spine-offline-foundation-qa.ts
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── 対象モジュール ───────────────────────────────────────────────────
import { renderSafeAggregate } from '@/lib/careerAggregate/renderer';
import { createInMemoryAggregateReadRepository } from '@/lib/careerAggregate/inMemoryReadRepository';
import { runOfflineEtl, collectDroppedInputFields } from '@/lib/careerAggregate/offlineEtl';
import { evaluateRareCategory, RARE_CATEGORY_POLICY } from '@/lib/careerAggregate/rareCategory';
import { runFeatureUsagePrevalence } from '@/lib/careerAggregate/pipeline';
import { baseInput, usersEachOneEvent, consent, GENERATED_AT } from './fixtures/careerAggregateFixtures';
import { etlUsers, ETL_MONTH, ETL_NOW, ETL_WINDOW, ETL_GENERATED_AT } from './fixtures/careerAggregateEventFixtures';

import { detectAliasCollisions, resolveCompany } from '@/lib/careerCompanyKnowledge/identity';
import { classifyPair } from '@/lib/careerCompanyKnowledge/dedup';
import { createInMemoryCompanyKnowledgeRepository } from '@/lib/careerCompanyKnowledge/inMemoryRepository';
import {
  MASTER,
  NOW_ISO,
  mkContribution,
  moderationPending,
  moderationPiiUnknown,
  moderationConfidentialityUnknown,
} from './fixtures/careerCompanyKnowledgeFixtures';

import { sampleAvailable, assertNoDataOnNonAvailable } from './fixtures/careerContextSourceFixtures';
import { isContextSourceAvailable } from '@/types/careerContextSource';
import type { AggregatedInsightProjection, ContextSourceResult } from '@/types/careerContextSource';
import type { CareerEventFeature } from '@/types/careerAggregate';

import {
  loadAggregatedInsightContext,
} from '@/lib/careerContextLoaders/aggregatedInsight';
import { loadCompanyKnowledgeContext } from '@/lib/careerContextLoaders/companyKnowledge';
import { loadPersonalMemoryContext } from '@/lib/careerContextLoaders/personalMemory';

let failures = 0;
import {
  assertSanctionedPureModules,
  findForbiddenLayerImports,
  SANCTIONED_PURE_LAYER_MODULES,
} from './fixtures/careerLayerBoundary';

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

// prompt 側で「利用可能」なのは available のみ（stale/disabled/blocked/empty/unavailable は不可）。
function isPromptUsable(r: ContextSourceResult<unknown>): boolean {
  return r.status === 'available';
}
// literal narrowing を避けて status 文字列を比較するための helper。
function statusOf(r: ContextSourceResult<unknown>): string {
  return r.status;
}

// ══════════════════════════════════════════════════════════════════
console.log('[A] Shared Context Source contract');
{
  const avail = sampleAvailable();
  const empty: ContextSourceResult<unknown> = { status: 'empty', reason: 'no_evidence' };
  const unavailable: ContextSourceResult<unknown> = { status: 'unavailable', reason: 'unknown' };
  const disabled: ContextSourceResult<unknown> = { status: 'disabled', reason: 'not_connected' };
  const blocked: ContextSourceResult<unknown> = { status: 'blocked', reason: 'consent' };
  const stale: ContextSourceResult<unknown> = { status: 'stale', reason: 'freshness_expired' };

  // 1. available だけが data を持つ
  check('1 available は data を持つ', 'data' in avail && isContextSourceAvailable(avail));
  check('1 empty/unavailable/disabled/blocked/stale は data を持たない',
    !('data' in empty) && !('data' in unavailable) && !('data' in disabled) && !('data' in blocked) && !('data' in stale));
  check('1 assertNoDataOnNonAvailable(empty)=true', assertNoDataOnNonAvailable(empty) === true);

  // 2. available 必須属性
  check('2 available は privacy/usage/provenance/confidence/freshness 必須',
    avail.status === 'available' &&
    'privacy' in avail && 'usage' in avail && 'provenance' in avail &&
    typeof avail.confidence === 'number' && 'freshness' in avail);

  // 3. empty ≠ unavailable
  check('3 empty と unavailable は別 status', statusOf(empty) !== statusOf(unavailable));
  check('3 empty.reason と unavailable.reason は別 union', empty.reason === 'no_evidence' && unavailable.reason === 'unknown');

  // 4. disabled ≠ blocked
  check('4 disabled と blocked は別 status', statusOf(disabled) !== statusOf(blocked));

  // 5. stale は prompt 利用不可
  check('5 stale は prompt 利用不可', isPromptUsable(stale) === false);
  check('5 available のみ prompt 利用可', isPromptUsable(avail) === true &&
    [empty, unavailable, disabled, blocked, stale].every((r) => isPromptUsable(r) === false));

  // 6. reason union（型で制限・runtime でも既知値のみ）
  const knownEmpty = ['no_evidence', 'no_eligible_data'];
  check('6 empty.reason は既知 union のみ', knownEmpty.includes(empty.reason));

  // 7. unknown が negative evidence として扱われない（empty と別・data 無し）
  check('7 unavailable は empty ではない & data 無し',
    statusOf(unavailable) !== 'empty' && !('data' in unavailable));
}

// ══════════════════════════════════════════════════════════════════
console.log('[B] Layer 4 read repository / ETL / rare-category / privacy');

// ETL over 50 eligible users（禁止 field 混入）。
const etl50 = etlUsers(50, 'interview');
const etlResult = runOfflineEtl({
  rawRows: etl50.rawRows,
  consentByUser: etl50.consentByUser,
  targets: [{ feature: 'interview', cohortType: 'all', cohortValue: 'all', monthBucket: ETL_MONTH, audience: 'user_facing' }],
  window: ETL_WINDOW,
  generatedAt: ETL_GENERATED_AT,
  now: ETL_NOW,
});
const etlJson = JSON.stringify(etlResult.artifacts);

{
  // 8. user_id が artifact に残らない
  check('8 artifact に user_id key 無し', !etlJson.includes('user_id') && !etlJson.includes('__dedupUserKey'));
  check('8 artifact に合成 user id (u#####) 無し', !/u\d{5}/.test(etlJson));

  // 9. free text / 禁止 field が残らない
  check('9 artifact に free text 無し', !etlJson.includes('raw free text') && !etlJson.includes('should-be-dropped'));
  check('9 droppedInputFields が禁止 field を捕捉',
    ['company_id', 'metadata', 'score_band', 'text', 'weakness_category', 'industry'].every((f) =>
      etlResult.droppedInputFields.includes(f)));
  check('9 droppedInputFields は決定論順', JSON.stringify(etlResult.droppedInputFields) === JSON.stringify([...etlResult.droppedInputFields].sort()));

  // 10. exact raw count が prompt projection へ出ない
  const valid = etlResult.artifacts[0];
  check('10 ETL(all,50) は valid', valid.kind === 'valid');
  if (valid.kind === 'valid') {
    const rendered = renderSafeAggregate(valid)!;
    const projection: AggregatedInsightProjection = {
      metricKey: valid.metricKey,
      feature: valid.feature,
      displayText: rendered.text,
      disclaimerKey: valid.disclaimerKey,
      sampleSizeBucket: valid.sampleSizeBucket,
      generatedAt: valid.generatedAt,
      expiresAt: valid.expiresAt,
      provenance: {
        layer: 'aggregated_insight',
        generatedAt: valid.generatedAt,
        sourceWindow: valid.timeBucket,
        calculationVersion: valid.calculationVersion,
        policyStatus: valid.provenance.policyStatus,
      },
    };
    const pk = Object.keys(projection);
    check('10 projection に numerator/denominator/prevalence key 無し',
      !pk.includes('numerator') && !pk.includes('denominator') && !pk.includes('prevalence'));
    check('10 projection は sampleSizeBucket を持つ', projection.sampleSizeBucket === '50–99');
  }

  // 11. rare category が suppressed（graduation_year の support < 20）
  const rareUsers = etlUsers(5, 'interview'); // 5 人（< minCategorySupport 20）
  const cohortByUser: Record<string, string> = {};
  for (const r of rareUsers.rawRows) cohortByUser[String(r.user_id)] = '2028';
  const rareEtl = runOfflineEtl({
    rawRows: rareUsers.rawRows,
    consentByUser: rareUsers.consentByUser,
    cohortByUser,
    targets: [{ feature: 'interview', cohortType: 'graduation_year', cohortValue: '2028', monthBucket: ETL_MONTH, audience: 'user_facing' }],
    window: ETL_WINDOW, generatedAt: ETL_GENERATED_AT, now: ETL_NOW,
  });
  check('11 rare category → suppressed(rare_category)',
    rareEtl.artifacts[0].kind === 'suppressed' &&
    rareEtl.artifacts[0].suppression.suppressed === true &&
    rareEtl.artifacts[0].suppression.reason === 'rare_category');
  check('11 evaluateRareCategory(all) は常に rare=false',
    evaluateRareCategory({ cohortType: 'all', distinctUsersInCategory: 1 }).rare === false);
  check('11 rare policy は PROVISIONAL', RARE_CATEGORY_POLICY.status === 'PROVISIONAL');

  // 12. insufficient cohort が suppressed（k=49 user_facing）
  const k49 = usersEachOneEvent(49, 'interview');
  const a49 = runFeatureUsagePrevalence(baseInput({ ...k49 }));
  check('12 k=49 → suppressed(below_audience_threshold)',
    a49.kind === 'suppressed' && a49.suppression.suppressed && a49.suppression.reason === 'below_audience_threshold');

  // 13. zero ≠ suppressed
  const evs = usersEachOneEvent(50, 'interview').events;
  const personalOnly: Record<string, ReturnType<typeof consent.personalOnly>> = {};
  for (const e of evs) personalOnly[String(e.user_id)] = consent.personalOnly();
  const zeroA = runFeatureUsagePrevalence(baseInput({ events: evs, consentByUser: personalOnly }));
  check('13 eligible 0 → zero（suppressed ではない）', zeroA.kind === 'zero' && zeroA.suppression.suppressed === false);
  check('13 zero と suppressed は別 kind', zeroA.kind !== a49.kind);

  // 14. stale artifact が read 不可
  const repo = createInMemoryAggregateReadRepository();
  const validFresh = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(50, 'interview'), generatedAt: GENERATED_AT }));
  repo.put(validFresh);
  const query = {
    metricKey: 'feature_usage_prevalence' as const,
    feature: 'interview' as CareerEventFeature,
    cohortType: 'all' as const,
    cohortValue: 'all',
    timeBucket: '2026-05',
    audience: 'user_facing' as const,
  };
  const readFresh = repo.read({ ...query, now: Date.parse('2026-07-05T00:00:00.000Z') });
  const readStale = repo.read({ ...query, now: Date.parse('2026-07-30T00:00:00.000Z') }); // expiresAt 超過
  check('14 期限内 → available', readFresh.status === 'available');
  check('14 期限切れ → stale（available にしない）', readStale.status === 'stale');
  check('14 未登録 key → missing', repo.read({ ...query, feature: 'es', now: ETL_NOW }).status === 'missing');

  // 15. duplicate metric の結果が決定的（新しい generatedAt を採用・put 順非依存）
  const older = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(50, 'interview'), generatedAt: '2026-07-01T00:00:00.000Z' }));
  const newer = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(60, 'interview'), generatedAt: '2026-07-05T00:00:00.000Z' }));
  const r1 = createInMemoryAggregateReadRepository();
  r1.put(older); r1.put(newer);
  const r2 = createInMemoryAggregateReadRepository();
  r2.put(newer); r2.put(older);
  const read1 = r1.read({ ...query, now: Date.parse('2026-07-08T00:00:00.000Z') });
  const read2 = r2.read({ ...query, now: Date.parse('2026-07-08T00:00:00.000Z') });
  check('15 duplicate metric は put 順非依存で同一', JSON.stringify(read1) === JSON.stringify(read2));
  check('15 新しい generatedAt(denominator=60) を採用',
    read1.status === 'available' && read1.artifact.kind === 'valid' && read1.artifact.denominator === 60);

  // 16. ETL fixture output が決定的
  const etlAgain = runOfflineEtl({
    rawRows: etl50.rawRows, consentByUser: etl50.consentByUser,
    targets: [{ feature: 'interview', cohortType: 'all', cohortValue: 'all', monthBucket: ETL_MONTH, audience: 'user_facing' }],
    window: ETL_WINDOW, generatedAt: ETL_GENERATED_AT, now: ETL_NOW,
  });
  check('16 ETL output は決定的（再実行で同一）', JSON.stringify(etlAgain.artifacts) === etlJson);
  check('16 collectDroppedInputFields は決定的', JSON.stringify(collectDroppedInputFields(etl50.rawRows)) === JSON.stringify(etlResult.droppedInputFields));

  // 17. missing consent が available にならない
  const noConsent = runFeatureUsagePrevalence(baseInput({ events: evs, consentByUser: {} }));
  check('17 consent 無し → valid にならない', noConsent.kind !== 'valid');

  // 18. complementary / differencing attack が安全側
  // grad2027=50（valid 可能）だが grad2028=3（rare/absolute 未満）→ 差分で 2028 個人を特定できない。
  const g27 = usersEachOneEvent(50, 'interview', 0);
  const g28 = usersEachOneEvent(3, 'interview', 500);
  const cohortMix: Record<string, string> = {};
  for (const e of g27.events) cohortMix[String(e.user_id)] = '2027';
  for (const e of g28.events) cohortMix[String(e.user_id)] = '2028';
  const diffEtl = runOfflineEtl({
    rawRows: [...g27.events, ...g28.events],
    consentByUser: { ...g27.consentByUser, ...g28.consentByUser },
    cohortByUser: cohortMix,
    targets: [{ feature: 'interview', cohortType: 'graduation_year', cohortValue: '2028', monthBucket: '2026-05', audience: 'user_facing' }],
    window: ETL_WINDOW, generatedAt: ETL_GENERATED_AT, now: ETL_NOW,
  });
  check('18 差分攻撃対象の小 cohort(2028=3) は suppressed（数値なし）',
    diffEtl.artifacts[0].kind === 'suppressed');
}

// ══════════════════════════════════════════════════════════════════
console.log('[C] Layer 5 company knowledge domain');
{
  // 25. ambiguous company identity が確定されない
  const zeta = resolveCompany('zeta', MASTER);
  check('25 alias "zeta" は ambiguous（確定しない）', zeta.status === 'ambiguous');
  check('25 一意名は resolved', resolveCompany('Alpha株式会社', MASTER).status === 'resolved');
  check('25 未知名は unresolved', resolveCompany('NoSuchCompany', MASTER).status === 'unresolved');

  // 26. alias collision を検出
  const collisions = detectAliasCollisions(MASTER);
  check('26 alias collision "zeta" を検出', collisions.some((c) => c.alias === 'zeta' && c.companyIds.length >= 2));

  // 27. exact duplicate を検出
  const c1 = mkContribution({ contributionId: 'k27a', contributorKey: 'kA' });
  const c1dup = mkContribution({ contributionId: 'k27b', contributorKey: 'kB' });
  check('27 同一内容 → exact_duplicate', classifyPair(c1, c1dup) === 'exact_duplicate');

  // 28. conflict を保持（同一 slot・低類似）
  const confA = mkContribution({ contributionId: 'k28a', contributorKey: 'kA', bodySummary: '一次はGD、二次は個人面接、最終は役員面接。' });
  const confB = mkContribution({ contributionId: 'k28b', contributorKey: 'kB', bodySummary: '選考はWebテストのみで面接は一切なかった。' });
  check('28 相反 evidence → conflicting（統合しない）', classifyPair(confA, confB) === 'conflicting');

  // Repository projection tests。
  const repo = createInMemoryCompanyKnowledgeRepository();
  for (const m of MASTER) repo.putMaster(m);

  // 29. 単一投稿を trend として返さない
  repo.putContribution(mkContribution({ contributionId: 's1', companyId: 'c_alpha', contributorKey: 'kSolo' }));
  const soloProj = repo.readProjection({ purpose: 'company_research', companyId: 'c_alpha', displayName: 'Alpha株式会社', nowIso: NOW_ISO });
  check('29 単一投稿 → available だが corroboration=single_report',
    soloProj.status === 'available' && soloProj.data.corroboration === 'single_report');

  // 20 + 30. contributor identity 非存在 & official/user 区別
  repo.putContribution(mkContribution({ contributionId: 's2', companyId: 'c_alpha', contributorKey: 'kOther', evidenceKind: 'official', contentCategory: 'briefing_note', bodySummary: '公式採用ページに説明会情報が記載されている。' }));
  const proj = repo.readProjection({ purpose: 'company_research', companyId: 'c_alpha', displayName: 'Alpha株式会社', nowIso: NOW_ISO });
  const projJson = JSON.stringify(proj);
  check('20 projection に contributor opaque key / 合成 contributor id 無し',
    !projJson.includes('__contributorOpaqueKey') && !projJson.includes('kSolo') && !projJson.includes('kOther') && !projJson.includes('kdefault'));
  check('20 projection に禁止 contributor field 無し',
    !projJson.includes('email') && !projJson.includes('applicationId') && !projJson.includes('university') && !projJson.includes('authUserId'));
  check('30 official と user_experience を区別',
    proj.status === 'available' && proj.data.evidence.some((e) => e.evidenceKind === 'official') && proj.data.evidence.some((e) => e.evidenceKind === 'user_experience'));

  // 21. consent 無しが read 不可
  const repo21 = createInMemoryCompanyKnowledgeRepository();
  repo21.putContribution(mkContribution({ contributionId: 'nc1', companyId: 'c_beta', consentState: 'not_shared', contributorKey: 'kX' }));
  check('21 consent not_shared → read 不可（empty）',
    repo21.readProjection({ purpose: 'company_research', companyId: 'c_beta', displayName: 'Beta', nowIso: NOW_ISO }).status === 'empty');

  // 22. moderation pending が read 不可
  const repo22 = createInMemoryCompanyKnowledgeRepository();
  repo22.putContribution(mkContribution({ contributionId: 'mp1', companyId: 'c_beta', moderation: moderationPending(), contributorKey: 'kX' }));
  check('22 moderation pending → read 不可（empty）',
    repo22.readProjection({ purpose: 'company_research', companyId: 'c_beta', displayName: 'Beta', nowIso: NOW_ISO }).status === 'empty');

  // 23. PII scan unknown が read 不可
  const repo23 = createInMemoryCompanyKnowledgeRepository();
  repo23.putContribution(mkContribution({ contributionId: 'pii1', companyId: 'c_beta', moderation: moderationPiiUnknown(), contributorKey: 'kX' }));
  check('23 PII scan not_scanned → read 不可（empty）',
    repo23.readProjection({ purpose: 'company_research', companyId: 'c_beta', displayName: 'Beta', nowIso: NOW_ISO }).status === 'empty');

  // 24. confidentiality unknown が read 不可
  const repo24 = createInMemoryCompanyKnowledgeRepository();
  repo24.putContribution(mkContribution({ contributionId: 'cf1', companyId: 'c_beta', moderation: moderationConfidentialityUnknown(), contributorKey: 'kX' }));
  check('24 confidentiality unknown → read 不可（empty）',
    repo24.readProjection({ purpose: 'company_research', companyId: 'c_beta', displayName: 'Beta', nowIso: NOW_ISO }).status === 'empty');

  // 28(proj). conflict を projection でも保持
  const repoCf = createInMemoryCompanyKnowledgeRepository();
  repoCf.putContribution(mkContribution({ contributionId: 'cfa', companyId: 'c_alpha', contributorKey: 'kA', bodySummary: '一次はGD、二次は個人面接、最終は役員面接。' }));
  repoCf.putContribution(mkContribution({ contributionId: 'cfb', companyId: 'c_alpha', contributorKey: 'kB', bodySummary: '選考はWebテストのみで面接は一切なかった。' }));
  const cfProj = repoCf.readProjection({ purpose: 'company_research', companyId: 'c_alpha', displayName: 'Alpha株式会社', nowIso: NOW_ISO });
  check('28 projection が conflict を隠さない',
    cfProj.status === 'available' && (cfProj.data.corroboration === 'conflicting' || cfProj.data.evidence.some((e) => e.conflicting)));

  // 31. stale evidence を除外
  const repo31 = createInMemoryCompanyKnowledgeRepository();
  repo31.putContribution(mkContribution({ contributionId: 'st1', companyId: 'c_beta', observedPeriod: '2020', contributorKey: 'kX' }));
  check('31 stale evidence（observedPeriod 2020）→ 除外（empty）',
    repo31.readProjection({ purpose: 'company_research', companyId: 'c_beta', displayName: 'Beta', nowIso: NOW_ISO }).status === 'empty');

  // 32. purpose-specific projection が過剰情報を返さない
  const repo32 = createInMemoryCompanyKnowledgeRepository();
  repo32.putContribution(mkContribution({ contributionId: 'sf1', companyId: 'c_alpha', contentCategory: 'selection_flow', contributorKey: 'kX' }));
  repo32.putContribution(mkContribution({ contributionId: 'es1', companyId: 'c_alpha', contentCategory: 'es_question', bodySummary: '学生時代に力を入れたことを400字で問われた。', contributorKey: 'kY' }));
  const esProj = repo32.readProjection({ purpose: 'es_generation', companyId: 'c_alpha', displayName: 'Alpha株式会社', nowIso: NOW_ISO });
  check('32 es_generation は es_question のみ（selection_flow を含まない）',
    esProj.status === 'available' && esProj.data.evidence.every((e) => e.contentCategory !== 'selection_flow'));

  // 33. revoke 済 contribution が read されない
  const repo33 = createInMemoryCompanyKnowledgeRepository();
  repo33.putContribution(mkContribution({ contributionId: 'rv1', companyId: 'c_beta', contributorKey: 'kX' }));
  const beforeRevoke = repo33.readProjection({ purpose: 'company_research', companyId: 'c_beta', displayName: 'Beta', nowIso: NOW_ISO });
  check('33 revoke 前は available', beforeRevoke.status === 'available');
  repo33.revoke('rv1');
  check('33 revoke 後は read されない（empty）',
    repo33.readProjection({ purpose: 'company_research', companyId: 'c_beta', displayName: 'Beta', nowIso: NOW_ISO }).status === 'empty');

  // 34. output 順が決定的
  const projA = repo.readProjection({ purpose: 'company_research', companyId: 'c_alpha', displayName: 'Alpha株式会社', nowIso: NOW_ISO });
  const projB = repo.readProjection({ purpose: 'company_research', companyId: 'c_alpha', displayName: 'Alpha株式会社', nowIso: NOW_ISO });
  check('34 projection 出力順は決定的', JSON.stringify(projA) === JSON.stringify(projB));
}

// ══════════════════════════════════════════════════════════════════
console.log('[C-guard] Layer 5 private research 分離');
{
  // 19. private research import が 0 件（Layer 5 domain / loaders から）。
  const l5Files = [...walk(join(ROOT, 'lib/careerCompanyKnowledge')), ...walk(join(ROOT, 'lib/careerContextLoaders'))];
  const offenders = l5Files.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return /careerCompanyResearch/.test(src) || /companyResearchStorage/.test(src);
  });
  check('19 Layer5/loaders が private company research を import しない', offenders.length === 0, offenders.join(','));
}

// ══════════════════════════════════════════════════════════════════
console.log('[D] Loader / production isolation');

async function loaderChecks(): Promise<void> {
  // 35. 3 loader が常に disabled
  const ai = await loadAggregatedInsightContext({ purpose: 'consultation' });
  const ck = await loadCompanyKnowledgeContext({ purpose: 'company_research', companyId: 'c_alpha' });
  const pm = await loadPersonalMemoryContext({ sections: ['base'] });
  check('35 aggregatedInsight loader = disabled/not_connected', ai.status === 'disabled' && ai.reason === 'not_connected');
  check('35 companyKnowledge loader = disabled/not_connected', ck.status === 'disabled' && ck.reason === 'not_connected');
  check('35 personalMemory loader = disabled/shadow_only（available を返さない）',
    pm.status === 'disabled' && pm.reason === 'shadow_only');

  // 36. 複数回呼出しが同一結果
  const ai2 = await loadAggregatedInsightContext({ purpose: 'consultation' });
  check('36 loader は複数回で同一結果', JSON.stringify(ai) === JSON.stringify(ai2));

  // 37. loader が例外を投げない
  let threw = false;
  try {
    await loadAggregatedInsightContext({ purpose: '' });
    await loadCompanyKnowledgeContext({ purpose: '', companyId: '' });
    await loadPersonalMemoryContext({});
  } catch {
    threw = true;
  }
  check('37 loader は例外を投げない', threw === false);
}

// 38-43. 静的 import guard。
function importGuards(): void {
  // production consumer（app / components / lib（新 dir 除く））が loaders / company knowledge を import しない。
  const NEW_DIR_PREFIXES = [
    join(ROOT, 'lib/careerContextLoaders'),
    join(ROOT, 'lib/careerCompanyKnowledge'),
  ];
  const isNewDir = (f: string) => NEW_DIR_PREFIXES.some((p) => f.startsWith(p));
  const consumerFiles = [
    ...walk(join(ROOT, 'app')),
    ...walk(join(ROOT, 'components')),
    ...walk(join(ROOT, 'lib')),
  ].filter((f) => !isNewDir(f));

  const importsLoader = (src: string) => /from\s+['"][^'"]*careerContextLoaders[^'"]*['"]/.test(src);
  // ★ Company Knowledge（Layer 5）の **データ権威** を production が使っていないこと。
  //   企業名正規化のような純粋関数の再利用は Company Identity の正当な実装なので
  //   allowlist で除外する（allowlist 対象の purity は下の 43b が毎回検証する）。
  const importsCompanyKnowledge = (src: string) =>
    findForbiddenLayerImports(src, ['careerCompanyKnowledge']).length > 0;

  const appApiFiles = consumerFiles.filter((f) => f.startsWith(join(ROOT, 'app')));
  const apiOnly = appApiFiles.filter((f) => f.startsWith(join(ROOT, 'app/api')));

  const loaderOffendersApp = appApiFiles.filter((f) => importsLoader(readFileSync(f, 'utf8')));
  const loaderOffendersApi = apiOnly.filter((f) => importsLoader(readFileSync(f, 'utf8')));
  const ckOffenders = consumerFiles.filter((f) => importsCompanyKnowledge(readFileSync(f, 'utf8')));

  // 38. app/ から loader import 0
  check('38 app/ から loader import 0', loaderOffendersApp.length === 0, loaderOffendersApp.join(','));
  // 39. app/api/ から loader import 0
  check('39 app/api/ から loader import 0', loaderOffendersApi.length === 0, loaderOffendersApi.join(','));
  // 43. private research storage import 0（新 Layer5/loaders 側）は [C-guard]19 で検証済。
  check('43 production consumer が company knowledge domain のデータ権威を import 0', ckOffenders.length === 0, ckOffenders.join(','));
  // 43b. 許可した純粋 module が I/O を獲得していないこと（許可が穴に化けない）。
  const impureCk = assertSanctionedPureModules(ROOT);
  check(
    `43b allowlist した Layer 4/5 module は純粋関数のまま（${SANCTIONED_PURE_LAYER_MODULES.length} module）`,
    impureCk.length === 0,
    impureCk.map((v) => `${v.file}: ${v.markers.join('/')}`).join(' | '),
  );

  // 40. production prompt から import 0（prompt 名を含むファイル）。
  const promptFiles = consumerFiles.filter((f) => /prompt/i.test(f));
  const promptOffenders = promptFiles.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return importsLoader(src) || importsCompanyKnowledge(src) || /careerContextSource/.test(src);
  });
  check('40 production prompt から loader/company/context-source import 0', promptOffenders.length === 0, promptOffenders.join(','));

  // 41. orchestrator.ts から import 0
  const orch = readFileSync(join(ROOT, 'lib/careerContext/orchestrator.ts'), 'utf8');
  check('41 orchestrator.ts が新モジュールを import しない',
    !/careerContextLoaders/.test(orch) && !/careerCompanyKnowledge/.test(orch) &&
    !/careerContextSource/.test(orch) && !/careerAggregate/.test(orch));

  // 42. 新モジュールが production Supabase / localStorage / fetch / server-only を import しない
  const newFiles = [
    ...walk(join(ROOT, 'lib/careerContextLoaders')),
    ...walk(join(ROOT, 'lib/careerCompanyKnowledge')),
    join(ROOT, 'lib/careerAggregate/readRepository.ts'),
    join(ROOT, 'lib/careerAggregate/inMemoryReadRepository.ts'),
    join(ROOT, 'lib/careerAggregate/offlineEtl.ts'),
    join(ROOT, 'lib/careerAggregate/rareCategory.ts'),
    join(ROOT, 'types/careerContextSource.ts'),
    join(ROOT, 'types/careerCompanyKnowledge.ts'),
  ];
  const unsafe = newFiles.filter((f) => {
    if (!existsSync(f)) return false;
    const src = readFileSync(f, 'utf8');
    // 実 import / 実使用のみを検出する（コメント中の語は対象外）。
    return /from\s+['"][^'"]*supabase[^'"]*['"]/i.test(src) ||
      /\blocalStorage\s*\./.test(src) ||
      /from\s+['"]server-only['"]/.test(src) ||
      /from\s+['"]next\/headers['"]/.test(src) ||
      /\bfetch\s*\(/.test(src);
  });
  check('42 新モジュールが supabase/localStorage/fetch/server-only を実使用しない', unsafe.length === 0, unsafe.join(','));
}

// ── run async + finalize ─────────────────────────────────────────────
loaderChecks()
  .then(() => {
    importGuards();
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('UNEXPECTED', err);
    process.exit(1);
  });
