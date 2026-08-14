/*
 * scripts/career-collective-intelligence-closure-qa.ts
 *
 * PASSAI CAREER — Collective Intelligence Closure QA（CI-1 〜 CI-16）。
 *   dev-only・pure / DI fake・実 Supabase 非接続・実 AI call なし。
 *
 * CI-1  consent 無し             → Layer 4 寄与なし
 * CI-2  sharing consent 無し     → Layer 5 寄与なし
 * CI-3  consent 撤回             → 以後の寄与が構造的に止まる
 * CI-4  小 cohort                → suppressed / 数値を返さない
 * CI-5  rare filter 組み合わせ    → 個人を特定できない
 * CI-6  raw personal text        → Layer 5 published へ直接入らない
 * CI-7  未 moderation            → published knowledge として読めない
 * CI-8  private company research → 自動共有されない
 * CI-9  cross-user RLS           → 他 member の private を読めない
 * CI-10 client 偽造 user ID      → 他人として寄与/読取できない
 * CI-11 未知 purpose / 不正 version → deny
 * CI-12 全 flag OFF              → production 挙動ゼロ変化
 * CI-13 Layer 4 output に individual row が無い
 * CI-14 Layer 5 public output に contributor PII が無い
 * CI-15 Event Signal が ability/matching aggregate にならない
 * CI-16 Personal Memory が黙って shared knowledge にならない
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-collective-intelligence-closure-qa.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ── Data governance ────────────────────────────────────────────────
import {
  CAREER_DATA_CLASSES,
  DATA_CLASSIFICATION_TABLE,
  classifyDataClass,
  dataClassesWithPrivacyClass,
  mayBeAggregated,
  mayBeShared,
  requiredConsentScopeFor,
} from '@/lib/careerDataGovernance/dataClassification';
import {
  PROPAGATION_MATRIX,
  propagationEffect,
  codeGuaranteedRules,
  humanDecisionRules,
  IRREVERSIBLE_FACTS,
} from '@/lib/careerDataGovernance/deletionPropagation';

// ── Layer 4 ────────────────────────────────────────────────────────
import {
  SOURCE_ELIGIBILITY_TABLE,
  eligibleAggregateSources,
  isAggregateEligibleSource,
} from '@/lib/careerAggregate/sourceEligibility';
import {
  evaluateRetentionPolicy,
  evaluateArtifactRetention,
  isRetentionServable,
  RETENTION_MAX_DAYS,
} from '@/lib/careerAggregate/retention';
import { evaluateConsentEligibility } from '@/lib/careerAggregate/consent';
import { evaluateCohort, validateCohortSpec } from '@/lib/careerAggregate/cohort';
import { evaluateRareCategory } from '@/lib/careerAggregate/rareCategory';
import {
  COHORT_THRESHOLDS,
  PROHIBITED_DIMENSIONS,
  CONSUMER_CAPABILITIES,
  isConsumerConnected,
  isPermanentlyProhibitedConsumer,
} from '@/lib/careerAggregate/policy';
import { buildSuppressedArtifact, buildValidArtifact } from '@/lib/careerAggregate/artifact';

// ── Layer 5 ────────────────────────────────────────────────────────
import {
  COMPANY_KNOWLEDGE_SOURCE_CLASSES,
  classifyContributionSourceClass,
  evaluateSharingAdmission,
  isImpliedConsentAcceptable,
  isPubliclyReadableSourceClass,
  NON_CONSENT_SIGNALS,
} from '@/lib/careerCompanyKnowledge/sourceClass';
import { buildCompanyKnowledgeProjection } from '@/lib/careerCompanyKnowledge/projection';
import { computeContributionFingerprint } from '@/lib/careerCompanyKnowledge/contribution';
import { PROHIBITED_CONTRIBUTOR_FIELDS } from '@/lib/careerCompanyKnowledge/policy';

// ── Consent ────────────────────────────────────────────────────────
import {
  CONSENT_PURPOSE_REGISTRY,
  consentPurposeFamily,
  evaluateConsent,
  isSameConsentPurpose,
  scopesForFamily,
} from '@/lib/careerConsent/purposeRegistry';

// ── Activation ─────────────────────────────────────────────────────
import {
  EMPTY_ACTIVATION_INPUT,
  evaluateActivation,
  evaluateActivationReadiness,
  isAccidentalEnablePattern,
  LAYER_REQUIRED_ASPECTS,
} from '@/lib/careerDataSpineGate/activation';

import type { CompanyKnowledgeContribution } from '@/types/careerCompanyKnowledge';
import type { ConsentRecord } from '@/types/careerAggregate';

const ROOT = process.cwd();

/** コメント行を除いた実コードだけを返す。 */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** app / lib を走査して条件に合うファイルを集める。 */
function walkSources(dirs: readonly string[], pred: (rel: string, src: string) => boolean): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      const rel = full.slice(ROOT.length + 1);
      if (pred(rel, readFileSync(full, 'utf8'))) hits.push(rel);
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return hits.sort();
}

// ── fixtures ───────────────────────────────────────────────────────
const CLEAN_MODERATION = {
  state: 'approved' as const,
  piiScan: 'clean' as const,
  confidentiality: 'low' as const,
  abuse: 'none' as const,
  rejectionReason: null,
};

