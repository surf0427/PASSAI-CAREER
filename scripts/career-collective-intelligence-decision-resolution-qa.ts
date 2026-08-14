/*
 * scripts/career-collective-intelligence-decision-resolution-qa.ts
 *
 * PASSAI CAREER — Decision Resolution QA（HDR-1 〜 HDR-10）。
 *   dev-only・pure / DI fake・実 Supabase 非接続・実 AI call なし。
 *
 * HDR-1  member-request path から service-role read port へ **到達不能**（推移的 import graph）
 * HDR-2  privileged batch path が member route と分離されている
 * HDR-3  偽造 user ID で他 user の contribution を扱えない
 * HDR-4  identity strategy で owner-scoped RLS が可能（対応表で auth.uid() と照合できる）
 * HDR-5  consent 撤回が future contribution を止める
 * HDR-6  Human policy 値が未設定なら L4 / L5 を serve しない
 * HDR-7  ETL retry が duplicate aggregate を作らない
 * HDR-8  batch failure 後に safe retry できる
 * HDR-9  production consumer が事故で増えていない
 * HDR-10 全 flag OFF → 挙動ゼロ変化
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-collective-intelligence-decision-resolution-qa.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

import {
  CONTRIBUTOR_IDENTITY_STRATEGY,
  canCreateContribution,
  containsIdentityLeak,
  isOwnContribution,
  resolveContributorOpaqueKey,
  unlinkSubject,
  type ContributorSubject,
} from '@/lib/careerCompanyKnowledge/contributorIdentity';
import {
  EMPTY_CURSOR,
  collectRebuildTargets,
  nextWindow,
  runAggregateBatch,
  serializeRunKey,
  type BatchPorts,
  type BatchRunKey,
  type BatchRunRecord,
  type BatchCursor,
} from '@/lib/careerAggregate/batch/batchRunner';
import {
  EMPTY_ACTIVATION_INPUT,
  evaluateActivation,
} from '@/lib/careerDataSpineGate/activation';
import { evaluateRetentionPolicy } from '@/lib/careerAggregate/retention';
import { CONSUMER_CAPABILITIES, isConsumerConnected } from '@/lib/careerAggregate/policy';
import { evaluateSharingAdmission } from '@/lib/careerCompanyKnowledge/sourceClass';
import { computeContributionFingerprint } from '@/lib/careerCompanyKnowledge/contribution';
import type { CompanyKnowledgeContribution } from '@/types/careerCompanyKnowledge';

const ROOT = process.cwd();

const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// ── import graph（推移的到達性を実測する）──────────────────────────
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

/** import specifier をファイルへ解決（`@/` alias と相対のみ。外部 package は無視）。 */
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

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;
function directDeps(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(IMPORT_RE.source, 'g');
  while ((m = re.exec(src))) {
    const r = resolveSpec(file, m[1]);
    if (r) out.push(r);
  }
  return out;
}

/** seed から target 条件に一致するファイルへ到達する経路を返す（無ければ null）。 */
function findReachablePath(seed: string, isTarget: (f: string) => boolean): string[] | null {
  const stack: { f: string; path: string[] }[] = [{ f: seed, path: [seed] }];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop() as { f: string; path: string[] };
    if (seen.has(cur.f)) continue;
    seen.add(cur.f);
    if (cur.f !== seed && isTarget(cur.f)) return cur.path;
    for (const d of directDeps(cur.f)) if (!seen.has(d)) stack.push({ f: d, path: [...cur.path, d] });
  }
  return null;
}

const rel = (f: string) => f.slice(ROOT.length + 1);

