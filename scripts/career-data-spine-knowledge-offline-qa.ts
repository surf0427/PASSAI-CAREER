/*
 * scripts/career-data-spine-knowledge-offline-qa.ts
 *
 * PASSAI CAREER — Data Spine Knowledge Offline 統合 QA（P17-B §15）。
 *
 * 検証範囲（production 非接続・synthetic のみ）:
 *   [A] Company identity / master
 *   [B] Contribution lifecycle / consent
 *   [C] PII / confidentiality（fail-closed）
 *   [D] Evidence aggregation / trend eligibility
 *   [E] Layer 5 repository（revoke/legal hold/history/order/projection）
 *   [F] Layer 4 batch / lineage / idempotency / validation
 *   [G] Revoke / deletion propagation
 *   [H] Audit / monitoring contract
 *   [I] Offline vertical simulation（L4→consultation / L5→company research）
 *   [J] Production isolation（static guard）
 *
 * 使い方: npx tsx scripts/career-data-spine-knowledge-offline-qa.ts
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertSanctionedPureModules,
  findForbiddenLayerImports,
  SANCTIONED_PURE_LAYER_MODULES,
} from './fixtures/careerLayerBoundary';

// Layer 5
import {
  detectAliasCollisions,
  resolveCompany,
  matchHistoricalName,
  isCorporateGroupReference,
  currentIdentityVersion,
  detectMergeCandidates,
} from '@/lib/careerCompanyKnowledge/identity';
import { transitionContributionLifecycle } from '@/lib/careerCompanyKnowledge/lifecycle';
import {
  buildGrantSnapshot,
  applyRevoke,
  deriveConsentEffectiveState,
  isConsentEffectiveForShare,
  isUsePermitted,
} from '@/lib/careerCompanyKnowledge/consentSnapshot';
import {
  createDeterministicPiiScanner,
  isPiiResultPublishable,
  notScannedResult,
  scanFailedResult,
} from '@/lib/careerCompanyKnowledge/pii';
import { buildEvidenceGroups } from '@/lib/careerCompanyKnowledge/evidence';
import { supersede, buildRevision, classifyStaleReason } from '@/lib/careerCompanyKnowledge/version';
import { createInMemoryCompanyKnowledgeRepository } from '@/lib/careerCompanyKnowledge/inMemoryRepository';

// Layer 4 readiness
import {
  startBatchManifest,
  completeBatchManifest,
  failBatchManifest,
  markIncomplete,
  validateBatchManifest,
  publishBatchManifest,
  manifestToGovernanceState,
} from '@/lib/careerAggregate/batchManifest';
import { startPropagation, advancePropagation, findAffectedBatches } from '@/lib/careerAggregate/invalidation';
import { createInMemoryAggregateBatchRepository } from '@/lib/careerAggregate/inMemoryBatchRepository';
import { runFeatureUsagePrevalence } from '@/lib/careerAggregate/pipeline';

// governance
import { evaluateGovernanceDisposition } from '@/lib/careerDataGovernance/state';
import { buildAuditEvent, isAuditPayloadSafe, buildRateSignal, buildCountSignal, isMonitoringSignalSafe, toCountBucket } from '@/lib/careerDataGovernance/audit';

// renderers（offline 専用）
import { renderAggregatedInsightConsultationBlock } from '@/lib/careerContextRenderers/aggregatedInsightConsultation';
import { renderCompanyKnowledgeResearchBlock } from '@/lib/careerContextRenderers/companyKnowledgeResearch';

// fixtures
import { baseInput, usersEachOneEvent } from './fixtures/careerAggregateFixtures';
import { MASTER, NOW_ISO, mkContribution } from './fixtures/careerCompanyKnowledgeFixtures';

import type { CompanyKnowledgeContribution, ContributionLifecycleState } from '@/types/careerCompanyKnowledge';
import type { AggregateBatchManifest } from '@/types/careerAggregateBatch';
import type { AggregatedInsightProjection, ContextSourceResult } from '@/types/careerContextSource';
import type { ValidAggregateArtifact } from '@/types/careerAggregate';

let failures = 0;
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

// published lifecycle 済 contribution を作る（projection gate も満たす）。
function mkPublished(over: Parameters<typeof mkContribution>[0]): CompanyKnowledgeContribution {
  return { ...mkContribution(over), lifecycleState: 'published' as ContributionLifecycleState };
}

// ══════════════════════════════════════════════════════════════════
console.log('[A] Company identity / master');
{
  check('A1 ambiguous を確定しない', resolveCompany('zeta', MASTER).status === 'ambiguous');
  check('A2 alias collision 検出', detectAliasCollisions(MASTER).some((c) => c.alias === 'zeta'));

  const histMaster = [
    { companyId: 'c_new', displayName: 'NewName株式会社', normalizedName: 'newname', aliases: [], corporateGroupId: null, historicalNames: ['OldName'] },
  ];
  check('A3 historical name 保持（照合できる）', matchHistoricalName('OldName', histMaster)?.companyId === 'c_new');
  check('A3 過去社名を current として自動確定しない', resolveCompany('OldName', histMaster).status === 'unresolved');

  const groupMaster = [
    { companyId: 'c_parent', displayName: 'Parent', normalizedName: 'parent', aliases: [], corporateGroupId: null, subsidiaryIds: ['c_sub'] },
    { companyId: 'c_sub', displayName: 'Sub', normalizedName: 'sub', aliases: [], corporateGroupId: null, parentId: 'c_parent' },
  ];
  check('A4 corporate group と単一法人を区別', isCorporateGroupReference('c_parent', groupMaster) === true && isCorporateGroupReference('c_sub', groupMaster) === false);

  check('A5 identity version 追跡', currentIdentityVersion({ companyId: 'x', displayName: 'X', normalizedName: 'x', aliases: [], corporateGroupId: null, identityVersion: 3 }) === 3);

  const dupMaster = [
    { companyId: 'c_a', displayName: 'Same', normalizedName: 'same', aliases: [], corporateGroupId: null },
    { companyId: 'c_b', displayName: 'Same', normalizedName: 'same', aliases: [], corporateGroupId: null },
  ];
  check('A6 merge candidate 検出（自動確定しない）', detectMergeCandidates(dupMaster).some((m) => m.kind === 'merge_candidate'));
}

// ══════════════════════════════════════════════════════════════════
console.log('[B] Contribution lifecycle / consent');
{
  // invalid transition
  check('B1 draft から publish は不可', transitionContributionLifecycle('draft', 'publish').ok === false);
  // consent なし publish 不可（consent_pending からは publish できない）
  check('B2 consent_pending から publish 不可', transitionContributionLifecycle('consent_pending', 'publish').ok === false);
  // moderation 前 publish 不可
  check('B3 moderation_pending から publish 不可', transitionContributionLifecycle('moderation_pending', 'publish').ok === false);
  // privacy review 前 approve 不可
  check('B4 submitted から approve 不可', transitionContributionLifecycle('submitted', 'approve').ok === false);
  // 正常 approve→publish
  check('B5 approved → publish 可', transitionContributionLifecycle('approved', 'publish').ok === true);
  // terminal
  check('B6 revoked（terminal）からの遷移拒否', transitionContributionLifecycle('revoked', 'publish').ok === false);

  // repository で full path + revoke + audit
  const repo = createInMemoryCompanyKnowledgeRepository();
  for (const m of MASTER) repo.putMaster(m);
  const c = { ...mkContribution({ contributionId: 'lc1', companyId: 'c_alpha', contributorKey: 'kA' }), lifecycleState: 'draft' as ContributionLifecycleState };
  repo.putContribution(c);
  const seq: Array<Parameters<typeof transitionContributionLifecycle>[1]> = ['submit', 'grant_consent', 'start_privacy_review', 'pass_privacy_review', 'approve', 'publish'];
  let allOk = true;
  seq.forEach((a, i) => { if (!repo.transitionLifecycle('lc1', a, `2026-06-0${i + 1}T00:00:00.000Z`).ok) allOk = false; });
  check('B7 full lifecycle path が成立', allOk && repo.getContribution('lc1')?.lifecycleState === 'published');
  const pubProj = repo.readProjection({ purpose: 'company_research', companyId: 'c_alpha', displayName: 'Alpha株式会社', nowIso: NOW_ISO });
  check('B7 published は projection available', pubProj.status === 'available');
  repo.transitionLifecycle('lc1', 'revoke', '2026-06-10T00:00:00.000Z');
  check('B8 revoke 後は read 不可（empty）', repo.readProjection({ purpose: 'company_research', companyId: 'c_alpha', displayName: 'Alpha株式会社', nowIso: NOW_ISO }).status === 'empty');
  const audit1 = repo.listLifecycleAudit();
  const audit2 = repo.listLifecycleAudit();
  check('B9 transition audit は記録され決定的', audit1.length >= 6 && JSON.stringify(audit1) === JSON.stringify(audit2));

  // legal hold
  const repoLH = createInMemoryCompanyKnowledgeRepository();
  repoLH.putContribution(mkPublished({ contributionId: 'lh1', companyId: 'c_beta', contributorKey: 'kX' }));
  check('B10 legal hold 前は available', repoLH.readProjection({ purpose: 'company_research', companyId: 'c_beta', displayName: 'Beta', nowIso: NOW_ISO }).status === 'available');
  repoLH.setLegalHold('lh1', true);
  check('B10 legal hold で read 除外（公開継続と混同しない）', repoLH.readProjection({ purpose: 'company_research', companyId: 'c_beta', displayName: 'Beta', nowIso: NOW_ISO }).status === 'empty');

  // consent snapshot
  const snap = buildGrantSnapshot({ contributionId: 'lc1', grantedAt: '2026-06-01T00:00:00.000Z' });
  check('B11 grant snapshot は granted', deriveConsentEffectiveState(snap) === 'granted' && isConsentEffectiveForShare(snap));
  check('B11 commercial_resale は許可されない（default deny）', isUsePermitted(snap, 'commercial_resale') === false);
  const revoked = applyRevoke(snap, '2026-06-05T00:00:00.000Z');
  check('B12 revoke 後は granted でない', deriveConsentEffectiveState(revoked) === 'revoked' && !isConsentEffectiveForShare(revoked));
}

// ══════════════════════════════════════════════════════════════════
console.log('[C] PII / confidentiality (fail-closed)');
{
  const scanner = createDeterministicPiiScanner();
  check('C1 not_scanned は publish 不可', isPiiResultPublishable(notScannedResult()) === false);
  check('C2 scan_failed は publish 不可', isPiiResultPublishable(scanFailedResult()) === false);
  const failed = scanner.scan(null as unknown as string);
  check('C2 非文字列入力は scan_failed', failed.state === 'scan_failed' && failed.publishable === false);

  const email = scanner.scan('連絡は sample@example.com まで');
  check('C3 email は confirmed / publish 不可', email.state === 'confirmed' && email.publishable === false);
  const nameLabel = scanner.scan('お名前: 山田花子');
  check('C4 氏名ラベルは suspected/confirmed / publish 不可', nameLabel.state !== 'clean' && nameLabel.publishable === false);
  const marker = scanner.scan('この情報は社外秘です');
  check('C5 confidential marker は prohibited / publish 不可', marker.confidentiality === 'prohibited' && marker.publishable === false);
  const clean = scanner.scan('一次面接は志望動機を中心に30分程度でした。');
  check('C6 clean/low のみ publishable', clean.state === 'clean' && clean.confidentiality === 'low' && clean.publishable === true);
  check('C7 raw content を findings へ残さない', !JSON.stringify(email.findings).includes('sample@example.com') && JSON.stringify(email.findings).includes('[redacted:'));
  check('C8 confidentiality unknown は publish 不可', notScannedResult().confidentiality === 'unknown' && notScannedResult().publishable === false);
}

// ══════════════════════════════════════════════════════════════════
console.log('[D] Evidence aggregation / trend eligibility');
{
  const solo = [mkContribution({ contributionId: 'e1', companyId: 'c_alpha', contributorKey: 'kA' })];
  const gSolo = buildEvidenceGroups(solo, NOW_ISO);
  check('D1 単一投稿は trend 不可', gSolo[0].trend.eligible === false && gSolo[0].trend.eligible === false);

  const dup = [
    mkContribution({ contributionId: 'd1', companyId: 'c_alpha', contributorKey: 'kA' }),
    mkContribution({ contributionId: 'd2', companyId: 'c_alpha', contributorKey: 'kA' }), // 同 contributor・同内容
  ];
  const gDup = buildEvidenceGroups(dup, NOW_ISO);
  check('D2 duplicate / 同一 source を独立根拠に数えない', gDup[0].independentContributorCount === 1 && gDup[0].corroboration === 'single');

  const conflict = [
    mkContribution({ contributionId: 'cf1', companyId: 'c_alpha', contributorKey: 'kA', bodySummary: '面接は3回、最終は役員面接。' }),
    mkContribution({ contributionId: 'cf2', companyId: 'c_alpha', contributorKey: 'kB', bodySummary: '面接はなくWebテストのみ。' }),
  ];
  const gConf = buildEvidenceGroups(conflict, NOW_ISO);
  check('D3 conflict を保持', gConf[0].hasConflict === true);
  check('D3 conflict 時は trend eligible=false', gConf[0].trend.eligible === false);

  const mixed = [
    mkContribution({ contributionId: 'of1', companyId: 'c_alpha', contributorKey: 'kA', evidenceKind: 'official' }),
    mkContribution({ contributionId: 'ue1', companyId: 'c_alpha', contributorKey: 'kB', evidenceKind: 'user_experience', bodySummary: '別の体験談です面接は和やか。' }),
  ];
  const gMix = buildEvidenceGroups(mixed, NOW_ISO);
  check('D4 official / user evidence を別 count', gMix[0].officialCount === 1 && gMix[0].userExperienceCount === 1);

  const twoIndep = [
    mkContribution({ contributionId: 'i1', companyId: 'c_alpha', contributorKey: 'kA', bodySummary: '選考フローはES→面接3回で共通。' }),
    mkContribution({ contributionId: 'i2', companyId: 'c_alpha', contributorKey: 'kB', bodySummary: '選考フローはES→面接3回で共通。' }),
  ];
  const gInd = buildEvidenceGroups(twoIndep, NOW_ISO);
  check('D5 2 独立 contributor・非 conflict は trend eligible', gInd[0].trend.eligible === true);
}

// ══════════════════════════════════════════════════════════════════
console.log('[E] Layer 5 repository (history / order / projection)');
{
  const repo = createInMemoryCompanyKnowledgeRepository();
  const older = mkContribution({ contributionId: 'v1', companyId: 'c_alpha', contributorKey: 'kA', observedPeriod: '2025', version: 1 });
  const newer = mkContribution({ contributionId: 'v2', companyId: 'c_alpha', contributorKey: 'kA', observedPeriod: '2026', version: 2 });
  const sup = supersede(older, newer);
  repo.putContribution(sup.older);
  repo.putContribution(sup.newer);
  const revs = repo.listRevisions(NOW_ISO);
  check('E1 history 保持（superseded も残る）', revs.length === 2);
  check('E1 superseded は staleReason=superseded', classifyStaleReason(sup.older, NOW_ISO) === 'superseded');
  check('E1 revision は削除されず buildRevision で lineage を持つ', buildRevision(sup.older, NOW_ISO).supersededBy === 'v2');
  const revs2 = repo.listRevisions(NOW_ISO);
  check('E2 listRevisions は決定的', JSON.stringify(revs) === JSON.stringify(revs2));

  // purpose projection 制限（es_generation は selection_flow を含めない）
  const repo2 = createInMemoryCompanyKnowledgeRepository();
  repo2.putContribution(mkPublished({ contributionId: 'sf', companyId: 'c_alpha', contentCategory: 'selection_flow', contributorKey: 'kX' }));
  repo2.putContribution(mkPublished({ contributionId: 'es', companyId: 'c_alpha', contentCategory: 'es_question', bodySummary: 'ESは志望動機400字。', contributorKey: 'kY' }));
  const esProj = repo2.readProjection({ purpose: 'es_generation', companyId: 'c_alpha', displayName: 'Alpha株式会社', nowIso: NOW_ISO });
  check('E3 purpose projection 制限（es は selection_flow 除外）', esProj.status === 'available' && esProj.data.evidence.every((e) => e.contentCategory !== 'selection_flow'));

  // stale 除外
  const repo3 = createInMemoryCompanyKnowledgeRepository();
  repo3.putContribution(mkPublished({ contributionId: 'old', companyId: 'c_beta', observedPeriod: '2018', contributorKey: 'kZ' }));
  check('E4 stale evidence は除外（empty）', repo3.readProjection({ purpose: 'company_research', companyId: 'c_beta', displayName: 'Beta', nowIso: NOW_ISO }).status === 'empty');

  // 件数上限
  const repo4 = createInMemoryCompanyKnowledgeRepository();
  for (let i = 0; i < 20; i++) {
    repo4.putContribution(mkPublished({ contributionId: `m${i}`, companyId: 'c_alpha', contentCategory: 'interview_question', bodySummary: `設問${i}: 学生時代の取り組みについて`, contributorKey: `k${i}` }));
  }
  const capped = repo4.readProjection({ purpose: 'company_research', companyId: 'c_alpha', displayName: 'Alpha株式会社', nowIso: NOW_ISO });
  check('E5 projection 件数上限が効く', capped.status === 'available' && capped.data.evidence.length <= 8);
}

// ══════════════════════════════════════════════════════════════════
console.log('[F] Layer 4 batch / lineage / idempotency');

function buildValidArtifactViaPipeline(generatedAt: string): ValidAggregateArtifact {
  const a = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(60, 'interview'), generatedAt }));
  if (a.kind !== 'valid') throw new Error('fixture artifact not valid');
  return a;
}

const baseManifestInput = {
  batchId: 'b1',
  idempotencyKey: 'idem-1',
  metricKey: 'feature_usage_prevalence' as const,
  calculationVersion: 'feature_usage_prevalence@1' as const,
  policyVersion: 1,
  sourceWindowStart: '2026-05-01T00:00:00.000Z',
  sourceWindowEnd: '2026-06-01T00:00:00.000Z',
  inputWatermark: '2026-06-02T00:00:00.000Z',
  consentSnapshotVersion: 'cs-1',
  startedAt: '2026-07-01T00:00:00.000Z',
};

{
  const repo = createInMemoryAggregateBatchRepository();
  const artifact = buildValidArtifactViaPipeline('2026-07-01T00:00:00.000Z');

  // happy path
  let m: AggregateBatchManifest = startBatchManifest(baseManifestInput);
  m = completeBatchManifest(m, { completedAt: '2026-07-01T01:00:00.000Z', sourceEventCountBucket: '100–499', eligibleEventCountBucket: '50–99', suppressedResultCount: 0, generatedArtifactIds: ['art1'] });
  m = validateBatchManifest(m);
  check('F1 完全 batch は validation valid', m.validationState === 'valid');
  m = publishBatchManifest(m);
  check('F1 valid batch は published', m.publishState === 'published');
  repo.putManifest(m);
  repo.putArtifact('b1', 'art1', artifact);
  const readFresh = repo.readArtifact('art1', Date.parse('2026-07-05T00:00:00.000Z'));
  check('F1 published/valid/fresh は available', readFresh.status === 'available');

  // exact count は manifest に生値で無い（bucket）
  check('F1 count は bucket（生値なし）', m.sourceEventCountBucket === '100–499' && m.eligibleEventCountBucket === '50–99');

  // incomplete batch unavailable
  const repo2 = createInMemoryAggregateBatchRepository();
  let mi = startBatchManifest({ ...baseManifestInput, batchId: 'b2', idempotencyKey: 'idem-2' });
  mi = completeBatchManifest(mi, { completedAt: '2026-07-01T01:00:00.000Z', sourceEventCountBucket: '50–99', eligibleEventCountBucket: '10–49', suppressedResultCount: 0, generatedArtifactIds: ['art2'] });
  mi = markIncomplete(mi, 'watermark_gap');
  mi = validateBatchManifest(mi);
  repo2.putManifest(mi);
  repo2.putArtifact('b2', 'art2', artifact);
  check('F2 incomplete batch は available にならない', repo2.readArtifact('art2', Date.parse('2026-07-05T00:00:00.000Z')).status !== 'available');
  check('F2 incomplete batch validation は invalid', mi.validationState === 'invalid');

  // failed batch 非公開
  const repo3 = createInMemoryAggregateBatchRepository();
  let mf = startBatchManifest({ ...baseManifestInput, batchId: 'b3', idempotencyKey: 'idem-3' });
  mf = failBatchManifest(mf, '2026-07-01T02:00:00.000Z');
  repo3.putManifest(mf);
  repo3.putArtifact('b3', 'art3', artifact);
  check('F3 failed batch artifact は非公開（blocked）', repo3.readArtifact('art3', Date.parse('2026-07-05T00:00:00.000Z')).status === 'blocked');

  // idempotency
  const repo4 = createInMemoryAggregateBatchRepository();
  repo4.putManifest(startBatchManifest({ ...baseManifestInput, batchId: 'b4', idempotencyKey: 'dup-key' }));
  const dup = repo4.putManifest(startBatchManifest({ ...baseManifestInput, batchId: 'b5', idempotencyKey: 'dup-key' }));
  check('F4 同一 idempotency key・別 batch は拒否', dup.accepted === false && dup.deduped === true);

  // source window 欠落 → invalid → read 不可
  let mw = startBatchManifest({ ...baseManifestInput, batchId: 'b6', idempotencyKey: 'idem-6', sourceWindowStart: '' });
  mw = completeBatchManifest(mw, { completedAt: 'x', sourceEventCountBucket: '50–99', eligibleEventCountBucket: '50–99', suppressedResultCount: 0, generatedArtifactIds: ['art6'] });
  mw = validateBatchManifest(mw);
  check('F5 source window 欠落 → validation invalid', mw.validationState === 'invalid');

  // lineage 追跡
  const gov = manifestToGovernanceState(m, { freshness: 'fresh' });
  check('F6 calculation / policy version が lineage 追跡可能', gov.lineage.calculationVersion === 'feature_usage_prevalence@1' && gov.lineage.policyVersion === 1);
  check('F6 healthy governance は serve', evaluateGovernanceDisposition(gov).serve === true);
}

// ══════════════════════════════════════════════════════════════════
console.log('[G] Revoke / deletion propagation');
{
  const repo = createInMemoryAggregateBatchRepository();
  const artifact = buildValidArtifactViaPipeline('2026-07-01T00:00:00.000Z');
  let m: AggregateBatchManifest = startBatchManifest(baseManifestInput);
  m = completeBatchManifest(m, { completedAt: '2026-07-01T01:00:00.000Z', sourceEventCountBucket: '100–499', eligibleEventCountBucket: '50–99', suppressedResultCount: 0, generatedArtifactIds: ['art1'] });
  m = publishBatchManifest(validateBatchManifest(m));
  repo.putManifest(m);
  repo.putArtifact('b1', 'art1', artifact);
  const now = Date.parse('2026-07-05T00:00:00.000Z');
  check('G0 propagation 前は available', repo.readArtifact('art1', now).status === 'available');

  const req = {
    requestId: 'p1',
    trigger: 'consent_revoke' as const,
    subjectOpaqueKey: 'opaque-123',
    metricKey: 'feature_usage_prevalence' as const,
    affectedWindowStart: '2026-05-10T00:00:00.000Z',
    affectedWindowEnd: '2026-05-20T00:00:00.000Z',
    requestedAt: '2026-07-04T00:00:00.000Z',
  };
  let rec = startPropagation(req, [m]);
  check('G1 revoke → 影響 batch を特定', rec.affectedBatchIds.includes('b1'));
  rec = advancePropagation(rec, 'invalidated', '2026-07-04T01:00:00.000Z');
  repo.recordPropagation(rec);
  check('G2 invalidation 中は read 不可（blocked）', repo.readArtifact('art1', now).status === 'blocked');

  // regeneration 完了前は fail-closed
  rec = advancePropagation(rec, 'regeneration_requested', '2026-07-04T02:00:00.000Z');
  repo.recordPropagation(rec);
  check('G3 regeneration 完了前は fail-closed（blocked）', repo.readArtifact('art1', now).status === 'blocked');
  rec = advancePropagation(rec, 'completed', '2026-07-04T03:00:00.000Z');
  repo.recordPropagation(rec);
  check('G4 regeneration 完了後は再び serve 可', repo.readArtifact('art1', now).status === 'available');

  // deletion trigger
  const reqDel = { ...req, requestId: 'p2', trigger: 'user_deletion' as const };
  const affected = findAffectedBatches([m], reqDel);
  check('G5 deletion trigger でも影響 batch 特定', affected.includes('b1'));

  // failure audit
  let recF = startPropagation({ ...req, requestId: 'p3' }, [m]);
  recF = advancePropagation(recF, 'failed', '2026-07-04T05:00:00.000Z');
  check('G6 propagation failure state', recF.state === 'failed' && recF.failureReason !== null);

  // 個人逆算情報を持たない
  check('G7 propagation request は opaque key のみ（個人情報なし）', !JSON.stringify(rec.request).includes('@') && rec.request.subjectOpaqueKey === 'opaque-123');
}

// ══════════════════════════════════════════════════════════════════
console.log('[H] Audit / monitoring contract');
{
  const evt = buildAuditEvent({ eventType: 'invalidated', component: 'aggregated_insight', subjectKey: 'batch:b1', correlationKey: 'corr-1', occurredAt: '2026-07-04T01:00:00.000Z', reasonCode: 'consent_revoked', calculationVersion: 'feature_usage_prevalence@1', policyVersion: 1 });
  check('H1 audit event に identity/raw を含めない', isAuditPayloadSafe(evt));
  const rate = buildRateSignal({ kind: 'blocked_rate', component: 'aggregated_insight', rate: 0.6, observedAt: '2026-07-05T00:00:00.000Z' });
  check('H2 rate signal は 0..1・critical 判定', rate.rate === 0.6 && rate.severity === 'critical' && isMonitoringSignalSafe(rate));
  const cnt = buildCountSignal({ kind: 'moderation_backlog', component: 'company_knowledge', count: 37, observedAt: '2026-07-05T00:00:00.000Z' });
  check('H3 count signal は bucket（生値なし）', cnt.rate === null && cnt.countBucket === '10–49' && isMonitoringSignalSafe(cnt));
  check('H4 toCountBucket は生 count を出さない', toCountBucket(1234) === '500+' && toCountBucket(0) === '0');
}

// ══════════════════════════════════════════════════════════════════
console.log('[I] Offline vertical simulation');
{
  // L4 → consultation
  const validArt = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(60, 'interview'), generatedAt: '2026-07-01T00:00:00.000Z' })) as ValidAggregateArtifact;
  const projection: AggregatedInsightProjection = {
    metricKey: validArt.metricKey,
    feature: validArt.feature,
    displayText: 'この時期には、面接練習に取り組む利用者が一定数いる傾向があります。',
    disclaimerKey: validArt.disclaimerKey,
    sampleSizeBucket: validArt.sampleSizeBucket,
    generatedAt: validArt.generatedAt,
    expiresAt: validArt.expiresAt,
    provenance: { layer: 'aggregated_insight', generatedAt: validArt.generatedAt, sourceWindow: validArt.timeBucket, calculationVersion: validArt.calculationVersion, policyStatus: 'PROVISIONAL' },
  };
  const availResult: ContextSourceResult<AggregatedInsightProjection[]> = {
    status: 'available', data: [projection],
    provenance: projection.provenance, confidence: 0.5,
    freshness: { generatedAt: validArt.generatedAt, expiresAt: validArt.expiresAt, observedPeriod: null, classification: 'fresh' },
    privacy: 'anonymous_aggregate', usage: 'reference_only',
  };
  const block = renderAggregatedInsightConsultationBlock(availResult);
  check('I1 L4 valid のみ consultation block 生成', block.used === true && block.text.length > 0);
  check('I2 L4 disclaimer 必須', block.text.includes('あなたの能力・準備度・適性・選考結果を示すものではありません'));
  check('I3 L4 suppressed/stale/blocked は空',
    renderAggregatedInsightConsultationBlock({ status: 'stale', reason: 'freshness_expired' }).used === false &&
    renderAggregatedInsightConsultationBlock({ status: 'blocked', reason: 'consent' }).used === false &&
    renderAggregatedInsightConsultationBlock({ status: 'disabled', reason: 'not_connected' }).used === false);
  check('I4 L4 budget 超過は空', renderAggregatedInsightConsultationBlock(availResult, { maxBytes: 20 }).used === false);
  check('I5 L4 renderer 決定的', JSON.stringify(renderAggregatedInsightConsultationBlock(availResult)) === JSON.stringify(block));
  // 例外時空（型を欺いて data を壊す）
  check('I6 L4 renderer 例外/異常時は空', renderAggregatedInsightConsultationBlock({ status: 'available', data: null } as unknown as ContextSourceResult<AggregatedInsightProjection[]>).used === false);

  // L5 → company research（conflict / single report）
  const repoConf = createInMemoryCompanyKnowledgeRepository();
  repoConf.putContribution(mkPublished({ contributionId: 'r1', companyId: 'c_alpha', contributorKey: 'kA', bodySummary: '面接は3回、最終は役員。' }));
  repoConf.putContribution(mkPublished({ contributionId: 'r2', companyId: 'c_alpha', contributorKey: 'kB', bodySummary: '面接はなくテストのみ。' }));
  const confProj = repoConf.readProjection({ purpose: 'company_research', companyId: 'c_alpha', displayName: 'Alpha株式会社', nowIso: NOW_ISO });
  const l5block = renderCompanyKnowledgeResearchBlock(confProj);
  check('I7 L5 approved/safe のみ block 生成', l5block.used === true);
  check('I8 L5 conflict を明示', l5block.text.includes('相反'));
  check('I9 L5 確定情報ではない旨を明示（user_evidence_not_fact）', l5block.text.includes('確定') && l5block.text.includes('確認'));

  const repoSolo = createInMemoryCompanyKnowledgeRepository();
  repoSolo.putContribution(mkPublished({ contributionId: 's1', companyId: 'c_beta', contributorKey: 'kSolo' }));
  const soloProj = repoSolo.readProjection({ purpose: 'company_research', companyId: 'c_beta', displayName: 'Beta', nowIso: NOW_ISO });
  const soloBlock = renderCompanyKnowledgeResearchBlock(soloProj);
  check('I10 L5 単一投稿は trend 表示しない（単一報告明示）', soloBlock.used === true && soloBlock.text.includes('単一報告'));
  check('I11 L5 blocked/empty は空', renderCompanyKnowledgeResearchBlock({ status: 'empty', reason: 'no_eligible_data' }).used === false);
  check('I12 L5 renderer 決定的', JSON.stringify(renderCompanyKnowledgeResearchBlock(confProj)) === JSON.stringify(l5block));
}

// ══════════════════════════════════════════════════════════════════
console.log('[J] Production isolation (static guard)');
{
  const NEW_DIRS = [
    'lib/careerCompanyKnowledge',
    'lib/careerContextLoaders',
    'lib/careerContextRenderers',
    'lib/careerDataGovernance',
  ].map((d) => join(ROOT, d));
  // lib/careerAggregate 内の P17-B offline 追加ファイル（互いに / governance を import してよい offline 群）。
  const NEW_AGG_FILES = [
    'lib/careerAggregate/batchManifest.ts',
    'lib/careerAggregate/invalidation.ts',
    'lib/careerAggregate/batchRepository.ts',
    'lib/careerAggregate/inMemoryBatchRepository.ts',
    // P17-C: lib/careerAggregate 内の supabase repo（governance / batch 型を import する offline scaffold）。
    'lib/careerAggregate/supabaseBatchRepository.ts',
    'lib/careerAggregate/supabaseReadRepository.ts',
    'lib/careerAggregate/supabaseInvalidationRepository.ts',
    // P17-E: shadow evidence / dispatcher（sanctioned な server 統合層）。
    'lib/careerAggregate/shadowEvidence.ts',
    'lib/careerAggregate/shadowDispatcher.server.ts',
    // P17-E2: synthetic shadow read repository（governance を使う sanctioned 統合層）。
    'lib/careerAggregate/syntheticShadowReadRepository.ts',
    // Closure Batch（`D-C2` / `D-C3`）: source eligibility 表 と retention policy。
    //   どちらも offline pure（DB / env / production consumer 非依存）で、
    //   governance の分類表を参照する sanctioned な offline scaffold。
    'lib/careerAggregate/sourceEligibility.ts',
    'lib/careerAggregate/retention.ts',
  ].map((f) => join(ROOT, f));
  // P17-E: server composition（careerAggregate/server/*）も sanctioned な統合層として除外。
  const isNewModule = (f: string) =>
    NEW_DIRS.some((p) => f.startsWith(p)) ||
    NEW_AGG_FILES.includes(f) ||
    f.includes('/careerAggregate/server/') ||
    // Decision Resolution Batch（`D-R1`/`D-R3`）: batch 層（route から到達不能・HDR-2 が固定）。
    f.includes('/careerAggregate/batch/');

  const consumerFiles = [
    ...walk(join(ROOT, 'app')),
    ...walk(join(ROOT, 'components')),
    ...walk(join(ROOT, 'lib')),
  ].filter((f) => !isNewModule(f));

  const FORBIDDEN = [
    'careerContextLoaders',
    'careerContextRenderers',
    'careerCompanyKnowledge',
    'careerDataGovernance',
    'careerAggregateBatch',
  ];
  // ★ 禁止判定は **directory 名**ではなく **runtime data authority** で行う。
  //   Company Identity / Company Data Spine が Layer 5 の純粋関数
  //   （identity.ts の normalizeCompanyName / resolveCompany、companyOfficialContext の
  //     renderCompanyOfficialForPurpose）を正当に再利用するようになったため、
  //   directory 名判定はそれを「禁止 consumer」と誤検出して落ちていた。
  //   許可するのは fixtures/careerLayerBoundary の allowlist（純粋 module のみ）と
  //   型だけの import に限り、repository / projection / loader / governance などの
  //   データ権威は従来どおり禁止のまま。
  const importsForbidden = (src: string) =>
    findForbiddenLayerImports(src, FORBIDDEN).length > 0;

  // ★ 許可が穴に化けないよう、allowlist した module が本当に純粋かを毎回検証する。
  const impure = assertSanctionedPureModules(ROOT);
  check(
    `J0 allowlist した Layer 4/5 module は I/O を持たない純粋関数のまま（${SANCTIONED_PURE_LAYER_MODULES.length} module）`,
    impure.length === 0,
    impure.map((v) => `${v.file}: ${v.markers.join('/')}`).join(' | '),
  );

  const appFiles = consumerFiles.filter((f) => f.startsWith(join(ROOT, 'app')));
  const apiFiles = appFiles.filter((f) => f.startsWith(join(ROOT, 'app/api')));
  const promptFiles = consumerFiles.filter((f) => /prompt/i.test(f));

  check('J1 app/ から新モジュール import 0', appFiles.filter((f) => importsForbidden(readFileSync(f, 'utf8'))).length === 0);
  check('J2 app/api/ から新モジュール import 0', apiFiles.filter((f) => importsForbidden(readFileSync(f, 'utf8'))).length === 0);
  check('J3 production prompt から新モジュール import 0', promptFiles.filter((f) => importsForbidden(readFileSync(f, 'utf8'))).length === 0);
  const j4Offenders = consumerFiles.filter((f) => importsForbidden(readFileSync(f, 'utf8')));
  check('J4 production consumer 全体で新モジュール import 0', j4Offenders.length === 0,
    j4Offenders.map((f) => f.slice(ROOT.length + 1)).join(','));
  // ★ manifest の陳腐化検知: NEW_AGG_FILES に挙げたファイルが実在すること
  //   （リネーム / 削除で manifest だけ残る事故を即 FAIL にする）。
  const missingManifest = NEW_AGG_FILES.filter((f) => !existsSync(f));
  check('J4b NEW_AGG_FILES manifest が実体と一致', missingManifest.length === 0,
    missingManifest.map((f) => f.slice(ROOT.length + 1)).join(','));

  // orchestrator 未変更（新モジュール非 import）
  //   ★ 旧実装は生 substring（コメント込み）で判定していたため、orchestrator が
  //     純粋 renderer を 1 本 import しただけで落ちていた。import 文だけを見る。
  const orch = readFileSync(join(ROOT, 'lib/careerContext/orchestrator.ts'), 'utf8');
  const orchForbidden = findForbiddenLayerImports(orch, [...FORBIDDEN, 'careerAggregate']);
  check(
    'J5 orchestrator.ts が Layer 4/5 のデータ権威を import しない',
    orchForbidden.length === 0,
    orchForbidden.join(','),
  );

  // 新モジュールが supabase/localStorage/fetch/private research を実使用しない
  const newFiles = [
    ...walk(join(ROOT, 'lib/careerCompanyKnowledge')),
    ...walk(join(ROOT, 'lib/careerContextLoaders')),
    ...walk(join(ROOT, 'lib/careerContextRenderers')),
    ...walk(join(ROOT, 'lib/careerDataGovernance')),
    join(ROOT, 'lib/careerAggregate/batchManifest.ts'),
    join(ROOT, 'lib/careerAggregate/invalidation.ts'),
    join(ROOT, 'lib/careerAggregate/batchRepository.ts'),
    join(ROOT, 'lib/careerAggregate/inMemoryBatchRepository.ts'),
  ].filter((f) => existsSync(f));
  const unsafe = newFiles.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return /from\s+['"][^'"]*supabase[^'"]*['"]/i.test(src) ||
      /\blocalStorage\s*\./.test(src) ||
      /from\s+['"]server-only['"]/.test(src) ||
      /\bfetch\s*\(/.test(src) ||
      /careerCompanyResearch/.test(src) ||
      /companyResearchStorage/.test(src);
  });
  check('J6 新モジュールが supabase/localStorage/fetch/private research を実使用しない', unsafe.length === 0, unsafe.join(','));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