function contribution(
  over: Partial<CompanyKnowledgeContribution> = {},
): CompanyKnowledgeContribution {
  const base = {
    contributionId: 'c-1',
    company: { status: 'resolved', companyId: 'co-1', displayName: 'Alpha' },
    contentCategory: 'selection_flow',
    sourceCategory: 'candidate_experience',
    evidenceKind: 'first_hand',
    observedPeriod: '2026',
    selectionCategory: 'full_time',
    roleCategory: 'engineering',
    bodySummary: '一次面接はオンラインで 30 分程度だった。',
    consentState: 'share_granted',
    submittedAt: '2026-07-02T00:00:00.000Z',
    moderation: { ...CLEAN_MODERATION },
    provenanceNote: 'candidate_experience/2026',
    privacyClassification: 'shared_company_knowledge',
    lifecycleState: 'published',
    legalHold: false,
    __contributorOpaqueKey: 'opaque-1',
    __contentFingerprint: '',
    ...over,
  } as unknown as CompanyKnowledgeContribution;
  if (!over.__contentFingerprint) {
    (base as { __contentFingerprint: string }).__contentFingerprint =
      computeContributionFingerprint(base);
  }
  return base;
}

const ADMIT_OK = {
  authenticated: true,
  explicitSharingConsentActive: true,
  consentPolicyVersionSupported: true,
};

function consentRecord(over: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    grantedScopes: ['internal_aggregated_analytics'],
    version: 1,
    grantedAt: Date.parse('2026-01-01T00:00:00.000Z'),
    optedOut: false,
    accountDeleted: false,
    ...over,
  } as unknown as ConsentRecord;
}

