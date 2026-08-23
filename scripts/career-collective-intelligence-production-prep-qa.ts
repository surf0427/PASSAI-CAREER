/*
 * scripts/career-collective-intelligence-production-prep-qa.ts
 *
 * PASSAI CAREER — Production Prep QA（PF-1 〜 PF-16）。
 *   dev-only・pure / DI fake・実 Supabase 非接続・実 AI call なし。
 *
 * PF-1  policy 値の権威が 1 箇所（registry と既存 module が一致）
 * PF-2  未サポート policy version → fail closed
 * PF-3  禁止 purpose は Layer 4 を consume できない
 * PF-4  master opt-in のみ → per-item 確認なしでは寄与にならない
 * PF-5  per-item 確認のみ → master opt-in なしでは寄与にならない
 * PF-6  pending は Human moderation なしで publish できない
 * PF-7  一般 member は moderation できない
 * PF-8  legal gate 未達 → activation 拒否
 * PF-9  I2 owner RLS が auth UUID を公開しない
 * PF-10 cross-user contribution access 拒否
 * PF-11 retention cleanup の dry-run が非破壊
 * PF-12 expired candidate の分類が policy と一致
 * PF-13 production migration package が RLS を安全に有効化する
 * PF-14 全 feature flag OFF → 挙動ゼロ変化
 * PF-15 production consumer が増えていない
 * PF-16 Personal Optimization が分離されたまま
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-collective-intelligence-production-prep-qa.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  AGGREGATE_PURPOSE_POLICY,
  COHORT_POLICY,
  CURRENT_POLICY_VERSION,
  FORBIDDEN_AGGREGATE_PURPOSES,
  MODERATION_POLICY,
  RETENTION_POLICY,
  SHARING_POLICY,
  SUPPORTED_POLICY_VERSIONS,
  WITHDRAWAL_POLICY,
  currentPolicySnapshot,
  isAggregatePurposeAllowed,
  isAggregatePurposeForbidden,
  isPolicyFrozen,
  isPolicyVersionSupported,
  retentionDaysFor,
  withdrawalDispositionFor,
} from '@/lib/careerCollectiveIntelligence/policy/registry';
import {
  DEFAULT_MAX_CLEANUP_CANDIDATES,
  classifyExpiration,
  executeCleanup,
  expiresAtFor,
  planCleanup,
  retentionSummary,
  type SafeDeletePort,
} from '@/lib/careerCollectiveIntelligence/policy/retentionPlanner';
import {
  evaluateSharingStages,
  isRejectedImpliedConsentSource,
  planWithdrawal,
} from '@/lib/careerCollectiveIntelligence/policy/sharingGate';
import {
  authorizeModeratorAction,
  containsForbiddenModeratorInput,
  isModeratorProviderConfigured,
  FORBIDDEN_MODERATOR_INPUT_FIELDS,
  type ResolveModeratorPort,
} from '@/lib/careerCollectiveIntelligence/moderation/moderatorAuthorization';
import { isLegalApproved, isModerationModeSafe, runPreflight } from '@/lib/careerCollectiveIntelligence/preflight';
import { COHORT_THRESHOLDS, CONSUMER_CAPABILITIES, isConsumerConnected } from '@/lib/careerAggregate/policy';
import { RARE_CATEGORY_POLICY } from '@/lib/careerAggregate/rareCategory';
import { EMPTY_ACTIVATION_INPUT, evaluateActivation } from '@/lib/careerDataSpineGate/activation';
import { transitionContributionLifecycle } from '@/lib/careerCompanyKnowledge/lifecycle';
import { isOwnContribution, type ContributorSubject } from '@/lib/careerCompanyKnowledge/contributorIdentity';
import { computeContributionFingerprint } from '@/lib/careerCompanyKnowledge/contribution';
import type { CompanyKnowledgeContribution } from '@/types/careerCompanyKnowledge';

const ROOT = process.cwd();
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');

let failures = 0;
import {
  assertSanctionedPureModules,
  findForbiddenLayerImports,
  SANCTIONED_PURE_LAYER_MODULES,
} from './fixtures/careerLayerBoundary';

const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.tsx?$/.test(e.name)) out.push(f);
    }
  };
  walk(join(ROOT, dir));
  return out;
}
const rel = (f: string) => f.slice(ROOT.length + 1);

// ── fixtures ───────────────────────────────────────────────────────
const CLEAN_MOD = {
  state: 'approved' as const, piiScan: 'clean' as const,
  confidentiality: 'low' as const, abuse: 'none' as const, rejectionReason: null,
};
function contribution(over: Partial<CompanyKnowledgeContribution> = {}): CompanyKnowledgeContribution {
  const base = {
    contributionId: 'c-1',
    company: { status: 'resolved', companyId: 'co-1', displayName: 'Alpha' },
    contentCategory: 'selection_flow', sourceCategory: 'candidate_experience',
    evidenceKind: 'first_hand', observedPeriod: '2026',
    selectionCategory: 'full_time', roleCategory: 'engineering',
    bodySummary: '一次面接はオンラインで 30 分程度だった。',
    consentState: 'share_granted', submittedAt: '2026-07-02T00:00:00.000Z',
    moderation: { ...CLEAN_MOD }, provenanceNote: 'candidate_experience/2026',
    privacyClassification: 'shared_company_knowledge', lifecycleState: 'published',
    legalHold: false, __contributorOpaqueKey: 'opaque-A', __contentFingerprint: '',
    ...over,
  } as unknown as CompanyKnowledgeContribution;
  if (!over.__contentFingerprint) {
    (base as { __contentFingerprint: string }).__contentFingerprint = computeContributionFingerprint(base);
  }
  return base;
}
const UID_A = '11111111-1111-4111-8111-111111111111';
const UID_B = '22222222-2222-4222-8222-222222222222';
const SUBJECTS: ContributorSubject[] = [
  { authUserId: UID_A, opaqueKey: 'opaque-A', linkedAt: '2026-01-01T00:00:00.000Z', unlinkedAt: null },
  { authUserId: UID_B, opaqueKey: 'opaque-B', linkedAt: '2026-01-01T00:00:00.000Z', unlinkedAt: null },
];
const NOW = Date.parse('2026-08-14T00:00:00.000Z');

async function main() {
  console.log('=== career-collective-intelligence-production-prep-qa ===');

  // ── PF-1 ────────────────────────────────────────────────────────
  console.log('[PF-1] policy 値の権威が 1 箇所');
  {
    // ★ registry と既存 module の値が **一致**していること（二重管理の検出）。
    check(COHORT_THRESHOLDS.absoluteLowerBound === COHORT_POLICY.absoluteLowerBound,
      `absoluteLowerBound 一致（${COHORT_THRESHOLDS.absoluteLowerBound}）`);
    check(COHORT_THRESHOLDS.internal === COHORT_POLICY.internal, 'internal 一致');
    check(COHORT_THRESHOLDS.userFacing === COHORT_POLICY.userFacing, 'userFacing 一致');
    check(COHORT_THRESHOLDS.aiContext === COHORT_POLICY.aiContext, 'aiContext 一致');
    check(RARE_CATEGORY_POLICY.minCategorySupport === COHORT_POLICY.rareCategoryMinSupport,
      'rareCategoryMinSupport 一致');
    // policy が凍結されている（PENDING が無い）。
    check(isPolicyFrozen(), 'policy が frozen（PENDING approval が無い）');
    const snap = currentPolicySnapshot();
    check(snap.version === CURRENT_POLICY_VERSION && snap.effective, 'snapshot が有効');
    check(snap.cohortApproval === 'APPROVED', 'H-L1 APPROVED');
    check(snap.aggregatePurposeApproval === 'APPROVED', 'H-L3 APPROVED');
    check(snap.sharingApproval === 'APPROVED', 'H-L4 APPROVED');
    check(snap.moderationApproval === 'APPROVED', 'H-L6 APPROVED');
    check(snap.retentionApproval === 'PROVISIONALLY_APPROVED_PENDING_LEGAL', 'H-L2 は法務保留');
    check(snap.withdrawalApproval === 'PROVISIONALLY_APPROVED_PENDING_LEGAL', 'H-L5 は法務保留');
    // ★ 承認済み数値が registry の外に散在していないこと。
    //   （閾値のリテラルを持ってよいのは registry / 既存 policy / QA だけ）
    const allowed = new Set([
      'lib/careerCollectiveIntelligence/policy/registry.ts',
      'lib/careerAggregate/policy.ts',
      'lib/careerAggregate/rareCategory.ts',
    ]);
    const scatter: string[] = [];
    for (const f of [...tsFiles('lib'), ...tsFiles('app')]) {
      if (allowed.has(rel(f))) continue;
      const code = codeOnly(readFileSync(f, 'utf8'));
      // retention の日数リテラルが registry 外に現れていないか。
      if (/\b(730|400|180)\s*[,;)]/.test(code) && /retention/i.test(code)) scatter.push(rel(f));
    }
    check(scatter.length === 0, '★ retention 日数が registry 外に hardcode されていない', scatter.join(','));
  }

  // ── PF-2 ────────────────────────────────────────────────────────
  console.log('[PF-2] 未サポート policy version → fail closed');
  {
    for (const v of [0, -1, 1.5, 99, Number.NaN, null, undefined, '1'] as unknown[]) {
      check(!isPolicyVersionSupported(v as never), `version ${String(v)} は未サポート`);
    }
    check(isPolicyVersionSupported(1), 'version 1 はサポート');
    check(SUPPORTED_POLICY_VERSIONS.length >= 1, 'サポート version が定義されている');
    // 未サポート version では retention 判定が undetermined（削除もしない）。
    const v = classifyExpiration({
      retentionClass: 'aggregate_artifact', createdAt: '2020-01-01T00:00:00.000Z',
      nowMs: NOW, policyVersion: 99,
    });
    check(v.status === 'undetermined', '★ 未サポート version → undetermined（削除しない）');
    // 未サポート version では cleanup を計画しない。
    const plan = planCleanup({
      records: [{ retentionClass: 'aggregate_artifact', recordId: 'a', createdAt: '2020-01-01T00:00:00.000Z' }],
      nowMs: NOW, policyVersion: 99,
    });
    check(plan.candidates.length === 0, '★ 未サポート version → 候補ゼロ');
    check(plan.undeterminedCount === 1, '未判定として数える');
    // 未サポート version の sharing は拒否。
    const s = evaluateSharingStages({
      masterOptInActive: true, consentScope: 'company_knowledge_contribution',
      perContributionConfirmed: true, policyVersion: 99,
    });
    check(!s.allowed, '★ 未サポート version → 共有不可');
  }

  // ── PF-3 ────────────────────────────────────────────────────────
  console.log('[PF-3] 禁止 purpose は Layer 4 を consume できない');
  {
    for (const p of FORBIDDEN_AGGREGATE_PURPOSES) {
      check(isAggregatePurposeForbidden(p), `${p} は明示禁止`);
      check(!isAggregatePurposeAllowed(p), `${p} は許可されない`);
    }
    check(isAggregatePurposeAllowed('internal_product_analytics'), 'internal analytics は許可');
    check(isAggregatePurposeAllowed('user_facing_aggregate_trend'), 'user-facing trend は許可');
    check(!isAggregatePurposeAllowed('unknown_purpose'), '未知 purpose は default deny');
    // ★ Layer 4 を Personal Optimization AI context へ接続しない（H-L3）。
    check(AGGREGATE_PURPOSE_POLICY.allowPersonalOptimizationAiContext === false,
      '★ Personal Optimization AI context へ接続しない');
    // 静的: Personal Optimization の prompt / resolver が Layer 4 を import しない。
    const poDirs = ['app/api/career', 'lib/careerServerContext', 'lib/careerMemory', 'lib/careerContext'];
    const offenders: string[] = [];
    for (const d of poDirs) {
      for (const f of tsFiles(d)) {
        if (/shadowDispatcher/.test(f)) continue; // gate probe のみ（privileged 非依存）
        const code = codeOnly(readFileSync(f, 'utf8'));
        if (/from\s+['"][^'"]*careerAggregate\/(?!.*shadowDispatcher)[^'"]*['"]/.test(code)) {
          offenders.push(rel(f));
        }
      }
    }
    check(offenders.length === 0, '★ Personal Optimization 経路が Layer 4 を import しない', offenders.join(','));
    // matching は恒久禁止 consumer。
    const m = CONSUMER_CAPABILITIES.find((c) => c.consumer === 'matching');
    check(m?.permanentlyProhibited === true, 'matching は恒久禁止 consumer');
    const matchingSrc = codeOnly(readFileSync(join(ROOT, 'app/api/career/matching/route.ts'), 'utf8'));
    check(!/careerAggregate|careerCompanyKnowledge/.test(matchingSrc), 'matching route が Layer 4/5 を import しない');
  }

  // ── PF-4 / PF-5 ─────────────────────────────────────────────────
  console.log('[PF-4/PF-5] 共有は二段 gate（片方だけでは通らない）');
  {
    const base = { consentScope: 'company_knowledge_contribution', policyVersion: CURRENT_POLICY_VERSION };
    const both = evaluateSharingStages({ ...base, masterOptInActive: true, perContributionConfirmed: true });
    check(both.allowed, '両方揃えば許可');
    // PF-4: master のみ。
    const masterOnly = evaluateSharingStages({ ...base, masterOptInActive: true, perContributionConfirmed: false });
    check(!masterOnly.allowed, '★ master opt-in だけでは寄与にならない');
    check(!masterOnly.allowed && masterOnly.reasons.includes('per_contribution_confirmation_missing'),
      '理由が per_contribution_confirmation_missing');
    // PF-5: per-item のみ。
    const itemOnly = evaluateSharingStages({ ...base, masterOptInActive: false, perContributionConfirmed: true });
    check(!itemOnly.allowed, '★ per-item 確認だけでは寄与にならない');
    check(!itemOnly.allowed && itemOnly.reasons.includes('master_opt_in_missing'), '理由が master_opt_in_missing');
    // consent family が Personal Optimization と共有されない。
    const wrongFamily = evaluateSharingStages({
      ...base, consentScope: 'personal_service_processing',
      masterOptInActive: true, perContributionConfirmed: true,
    });
    check(!wrongFamily.allowed, '★ Personal Optimization の同意では共有できない');
    check(!wrongFamily.allowed && wrongFamily.reasons.includes('wrong_consent_family'), '理由が wrong_consent_family');
    // 暗黙同意は根拠にならない。
    for (const src of SHARING_POLICY.rejectedImpliedConsentSources) {
      check(isRejectedImpliedConsentSource(src), `暗黙同意「${src}」は拒否対象`);
      const implied = evaluateSharingStages({
        ...base, masterOptInActive: true, perContributionConfirmed: true, impliedConsentSource: src,
      });
      check(!implied.allowed, `暗黙同意「${src}」を根拠にすると拒否`);
    }
    check(SHARING_POLICY.requireMasterOptIn && SHARING_POLICY.requirePerContributionConfirmation,
      'policy が両方必須と宣言している');
  }

  // ── PF-6 ────────────────────────────────────────────────────────
  console.log('[PF-6] pending は Human moderation なしで publish できない');
  {
    check(isModerationModeSafe(), 'moderation mode が automated_prescreen_then_human');
    check(MODERATION_POLICY.allowAutomatedPublication === false, '★ 自動公開は禁止');
    // lifecycle: pending 相当から直接 publish できない。
    for (const from of ['draft', 'consent_pending', 'submitted', 'privacy_review', 'moderation_pending'] as const) {
      const r = transitionContributionLifecycle(from, 'publish');
      check(!('to' in r) || r.to !== 'published', `${from} → publish は不可`);
    }
    // approve を経た approved からのみ publish できる。
    const approved = transitionContributionLifecycle('moderation_pending', 'approve');
    check('to' in approved && approved.to === 'approved', 'moderation_pending → approve → approved');
    const published = transitionContributionLifecycle('approved', 'publish');
    check('to' in published && published.to === 'published', 'approved → publish → published');
    // ★ pre-screen（privacy_review 通過）だけでは publish に届かない。
    const prescreened = transitionContributionLifecycle('privacy_review', 'pass_privacy_review');
    check('to' in prescreened && prescreened.to === 'moderation_pending',
      '★ pre-screen 通過先は moderation_pending（published ではない）');
  }

  // ── PF-7 ────────────────────────────────────────────────────────
  console.log('[PF-7] 一般 member は moderation できない');
  {
    // provider 未設定 → 拒否（★ 素通ししない）。
    const noProvider = await authorizeModeratorAction({ authUserId: UID_A, action: 'approve' });
    check(!noProvider.authorized, '★ moderator provider 未設定 → 拒否');
    check(!noProvider.authorized && noProvider.reason === 'no_moderator_provider', '理由が no_moderator_provider');
    check(!isModeratorProviderConfigured(null), 'provider 未設定を configured と見なさない');
    check(!isModeratorProviderConfigured(undefined), 'undefined も同様');
    // 未認証 → 拒否。
    const anon = await authorizeModeratorAction({
      authUserId: null, action: 'approve', resolveModerator: async () => ({ authUserId: UID_A, capabilities: ['approve'] }),
    });
    check(!anon.authorized, '未認証 → 拒否');
    // 一般 member（provider が null を返す）→ 拒否。
    const member: ResolveModeratorPort = async () => null;
    const ordinary = await authorizeModeratorAction({ authUserId: UID_B, action: 'approve', resolveModerator: member });
    check(!ordinary.authorized, '★ 一般 member → 拒否');
    check(!ordinary.authorized && ordinary.reason === 'not_a_moderator', '理由が not_a_moderator');
    // capability 不足 → 拒否。
    const reviewer: ResolveModeratorPort = async (uid) => ({ authUserId: uid, capabilities: ['review'] });
    const noCap = await authorizeModeratorAction({ authUserId: UID_A, action: 'publish', resolveModerator: reviewer });
    check(!noCap.authorized, 'capability 不足 → 拒否');
    // 正常系。
    const mod: ResolveModeratorPort = async (uid) => ({ authUserId: uid, capabilities: ['approve', 'publish'] });
    const ok = await authorizeModeratorAction({ authUserId: UID_A, action: 'approve', resolveModerator: mod });
    check(ok.authorized, '正しい moderator は許可される');
    // provider が別 user を返したら拒否（port 実装ミス検出）。
    const wrong: ResolveModeratorPort = async () => ({ authUserId: UID_B, capabilities: ['approve'] });
    const mismatch = await authorizeModeratorAction({ authUserId: UID_A, action: 'approve', resolveModerator: wrong });
    check(!mismatch.authorized, 'provider の返す uid が一致しなければ拒否');
    // ★ client 由来の値を根拠にしない。
    for (const f of FORBIDDEN_MODERATOR_INPUT_FIELDS) {
      check(containsForbiddenModeratorInput({ [f]: true }), `body の ${f} を検出できる`);
    }
    check(!containsForbiddenModeratorInput({ contributionId: 'c-1' }), '正常な body は検出しない');
    // 静的: repo に client isAdmin / body moderatorId を読む実装が無い。
    const offenders: string[] = [];
    for (const f of [...tsFiles('app'), ...tsFiles('lib')]) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      if (/b\.isAdmin|body\.isAdmin|body\.moderatorId|b\.moderatorId/.test(code)) offenders.push(rel(f));
    }
    check(offenders.length === 0, '★ client 由来 isAdmin / moderatorId を読む実装が無い', offenders.join(','));
  }

  // ── PF-8 ────────────────────────────────────────────────────────
  console.log('[PF-8] legal gate 未達 → activation 拒否');
  {
    check(!isLegalApproved({}), '空 → 未承認');
    check(!isLegalApproved({ approved: true }), '★ source 無しの true は承認と見なさない');
    check(!isLegalApproved({ approved: true, source: '   ' }), '空白 source は無効');
    check(!isLegalApproved({ approved: 'true', source: 'doc-1' }), '文字列 true は無効');
    check(isLegalApproved({ approved: true, source: 'legal-review-2026-08' }), '明示 true + source なら承認');
    // activation は legal 未承認で必ず false。
    for (const layer of ['layer4', 'layer5'] as const) {
      const d = evaluateActivation({
        ...EMPTY_ACTIVATION_INPUT, layer,
        flagEnabled: true, userIsCanary: true, infrastructureReady: true,
        consentReady: true, moderationReady: true,
        retentionConfig: { retentionDays: 400, policyVersion: 'v1', legalApproved: true },
        cohortThresholdConfigured: true,
        legalApproved: false,
      });
      check(!d.activated, `${layer}: legal 未承認 → activated=false`);
      check(!d.activated && d.blockers.includes('legal_not_approved'), `${layer}: blocker が legal_not_approved`);
    }
    // preflight も legal を blocking に挙げる。
    const pf = runPreflight({
      moderatorProviderConfigured: true, infraAdapterConfigured: true,
      migrationApplied: true, rlsVerified: true, featureFlagsOff: true,
    });
    check(!pf.ready, 'preflight: legal 未承認なら ready=false');
    check(pf.blocking.includes('legal_approved'), 'blocking に legal_approved');
    // 全部揃えば ready（ただし activation は別）。
    const full = runPreflight({
      legalApproved: true, legalApprovalSource: 'legal-review-2026-08',
      moderatorProviderConfigured: true, infraAdapterConfigured: true,
      migrationApplied: true, rlsVerified: true, featureFlagsOff: true,
    });
    check(full.ready, '全条件充足で preflight ready');
    check(!evaluateActivation({ ...EMPTY_ACTIVATION_INPUT, layer: 'layer4' }).activated,
      '★ preflight ready でも flag OFF なら activation は false');
  }

  // ── PF-9 / PF-10 ────────────────────────────────────────────────
  console.log('[PF-9/PF-10] I2 owner RLS / cross-user access');
  {
    const c = contribution();
    check(isOwnContribution({ authUserId: UID_A, contribution: c, subjects: SUBJECTS }), '本人は自分の寄与にアクセス可');
    check(!isOwnContribution({ authUserId: UID_B, contribution: c, subjects: SUBJECTS }), '★ 他 user はアクセス不可');
    // contribution に auth UUID が入らない。
    const json = JSON.stringify(c);
    check(!json.includes(UID_A) && !json.includes(UID_B), '★ contribution に auth UUID が無い');
    check(!/authUserId|auth_user_id/.test(json), 'auth user id の key が無い');
    // migration: published view が contributor 識別子を含まない。
    const l5 = readFileSync(join(ROOT, 'supabase/migrations_pending/030_layer5_read_contract.sql'), 'utf8');
    const viewBlock = l5.slice(l5.indexOf('CREATE OR REPLACE VIEW'), l5.indexOf('COMMENT ON VIEW'));
    for (const banned of ['contributor_opaque_key', 'content_fingerprint', 'auth_user_id', 'contributor_user_id', 'provenance_note']) {
      check(!viewBlock.includes(banned), `★ published view に ${banned} が無い`);
    }
    check(/security_invoker\s*=\s*on/.test(l5), '★ view は security_invoker=on（RLS を迂回しない）');
    // subject 対応表: 本人のみ SELECT。
    const idm = readFileSync(join(ROOT, 'supabase/migrations_pending/020_contributor_subject_identity.sql'), 'utf8');
    check(/USING \(auth\.uid\(\) = auth_user_id\)/.test(idm), 'subject table は owner-scoped');
    check(!/FOR (INSERT|UPDATE|DELETE)/.test(idm.replace(/--.*$/gm, '')), '★ INSERT/UPDATE/DELETE policy を作らない');
    check(/career_ck_ensure_subject\(\)/.test(idm) && !/career_ck_ensure_subject\(\s*\w/.test(idm),
      '★ RPC は引数を取らない（caller-selected uuid を受け付けない）');
    check(/v_uid uuid := auth\.uid\(\)/.test(idm), 'subject は auth.uid() から導出');
  }

  // ── PF-11 / PF-12 ───────────────────────────────────────────────
  console.log('[PF-11/PF-12] retention: dry-run 非破壊 / 期限分類が policy と一致');
  {
    // PF-12: 分類が policy 日数と一致。
    for (const { retentionClass, days } of retentionSummary()) {
      check(retentionDaysFor(retentionClass) === days, `${retentionClass} = ${days} 日`);
      const justInside = classifyExpiration({
        retentionClass, createdAt: new Date(NOW - (days - 1) * 86400000).toISOString(), nowMs: NOW,
      });
      check(justInside.status === 'retained', `${retentionClass}: ${days - 1} 日は retained`);
      const justOutside = classifyExpiration({
        retentionClass, createdAt: new Date(NOW - (days + 1) * 86400000).toISOString(), nowMs: NOW,
      });
      check(justOutside.status === 'expired', `${retentionClass}: ${days + 1} 日は expired`);
      check(expiresAtFor(retentionClass, '2026-01-01T00:00:00.000Z') !== null, `${retentionClass}: 期限日を計算できる`);
    }
    check(retentionDaysFor('unknown_class') === null, '未知 class は null（fail-closed）');
    check(classifyExpiration({ retentionClass: 'unknown', createdAt: '2020-01-01', nowMs: NOW }).status === 'undetermined',
      '未知 class → undetermined');
    check(RETENTION_POLICY.classes.length === 5, 'retention class が 5 種類');

    // PF-11: dry-run が非破壊。
    const old = new Date(NOW - 900 * 86400000).toISOString();
    const plan = planCleanup({
      records: [
        { retentionClass: 'aggregate_artifact', recordId: 'a1', createdAt: old },
        { retentionClass: 'approved_shared_knowledge', recordId: 's1', createdAt: old },
        { retentionClass: 'aggregate_artifact', recordId: 'a2', createdAt: new Date(NOW - 1 * 86400000).toISOString() },
      ],
      nowMs: NOW,
    });
    check(plan.candidates.length === 2, `期限切れ 2 件を候補化（${plan.candidates.length}）`);
    check(plan.destructive === false, '★ plan 自体は非破壊');
    check(plan.candidates.every((c) => !JSON.stringify(c).includes('bodySummary')), '候補に本文を含まない');

    let deleteCalls = 0;
    const port: SafeDeletePort = {
      deleteRecords: async ({ recordIds }) => { deleteCalls += 1; return { deleted: recordIds.length, skipped: 0 }; },
    };
    const dry = await executeCleanup(plan, { dryRun: true, legalApproved: true, port });
    check(dry.dryRun && dry.deleted === 0, '★ dry-run は 0 件削除');
    check(deleteCalls === 0, '★ dry-run は port を呼ばない');
    // legal 未承認では破壊しない。
    const noLegal = await executeCleanup(plan, { dryRun: false, legalApproved: false, port });
    check(noLegal.deleted === 0 && noLegal.refusedReason === 'legal_not_approved', '★ legal 未承認 → 削除しない');
    check(deleteCalls === 0, 'port を呼ばない');
    // port 無しでも破壊しない。
    const noPort = await executeCleanup(plan, { dryRun: false, legalApproved: true, port: null });
    check(noPort.deleted === 0 && noPort.refusedReason === 'no_port', '★ port 無し → 削除しない');
    // 全条件が揃ったときだけ削除される。
    const real = await executeCleanup(plan, { dryRun: false, legalApproved: true, port });
    check(real.deleted === 2 && deleteCalls > 0, '全条件充足で削除される（fake port）');
    // ★ production SafeDeletePort の実装が repo に存在しない。
    const impls: string[] = [];
    for (const f of [...tsFiles('lib'), ...tsFiles('app')]) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      if (/:\s*SafeDeletePort\s*=/.test(code)) impls.push(rel(f));
    }
    check(impls.length === 0, '★ production SafeDeletePort 実装が存在しない（破壊経路なし）', impls.join(','));
    check(DEFAULT_MAX_CLEANUP_CANDIDATES > 0, '一括削除に上限がある');

    // withdrawal: legal 未承認中は保守側（unpublish）。
    const derived = planWithdrawal({ state: 'derived_multi_source', legalApproved: false });
    check(derived.disposition === 'unpublish', '★ legal 未承認の derived は unpublish（自動 retain しない）');
    check(derived.conservativeFallbackApplied, '保守 fallback が記録される');
    check(derived.futureContributionsBlocked === true, '以後の寄与は必ず止まる');
    check(planWithdrawal({ state: 'pending', legalApproved: false }).disposition === 'delete', 'pending は delete');
    check(planWithdrawal({ state: 'published_single_source', legalApproved: false }).disposition === 'unpublish',
      'single source は unpublish');
    check(withdrawalDispositionFor('derived_multi_source', true) === 'legal_policy_gate',
      'legal 承認後は legal_policy_gate へ戻る');
    check(planWithdrawal({ state: 'nonexistent', legalApproved: false }).disposition === 'unpublish',
      '未知 state も保守側');
    check(WITHDRAWAL_POLICY.derivedFallbackUntilLegalApproval === 'unpublish', 'fallback が可逆な unpublish');
  }

  // ── PF-13 ───────────────────────────────────────────────────────
  console.log('[PF-13] production migration package が RLS を安全に有効化する');
  {
    const dir = join(ROOT, 'supabase/migrations_pending');
    check(existsSync(dir), 'migrations_pending/ が存在する');
    const sqls = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    check(sqls.length >= 4, `migration が揃っている（${sqls.length}）`);
    check(existsSync(join(dir, 'README.md')), '適用手順 README がある');
    for (const f of sqls) {
      const src = readFileSync(join(dir, f), 'utf8');
      check(/NOT APPLIED/.test(src), `${f}: NOT APPLIED と明記`);
      check(/BEGIN;/.test(src) && /COMMIT;/.test(src), `${f}: transaction で囲まれている`);
      check(!/TO\s+anon/i.test(src), `${f}: anon へ GRANT しない`);
      // ★ RLS 順序: GRANT より前に ENABLE ROW LEVEL SECURITY があること
      //   （その file が table を作る場合）。
      if (/CREATE TABLE/i.test(src)) {
        const firstGrant = src.search(/^GRANT/m);
        const lastEnable = src.lastIndexOf('ENABLE ROW LEVEL SECURITY');
        check(lastEnable >= 0, `${f}: RLS を有効化している`);
        check(firstGrant < 0 || lastEnable < firstGrant,
          `★ ${f}: GRANT より前に RLS を有効化（保護なしの瞬間を作らない）`);
      }
      // SECURITY DEFINER 関数は anon から REVOKE している。
      //   ★ コメント内の言及（security_invoker の説明等）は対象外にする。
      const sqlCode = codeOnly(src);
      if (/SECURITY DEFINER/.test(sqlCode)) {
        check(/REVOKE ALL ON FUNCTION[\s\S]*anon/.test(sqlCode), `${f}: SECURITY DEFINER を anon から REVOKE`);
        check(/auth\.uid\(\)/.test(sqlCode), `${f}: subject を auth.uid() から導出`);
      }
    }
    // ★ 適用済み扱いのファイル名（*_apply.sql）になっていない。
    check(sqls.every((f) => !/_apply\.sql$/.test(f)), '★ *_apply.sql 命名を避けている（誤適用防止）');
    // 適用済み DDL 側は依然 policy 無し（deny-by-default のまま）。
    for (const f of ['career_aggregated_insight_apply.sql', 'career_company_knowledge_apply.sql']) {
      const src = readFileSync(join(ROOT, 'supabase', f), 'utf8');
      check(!/CREATE POLICY/i.test(src), `${f}: 適用済み側に policy を追加していない`);
      check(!/GRANT[\s\S]*TO\s+(anon|authenticated)/i.test(src), `${f}: 適用済み側に GRANT を追加していない`);
    }
  }

  // ── PF-14 / PF-15 / PF-16 ───────────────────────────────────────
  console.log('[PF-14/PF-15/PF-16] flags OFF / consumer 0 / Personal Optimization 分離');
  {
    for (const layer of ['layer4', 'layer5'] as const) {
      check(!evaluateActivation({ ...EMPTY_ACTIVATION_INPUT, layer }).activated, `${layer}: 既定で OFF`);
    }
    for (const cap of CONSUMER_CAPABILITIES) {
      check(!isConsumerConnected(cap.consumer), `consumer ${cap.consumer}: not_connected`);
    }
    // app/ から Layer 5 / loaders / renderers の **データ権威**を import しない。
    //   ★ 純粋ユーティリティの再利用（allowlist）は許可し、repository / projection /
    //     loader / policy registry への import だけを違反として検出する。
    const impurePrep = assertSanctionedPureModules(ROOT);
    check(
      impurePrep.length === 0,
      `★ allowlist した Layer 4/5 module は純粋関数のまま（${SANCTIONED_PURE_LAYER_MODULES.length} module）`,
      impurePrep.map((v) => `${v.file}: ${v.markers.join('/')}`).join(' | '),
    );
    const FORBIDDEN_LAYER_MODULES = ['careerCompanyKnowledge', 'careerCollectiveIntelligence', 'careerContextLoaders', 'careerContextRenderers'];
    const offenders: string[] = [];
    for (const f of tsFiles('app')) {
      const specs = findForbiddenLayerImports(readFileSync(f, 'utf8'), FORBIDDEN_LAYER_MODULES);
      if (specs.length > 0) offenders.push(`${rel(f)}(${specs.join(' ')})`);
    }
    check(offenders.length === 0, '★ app/ が Layer 5 / policy registry のデータ権威を import しない', offenders.join(','));
    // Personal Optimization の分離。
    for (const d of ['lib/careerSourceData', 'lib/careerServerContext', 'lib/careerMemory']) {
      for (const f of tsFiles(d)) {
        const code = codeOnly(readFileSync(f, 'utf8'));
        check(!/careerAggregate|careerCompanyKnowledge|careerCollectiveIntelligence/.test(code),
          `${rel(f)}: Layer 4/5 非依存`);
      }
    }
    // policy registry / preflight は env / service role を読まない。
    for (const f of tsFiles('lib/careerCollectiveIntelligence')) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      check(!/process\.env/.test(code), `${rel(f)}: env を読まない（pure）`);
      check(!/serviceRole|SERVICE_ROLE/.test(code), `${rel(f)}: service role なし`);
      check(!/console\.(log|warn|error|info)/.test(code), `${rel(f)}: log を出さない`);
    }
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-collective-intelligence-production-prep-qa: ALL PASS'
      : `career-collective-intelligence-production-prep-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
