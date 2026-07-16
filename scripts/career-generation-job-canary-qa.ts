/*
 * scripts/career-generation-job-canary-qa.ts
 *
 * PASSAI CAREER — Gate B 準備: 自己分析 job pilot の **fail-closed canary targeting** の
 *   決定論 QA。外部 Claude API・本番 DB・secret・実 user UUID 非使用（合成 UUID のみ）。
 *
 * 何を守るか（fail-closed 要件）:
 *   - flag unset/false → 誰も job 経路に入れない。
 *   - flag true + allowlist 未設定/空/whitespace/malformed/wildcard → 誰も job 経路に入れない。
 *   - flag true + valid non-empty allowlist → 掲載 UUID に exact 一致した member のみ。
 *   - guest（非 UUID / 空 userId）→ 決して member job 経路に入れない。
 *   - env 値は戻り値・log へ露出しない（pure evaluator は boolean のみ返す）。
 *
 * 加えて service routing（handleSelfAnalysisJobPost）に **実 pure evaluator を DI** し、
 *   非対象（guest / 非掲載 member / 空 allowlist member）が legacy、掲載 member が 202 に
 *   なる配線契約を検証する。
 *
 * 使い方: npx tsx scripts/career-generation-job-canary-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isPilotEnabledForUser,
  parsePilotAllowlist,
} from '../lib/careerGenerationJob/pilotTargeting';
import {
  handleSelfAnalysisJobPost,
  type AuthResolution,
  type JobPostDeps,
} from '../lib/careerSelfAnalysis/summaryJobService';
import type { SelfAnalysisSummaryInput } from '../lib/careerSelfAnalysis/summaryPrompt';
import type { GenerationJobClaimResult } from '../lib/careerGenerationJob/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 合成 UUID（実ユーザーではない）。case 照合の確認用に大文字版も用意。
const CANARY = '11111111-1111-4111-8111-111111111111';
const CANARY_UPPER = CANARY.toUpperCase();
const OTHER = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';

function pilot(
  flagEnabled: boolean,
  rawAllowlist: string | null | undefined,
  userId: string | null | undefined,
): boolean {
  return isPilotEnabledForUser({ flagEnabled, rawAllowlist, userId });
}

function validInput(): SelfAnalysisSummaryInput {
  return {
    profile: { name: 'テスト' } as SelfAnalysisSummaryInput['profile'],
    activity: { items: [{ id: '1' }] } as SelfAnalysisSummaryInput['activity'],
    values: null,
    userInput: '',
    conversation: [],
    pastSummaries: [],
  };
}

const CLAIM_NEW: GenerationJobClaimResult = {
  outcome: 'CLAIMED_NEW',
  jobId: 'job-1',
  attemptToken: 'tok-1',
  status: 'running',
  attemptCount: 1,
};

// route.ts と同じ「flag true + env 由来 allowlist」を実 pure evaluator で束縛した deps を組む。
function depsFor(auth: AuthResolution, rawAllowlist: string | null | undefined) {
  let legacy = false;
  let scheduled = false;
  const deps: JobPostDeps = {
    isPilotEnabledGlobally: () => true, // flag ON deployment を模す
    isPilotEnabledForUser: (userId) => isPilotEnabledForUser({ flagEnabled: true, rawAllowlist, userId }),
    resolveAuth: async () => auth,
    getAdmin: () => ({ kind: 'ok', admin: {} }),
    buildIdentity: () => ({
      idempotencyKey: 'k',
      inputRevision: 'r',
      promptRevision: 'p',
      outputSchemaRevision: 's',
      model: 'm',
    }),
    claimJob: async () => CLAIM_NEW,
    readJob: async () => null,
    schedule: () => {
      scheduled = true;
    },
    runAttempt: async () => {},
    legacy: async () => {
      legacy = true;
      return Response.json({ result: {} }, { status: 200 });
    },
    allowDevUndefinedTableFallback: () => false,
  };
  return { deps, legacyCalled: () => legacy, scheduled: () => scheduled };
}

async function main(): Promise<void> {
  // ════════════════════════════════════════════════════════════════
  console.log('[1] flag OFF → 誰も対象外');
  check('flag false + 有効 allowlist + 掲載 user → false', pilot(false, CANARY, CANARY) === false);
  check('flag false + allowlist 空 → false', pilot(false, '', CANARY) === false);
  check('flag false + allowlist undefined → false', pilot(false, undefined, CANARY) === false);

  // ════════════════════════════════════════════════════════════════
  console.log('[2] flag ON + 空/未設定/malformed/wildcard allowlist → 誰も対象外（fail-closed）');
  check('allowlist undefined → false', pilot(true, undefined, CANARY) === false);
  check('allowlist null → false', pilot(true, null, CANARY) === false);
  check('allowlist "" → false', pilot(true, '', CANARY) === false);
  check('allowlist 空白のみ → false', pilot(true, '   ', CANARY) === false);
  check('allowlist カンマのみ ",," → false', pilot(true, ',,', CANARY) === false);
  check('allowlist wildcard "*" → false', pilot(true, '*', CANARY) === false);
  check('allowlist "all" → false', pilot(true, 'all', CANARY) === false);
  check('allowlist "ALL" → false', pilot(true, 'ALL', CANARY) === false);
  check('allowlist malformed（非 UUID）→ false', pilot(true, 'not-a-uuid', CANARY) === false);
  check('allowlist 部分 UUID → false', pilot(true, '1111', CANARY) === false);
  check('valid+malformed 混在 → 全体 deny（掲載 valid も false）', pilot(true, `${CANARY},bogus`, CANARY) === false);
  check('valid+wildcard 混在 → 全体 deny', pilot(true, `${CANARY},*`, CANARY) === false);

  // ════════════════════════════════════════════════════════════════
  console.log('[3] flag ON + valid non-empty allowlist → 掲載 UUID exact 一致のみ');
  check('掲載 user → true', pilot(true, CANARY, CANARY) === true);
  check('非掲載 user → false', pilot(true, CANARY, OTHER) === false);
  check('複数掲載のうち一致 → true', pilot(true, `${OTHER},${CANARY}`, CANARY) === true);
  check('複数掲載のいずれにも非一致 → false', pilot(true, `${OTHER},${CANARY}`, THIRD) === false);
  check('allowlist 要素の前後空白は trim → true', pilot(true, `  ${CANARY}  `, CANARY) === true);
  check('allowlist 大文字 / user 小文字 → true（case 非破壊照合）', pilot(true, CANARY_UPPER, CANARY) === true);
  check('substring は一致しない', pilot(true, CANARY, CANARY.slice(0, 30)) === false);

  // ════════════════════════════════════════════════════════════════
  console.log('[4] guest / 不正 userId → 決して対象にならない');
  check('userId "" → false', pilot(true, CANARY, '') === false);
  check('userId null → false', pilot(true, CANARY, null) === false);
  check('userId undefined → false', pilot(true, CANARY, undefined) === false);
  check('userId 非 UUID（guest 相当）→ false', pilot(true, CANARY, 'anonymous') === false);

  // ════════════════════════════════════════════════════════════════
  console.log('[5] parsePilotAllowlist の理由コード');
  {
    const e = parsePilotAllowlist('');
    check('"" → empty', e.ok === false && e.reason === 'empty');
    const u = parsePilotAllowlist(undefined);
    check('undefined → empty', u.ok === false && u.reason === 'empty');
    const w = parsePilotAllowlist('*');
    check('"*" → wildcard_rejected', w.ok === false && w.reason === 'wildcard_rejected');
    const m = parsePilotAllowlist('nope');
    check('malformed → malformed', m.ok === false && m.reason === 'malformed');
    const ok = parsePilotAllowlist(CANARY);
    check('valid → ok + 正規化 lowercase set', ok.ok === true && ok.ids.has(CANARY));
  }

  // ════════════════════════════════════════════════════════════════
  console.log('[6] service routing 配線（実 pure evaluator を DI）');
  {
    // guest → legacy（job table 未使用・schedule なし）。
    const g = depsFor({ kind: 'anonymous' }, CANARY);
    const gRes = await handleSelfAnalysisJobPost(g.deps, validInput());
    check('guest → legacy 呼出', g.legacyCalled() === true);
    check('guest → schedule なし', g.scheduled() === false);
    check('guest → 200', gRes.status === 200);

    // 空 allowlist の member → legacy（fail-closed。job 経路に入れない）。
    const em = depsFor({ kind: 'member', userId: CANARY }, '');
    const emRes = await handleSelfAnalysisJobPost(em.deps, validInput());
    check('空 allowlist member → legacy 呼出（fail-closed）', em.legacyCalled() === true);
    check('空 allowlist member → schedule なし', em.scheduled() === false);
    check('空 allowlist member → 200（202 でない）', emRes.status === 200);

    // valid allowlist + 非掲載 member → legacy。
    const nm = depsFor({ kind: 'member', userId: OTHER }, CANARY);
    const nmRes = await handleSelfAnalysisJobPost(nm.deps, validInput());
    check('非掲載 member → legacy 呼出', nm.legacyCalled() === true);
    check('非掲載 member → schedule なし', nm.scheduled() === false);
    check('非掲載 member → 200', nmRes.status === 200);

    // valid allowlist + 掲載 member → job 経路（202 running・schedule 済み・legacy 未使用）。
    const cm = depsFor({ kind: 'member', userId: CANARY }, CANARY);
    const cmRes = await handleSelfAnalysisJobPost(cm.deps, validInput());
    check('掲載 member → 202', cmRes.status === 202);
    check('掲載 member → schedule 済み（after 登録）', cm.scheduled() === true);
    check('掲載 member → legacy 未使用', cm.legacyCalled() === false);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('[7] flag.server.ts / route.ts の静的契約（unsafe 経路が消えている）');
  {
    const flagSrc = readFileSync(join(process.cwd(), 'lib', 'careerGenerationJob', 'flag.server.ts'), 'utf8');
    check('default OFF（=== \'true\' のみ ON）', /=== 'true'/.test(flagSrc));
    check('pure evaluator へ委譲', /from '\.\/pilotTargeting'/.test(flagSrc) && /isPilotEnabledForUser\(/.test(flagSrc));
    check('unsafe「空 allowlist → return true」が存在しない', !/allow\.length === 0[\s\S]*return true/.test(flagSrc));
    check('生 allowlist を返す helper が存在しない', !/selfAnalysisJobCanaryAllowlist/.test(flagSrc));

    const targetingSrc = readFileSync(join(process.cwd(), 'lib', 'careerGenerationJob', 'pilotTargeting.ts'), 'utf8');
    check('pilotTargeting は server-only を持たない（QA import 可）', !/server-only/.test(targetingSrc));
    check('wildcard/all を拒否', /wildcard_rejected/.test(targetingSrc));
  }
}

main()
  .then(() => {
    console.log('');
    if (failures === 0) {
      console.log('career-generation-job-canary-qa: ALL PASS');
      process.exit(0);
    } else {
      console.error(`career-generation-job-canary-qa: ${failures} FAIL`);
      process.exit(1);
    }
  })
  .catch((e) => {
    console.error('career-generation-job-canary-qa: THREW', e);
    process.exit(1);
  });
