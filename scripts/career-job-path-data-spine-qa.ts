/*
 * scripts/career-job-path-data-spine-qa.ts
 *
 * PASSAI CAREER — Job Path × Data Spine 互換 QA（Gate B 前提 / dev-only・実 DB/API 非接続）。
 *
 * 何を守るか（canary 前に必ず固定したい安全性質）:
 *   自己分析 route は POST の先頭で Data Spine の server context を解決し、その結果が
 *   **job identity（idempotency key）と provider 入力の両方**に流れる。
 *   したがって Source Read の結果が揺れると、同一 request が別 job として二重生成されうる。
 *
 *   ★ 本 QA が固定する不変条件:
 *     「Source Read が成功しても、soft timeout / 失敗で bridge へ倒れても、
 *       同じ入力に対する job identity は同一である」
 *
 *   これが崩れると canary で重複 job・重複 Claude 課金・重複保存が起きうる。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-job-path-data-spine-qa.ts
 * 終了コード: 全 PASS → 0 / 1 件でも FAIL → 1。
 */

import { readFileSync } from 'node:fs';

import {
  resolveSelfAnalysisContextInputs,
  SELF_ANALYSIS_SOURCE_KINDS,
} from '@/app/api/career/self-analysis/resolveContextInputs';
import { buildSelfAnalysisIdentity } from '@/lib/careerGenerationJob/idempotency';
import {
  SELF_ANALYSIS_FEATURE,
  SELF_ANALYSIS_MODEL,
  SELF_ANALYSIS_PROMPT_REVISION,
  SELF_ANALYSIS_OUTPUT_SCHEMA_REVISION,
  SELF_ANALYSIS_SUMMARY_OPERATION,
} from '@/lib/careerGenerationJob/constants';
import { EMPTY_CAREER_SOURCE_BUNDLE } from '@/lib/careerSourceData/types';
import type { CareerSourceKind } from '@/lib/careerSourceData/types';

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const USER_ID = '11111111-2222-3333-4444-555555555555';

// 1 request 分の client 申告入力（bridge 入力）。
const BODY = {
  profile: { name: 'テスト', university: 'A大学' },
  activity: { items: [{ title: 'サークル', detail: '運営' }] },
  values: { axes: ['成長', '裁量'] },
  pastSummaries: [],
} as unknown as Parameters<typeof resolveSelfAnalysisContextInputs>[1];
const CONVERSATION = [
  { role: 'question' as const, content: 'なぜそれを選んだ？' },
  { role: 'answer' as const, content: '裁量が大きかったから。' },
];

function identityOf(ctx: {
  profile: unknown;
  activity: unknown;
  values: unknown;
}): string {
  return buildSelfAnalysisIdentity({
    userId: USER_ID,
    feature: SELF_ANALYSIS_FEATURE,
    operation: SELF_ANALYSIS_SUMMARY_OPERATION,
    profile: ctx.profile as never,
    activity: ctx.activity as never,
    values: ctx.values as never,
    conversation: CONVERSATION,
    promptRevision: SELF_ANALYSIS_PROMPT_REVISION,
    outputSchemaRevision: SELF_ANALYSIS_OUTPUT_SCHEMA_REVISION,
    model: SELF_ANALYSIS_MODEL,
  }).idempotencyKey;
}

const ORIGIN_ALL = (o: 'server' | 'bridge') =>
  Object.fromEntries(
    (
      [
        'profile', 'activity', 'values', 'self_analysis', 'es', 'interview',
        'matching', 'company_research', 'presentation', 'consultation', 'gd_room',
      ] as CareerSourceKind[]
    ).map((k) => [k, o]),
  ) as Readonly<Record<CareerSourceKind, 'server' | 'bridge'>>;

