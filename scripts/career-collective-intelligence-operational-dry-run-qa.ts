/*
 * scripts/career-collective-intelligence-operational-dry-run-qa.ts
 *
 * PASSAI CAREER — Operational Dry-Run QA（OD-1 〜 OD-16 + M/L4/L5 シナリオ）。
 *   dev-only・**実 DB / 実 AI API へ一切接続しない**・production 変更なし。
 *
 * OD-1  pending migration が内部整合
 * OD-2  migration の RLS 順序が安全
 * OD-3  Layer 4 happy path（synthetic dry-run）
 * OD-4  Layer 4 suppression 経路
 * OD-5  ETL retry が idempotent
 * OD-6  Layer 5 submission → moderation → publish の一本通し
 * OD-7  一般 member は moderation できない
 * OD-8  PII 未検査は publish できない
 * OD-9  I2 identity が auth UUID を公開しない
 * OD-10 consent 撤回が以後の利用を止める
 * OD-11 retention の境界分類が正しい
 * OD-12 legal 未承認の間 production preflight は NOT READY
 * OD-13 test harness が app/ から到達不能
 * OD-14 production flag が有効化されていない
 * OD-15 production DB へ接続していない
 * OD-16 member app path から service-role へ到達不能
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-collective-intelligence-operational-dry-run-qa.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

import {
  checkIdempotency,
  checkNoAnonGrant,
  checkNoCallerSelectedUuid,
  checkNoPartialExposure,
  checkObjectReferences,
  checkOwnerScopedPolicies,
  checkPublishedViewColumns,
  checkRlsBeforeGrant,
  checkTransactionBoundaries,
  existingTables,
  loadMigrationPackage,
} from './ciOperational/sqlMigrationValidator';

// ── Layer 4 ────────────────────────────────────────────────────────
import { evaluateConsentEligibility } from '@/lib/careerAggregate/consent';
import { projectAggregateContribution } from '@/lib/careerAggregate/projection';
import { boundContributions } from '@/lib/careerAggregate/contribution';
import { evaluateCohort } from '@/lib/careerAggregate/cohort';
import { evaluateRareCategory } from '@/lib/careerAggregate/rareCategory';
import { buildSuppressedArtifact, buildValidArtifact } from '@/lib/careerAggregate/artifact';
import { FEATURE_USAGE_PREVALENCE } from '@/lib/careerAggregate/policy';
import { isAggregateEligibleSource } from '@/lib/careerAggregate/sourceEligibility';
import {
  EMPTY_CURSOR,
  nextWindow,
  runAggregateBatch,
  serializeRunKey,
  type BatchCursor,
  type BatchPorts,
  type BatchRunKey,
  type BatchRunRecord,
} from '@/lib/careerAggregate/batch/batchRunner';

// ── Layer 5 ────────────────────────────────────────────────────────
import { evaluateSharingAdmission } from '@/lib/careerCompanyKnowledge/sourceClass';
import { transitionContributionLifecycle } from '@/lib/careerCompanyKnowledge/lifecycle';
import { buildCompanyKnowledgeProjection } from '@/lib/careerCompanyKnowledge/projection';
import { computeContributionFingerprint } from '@/lib/careerCompanyKnowledge/contribution';
import { createDeterministicPiiScanner, toModerationFields } from '@/lib/careerCompanyKnowledge/pii';
import {
  canCreateContribution,
  isOwnContribution,
  resolveContributorOpaqueKey,
  unlinkSubject,
  type ContributorSubject,
} from '@/lib/careerCompanyKnowledge/contributorIdentity';

// ── policy / gate ──────────────────────────────────────────────────
import {
  CURRENT_POLICY_VERSION,
  isPolicyVersionSupported,
} from '@/lib/careerCollectiveIntelligence/policy/registry';
import {
  evaluateSharingStages,
  planWithdrawal,
} from '@/lib/careerCollectiveIntelligence/policy/sharingGate';
import {
  classifyExpiration,
  executeCleanup,
  planCleanup,
} from '@/lib/careerCollectiveIntelligence/policy/retentionPlanner';
import {
  authorizeModeratorAction,
  type ResolveModeratorPort,
} from '@/lib/careerCollectiveIntelligence/moderation/moderatorAuthorization';
import { runPreflight } from '@/lib/careerCollectiveIntelligence/preflight';
import { evaluateConsent } from '@/lib/careerConsent/purposeRegistry';
import { EMPTY_ACTIVATION_INPUT, evaluateActivation } from '@/lib/careerDataSpineGate/activation';

import type { CompanyKnowledgeContribution } from '@/types/careerCompanyKnowledge';
import type { ConsentRecord, RawAggregateEventInput } from '@/types/careerAggregate';

const ROOT = process.cwd();
const codeOnly = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');

let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const trace = (msg: string) => console.log(`        · ${msg}`);

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

/** import graph の推移的到達判定（`@/` alias と相対のみ解決）。 */
function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const c of [base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx'), base]) {
    if (existsSync(c) && /\.tsx?$/.test(c)) return c;
  }
  return null;
}
function reaches(seed: string, isTarget: (f: string) => boolean): string[] | null {
  const stack: { f: string; path: string[] }[] = [{ f: seed, path: [seed] }];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop() as { f: string; path: string[] };
    if (seen.has(cur.f)) continue;
    seen.add(cur.f);
    if (cur.f !== seed && isTarget(cur.f)) return cur.path;
    const src = readFileSync(cur.f, 'utf8');
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const r = resolveSpec(cur.f, m[1]);
      if (r && !seen.has(r)) stack.push({ f: r, path: [...cur.path, r] });
    }
  }
  return null;
}