async function main() {
  console.log('=== career-collective-intelligence-closure-qa ===');

  // ── CI-1 ────────────────────────────────────────────────────────
  console.log('[CI-1] consent 無し → Layer 4 寄与なし');
  {
    const at = Date.parse('2026-06-01T00:00:00.000Z');
    for (const audience of ['internal', 'user_facing', 'ai_context'] as const) {
      const none = evaluateConsentEligibility({ consent: null, audience, eventOccurredAt: at });
      check(!none.eligible, `${audience}: consent null → ineligible`);
      const optedOut = evaluateConsentEligibility({
        consent: consentRecord({ optedOut: true }), audience, eventOccurredAt: at,
      });
      check(!optedOut.eligible, `${audience}: opt-out → ineligible`);
      const wrongScope = evaluateConsentEligibility({
        consent: consentRecord({ grantedScopes: ['personal_service_processing'] as never }),
        audience, eventOccurredAt: at,
      });
      check(!wrongScope.eligible, `${audience}: 別 scope のみ → ineligible（purpose limitation）`);
    }
    // ★ personal_service_processing（＝Personal Memory の同意）は aggregate 同意にならない。
    check(
      !isSameConsentPurpose('personal_service_processing', 'internal_aggregated_analytics'),
      'personal_service_processing は aggregate 同意と同一視されない',
    );
  }

  // ── CI-2 ────────────────────────────────────────────────────────
  console.log('[CI-2] sharing consent 無し → Layer 5 寄与なし');
  {
    const noConsent = evaluateSharingAdmission({
      contribution: contribution({ consentState: 'not_shared' }),
      ...ADMIT_OK,
    });
    check(!noConsent.admitted, 'not_shared → admitted=false');
    check(
      !noConsent.admitted && noConsent.reasons.includes('no_explicit_sharing_consent'),
      '理由に no_explicit_sharing_consent が含まれる',
    );
    const ledgerInactive = evaluateSharingAdmission({
      contribution: contribution(),
      ...ADMIT_OK,
      explicitSharingConsentActive: false,
    });
    check(!ledgerInactive.admitted, 'consent ledger 無効 → admitted=false');
    // 暗黙同意は一切 consent にならない。
    for (const sig of NON_CONSENT_SIGNALS) {
      check(isImpliedConsentAcceptable(sig) === false, `暗黙 signal「${sig}」は同意にならない`);
    }
  }

  // ── CI-3 ────────────────────────────────────────────────────────
  console.log('[CI-3] consent 撤回 → 以後の寄与が構造的に止まる');
  {
    const revoked = evaluateSharingAdmission({
      contribution: contribution({ consentState: 'share_revoked' }),
      ...ADMIT_OK,
    });
    check(!revoked.admitted, 'share_revoked → admitted=false');
    const excluded = evaluateSharingAdmission({
      contribution: contribution({ __excluded: true } as never),
      ...ADMIT_OK,
    });
    check(!excluded.admitted, '__excluded → admitted=false');
    // Layer 4 側: 撤回後の event は以後 ineligible。
    const at = Date.parse('2026-06-01T00:00:00.000Z');
    const l4 = evaluateConsentEligibility({
      consent: consentRecord({ optedOut: true }), audience: 'internal', eventOccurredAt: at,
    });
    check(!l4.eligible, 'Layer 4: 撤回後は ineligible');
    // 伝播表: 撤回 → 未 publish は無効化、aggregate input は future-only block。
    check(
      propagationEffect('consent_revoked', 'pending_contribution').effect === 'invalidated_and_rebuilt',
      '伝播表: 撤回 × pending → invalidated',
    );
    check(
      propagationEffect('consent_revoked', 'aggregate_input').effect === 'future_use_only_blocked',
      '伝播表: 撤回 × aggregate input → future-use blocked',
    );
    check(
      propagationEffect('consent_revoked', 'published_contribution').effect === 'human_policy_required',
      '★ 既 publish の扱いは Human/legal decision（コードで確定しない）',
    );
    check(codeGuaranteedRules().length > 0 && humanDecisionRules().length > 0, '伝播表が両方の分類を持つ');
    check(IRREVERSIBLE_FACTS.length >= 2, '不可逆な事実がコードに明記されている');
  }

  // ── CI-4 ────────────────────────────────────────────────────────
  console.log('[CI-4] 小 cohort → suppressed / 数値を返さない');
  {
    const lower = COHORT_THRESHOLDS.absoluteLowerBound;
    for (const audience of ['internal', 'user_facing', 'ai_context'] as const) {
      const tiny = evaluateCohort({ uniqueUsers: 1, audience, cohortType: 'all' });
      check(tiny.suppressed === true, `${audience}: n=1 → suppressed`);
      const belowAbs = evaluateCohort({ uniqueUsers: lower - 1, audience, cohortType: 'all' });
      check(belowAbs.suppressed === true, `${audience}: n<absoluteLowerBound → suppressed`);
      check(
        belowAbs.suppressed === true && belowAbs.reason === 'below_absolute_minimum',
        `${audience}: 理由が below_absolute_minimum`,
      );
    }
    // audience 別閾値が単調（internal <= userFacing <= aiContext）。
    check(
      COHORT_THRESHOLDS.internal <= COHORT_THRESHOLDS.userFacing &&
        COHORT_THRESHOLDS.userFacing <= COHORT_THRESHOLDS.aiContext,
      'audience 閾値が単調（AI が最保守）',
    );
    check(COHORT_THRESHOLDS.status === 'PROVISIONAL', '閾値が PROVISIONAL と明示されている（H-L1）');
    // suppressed artifact は数値を持たない。
    const art = buildSuppressedArtifact(
      {
        feature: 'self_analysis', cohortType: 'all', cohortValue: 'all', timeBucket: '2026-06',
        sourceWindowStart: '2026-06-01T00:00:00.000Z', sourceWindowEnd: '2026-07-01T00:00:00.000Z',
        generatedAt: '2026-07-02T00:00:00.000Z', audience: 'user_facing',
        consentScope: 'user_facing_aggregated_insight', qualityStatus: 'ok',
      } as never,
      'below_absolute_minimum',
    );
    const artJson = JSON.stringify(art);
    check(!/"numerator"|"denominator"|"prevalence"/.test(artJson), '★ suppressed artifact に数値が無い');
    check(art.kind === 'suppressed', 'kind=suppressed');
  }

  // ── CI-5 ────────────────────────────────────────────────────────
  console.log('[CI-5] rare filter 組み合わせ → 個人を特定できない');
  {
    // 交差 dimension は常に拒否（単一 COUNT>=N では不十分なため構造的に禁止）。
    const crossed = validateCohortSpec({
      cohortType: 'graduation_year', extraDimensions: ['university'], timeGranularity: 'month',
    });
    check('suppressed' in crossed, '★ 交差 dimension は常に suppressed（小セル化を構造的に防ぐ）');
    const prohibited = validateCohortSpec({
      cohortType: 'graduation_year', extraDimensions: ['company'], timeGranularity: 'month',
    });
    check(
      'suppressed' in prohibited && prohibited.reason === 'prohibited_dimension',
      'prohibited dimension は理由付きで拒否',
    );
    // 高リスク dimension が禁止リストに含まれている。
    for (const d of ['university', 'company', 'gender', 'faculty', 'industry', 'job_type']) {
      check(PROHIBITED_DIMENSIONS.includes(d), `禁止 dimension に ${d} を含む`);
    }
    // rare category（support 不足）は suppressed。
    const rare = evaluateRareCategory({ cohortType: 'graduation_year', distinctUsersInCategory: 3 });
    check(rare.rare === true, 'support 不足の cohort 値は rare として suppress');
    const negative = evaluateRareCategory({ cohortType: 'graduation_year', distinctUsersInCategory: -5 });
    check(negative.rare === true, '不正 support は rare 側へ倒す（fail-closed）');
    // 時間粒度も粗いことを要求。
    const daily = validateCohortSpec({ cohortType: 'all', timeGranularity: 'day' });
    check('suppressed' in daily, 'day 粒度は拒否（時間で個人を絞らせない）');
  }

  // ── CI-6 ────────────────────────────────────────────────────────
  console.log('[CI-6] raw personal text → Layer 5 published へ直接入らない');
  {
    const notScanned = evaluateSharingAdmission({
      contribution: contribution({
        moderation: { ...CLEAN_MODERATION, piiScan: 'not_scanned' } as never,
      }),
      ...ADMIT_OK,
    });
    check(!notScanned.admitted, '★ piiScan=not_scanned は publishable ではない（fail-closed）');
    check(
      !notScanned.admitted && notScanned.reasons.includes('pii_not_scrubbed'),
      '理由に pii_not_scrubbed',
    );
    const detected = evaluateSharingAdmission({
      contribution: contribution({
        moderation: { ...CLEAN_MODERATION, piiScan: 'pii_detected' } as never,
      }),
      ...ADMIT_OK,
    });
    check(!detected.admitted, 'pii_detected → 拒否');
    // 分類上も raw 本文は shared へ行けない。
    check(!mayBeShared('raw.free_text'), 'raw.free_text は shared_knowledge へ到達不可');
    check(!mayBeAggregated('raw.free_text'), 'raw.free_text は aggregate へも到達不可');
    check(classifyDataClass('raw.free_text') === 'PERSONAL_ONLY', 'raw.free_text は PERSONAL_ONLY');
    // 未知 data class も PERSONAL_ONLY（default deny）。
    check(classifyDataClass('totally.unknown.class') === 'PERSONAL_ONLY', '★ 未知 class は default deny');
    check(!mayBeShared('totally.unknown.class'), '未知 class は shared へ到達不可');
  }

  // ── CI-7 ────────────────────────────────────────────────────────
  console.log('[CI-7] 未 moderation → published knowledge として読めない');
  {
    for (const state of ['pending', 'rejected', 'blocked'] as const) {
      const c = contribution({ moderation: { ...CLEAN_MODERATION, state } as never });
      const adm = evaluateSharingAdmission({ contribution: c, ...ADMIT_OK });
      check(!adm.admitted, `moderation=${state} → admitted=false`);
      check(
        classifyContributionSourceClass(c) !== 'MODERATED_SHARED_KNOWLEDGE',
        `moderation=${state} → MODERATED_SHARED_KNOWLEDGE にならない`,
      );
      // projection（read 経路）にも出ない。
      const proj = buildCompanyKnowledgeProjection({
        purpose: 'company_research', companyId: 'co-1', displayName: 'Alpha',
        contributions: [c], nowIso: '2026-07-02T00:00:00.000Z',
      });
      check(proj.status !== 'available', `moderation=${state} → projection に出ない`);
    }
    // lifecycle が published 未満なら read consumer には出さない。
    const approvedNotPublished = contribution({ lifecycleState: 'approved' } as never);
    const readGate = evaluateSharingAdmission({
      contribution: approvedNotPublished, ...ADMIT_OK, requirePublished: true,
    });
    check(!readGate.admitted, 'requirePublished: approved だけでは read できない');
    check(
      isPubliclyReadableSourceClass('USER_SHARED_CONTRIBUTION') === false,
      'USER_SHARED_CONTRIBUTION は public read 対象ではない',
    );
    check(
      isPubliclyReadableSourceClass('MODERATED_SHARED_KNOWLEDGE') === true,
      'MODERATED_SHARED_KNOWLEDGE のみ public read 可',
    );
  }

  // ── CI-8 ────────────────────────────────────────────────────────
  console.log('[CI-8] private company research → 自動共有されない');
  {
    check(
      classifyDataClass('source.company_research') === 'PERSONAL_ONLY',
      'source.company_research は PERSONAL_ONLY',
    );
    check(!mayBeShared('source.company_research'), '分類上 shared_knowledge へ到達不可');
    check(
      requiredConsentScopeFor('source.company_research') === null,
      '共有 scope が割り当てられていない（共有経路が存在しない）',
    );
    // ★ 静的: private research → contribution の自動変換関数が repo に存在しない。
    const converters = walkSources(['app', 'lib'], (rel, src) => {
      if (rel.startsWith('scripts/')) return false;
      const code = codeOnly(src);
      // 「CareerCompanyResearchLog を受け取り CompanyKnowledgeContribution を返す」関数の兆候。
      return (
        /CareerCompanyResearchLog/.test(code) && /CompanyKnowledgeContribution/.test(code)
      );
    });
    check(
      converters.length === 0,
      '★ private research → contribution の変換 module が存在しない',
      converters.join(','),
    );
    // Layer 5 module 群が private research storage を import していない。
    const l5Files = readdirSync(join(ROOT, 'lib/careerCompanyKnowledge')).filter((f) => f.endsWith('.ts'));
    for (const f of l5Files) {
      const code = codeOnly(readFileSync(join(ROOT, 'lib/careerCompanyKnowledge', f), 'utf8'));
      check(
        !/companyResearchStorage|careerCompanyResearch\//.test(code),
        `lib/careerCompanyKnowledge/${f}: private research storage を import しない`,
      );
    }
  }

  // ── CI-9 / CI-10 ────────────────────────────────────────────────
  console.log('[CI-9/CI-10] cross-user RLS / client 偽造 user ID');
  {
    // DDL: 全 L4/L5 table が RLS enabled、authenticated への GRANT が無い（default deny）。
    for (const sqlFile of ['career_aggregated_insight_apply.sql', 'career_company_knowledge_apply.sql']) {
      const sql = readFileSync(join(ROOT, 'supabase', sqlFile), 'utf8');
      const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
      check(tables.length > 0, `${sqlFile}: table が定義されている（${tables.length}）`);
      for (const t of tables) {
        check(
          new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).test(sql),
          `${sqlFile}: ${t} は RLS 有効`,
        );
      }
      check(
        !/GRANT[\s\S]*TO\s+(anon|authenticated)/i.test(sql),
        `${sqlFile}: anon/authenticated への GRANT が無い（default deny）`,
      );
      check(!/CREATE POLICY/i.test(sql), `${sqlFile}: policy 未作成（deny-by-default のまま）`);
    }
    // 型に contributor 実体が存在しない（＝client が他人として寄与する経路がない）。
    const ckTypes = codeOnly(readFileSync(join(ROOT, 'types/careerCompanyKnowledge.ts'), 'utf8'));
    for (const banned of ['authUserId', 'userId:', 'user_id:', 'email:']) {
      check(!ckTypes.includes(banned), `contribution 型に ${banned} が無い`);
    }
    // Layer 4/5 module 群が client 由来 userId を読まない。
    const l45 = walkSources(['lib/careerAggregate', 'lib/careerCompanyKnowledge', 'lib/careerConsent'], () => true);
    for (const rel of l45) {
      const code = codeOnly(readFileSync(join(ROOT, rel), 'utf8'));
      check(!/body\.userId|b\.userId|req\.userId|query\.userId/.test(code), `${rel}: client 由来 userId を読まない`);
    }
  }

  // ── CI-11 ───────────────────────────────────────────────────────
  console.log('[CI-11] 未知 purpose / 不正 consent version → deny');
  {
    check(!evaluateConsent({ scope: 'nonexistent_scope', state: 'granted', grantedVersion: 1 }).consented,
      '未知 scope → deny');
    check(!evaluateConsent({ scope: 'internal_aggregated_analytics', state: null, grantedVersion: 1 }).consented,
      '記録なし → deny');
    check(!evaluateConsent({ scope: 'internal_aggregated_analytics', state: 'revoked', grantedVersion: 1 }).consented,
      'revoked → deny');
    for (const v of [0, -1, 1.5, Number.NaN, null, undefined] as unknown[]) {
      check(
        !evaluateConsent({
          scope: 'internal_aggregated_analytics', state: 'granted', grantedVersion: v as never,
        }).consented,
        `不正 version(${String(v)}) → deny`,
      );
    }
    check(!evaluateConsent({ scope: 'internal_aggregated_analytics', state: 'granted', grantedVersion: 99 }).consented,
      'unsupported version → deny');
    check(evaluateConsent({ scope: 'internal_aggregated_analytics', state: 'granted', grantedVersion: 1 }).consented,
      '正常系のみ consented');
    // registry: default granted が存在しない。
    for (const e of CONSENT_PURPOSE_REGISTRY) {
      check(e.defaultGranted === false, `${e.scope}: defaultGranted=false`);
      check(e.revocable === true, `${e.scope}: 撤回可能`);
    }
    // 3 family が分離されている。
    check(scopesForFamily('personal_optimization').length >= 1, 'personal_optimization family が存在');
    check(scopesForFamily('aggregate_contribution').length >= 3, 'aggregate_contribution family が存在');
    check(scopesForFamily('company_knowledge_sharing').length === 1, 'company_knowledge_sharing family が存在');
    check(
      consentPurposeFamily('company_knowledge_contribution') === 'company_knowledge_sharing' &&
        consentPurposeFamily('internal_aggregated_analytics') === 'aggregate_contribution',
      '★ Layer 5 共有と aggregate は別 family',
    );
  }

  // ── CI-12 ───────────────────────────────────────────────────────
  console.log('[CI-12] 全 flag OFF → production 挙動ゼロ変化');
  {
    for (const layer of ['layer4', 'layer5'] as const) {
      const d = evaluateActivation({ ...EMPTY_ACTIVATION_INPUT, layer });
      check(!d.activated, `${layer}: 既定で activated=false`);
      check(
        !d.activated && d.blockers.includes('flag_off') && d.blockers.includes('consent_not_ready'),
        `${layer}: blocker に flag_off / consent_not_ready`,
      );
    }
    // Layer 5 は moderation を必須にする。
    const l5 = evaluateActivation({
      ...EMPTY_ACTIVATION_INPUT, layer: 'layer5',
      flagEnabled: true, userIsCanary: true, infrastructureReady: true, consentReady: true,
      legalApproved: true, moderationReady: false,
      readinessConfig: Object.fromEntries(LAYER_REQUIRED_ASPECTS.layer5.map(() => ['x', true])) as never,
    });
    check(!l5.activated, 'Layer 5: moderation 未整備なら activated=false');
    check(!l5.activated && l5.blockers.includes('moderation_not_ready'), 'blocker に moderation_not_ready');
    // Layer 4 は retention / cohort threshold を必須にする。
    const l4 = evaluateActivation({
      ...EMPTY_ACTIVATION_INPUT, layer: 'layer4',
      flagEnabled: true, userIsCanary: true, infrastructureReady: true, consentReady: true,
      legalApproved: true,
    });
    check(!l4.activated, 'Layer 4: retention 未設定なら activated=false');
    check(
      !l4.activated &&
        l4.blockers.includes('retention_not_configured') &&
        l4.blockers.includes('cohort_threshold_not_configured'),
      'blocker に retention / cohort threshold',
    );
    // accidental enable パターンを認めない。
    check(isAccidentalEnablePattern({ nodeEnvIsProduction: true }), 'NODE_ENV=production は accidental');
    check(isAccidentalEnablePattern({ envVarUnset: true }), 'env 未設定 true 化は accidental');
    check(isAccidentalEnablePattern({ allowlistEmpty: true }), '空 allowlist の全許可は accidental');
    check(isAccidentalEnablePattern({ legalApprovalUnset: true }), '法務未設定の approved 化は accidental');
    check(isAccidentalEnablePattern({ moderationModuleExistsOnly: true }), 'module 存在だけの ready 化は accidental');
    check(!isAccidentalEnablePattern({}), '根拠が無ければ accidental 判定しない');
    // flags.server.ts が === 'true' でのみ ON（未設定 true 化が無い）。
    const flags = codeOnly(readFileSync(join(ROOT, 'lib/careerDataSpineGate/flags.server.ts'), 'utf8'));
    const enableFns = [...flags.matchAll(/export function is\w+Enabled\(\)[\s\S]*?\n}/g)].map((m) => m[0]);
    check(enableFns.length >= 4, `enable flag が検出できる（${enableFns.length}）`);
    for (const fn of enableFns) {
      check(/=== 'true'/.test(fn), 'enable flag は === \'true\' でのみ ON');
      check(!/NODE_ENV/.test(fn), 'enable flag が NODE_ENV を見ない');
    }
    // retention: 未設定 / 無期限相当は NOT_CONFIGURED。
    check(evaluateRetentionPolicy(null).status === 'NOT_CONFIGURED', 'retention 未設定 → NOT_CONFIGURED');
    for (const days of [0, -1, 1.5, Number.POSITIVE_INFINITY, RETENTION_MAX_DAYS + 1]) {
      check(
        evaluateRetentionPolicy({ retentionDays: days, policyVersion: 'v1', legalApproved: true }).status ===
          'NOT_CONFIGURED',
        `retentionDays=${days} は invalid（無期限保持を表現できない）`,
      );
    }
    check(
      evaluateRetentionPolicy({ retentionDays: 90, policyVersion: null, legalApproved: true }).status ===
        'NOT_CONFIGURED',
      'policy version 欠落 → NOT_CONFIGURED',
    );
    const disp = evaluateArtifactRetention({
      generatedAt: '2026-01-01T00:00:00.000Z', nowMs: Date.parse('2026-07-02T00:00:00.000Z'),
      config: null,
    });
    check(!isRetentionServable(disp), 'retention 未確定 → serve しない（fail-closed）');
    // ★ production consumer は 0 のまま（capability が全て not_connected）。
    for (const cap of CONSUMER_CAPABILITIES) {
      check(!isConsumerConnected(cap.consumer), `consumer ${cap.consumer}: not_connected`);
    }
    check(isPermanentlyProhibitedConsumer('matching'), 'matching は恒久禁止 consumer');
  }

  // ── CI-13 ───────────────────────────────────────────────────────
  console.log('[CI-13] Layer 4 output に individual row が無い');
  {
    const valid = buildValidArtifact(
      {
        feature: 'self_analysis', cohortType: 'all', cohortValue: 'all', timeBucket: '2026-06',
        sourceWindowStart: '2026-06-01T00:00:00.000Z', sourceWindowEnd: '2026-07-01T00:00:00.000Z',
        generatedAt: '2026-07-02T00:00:00.000Z', audience: 'internal',
        consentScope: 'internal_aggregated_analytics', qualityStatus: 'ok',
      } as never,
      { numerator: 40, denominator: 80 },
    );
    const json = JSON.stringify(valid);
    // 識別子・生データ・行っぽい構造が無い。
    for (const banned of ['userId', 'user_id', 'hashedUserId', 'clientEventId', 'client_event_id', 'rows', 'records', 'occurredAt']) {
      check(!json.includes(banned), `valid artifact に ${banned} が無い`);
    }
    check(typeof (valid as { numerator?: number }).numerator === 'number', 'aggregate 数値（分子）を返す');
    check(/"prevalence"/.test(json), 'distribution/ratio を返す');
    check(!/\[\s*\{/.test(json.replace(/"[^"]*"/g, '')), 'object 配列（行の羅列）を含まない');
    // provenance に source class / policy が乗る。
    const prov = (valid as { provenance?: Record<string, unknown> }).provenance ?? {};
    check(prov.sourceDataClass === 'event.feature_usage', '★ provenance に source data class');
    check(typeof prov.calculationVersion === 'string', 'provenance に aggregation version');
    check(typeof prov.policyStatus === 'string', 'provenance に policy status');
    check(typeof (valid as { generatedAt?: string }).generatedAt === 'string', 'generated_at がある');
    // eligibility 表と実際の source class が一致。
    check(eligibleAggregateSources().length === 1, '★ eligible source は 1 種類のみ');
    check(isAggregateEligibleSource('event.feature_usage'), 'event.feature_usage は eligible');
    for (const dc of CAREER_DATA_CLASSES) {
      if (dc === 'event.feature_usage') continue;
      check(!isAggregateEligibleSource(dc), `${dc}: aggregate ineligible`);
    }
    check(
      SOURCE_ELIGIBILITY_TABLE.every((e) => e.eligible || e.why.length > 10),
      'ineligible には必ず理由が書かれている',
    );
  }

  // ── CI-14 ───────────────────────────────────────────────────────
  console.log('[CI-14] Layer 5 public output に contributor PII が無い');
  {
    const proj = buildCompanyKnowledgeProjection({
      purpose: 'company_research', companyId: 'co-1', displayName: 'Alpha',
      contributions: [contribution(), contribution({ contributionId: 'c-2', __contributorOpaqueKey: 'opaque-2' })],
      nowIso: '2026-07-02T00:00:00.000Z',
    });
    check(proj.status === 'available', `projection available（${proj.status}）`);
    const json = JSON.stringify(proj);
    for (const banned of PROHIBITED_CONTRIBUTOR_FIELDS) {
      check(!json.includes(banned), `public projection に ${banned} が無い`);
    }
    check(!json.includes('opaque-1') && !json.includes('opaque-2'), '★ contributor opaque key も出さない');
    check(!json.includes('contributionId'), 'contribution id も出さない');
  }

  // ── CI-15 ───────────────────────────────────────────────────────
  console.log('[CI-15] Event Signal が ability/matching aggregate にならない');
  {
    check(
      classifyDataClass('event.signal_summary') === 'PERSONAL_ONLY',
      'event.signal_summary は PERSONAL_ONLY',
    );
    check(!mayBeAggregated('event.signal_summary'), 'aggregate へ到達不可');
    check(!isAggregateEligibleSource('event.signal_summary'), 'eligibility 表でも ineligible');
    // Layer 4 module 群が Event Signal / matching を import しない。
    const l4 = walkSources(['lib/careerAggregate'], () => true);
    for (const rel of l4) {
      const code = codeOnly(readFileSync(join(ROOT, rel), 'utf8'));
      check(!/eventSignal|EventSignal|renderEventSignals/.test(code), `${rel}: Event Signal 非依存`);
      check(!/careerMatching|runCareerMatch|matchingScore/.test(code), `${rel}: matching 非依存`);
    }
    // matching route が Layer 4/5 を import しない。
    const matching = codeOnly(readFileSync(join(ROOT, 'app/api/career/matching/route.ts'), 'utf8'));
    check(!/careerAggregate|careerCompanyKnowledge/.test(matching), 'matching route が Layer 4/5 を import しない');
  }

  // ── CI-16 ───────────────────────────────────────────────────────
  console.log('[CI-16] Personal Memory が黙って shared knowledge にならない');
  {
    for (const dc of ['memory.base', 'memory.self_analysis', 'memory.es', 'memory.interview']) {
      check(classifyDataClass(dc) === 'PERSONAL_ONLY', `${dc}: PERSONAL_ONLY`);
      check(!mayBeShared(dc), `${dc}: shared_knowledge へ到達不可`);
      check(!mayBeAggregated(dc), `${dc}: aggregate へ到達不可`);
    }
    // Layer 5 module が Personal Memory を import しない。
    const l5 = walkSources(['lib/careerCompanyKnowledge'], () => true);
    for (const rel of l5) {
      const code = codeOnly(readFileSync(join(ROOT, rel), 'utf8'));
      check(!/careerMemory\/|PersonalMemory/.test(code), `${rel}: Personal Memory 非依存`);
    }
    // Layer 4 module も同様。
    const l4 = walkSources(['lib/careerAggregate'], () => true);
    for (const rel of l4) {
      const code = codeOnly(readFileSync(join(ROOT, rel), 'utf8'));
      check(!/careerMemory\/persistence|readCareerPersonalMemorySections/.test(code),
        `${rel}: Personal Memory persistence 非依存`);
    }
    // 分類表の網羅性: 全 data class が表に載っている（載せ忘れ＝default deny になるが、明示も要求）。
    check(
      DATA_CLASSIFICATION_TABLE.length === CAREER_DATA_CLASSES.length,
      `分類表が全 data class を網羅（${DATA_CLASSIFICATION_TABLE.length}/${CAREER_DATA_CLASSES.length}）`,
    );
    check(dataClassesWithPrivacyClass('ANONYMOUS_AGGREGATABLE').length === 1,
      '★ ANONYMOUS_AGGREGATABLE は 1 種類のみ（無闇に増やしていない）');
    check(dataClassesWithPrivacyClass('EXPLICITLY_SHAREABLE').length === 1,
      'EXPLICITLY_SHAREABLE も 1 種類のみ');
  }

  // ── 追加: ACTIVATION_READY ≠ PRODUCTION_ENABLED ─────────────────
  console.log('[CI-extra] ACTIVATION_READY ≠ PRODUCTION_ENABLED');
  {
    const allAspects = Object.fromEntries(
      LAYER_REQUIRED_ASPECTS.layer5.map((a) => [a, true]),
    ) as Record<string, boolean>;
    const ready = evaluateActivationReadiness('layer5', allAspects as never);
    check(ready.ready === true, '全 aspect 完了 → ACTIVATION_READY');
    // ★ それでも activation は false（flag / consent / legal / infra が未達）。
    const act = evaluateActivation({ ...EMPTY_ACTIVATION_INPUT, layer: 'layer5' });
    check(!act.activated, '★ ACTIVATION_READY でも PRODUCTION_ENABLED にはならない');
    const partial = evaluateActivationReadiness('layer5', { code_path: true } as never);
    check(partial.ready === false, '一部 aspect のみ → NOT READY（fail-closed）');
    check(evaluateActivationReadiness('layer4', null).ready === false, 'null → NOT READY');
    // Layer 4 は moderation aspect を要求しない（層ごとに要件が違うことを固定）。
    check(!LAYER_REQUIRED_ASPECTS.layer4.includes('moderation_gate'), 'Layer 4 は moderation aspect 不要');
    check(LAYER_REQUIRED_ASPECTS.layer5.includes('moderation_gate'), 'Layer 5 は moderation aspect 必須');
  }

  // ── 追加: source class / propagation の網羅性 ────────────────────
  console.log('[CI-extra] source class / propagation 網羅性');
  {
    check(COMPANY_KNOWLEDGE_SOURCE_CLASSES.length === 4, 'L5 source class は 4 種類');
    check(
      classifyContributionSourceClass(contribution({ consentState: 'not_shared' })) ===
        'PRIVATE_PERSONAL_RESEARCH',
      '未共有は PRIVATE_PERSONAL_RESEARCH',
    );
    check(
      classifyContributionSourceClass(contribution()) === 'MODERATED_SHARED_KNOWLEDGE',
      '完全に通過したものだけ MODERATED_SHARED_KNOWLEDGE',
    );
    // 伝播表が trigger × target を網羅している。
    check(PROPAGATION_MATRIX.length === 15, `伝播表が 3 trigger × 5 target を網羅（${PROPAGATION_MATRIX.length}）`);
    check(
      propagationEffect('account_deleted', 'aggregate_output').effect === 'invalidated_and_rebuilt',
      'アカウント削除 → aggregate output は invalidate + rebuild',
    );
    check(
      propagationEffect('consent_revoked' as never, 'unknown_target' as never).effect ===
        'human_policy_required',
      '未定義の組は Human decision（fail-closed）',
    );
  }

  // ── 追加: service-role boundary（Human 指示 §31）─────────────────
  console.log('[CI-extra] service-role boundary');
  {
    // ★ Closure 監査で確認した residual boundary:
    //   consultation route（member request）→ shadow dispatcher → runtime → service-role read port
    //   という経路が **存在する**。ただし以下で厳しく制限されている。ここではその制限を固定する。
    const runtime = readFileSync(
      join(ROOT, 'lib/careerAggregate/batch/aggregatedInsightPrivilegedShadow.batch.ts'), 'utf8',
    );
    const core = readFileSync(
      join(ROOT, 'lib/careerAggregate/server/aggregatedInsightShadowCore.ts'), 'utf8',
    );
    // 1) real mode は privileged client 生成 **前** に blocked。
    check(/mode !== 'synthetic_only'/.test(codeOnly(core)), '★ real mode は compose 冒頭で blocked');
    check(/real_mode_blocked/.test(core), 'real_mode_blocked の理由が明示されている');
    // 2) synthetic-only の既定が **安全側**（明示 'false' でのみ解除）。
    const flags = readFileSync(join(ROOT, 'lib/careerDataSpineGate/flags.server.ts'), 'utf8');
    check(
      /isAggregatedInsightSyntheticOnly[\s\S]*?!== 'false'/.test(codeOnly(flags)),
      '★ synthetic-only の default true は **安全側**（real 化には明示解除が必要）',
    );
    // 3) privileged client factory は gate 通過後にのみ呼ばれる（compose へ関数として渡す）。
    check(
      /resolvePrivilegedRead: ResolvePrivilegedRead = \(\) => getSharedServiceRoleReadPort\(\)/.test(runtime),
      'privileged read は factory 越し（gate 前に生成しない）',
    );
    // 4) service-role port は raw client を上位へ出さない。
    const ports = readFileSync(join(ROOT, 'lib/careerDataSpineDb/sharedServiceRolePorts.server.ts'), 'utf8');
    check(/DataSpineReadPort|adaptReadPort/.test(ports), 'read port としてのみ公開（raw client を返さない）');
    check(!/export .*SupabaseClient/.test(codeOnly(ports)), 'raw SupabaseClient を export しない');
    // 5) ★ member request path の他の Data Spine module は service role を使わない。
    for (const dir of ['lib/careerSourceData', 'lib/careerServerContext', 'lib/careerMemory/persistence']) {
      for (const rel of walkSources([dir], () => true)) {
        const code = codeOnly(readFileSync(join(ROOT, rel), 'utf8'));
        check(!/serviceRole|SERVICE_ROLE/.test(code), `${rel}: service role なし（Personal Optimization 経路）`);
      }
    }
    // 6) Layer 5 は service role をまったく使わない（consumer 0 のため経路自体が無い）。
    for (const rel of walkSources(['lib/careerCompanyKnowledge'], () => true)) {
      const code = codeOnly(readFileSync(join(ROOT, rel), 'utf8'));
      check(!/serviceRole|SERVICE_ROLE/.test(code), `${rel}: service role なし`);
    }
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-collective-intelligence-closure-qa: ALL PASS'
      : `career-collective-intelligence-closure-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