async function main(): Promise<void> {
  console.log('\n[1] Source Read 成功（verified server source）');
  // server が client と同一内容を返す（verified ⟹ 内容一致という設計前提の再現）。
  const okCtx = await resolveSelfAnalysisContextInputs('self_analysis', BODY, undefined, async () => ({
    base: { profile: BODY.profile as never, activity: BODY.activity as never, values: BODY.values as never },
    baseReason: 'server_source',
    sources: { ...EMPTY_CAREER_SOURCE_BUNDLE },
    origin: ORIGIN_ALL('server'),
    status: 'ok',
    verdicts: {},
  }) as never);
  check('1 server source が採用される', okCtx.origins.base === 'server');
  check('1 source reason は server_source', okCtx.source === 'server_source');

  console.log('\n[2] Source Read が soft timeout / 失敗（loadContext が throw）');
  const timeoutCtx = await resolveSelfAnalysisContextInputs('self_analysis', BODY, undefined, async () => {
    throw new Error('source read soft timeout');
  });
  check('2 never-throw で必ず inputs を返す（job 生成は続行できる）', !!timeoutCtx);
  check('2 bridge へ倒れる', timeoutCtx.origins.base === 'bridge');
  check('2 reason は source_unavailable', timeoutCtx.source === 'source_unavailable');
  check(
    '2 bridge 値は request body と一致（context を減らさない）',
    JSON.stringify(timeoutCtx.profile) === JSON.stringify(BODY.profile) &&
      JSON.stringify(timeoutCtx.activity) === JSON.stringify(BODY.activity) &&
      JSON.stringify(timeoutCtx.values) === JSON.stringify(BODY.values),
  );

  console.log('\n[3] flag off / 非 canary（base=null）');
  const offCtx = await resolveSelfAnalysisContextInputs('self_analysis', BODY, undefined, async () => ({
    base: null,
    baseReason: 'flag_off',
    sources: { ...EMPTY_CAREER_SOURCE_BUNDLE },
    origin: ORIGIN_ALL('bridge'),
    status: 'ok',
    verdicts: {},
  }) as never);
  check('3 base=null は bridge', offCtx.origins.base === 'bridge');

  console.log('\n[4] ★ job identity が Source Read の結果に依らず同一');
  const idOk = identityOf(okCtx);
  const idTimeout = identityOf(timeoutCtx);
  const idOff = identityOf(offCtx);
  check('4 verified server と soft timeout で idempotency key が同一', idOk === idTimeout,
    `${idOk.slice(0, 12)} vs ${idTimeout.slice(0, 12)}`);
  check('4 verified server と flag_off で idempotency key が同一', idOk === idOff,
    `${idOk.slice(0, 12)} vs ${idOff.slice(0, 12)}`);
  check('4 identity は非空の hash', idOk.length >= 32);

  console.log('\n[5] pastSummaries の採用元は identity を変えない');
  // server 側 log から作った pastSummaries が bridge と異なっても identity は不変であること
  //   （identity は profile/activity/values/conversation のみを反映する設計）。
  const withPast = await resolveSelfAnalysisContextInputs(
    'self_analysis',
    { ...BODY, pastSummaries: [] },
    undefined,
    async () => ({
      base: { profile: BODY.profile as never, activity: BODY.activity as never, values: BODY.values as never },
      baseReason: 'server_source',
      sources: {
        ...EMPTY_CAREER_SOURCE_BUNDLE,
        selfAnalysisLogs: [
          { id: 'l1', createdAt: '2026-01-01T00:00:00.000Z', result: { summary: 'x' } },
        ] as never,
      },
      origin: ORIGIN_ALL('server'),
      status: 'ok',
      verdicts: {},
    }) as never,
  );
  check('5 pastSummaries が変わっても identity は同一', identityOf(withPast) === idOk);

  console.log('\n[6] SOURCE_KINDS 契約（base 3 kind + self_analysis を 1 read で解決）');
  check(
    '6 base 3 kind を含む',
    (['profile', 'activity', 'values'] as CareerSourceKind[]).every((k) =>
      SELF_ANALYSIS_SOURCE_KINDS.includes(k),
    ),
  );
  check('6 self_analysis log を含む', SELF_ANALYSIS_SOURCE_KINDS.includes('self_analysis'));

  console.log('\n[7] claim 観測ログの redaction（Gate B B-15 allowlist）');
  {
    const route = readFileSync('app/api/career/self-analysis/route.ts', 'utf8');
    const fn = route.slice(route.indexOf('function logClaim('), route.indexOf('function logAttempt('));
    check('7 route が logClaim を service へ配線している', /\n\s+logClaim,/.test(route));
    check('7 固定 event 名を使う', /\[career\/self-analysis\/job\]/.test(fn));
    check(
      '7 allowlist 外の項目を出さない（userId / identity / 本文 / prompt / result）',
      !/userId|idempotencyKey|inputRevision|input\b|prompt|result|profile|activity|values|conversation|email|token/.test(
        fn.replace(/\/\/.*$/gm, ''),
      ),
    );
    // service 側は hook 未指定なら無出力（既存 caller / QA を壊さない optional 契約）。
    const svc = readFileSync('lib/careerSelfAnalysis/summaryJobService.ts', 'utf8');
    check('7 logClaim は optional（既存 deps を壊さない）', /logClaim\?:/.test(svc));
    check('7 service は optional chaining で呼ぶ', /deps\.logClaim\?\.\(/.test(svc));
  }
}

function finish(): void {
  console.log(`\n結果: PASS ${passes} / FAIL ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().then(finish);