// ── fixtures ───────────────────────────────────────────────────────
const CLEAN_MODERATION = {
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
    moderation: { ...CLEAN_MODERATION }, provenanceNote: 'candidate_experience/2026',
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

// ── batch fake ports ───────────────────────────────────────────────
function makePorts(opts: { failFirst?: boolean; produced?: number } = {}) {
  const runs = new Map<string, BatchRunRecord>();
  let cursor: BatchCursor | null = null;
  let executeCalls = 0;
  let writes = 0;
  const ports: BatchPorts = {
    claimRun: async (runKey, attempt) => {
      const existing = runs.get(runKey) ?? null;
      if (existing?.state === 'succeeded') return { claimed: false, existing };
      if (existing?.state === 'running') return { claimed: false, existing };
      runs.set(runKey, {
        runKey, state: 'pending', attempt, startedAt: null, finishedAt: null, failureCategory: null,
      });
      return { claimed: true, existing };
    },
    recordRun: async (record) => { writes += 1; runs.set(record.runKey, record); },
    readCursor: async () => cursor,
    writeCursor: async (c) => { writes += 1; cursor = c; },
    execute: async () => {
      executeCalls += 1;
      if (opts.failFirst && executeCalls === 1) throw new Error('boom');
      return { manifest: {} as never, producedArtifacts: opts.produced ?? 3 };
    },
  };
  return {
    ports,
    stats: () => ({ executeCalls, writes, cursor, runs: [...runs.values()] }),
  };
}

const KEY: BatchRunKey = {
  metricKey: 'feature_usage_prevalence',
  calculationVersion: 'feature_usage_prevalence@1',
  sourceWindowStart: '2026-06-01T00:00:00.000Z',
  sourceWindowEnd: '2026-07-01T00:00:00.000Z',
};

async function main() {
  console.log('=== career-collective-intelligence-decision-resolution-qa ===');

  // ── HDR-1 ───────────────────────────────────────────────────────
  console.log('[HDR-1] member-request path から service-role port へ到達不能');
  {
    const appFiles = tsFiles('app');
    check(appFiles.length > 100, `app/ を走査（${appFiles.length} files）`);
    const isPrivileged = (f: string) => /sharedServiceRolePorts/.test(f);
    const offenders: string[] = [];
    for (const seed of appFiles) {
      const path = findReachablePath(seed, isPrivileged);
      if (path) offenders.push(path.map(rel).join(' -> '));
    }
    check(
      offenders.length === 0,
      '★ app/ 配下のどのファイルからも Data Spine の service-role port へ到達しない',
      offenders.slice(0, 2).join(' | '),
    );
    // 置き換えた member path 自体も privileged を import しない。
    const probe = codeOnly(
      readFileSync(join(ROOT, 'lib/careerAggregate/server/memberGateProbe.server.ts'), 'utf8'),
    );
    check(!/sharedServiceRolePorts|serviceRoleClient/.test(probe), 'member gate probe は privileged を import しない');
    check(!/DataSpineReadPort|readPort|\.select\(/.test(probe), '★ member gate probe は DB read を行わない');
    const dispatcher = codeOnly(readFileSync(join(ROOT, 'lib/careerAggregate/shadowDispatcher.server.ts'), 'utf8'));
    check(/memberGateProbe/.test(dispatcher), 'dispatcher は privilege-free probe を使う');
    check(!/createAggregatedInsightRuntime|PrivilegedShadow/.test(dispatcher), 'dispatcher は privileged composition を import しない');
  }

  // ── HDR-2 ───────────────────────────────────────────────────────
  console.log('[HDR-2] privileged batch path が member route と分離');
  {
    const batchDir = join(ROOT, 'lib/careerAggregate/batch');
    check(existsSync(batchDir), 'batch ディレクトリが存在する');
    const batchFiles = tsFiles('lib/careerAggregate/batch');
    check(batchFiles.length >= 2, `batch module がある（${batchFiles.length}）`);
    // ★ app/ から *.batch.ts へ推移的に到達しない。
    const isBatch = (f: string) => /\.batch\.ts$/.test(f);
    const offenders: string[] = [];
    for (const seed of tsFiles('app')) {
      const path = findReachablePath(seed, isBatch);
      if (path) offenders.push(path.map(rel).join(' -> '));
    }
    check(offenders.length === 0, '★ app/ から *.batch.ts へ到達しない', offenders.slice(0, 2).join(' | '));
    // privileged composition は batch 側に居る。
    const privileged = join(ROOT, 'lib/careerAggregate/batch/aggregatedInsightPrivilegedShadow.batch.ts');
    check(existsSync(privileged), 'privileged composition が batch/ に居る');
    check(
      /getSharedServiceRoleReadPort/.test(readFileSync(privileged, 'utf8')),
      'privileged composition だけが service-role port を持つ',
    );
    // 旧 path は残っていない。
    check(
      !existsSync(join(ROOT, 'lib/careerAggregate/server/createAggregatedInsightRuntime.server.ts')),
      '旧 runtime path が残っていない（移設漏れなし）',
    );
    // batch runner は provider SDK を import しない（provider-neutral）。
    const runner = codeOnly(readFileSync(join(ROOT, 'lib/careerAggregate/batch/batchRunner.ts'), 'utf8'));
    for (const sdk of ['@vercel', 'aws-sdk', '@supabase/supabase-js', 'node-cron', 'bullmq']) {
      check(!runner.includes(sdk), `batch runner が ${sdk} を import しない（provider-neutral）`);
    }
    check(!/process\.env/.test(runner), 'batch runner が env を読まない（pure）');
  }

  // ── HDR-3 ───────────────────────────────────────────────────────
  console.log('[HDR-3] 偽造 user ID で他 user の contribution を扱えない');
  {
    const cA = contribution({ __contributorOpaqueKey: 'opaque-A' } as never);
    check(isOwnContribution({ authUserId: UID_A, contribution: cA, subjects: SUBJECTS }), 'owner 本人は自分の寄与を扱える');
    check(!isOwnContribution({ authUserId: UID_B, contribution: cA, subjects: SUBJECTS }), '★ 別 user は扱えない');
    for (const forged of ['opaque-A', 'not-a-uuid', '', '  ', '00000000-0000-0000-0000-000000000000']) {
      check(
        !isOwnContribution({ authUserId: forged, contribution: cA, subjects: SUBJECTS }),
        `偽造/不正 id「${forged}」では扱えない`,
      );
    }
    check(!isOwnContribution({ authUserId: null, contribution: cA, subjects: SUBJECTS }), 'null は扱えない');
    check(!isOwnContribution({ authUserId: UID_A, contribution: cA, subjects: [] }), '対応表が無ければ扱えない');
    // 静的: Layer 5 / batch module が client 由来 user id を読まない。
    for (const dir of ['lib/careerCompanyKnowledge', 'lib/careerAggregate/batch', 'lib/careerAggregate/server']) {
      for (const f of tsFiles(dir)) {
        const code = codeOnly(readFileSync(f, 'utf8'));
        check(!/body\.userId|b\.userId|req\.userId|query\.userId|params\.userId/.test(code),
          `${rel(f)}: caller-selected user id を読まない`);
      }
    }
  }

  // ── HDR-4 ───────────────────────────────────────────────────────
  console.log('[HDR-4] identity strategy で owner-scoped RLS が可能');
  {
    check(CONTRIBUTOR_IDENTITY_STRATEGY === 'I2_subject_table', '採用戦略が I2（subject table）');
    const r = resolveContributorOpaqueKey(UID_A, SUBJECTS);
    check(r.resolved && r.opaqueKey === 'opaque-A', 'auth.uid() から opaque key を解決できる（RLS 可能）');
    check(!resolveContributorOpaqueKey('bad', SUBJECTS).resolved, '不正 uid は解決不可');
    check(!resolveContributorOpaqueKey(UID_A, []).resolved, '対応表なしは解決不可');
    // ★ contribution 本体には identity が入らない。
    check(!containsIdentityLeak(contribution()), 'contribution に identity leak が無い');
    check(containsIdentityLeak({ x: { authUserId: UID_A } }), 'identity leak 検出器が機能する');
    // 型に auth user id が無いこと（静的）。
    const t = codeOnly(readFileSync(join(ROOT, 'types/careerCompanyKnowledge.ts'), 'utf8'));
    for (const banned of ['authUserId', 'auth_user_id']) {
      check(!t.includes(banned), `contribution 型に ${banned} が無い`);
    }
    // ★ unlink で再識別不能にできる（強い削除手段）。
    const unlinked = unlinkSubject(SUBJECTS[0], '2026-08-01T00:00:00.000Z');
    check(!resolveContributorOpaqueKey(UID_A, [unlinked, SUBJECTS[1]]).resolved,
      '★ unlink 後は本人へ辿れない（再識別不能）');
  }

  // ── HDR-5 ───────────────────────────────────────────────────────
  console.log('[HDR-5] consent 撤回が future contribution を止める');
  {
    check(canCreateContribution(UID_A, SUBJECTS), '有効な subject なら寄与を作れる');
    const unlinked = unlinkSubject(SUBJECTS[0], '2026-08-01T00:00:00.000Z');
    check(!canCreateContribution(UID_A, [unlinked, SUBJECTS[1]]), '★ unlink 後は新規寄与を作れない');
    check(!canCreateContribution(UID_A, []), '対応表が無ければ作れない');
    // consent state 側でも止まる。
    const revoked = evaluateSharingAdmission({
      contribution: contribution({ consentState: 'share_revoked' } as never),
      authenticated: true, explicitSharingConsentActive: true, consentPolicyVersionSupported: true,
    });
    check(!revoked.admitted, 'share_revoked → admission 不可');
    const ledgerOff = evaluateSharingAdmission({
      contribution: contribution(),
      authenticated: true, explicitSharingConsentActive: false, consentPolicyVersionSupported: true,
    });
    check(!ledgerOff.admitted, 'consent ledger 無効 → admission 不可');
  }

  // ── HDR-6 ───────────────────────────────────────────────────────
  console.log('[HDR-6] Human policy 値が未設定なら serve しない');
  {
    for (const layer of ['layer4', 'layer5'] as const) {
      const d = evaluateActivation({ ...EMPTY_ACTIVATION_INPUT, layer });
      check(!d.activated, `${layer}: 既定で activated=false`);
    }
    // cohort threshold / retention だけが未設定でも Layer 4 は serve しない。
    const almost = evaluateActivation({
      ...EMPTY_ACTIVATION_INPUT, layer: 'layer4',
      flagEnabled: true, userIsCanary: true, infrastructureReady: true,
      consentReady: true, legalApproved: true,
      retentionConfig: { retentionDays: 90, policyVersion: 'v1', legalApproved: true },
      cohortThresholdConfigured: false,
    });
    check(!almost.activated, '★ cohort threshold 未確定なら serve しない');
    check(!almost.activated && almost.blockers.includes('cohort_threshold_not_configured'), 'blocker が正しい');
    check(evaluateRetentionPolicy(null).status === 'NOT_CONFIGURED', 'retention 未設定 → NOT_CONFIGURED');
  }

  // ── HDR-7 ───────────────────────────────────────────────────────
  console.log('[HDR-7] ETL retry が duplicate aggregate を作らない');
  {
    const { ports, stats } = makePorts({ produced: 3 });
    const nowIso = '2026-07-02T00:00:00.000Z';
    const first = await runAggregateBatch({ key: KEY, ports, nowIso });
    check(first.status === 'succeeded', `1 回目は成功（${first.status}）`);
    const second = await runAggregateBatch({ key: KEY, ports, nowIso });
    check(second.status === 'skipped_already_succeeded', '★ 同じ runKey の再実行は skip される');
    check(stats().executeCalls === 1, '★ execute が 2 回呼ばれない（duplicate aggregate なし）');
    // runKey は決定論的で、window/version が違えば別 key。
    check(serializeRunKey(KEY) === serializeRunKey({ ...KEY }), 'runKey は決定論的');
    check(serializeRunKey(KEY) !== serializeRunKey({ ...KEY, calculationVersion: 'v2' }), 'version 差は別 key');
    check(
      serializeRunKey(KEY) !== serializeRunKey({ ...KEY, sourceWindowStart: '2026-05-01T00:00:00.000Z' }),
      'window 差は別 key',
    );
    // dry-run は書き込みゼロ。
    const { ports: p2, stats: s2 } = makePorts();
    const dry = await runAggregateBatch({ key: KEY, ports: p2, nowIso, dryRun: true });
    check(dry.status === 'skipped_dry_run', 'dry-run は実行しない');
    check(s2().executeCalls === 0 && s2().writes === 0, '★ dry-run は書き込みゼロ');
  }

  // ── HDR-8 ───────────────────────────────────────────────────────
  console.log('[HDR-8] batch failure 後に safe retry できる');
  {
    const { ports, stats } = makePorts({ failFirst: true, produced: 2 });
    const nowIso = '2026-07-02T00:00:00.000Z';
    const first = await runAggregateBatch({ key: KEY, ports, nowIso, attempt: 1 });
    check(first.status === 'failed', `1 回目は失敗（${first.status}）`);
    check(stats().cursor === null, '★ 失敗時に cursor を進めない（同じ window を再試行できる）');
    const failedRun = stats().runs.find((r) => r.state === 'failed');
    check(!!failedRun, '★ 失敗が state として残る（握り潰さない）');
    check(failedRun?.failureCategory !== null, '失敗理由が enum で残る');
    const retry = await runAggregateBatch({ key: KEY, ports, nowIso, attempt: 2 });
    check(retry.status === 'succeeded', '★ retry で成功できる');
    check(retry.status === 'succeeded' && retry.attempt === 2, 'attempt が記録される');
    check(stats().cursor?.nextWindowStart === KEY.sourceWindowEnd, '成功後に cursor が進む');
    // cursor から次 window を導ける。
    const w = nextWindow(stats().cursor, '2026-01-01T00:00:00.000Z', 30 * 24 * 3600 * 1000);
    check(w !== null && w.start === KEY.sourceWindowEnd, 'cursor から次 window を再開できる');
    check(nextWindow(EMPTY_CURSOR('m', 'v'), '2026-01-01T00:00:00.000Z', 1000)?.start === '2026-01-01T00:00:00.000Z',
      '未開始なら default から開始');
    check(nextWindow(null, 'invalid', 1000) === null, '不正入力は null（fail-closed）');
    // rebuild target は port が無ければ空（通常実行へ）。
    check((await collectRebuildTargets(ports)).length === 0, 'rebuild port 未実装なら空配列');
  }

  // ── HDR-9 ───────────────────────────────────────────────────────
  console.log('[HDR-9] production consumer が事故で増えていない');
  {
    for (const cap of CONSUMER_CAPABILITIES) {
      check(!isConsumerConnected(cap.consumer), `consumer ${cap.consumer}: not_connected`);
    }
    // app/ から Layer 5 / context loaders / renderers へ到達しない。
    const forbidden = (f: string) =>
      /lib\/careerCompanyKnowledge\//.test(f) ||
      /lib\/careerContextLoaders\//.test(f) ||
      /lib\/careerContextRenderers\//.test(f);
    const offenders: string[] = [];
    for (const seed of tsFiles('app')) {
      const path = findReachablePath(seed, forbidden);
      if (path) offenders.push(path.map(rel).join(' -> '));
    }
    check(offenders.length === 0, '★ app/ から Layer 5 / loader / renderer へ到達しない',
      offenders.slice(0, 2).join(' | '));
  }

  // ── HDR-10 ──────────────────────────────────────────────────────
  console.log('[HDR-10] 全 flag OFF → 挙動ゼロ変化');
  {
    // dispatcher は flag OFF なら probe へ入る前に return。
    const dispatcher = codeOnly(readFileSync(join(ROOT, 'lib/careerAggregate/shadowDispatcher.server.ts'), 'utf8'));
    check(
      /if \(!isAggregatedInsightReadEnabled\(\) \|\| !isAggregatedInsightConsultationEnabled\(\)\) return;/.test(dispatcher),
      '★ flag OFF なら probe すら実行しない（I/O ゼロ）',
    );
    check(/void |fire-and-forget|never-throw/.test(readFileSync(join(ROOT, 'app/api/career/consultation/route.ts'), 'utf8')),
      'route は fire-and-forget で呼ぶ（本処理に影響しない）');
    // probe の戻り値は prompt / response に触れない型（contract を型で持つ）。
    const probeSrc = readFileSync(join(ROOT, 'lib/careerAggregate/server/memberGateProbe.server.ts'), 'utf8');
    check(/performedRead: false/.test(probeSrc) && /privilegedAccess: false/.test(probeSrc),
      'probe の契約が型で固定されている');
    // flags は === 'true' でのみ ON。
    const flags = codeOnly(readFileSync(join(ROOT, 'lib/careerDataSpineGate/flags.server.ts'), 'utf8'));
    for (const fn of flags.match(/export function is\w+Enabled\(\)[\s\S]*?\n}/g) ?? []) {
      check(/=== 'true'/.test(fn), 'enable flag は === \'true\' のみ');
    }
    // .env.local に Layer 4/5 flag が入っていない（誤設定検出）。
    const envPath = join(ROOT, '.env.local');
    if (existsSync(envPath)) {
      const env = readFileSync(envPath, 'utf8');
      for (const k of [
        'CAREER_AGGREGATED_INSIGHT_READ_ENABLED',
        'CAREER_AGGREGATED_INSIGHT_CONSULTATION_ENABLED',
        'CAREER_COMPANY_KNOWLEDGE_READ_ENABLED',
        'CAREER_COMPANY_KNOWLEDGE_RESEARCH_ENABLED',
      ]) {
        check(!new RegExp(`^\\s*${k}\\s*=\\s*true`, 'm').test(env), `${k} が有効化されていない`);
      }
    } else {
      check(true, '.env.local 無し（flag 未設定）');
    }
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-collective-intelligence-decision-resolution-qa: ALL PASS'
      : `career-collective-intelligence-decision-resolution-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