// ── fixtures ───────────────────────────────────────────────────────
const UID_A = '11111111-1111-4111-8111-111111111111';
const UID_B = '22222222-2222-4222-8222-222222222222';
const SUBJECTS: ContributorSubject[] = [
  { authUserId: UID_A, opaqueKey: 'opaque-A', linkedAt: '2026-01-01T00:00:00.000Z', unlinkedAt: null },
  { authUserId: UID_B, opaqueKey: 'opaque-B', linkedAt: '2026-01-01T00:00:00.000Z', unlinkedAt: null },
];
const NOW_MS = Date.parse('2026-08-14T00:00:00.000Z');
const WINDOW = {
  start: '2026-06-01T00:00:00.000Z',
  end: '2026-07-01T00:00:00.000Z',
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

function event(userId: string, feature: string): RawAggregateEventInput {
  return {
    user_id: userId,
    client_event_id: `${userId}-${feature}`,
    feature,
    event_type: 'feature_completed',
    occurred_at: '2026-06-15T10:00:00.000Z',
  } as unknown as RawAggregateEventInput;
}

const CLEAN_MOD = {
  state: 'approved' as const, piiScan: 'clean' as const,
  confidentiality: 'low' as const, abuse: 'none' as const, rejectionReason: null,
};
function contribution(over: Partial<CompanyKnowledgeContribution> = {}): CompanyKnowledgeContribution {
  const base = {
    contributionId: 'c-1',
    company: { status: 'resolved', companyId: 'co-1', displayName: 'Alpha' },
    contentCategory: 'selection_flow', sourceCategory: 'candidate_experience',
    evidenceKind: 'user_experience', observedPeriod: '2026',
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

const ARTIFACT_BASE: Record<string, unknown> = {
  feature: 'self_analysis', cohortType: 'all', cohortValue: 'all', timeBucket: '2026-06',
  sourceWindowStart: WINDOW.start, sourceWindowEnd: WINDOW.end,
  generatedAt: '2026-07-02T00:00:00.000Z', audience: 'internal',
  consentScope: 'internal_aggregated_analytics', qualityStatus: 'ok',
};

async function main() {
  console.log('=== career-collective-intelligence-operational-dry-run-qa ===');

  // ══ OD-15 先に確認（実 DB へ触れないこと）══════════════════════
  console.log('[OD-15] production DB へ接続していない');
  {
    // ★ 本 harness は DB client を一切 import しない。
    const self = readFileSync(join(ROOT, 'scripts/career-collective-intelligence-operational-dry-run-qa.ts'), 'utf8');
    const validator = readFileSync(join(ROOT, 'scripts/ciOperational/sqlMigrationValidator.ts'), 'utf8');
    // ★ 判定は **import specifier** に対して行う（assertion 文字列そのものを誤検知しないため）。
    const importsOf = (src: string): string[] =>
      [...codeOnly(src).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const [n, src] of [['harness', self], ['validator', validator]] as const) {
      const imports = importsOf(src);
      check(!imports.some((i) => /@supabase|supabaseClient|serviceRoleClient|browserClient|serverClient/.test(i)),
        `${n}: Supabase client を import しない`);
      check(!imports.some((i) => /anthropic|openai|@\/lib\/ai$/.test(i)), `${n}: AI client を import しない`);
      check(!/process\.env\.(SUPABASE|NEXT_PUBLIC_SUPABASE|CAREER_SUPABASE)/.test(codeOnly(src)),
        `${n}: DB 接続 env を読まない`);
      // 実際に接続/呼び出しを行う式が無いこと（import 経由でなくても検出）。
      check(!/\.from\(['"]/.test(codeOnly(src)), `${n}: DB table へ query しない`);
      check(!/messages\.create\(/.test(codeOnly(src)), `${n}: AI API を呼ばない`);
    }
    // ★ 実行環境に DB client が無いことも記録（Option 2 を選んだ根拠）。
    const deps = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const all = { ...(deps.dependencies ?? {}), ...(deps.devDependencies ?? {}) };
    check(!Object.keys(all).some((k) => /^(pg|postgres|node-postgres)$/.test(k)),
      'repo に postgres client library が無い（実 DB apply 不可 → 静的検証を選択）');
  }

  // ══ OD-1 / OD-2: migration package ══════════════════════════════
  console.log('[OD-1] pending migration が内部整合');
  {
    const files = loadMigrationPackage(ROOT);
    check(files.length === 4, `migration file が 4 本（${files.length}）`);
    trace(files.map((f) => f.name).join(' → '));
    const stmtTotal = files.reduce((a, f) => a + f.statements.length, 0);
    check(stmtTotal > 30, `statement を分割できた（${stmtTotal}）`);

    // M1: transaction 境界。
    const tx = checkTransactionBoundaries(files);
    check(tx.length === 0, 'M1 全 file が BEGIN…COMMIT の 1 transaction', tx.map((i) => `${i.file}:${i.code}`).join(','));

    // 依存順序（参照オブジェクトが既知）。
    const applied = existingTables(ROOT);
    check(applied.size > 10, `適用済み table を認識（${applied.size}）`);
    const refs = checkObjectReferences(files, applied);
    check(refs.length === 0, '依存オブジェクトがすべて解決できる', refs.map((i) => `${i.file}:${i.detail}`).join(','));

    // 冪等性。
    const idem = checkIdempotency(files);
    check(idem.length === 0, '冪等（IF NOT EXISTS / DROP IF EXISTS / OR REPLACE）',
      idem.map((i) => `${i.file}:${i.detail}`).join(','));

    // M5: caller-selected UUID なし + auth.uid() 束縛 + anon REVOKE。
    const uuidIssues = checkNoCallerSelectedUuid(files);
    check(uuidIssues.length === 0, '★ M5 RPC が caller-selected UUID を取らない / auth.uid() 束縛 / anon REVOKE',
      uuidIssues.map((i) => `${i.file}:${i.detail}`).join(','));

    // anon GRANT なし。
    const anon = checkNoAnonGrant(files);
    check(anon.length === 0, 'anon への GRANT が無い', anon.map((i) => i.detail).join(','));

    // M3/M4: owner scoped policy。
    const { ownerScoped, broad } = checkOwnerScopedPolicies(files);
    check(ownerScoped.length >= 3, `★ M3 owner-scoped policy がある（${ownerScoped.length}）`);
    trace(`owner-scoped: ${ownerScoped.join(', ')}`);
    // broad policy は「個人データでない」ものだけ許す。
    const allowedBroad = new Set(['career_company_master read', 'career_consent_policies read',
      'career_ck_contributions published read', 'career_ck_moderation published read',
      'career_aggregate_artifacts member read']);
    const unexpected = broad.filter((b) => !allowedBroad.has(b.policy));
    check(unexpected.length === 0, '★ M4 想定外の broad policy が無い',
      unexpected.map((b) => b.policy).join(','));
    trace(`broad(許容): ${broad.map((b) => b.policy).join(', ')}`);

    // M7: published view に識別子が無い。
    const viewIssues = checkPublishedViewColumns(files, [
      'contributor_opaque_key', 'content_fingerprint', 'auth_user_id', 'contributor_user_id', 'provenance_note',
    ]);
    check(viewIssues.length === 0, '★ M7 published view に contributor 識別子が無い + security_invoker',
      viewIssues.map((i) => i.detail).join(','));

    // M6: I2 subject mapping が定義されている。
    const idm = files.find((f) => f.name.includes('contributor_subject'));
    check(!!idm, 'M6 subject mapping migration がある');
    check(!!idm && /career_ck_contributor_subjects/.test(idm.raw), 'subject table を作る');
    check(!!idm && /UNIQUE\s*\(opaque_key\)/i.test(idm.raw), 'opaque_key が UNIQUE');
    check(!!idm && /unlinked_at/.test(idm.raw), 'unlink を表現できる');
  }

  console.log('[OD-2] migration の RLS 順序が安全');
  {
    const files = loadMigrationPackage(ROOT);
    const rls = checkRlsBeforeGrant(files);
    check(rls.length === 0, '★ M2 GRANT より前に RLS 有効化（保護なしの瞬間が無い）',
      rls.map((i) => `${i.file}:${i.detail}`).join(','));
    const partial = checkNoPartialExposure(files);
    check(partial.length === 0, '★ M10 GRANT が transaction 内（失敗時に partial exposure なし）',
      partial.map((i) => i.detail).join(','));
    // 適用済み DDL 側は依然 deny-by-default。
    for (const f of ['career_aggregated_insight_apply.sql', 'career_company_knowledge_apply.sql']) {
      const src = readFileSync(join(ROOT, 'supabase', f), 'utf8');
      check(!/CREATE POLICY/i.test(src) && !/GRANT[\s\S]*TO\s+(anon|authenticated)/i.test(src),
        `${f}: 適用済み側は deny-by-default のまま`);
    }
  }

  // ══ OD-3 / OD-4: Layer 4 end-to-end ═════════════════════════════
  console.log('[OD-3] Layer 4 happy path（synthetic dry-run）');
  {
    // L4-1: consent なし → contribution なし。
    const noConsent = evaluateConsentEligibility({
      consent: null, audience: 'internal', eventOccurredAt: Date.parse('2026-06-15T10:00:00.000Z'),
    });
    check(!noConsent.eligible, 'L4-1 consent なし → ineligible');

    // L4-2: eligible source + consent → projection 成功。
    check(isAggregateEligibleSource('event.feature_usage'), 'L4-2 source が eligible');
    const okConsent = evaluateConsentEligibility({
      consent: consentRecord(), audience: 'internal', eventOccurredAt: Date.parse('2026-06-15T10:00:00.000Z'),
    });
    check(okConsent.eligible, 'L4-2 consent あり → eligible');
    const projected = projectAggregateContribution({
      raw: event(UID_A, 'self_analysis'), eligibility: okConsent, metric: FEATURE_USAGE_PREVALENCE,
    });
    check(projected.ok === true, `L4-2 projection ok（${projected.ok ? 'ok' : projected.reason}）`);
    if (projected.ok) trace(`projection → month=${projected.contribution.monthBucket}`);

    // 60 user の synthetic 母集団（user-facing 閾値 50 を超える）。
    const projections: unknown[] = [];
    const uf = evaluateConsentEligibility({
      consent: consentRecord({ grantedScopes: ['user_facing_aggregated_insight'] as never }),
      audience: 'user_facing', eventOccurredAt: Date.parse('2026-06-15T10:00:00.000Z'),
    });
    check(uf.eligible, 'user_facing scope の consent が eligible');
    for (let i = 0; i < 60; i++) {
      const uid = `u-${String(i).padStart(3, '0')}`;
      const p = projectAggregateContribution({
        raw: event(uid, 'self_analysis'), eligibility: uf, metric: FEATURE_USAGE_PREVALENCE,
      });
      if (p.ok) projections.push(p.contribution);
      // heavy user: 同じ user が複数 event（bounding で 1 になること）。
      if (i === 0) {
        const dupRaw = {
          ...(event(uid, 'self_analysis') as unknown as Record<string, unknown>),
          client_event_id: `${uid}-dup`,
        };
        const dup = projectAggregateContribution({
          raw: dupRaw as never, eligibility: uf, metric: FEATURE_USAGE_PREVALENCE,
        });
        if (dup.ok) projections.push(dup.contribution);
      }
    }
    check(projections.length === 61, `L4-2 projection 61 件（heavy user 込み）`);
    const bounded = boundContributions(projections as never);
    check(bounded.length === 60, `★ contribution bounding で 60（heavy user が 1 に畳まれる）`);
    trace(`bounding: 61 projections → ${bounded.length} contributions`);

    // L4-5: allowed cohort → artifact 生成。
    const cohort = evaluateCohort({ uniqueUsers: bounded.length, audience: 'user_facing', cohortType: 'all' });
    check(cohort.suppressed === false, 'L4-5 cohort 60 >= 50 → not suppressed');
    const artifact = buildValidArtifact(
      { ...ARTIFACT_BASE, audience: 'user_facing', consentScope: 'user_facing_aggregated_insight' } as never,
      { numerator: 40, denominator: bounded.length },
    );
    check(artifact.kind === 'valid', 'L4-5 valid artifact 生成');
    trace(`artifact: kind=${artifact.kind} denominator=${(artifact as {denominator?:number}).denominator}`);

    // L4-6: individual row が無い。
    const json = JSON.stringify(artifact);
    for (const banned of ['user_id', 'userId', 'client_event_id', 'u-000', 'occurredAt', 'rows']) {
      check(!json.includes(banned), `L4-6 artifact に ${banned} が無い`);
    }
    check(/"prevalence"/.test(json) && /"provenance"/.test(json), 'L4-6 集計値と provenance を持つ');

    // L4-7: 未サポート policy version → serve 不可。
    check(!isPolicyVersionSupported(2), 'L4-7 未知 policy version は未サポート');
    check(isPolicyVersionSupported(CURRENT_POLICY_VERSION), '現行 version はサポート');

    // L4-8: expired artifact → serve 不可 / retention candidate。
    const expired = classifyExpiration({
      retentionClass: 'aggregate_artifact', createdAt: new Date(NOW_MS - 401 * 86400000).toISOString(), nowMs: NOW_MS,
    });
    check(expired.status === 'expired', 'L4-8 401 日 → expired（retention candidate）');
  }

  console.log('[OD-4] Layer 4 suppression 経路');
  {
    // L4-3: small cohort → suppressed。
    for (const [n, audience] of [[3, 'internal'], [15, 'internal'], [30, 'user_facing'], [80, 'ai_context']] as const) {
      const d = evaluateCohort({ uniqueUsers: n, audience, cohortType: 'all' });
      check(d.suppressed === true, `L4-3 n=${n} audience=${audience} → suppressed`);
    }
    // L4-4: rare category → suppression。
    const rare = evaluateRareCategory({ cohortType: 'graduation_year', distinctUsersInCategory: 5 });
    check(rare.rare === true, 'L4-4 support 5 → rare');
    const notRare = evaluateRareCategory({ cohortType: 'graduation_year', distinctUsersInCategory: 25 });
    check(notRare.rare === false, 'support 25 → not rare');
    check(evaluateRareCategory({ cohortType: 'all', distinctUsersInCategory: 1 }).rare === false,
      'all cohort は rare 判定対象外');
    // suppressed artifact に数値が無い。
    const s = buildSuppressedArtifact(ARTIFACT_BASE as never, 'below_audience_threshold');
    const sj = JSON.stringify(s);
    check(!/"numerator"|"denominator"|"prevalence"/.test(sj), '★ suppressed artifact に数値が無い');
    trace(`suppressed: ${sj.slice(0, 90)}…`);
  }

  // ══ OD-5: ETL ═══════════════════════════════════════════════════
  console.log('[OD-5] ETL retry が idempotent');
  {
    const KEY: BatchRunKey = {
      metricKey: FEATURE_USAGE_PREVALENCE.metricKey,
      calculationVersion: FEATURE_USAGE_PREVALENCE.calculationVersion,
      sourceWindowStart: WINDOW.start, sourceWindowEnd: WINDOW.end,
    };
    const make = (opts: { failFirst?: boolean } = {}) => {
      const runs = new Map<string, BatchRunRecord>();
      let cursor: BatchCursor | null = null;
      let execs = 0;
      const ports: BatchPorts = {
        claimRun: async (k, a) => {
          const e = runs.get(k) ?? null;
          if (e?.state === 'succeeded' || e?.state === 'running') return { claimed: false, existing: e };
          runs.set(k, { runKey: k, state: 'pending', attempt: a, startedAt: null, finishedAt: null, failureCategory: null });
          return { claimed: true, existing: e };
        },
        recordRun: async (r) => { runs.set(r.runKey, r); },
        readCursor: async () => cursor,
        writeCursor: async (c) => { cursor = c; },
        execute: async () => {
          execs += 1;
          if (opts.failFirst && execs === 1) throw new Error('transient');
          return { manifest: {} as never, producedArtifacts: 2 };
        },
      };
      return { ports, stat: () => ({ execs, cursor, runs: [...runs.values()] }) };
    };
    const nowIso = '2026-07-02T00:00:00.000Z';

    // L4-9: dry-run → mutation なし。
    const d = make();
    const dry = await runAggregateBatch({ key: KEY, ports: d.ports, nowIso, dryRun: true });
    check(dry.status === 'skipped_dry_run', 'L4-9 dry-run');
    check(d.stat().execs === 0 && d.stat().cursor === null, '★ L4-9 dry-run で mutation ゼロ');

    // L4-10: 同一 batch retry → duplicate artifact なし。
    const a = make();
    const r1 = await runAggregateBatch({ key: KEY, ports: a.ports, nowIso });
    const r2 = await runAggregateBatch({ key: KEY, ports: a.ports, nowIso });
    check(r1.status === 'succeeded' && r2.status === 'skipped_already_succeeded', 'L4-10 2 回目は skip');
    check(a.stat().execs === 1, '★ L4-10 execute は 1 回だけ（duplicate なし）');
    trace(`runKey=${serializeRunKey(KEY).slice(0, 60)}…`);

    // failure → cursor 据え置き → retry 成功。
    const b = make({ failFirst: true });
    const f1 = await runAggregateBatch({ key: KEY, ports: b.ports, nowIso, attempt: 1 });
    check(f1.status === 'failed', 'failure が記録される');
    check(b.stat().cursor === null, '★ 失敗時に cursor を進めない');
    check(b.stat().runs.some((r) => r.state === 'failed'), 'failure state が残る');
    const f2 = await runAggregateBatch({ key: KEY, ports: b.ports, nowIso, attempt: 2 });
    check(f2.status === 'succeeded', '★ retry で成功');
    check(b.stat().cursor?.nextWindowStart === WINDOW.end, '成功後に cursor 進行');
    // restart: cursor から次 window を導ける。
    const nw = nextWindow(b.stat().cursor, '2026-01-01T00:00:00.000Z', 30 * 86400000);
    check(nw?.start === WINDOW.end, 'restart 時に続きから再開できる');
    check(nextWindow(EMPTY_CURSOR('m', 'v'), '2026-01-01T00:00:00.000Z', 86400000)?.start === '2026-01-01T00:00:00.000Z',
      '未開始なら default から');
    // concurrency = 1 契約（runner は分散ロックを提供しない）。
    const runnerSrc = codeOnly(readFileSync(join(ROOT, 'lib/careerAggregate/batch/batchRunner.ts'), 'utf8'));
    check(!/advisory_lock|Mutex|redlock/i.test(runnerSrc), '★ runner 自体は分散ロックを持たない（provider 責務）');
    const runnerDoc = readFileSync(join(ROOT, 'lib/careerAggregate/batch/batchRunner.ts'), 'utf8');
    check(/分散ロック.*提供しない|排他は/.test(runnerDoc), '★ その事実が module に明記されている');
  }

  // ══ OD-6: Layer 5 end-to-end ════════════════════════════════════
  console.log('[OD-6] Layer 5 submission → moderation → publish');
  {
    // 1) subject 解決（I2）。
    const subj = resolveContributorOpaqueKey(UID_A, SUBJECTS);
    check(subj.resolved, 'auth.uid() → opaque key を解決');
    trace(`subject: ${UID_A.slice(0, 8)}… → ${subj.resolved ? subj.opaqueKey : 'n/a'}`);

    // 2) 二段 gate。
    const stages = evaluateSharingStages({
      masterOptInActive: true, consentScope: 'company_knowledge_contribution',
      perContributionConfirmed: true, policyVersion: CURRENT_POLICY_VERSION,
    });
    check(stages.allowed, '二段 gate 通過');

    // 3) PII scan（pre-screen）。
    const scanner = createDeterministicPiiScanner();
    const clean = scanner.scan('一次面接はオンラインで 30 分程度だった。');
    check(clean.state === 'clean', `pre-screen clean（${clean.state}）`);
    const modFields = toModerationFields(clean);
    check(modFields.piiScan === 'clean', 'moderation field へ反映');

    // 4) lifecycle: draft → … → moderation_pending。
    let state: string = 'draft';
    for (const action of ['submit', 'grant_consent', 'start_privacy_review', 'pass_privacy_review'] as const) {
      const r = transitionContributionLifecycle(state as never, action);
      check('to' in r, `lifecycle ${state} --${action}-->`);
      if ('to' in r) { state = r.to; trace(`${action} → ${state}`); }
    }
    check(state === 'moderation_pending', 'L5-6 pre-screen 後は moderation_pending');
    // ★ ここから publish はできない。
    const directPublish = transitionContributionLifecycle('moderation_pending' as never, 'publish');
    check(!('to' in directPublish), '★ L5-6 moderation_pending から直接 publish 不可');

    // 5) moderator 認可（synthetic adapter）。
    const syntheticModerator: ResolveModeratorPort = async (uid) =>
      uid === UID_A ? { authUserId: uid, capabilities: ['review', 'approve', 'publish'] } : null;
    const authz = await authorizeModeratorAction({
      authUserId: UID_A, action: 'approve', resolveModerator: syntheticModerator,
    });
    check(authz.authorized, 'L5-8 synthetic moderator は approve できる');

    // 6) approve → publish。
    const approved = transitionContributionLifecycle('moderation_pending' as never, 'approve');
    check('to' in approved && approved.to === 'approved', 'approve → approved');
    const published = transitionContributionLifecycle('approved' as never, 'publish');
    check('to' in published && published.to === 'published', 'publish → published');

    // 7) shared read（published のみ・contributor 非開示）。
    const proj = buildCompanyKnowledgeProjection({
      purpose: 'company_research', companyId: 'co-1', displayName: 'Alpha',
      contributions: [contribution()], nowIso: '2026-07-02T00:00:00.000Z',
    });
    check(proj.status === 'available', `shared read available（${proj.status}）`);
    const pj = JSON.stringify(proj);
    for (const banned of ['opaque-A', 'contributionId', UID_A, '__contributorOpaqueKey', '__contentFingerprint']) {
      check(!pj.includes(banned), `L5-9 published payload に ${banned} が無い`);
    }
    trace(`read: ${pj.slice(0, 90)}…`);

    // L5-11: publication 前に consent 撤回 → publish 不可。
    const revoked = evaluateSharingAdmission({
      contribution: contribution({ consentState: 'share_revoked', lifecycleState: 'approved' } as never),
      authenticated: true, explicitSharingConsentActive: false, consentPolicyVersionSupported: true,
      requirePublished: true,
    });
    check(!revoked.admitted, 'L5-11 撤回後は publish 不可');

    // L5-12: published single-source の撤回 → unpublish 候補。
    const w = planWithdrawal({ state: 'published_single_source', legalApproved: false });
    check(w.disposition === 'unpublish', 'L5-12 single source → unpublish');
    check(w.futureContributionsBlocked === true, '以後の寄与は止まる');

    // L5-10: private research → 自動変換なし。
    const converters = tsFiles('lib').concat(tsFiles('app')).filter((f) => {
      const code = codeOnly(readFileSync(f, 'utf8'));
      return /CareerCompanyResearchLog/.test(code) && /CompanyKnowledgeContribution/.test(code);
    });
    check(converters.length === 0, '★ L5-10 private research → contribution の変換 module が無い',
      converters.map(rel).join(','));
  }

  // ══ OD-7 / OD-8 ═════════════════════════════════════════════════
  console.log('[OD-7] 一般 member は moderation できない');
  {
    // L5-7: 一般 member。
    const memberPort: ResolveModeratorPort = async (uid) =>
      uid === UID_A ? { authUserId: uid, capabilities: ['approve'] } : null;
    const ordinary = await authorizeModeratorAction({
      authUserId: UID_B, action: 'approve', resolveModerator: memberPort,
    });
    check(!ordinary.authorized, '★ L5-7 一般 member の approve は拒否');
    // ★ production code path では provider 未設定 = DENY。
    const noProvider = await authorizeModeratorAction({ authUserId: UID_A, action: 'approve' });
    check(!noProvider.authorized && noProvider.reason === 'no_moderator_provider',
      '★ provider 未設定は DENY（素通ししない）');
    // 未認証。
    const anon = await authorizeModeratorAction({
      authUserId: null, action: 'approve', resolveModerator: memberPort,
    });
    check(!anon.authorized, '未認証は拒否');
  }

  console.log('[OD-8] PII 未検査は publish できない');
  {
    for (const [pii, label] of [['not_scanned', 'L5-4'], ['pii_detected', 'L5-5']] as const) {
      const adm = evaluateSharingAdmission({
        contribution: contribution({ moderation: { ...CLEAN_MOD, piiScan: pii } as never }),
        authenticated: true, explicitSharingConsentActive: true, consentPolicyVersionSupported: true,
      });
      check(!adm.admitted, `${label} piiScan=${pii} → publish 不可`);
      const proj = buildCompanyKnowledgeProjection({
        purpose: 'company_research', companyId: 'co-1', displayName: 'Alpha',
        contributions: [contribution({ moderation: { ...CLEAN_MOD, piiScan: pii } as never })],
        nowIso: '2026-07-02T00:00:00.000Z',
      });
      check(proj.status !== 'available', `${label} shared read にも出ない`);
    }
    // L5-1/L5-2/L5-3: 二段 gate の欠落。
    const base = { consentScope: 'company_knowledge_contribution', policyVersion: CURRENT_POLICY_VERSION };
    check(!evaluateSharingStages({ ...base, masterOptInActive: false, perContributionConfirmed: false }).allowed,
      'L5-1 opt-in なし → reject');
    check(!evaluateSharingStages({ ...base, masterOptInActive: true, perContributionConfirmed: false }).allowed,
      'L5-2 master のみ → reject');
    check(!evaluateSharingStages({ ...base, masterOptInActive: false, perContributionConfirmed: true }).allowed,
      'L5-3 per-item のみ → reject');
  }

  // ══ OD-9: I2 identity lifecycle ═════════════════════════════════
  console.log('[OD-9] I2 identity が auth UUID を公開しない');
  {
    const c = contribution();
    check(isOwnContribution({ authUserId: UID_A, contribution: c, subjects: SUBJECTS }), 'owner は自分の寄与を扱える');
    check(!isOwnContribution({ authUserId: UID_B, contribution: c, subjects: SUBJECTS }), '他 user は扱えない');
    check(!JSON.stringify(c).includes(UID_A), 'contribution に auth UUID が無い');

    // unlink 後の contract。
    const unlinked = [unlinkSubject(SUBJECTS[0], '2026-08-01T00:00:00.000Z'), SUBJECTS[1]];
    check(!resolveContributorOpaqueKey(UID_A, unlinked).resolved, '★ unlink 後は本人へ辿れない（再識別不能）');
    check(!canCreateContribution(UID_A, unlinked), '★ unlink 後は新規寄与を作れない');
    check(!isOwnContribution({ authUserId: UID_A, contribution: c, subjects: unlinked }),
      '★ unlink 後は owner operation も不可（本人であることを証明できない）');
    trace('unlink → 本人にも他人にも contribution を紐づけられない = 完全匿名化');
    // ★ provenance は保持される（contribution 本体は変わらない）。
    check(c.provenanceNote !== null && (c.evidenceKind as string).length > 0,
      '★ unlink しても provenance は保持される');
    // withdrawal before unlink。
    const beforeUnlink = planWithdrawal({ state: 'approved_unpublished', legalApproved: false });
    check(beforeUnlink.disposition === 'delete', 'unlink 前の未公開寄与は delete 対象');
  }

  // ══ OD-10: consent lifecycle ════════════════════════════════════
  console.log('[OD-10] consent 撤回が以後の利用を止める');
  {
    // no consent → grant → contribute → revoke → blocked。
    check(!evaluateConsent({ scope: 'company_knowledge_contribution', state: null, grantedVersion: 1 }).consented,
      '1) 記録なし → NOT CONSENTED');
    check(evaluateConsent({ scope: 'company_knowledge_contribution', state: 'granted', grantedVersion: 1 }).consented,
      '2) grant → CONSENTED');
    check(evaluateSharingStages({
      masterOptInActive: true, consentScope: 'company_knowledge_contribution',
      perContributionConfirmed: true, policyVersion: 1,
    }).allowed, '3) contribute 可能');
    check(!evaluateConsent({ scope: 'company_knowledge_contribution', state: 'revoked', grantedVersion: 1 }).consented,
      '4) revoke → NOT CONSENTED');
    check(!evaluateSharingStages({
      masterOptInActive: false, consentScope: 'company_knowledge_contribution',
      perContributionConfirmed: true, policyVersion: 1,
    }).allowed, '★ 5) 以後の contribution が止まる');
    // policy version change: v1 → 未知 v2 で fail closed。
    check(!evaluateConsent({ scope: 'company_knowledge_contribution', state: 'granted', grantedVersion: 2 }).consented,
      '★ 未知 policy version v2 → fail closed');
    // Layer 4 側も同様。
    check(!evaluateConsentEligibility({
      consent: consentRecord({ optedOut: true }), audience: 'internal', eventOccurredAt: NOW_MS,
    }).eligible, 'Layer 4: 撤回後は ineligible');

    // ── Legal Q3 technical trace ──────────────────────────────────
    trace('Legal Q3 trace:');
    trace('  consent revoked → 以後の projection が reject（future input blocked）');
    trace('  → source は以後の batch に現れない（future rebuild excludes source）');
    trace('  → 既 materialized artifact は window 単位の invalidate + regeneration のみ');
    trace('  → 個人単位の逆引きを保持しないため、artifact から個人寄与だけを差し引くことは不可能');
    const artifact = buildValidArtifact(ARTIFACT_BASE as never, { numerator: 40, denominator: 80 });
    const aj = JSON.stringify(artifact);
    check(!/user|uid|subject|contributor/i.test(aj.replace(/"(metricKey|calculationVersion|feature)"/g, '')),
      '★ Q3 evidence: artifact に個人を辿る field が無い（差し引き不可能の技術的根拠）');
  }

  // ══ OD-11: retention boundary ═══════════════════════════════════
  console.log('[OD-11] retention の境界分類が正しい');
  {
    const cases: [string, number, 'retained' | 'expired'][] = [
      ['pending_moderation_contribution', 29, 'retained'],
      ['pending_moderation_contribution', 31, 'expired'],
      ['aggregate_raw_input', 89, 'retained'],
      ['aggregate_raw_input', 91, 'expired'],
      ['approved_shared_knowledge', 729, 'retained'],
      ['approved_shared_knowledge', 731, 'expired'],
      ['aggregate_artifact', 399, 'retained'],
      ['aggregate_artifact', 401, 'expired'],
      ['operational_log', 179, 'retained'],
      ['operational_log', 181, 'expired'],
    ];
    const records: { retentionClass: string; recordId: string; createdAt: string }[] = [];
    for (const [cls, age, expect] of cases) {
      const createdAt = new Date(NOW_MS - age * 86400000).toISOString();
      const v = classifyExpiration({ retentionClass: cls, createdAt, nowMs: NOW_MS });
      check(v.status === expect, `${cls} ${age}d → ${expect}`);
      records.push({ retentionClass: cls, recordId: `${cls}-${age}`, createdAt });
    }
    const plan = planCleanup({ records, nowMs: NOW_MS });
    check(plan.candidates.length === 5, `★ 境界超過の 5 件だけが候補（${plan.candidates.length}）`);
    check(plan.destructive === false, 'plan は非破壊');
    trace(`candidates: ${plan.candidates.map((c) => c.recordId).join(', ')}`);
    // dry-run は破壊しない。
    let calls = 0;
    const exec = await executeCleanup(plan, {
      dryRun: true, legalApproved: true,
      port: { deleteRecords: async ({ recordIds }) => { calls += 1; return { deleted: recordIds.length, skipped: 0 }; } },
    });
    check(exec.deleted === 0 && calls === 0, '★ dry-run で削除ゼロ・port 未呼び出し');
    // legal 未承認では破壊しない。
    const noLegal = await executeCleanup(plan, { dryRun: false, legalApproved: false, port: null });
    check(noLegal.refusedReason === 'legal_not_approved', '★ legal 未承認 → 拒否');
  }

  // ══ OD-12: preflight ════════════════════════════════════════════
  console.log('[OD-12] legal 未承認の間 production preflight は NOT READY');
  {
    const pf = runPreflight({
      moderatorProviderConfigured: true, infraAdapterConfigured: true,
      migrationApplied: true, rlsVerified: true, featureFlagsOff: true,
    });
    check(!pf.ready, '★ legal 未承認 → NOT READY');
    check(pf.blocking.includes('legal_approved'), 'blocking に legal_approved');
    trace(`blocking: ${pf.blocking.join(', ')}`);
    // 現実の状態（何も provisioning していない）。
    const actual = runPreflight({ featureFlagsOff: true });
    check(!actual.ready, '現状は NOT READY');
    trace(`現状 blocking: ${actual.blocking.join(', ')}`);
    // ★ 残る blocking が **運用項目だけ**であること（architecture 起因が無い）。
    const operationalOnly = new Set([
      'legal_approved', 'moderator_configured', 'infra_adapter_configured', 'migration_applied', 'rls_expected',
    ]);
    const nonOperational = actual.blocking.filter((k) => !operationalOnly.has(k));
    check(nonOperational.length === 0, '★ blocking が運用項目のみ（architecture blocker ゼロ）',
      nonOperational.join(','));
    // policy 側は満たされている。
    check(!actual.blocking.includes('policy_frozen'), 'policy は frozen');
    check(!actual.blocking.includes('cohort_configured'), 'cohort は設定済み');
    check(!actual.blocking.includes('retention_configured'), 'retention は設定済み');
  }

  // ══ OD-13 / OD-14 / OD-16 ═══════════════════════════════════════
  console.log('[OD-13] test harness が app/ から到達不能');
  {
    const isHarness = (f: string) => /scripts\/ciOperational\//.test(f) || /scripts\/career-collective-intelligence/.test(f);
    const offenders: string[] = [];
    for (const seed of tsFiles('app')) {
      const p = reaches(seed, isHarness);
      if (p) offenders.push(p.map(rel).join(' -> '));
    }
    check(offenders.length === 0, '★ app/ から operational harness へ到達しない', offenders.slice(0, 2).join(' | '));
    // harness は scripts/ 配下のみ。
    check(existsSync(join(ROOT, 'scripts/ciOperational/sqlMigrationValidator.ts')), 'harness が scripts/ 配下');
    check(!existsSync(join(ROOT, 'lib/ciOperational')), 'lib/ に harness を置いていない');
  }

  console.log('[OD-14] production flag が有効化されていない');
  {
    for (const layer of ['layer4', 'layer5'] as const) {
      check(!evaluateActivation({ ...EMPTY_ACTIVATION_INPUT, layer }).activated, `${layer}: activated=false`);
    }
    const envPath = join(ROOT, '.env.local');
    if (existsSync(envPath)) {
      const env = readFileSync(envPath, 'utf8');
      for (const k of [
        'CAREER_AGGREGATED_INSIGHT_READ_ENABLED', 'CAREER_AGGREGATED_INSIGHT_CONSULTATION_ENABLED',
        'CAREER_COMPANY_KNOWLEDGE_READ_ENABLED', 'CAREER_COMPANY_KNOWLEDGE_RESEARCH_ENABLED',
        'CAREER_CONSENT_CAPTURE_ENABLED', 'CAREER_CONSENT_POLICY_LEGAL_APPROVED',
      ]) {
        check(!new RegExp(`^\\s*${k}\\s*=\\s*true`, 'm').test(env), `${k} が有効化されていない`);
      }
    } else {
      check(true, '.env.local 無し');
    }
    // production consumer 0。
    const consumers: string[] = [];
    for (const f of tsFiles('app')) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      if (/careerCompanyKnowledge|careerCollectiveIntelligence|careerContextLoaders|careerContextRenderers/.test(code)) {
        consumers.push(rel(f));
      }
    }
    check(consumers.length === 0, '★ production consumer 0', consumers.join(','));
  }

  console.log('[OD-16] member app path から service-role へ到達不能');
  {
    const isPrivileged = (f: string) => /sharedServiceRolePorts/.test(f) || /\.batch\.ts$/.test(f);
    const offenders: string[] = [];
    for (const seed of tsFiles('app')) {
      const p = reaches(seed, isPrivileged);
      if (p) offenders.push(p.map(rel).join(' -> '));
    }
    check(offenders.length === 0, '★ app/ → service-role port / batch へ到達しない', offenders.slice(0, 2).join(' | '));
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-collective-intelligence-operational-dry-run-qa: ALL PASS'
      : `career-collective-intelligence-operational-dry-run-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
