/*
 * scripts/career-generation-job-core-qa.ts
 *
 * PASSAI CAREER — career generation job core（idempotency / constants / error 分類 /
 *   repository fencing source 契約）の決定論 QA。STEP-CAREER-GENJOB-01。
 *
 * 外部 Claude API / Supabase / 実データ / secret 非使用。純粋関数と source 文字列のみ検査。
 *
 * 使い方: npx tsx scripts/career-generation-job-core-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ALL_ERROR_CODES,
  FINALIZATION_RESERVE_MS,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  NONRETRYABLE_ERROR_CODES,
  PREPARATION_BUDGET_MS,
  PROVIDER_DEADLINE_MS,
  RETRYABLE_ERROR_CODES,
  ROUTE_MAX_DURATION_SECONDS,
  SELF_ANALYSIS_MODEL,
  SELF_ANALYSIS_OUTPUT_SCHEMA_REVISION,
  SELF_ANALYSIS_PROMPT_REVISION,
  isRetryableErrorCode,
} from '../lib/careerGenerationJob/constants';
import {
  buildSelfAnalysisIdentity,
  stableStringify,
  type SelfAnalysisIdempotencyInput,
} from '../lib/careerGenerationJob/idempotency';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function baseInput(): SelfAnalysisIdempotencyInput {
  return {
    userId: 'user-abc',
    feature: 'self_analysis',
    operation: 'summary',
    profile: { name: 'x', grade: 'B3', tags: ['a', 'b'] },
    activity: { items: [{ id: '1', title: 't' }] },
    values: { axis: ['安定', '成長'] },
    conversation: [
      { role: 'question', content: 'Q1' },
      { role: 'answer', content: 'A1' },
    ],
    promptRevision: SELF_ANALYSIS_PROMPT_REVISION,
    outputSchemaRevision: SELF_ANALYSIS_OUTPUT_SCHEMA_REVISION,
    model: SELF_ANALYSIS_MODEL,
  };
}

// ── 1. constants invariants ─────────────────────────────────────────
console.log('[1] constants invariants');
{
  check('MAX_ATTEMPTS = 3（初回含む）', MAX_ATTEMPTS === 3);
  check('provider deadline + prep + reserve <= route max',
    PROVIDER_DEADLINE_MS + PREPARATION_BUDGET_MS + FINALIZATION_RESERVE_MS <= ROUTE_MAX_DURATION_SECONDS * 1000,
    `${PROVIDER_DEADLINE_MS}+${PREPARATION_BUDGET_MS}+${FINALIZATION_RESERVE_MS} vs ${ROUTE_MAX_DURATION_SECONDS * 1000}`);
  // 定数は literal 型なので number へ広げて比較（TS の literal 比較警告回避）。
  const leaseSec: number = LEASE_SECONDS;
  const routeMaxSec: number = ROUTE_MAX_DURATION_SECONDS;
  check('lease > route max（境界 reclaim 競合回避）', leaseSec > routeMaxSec);
  check('stale threshold(=lease) != route max（要件: 同値にしない）', leaseSec !== routeMaxSec);
}

// ── 2. error_code allowlist 分割 ────────────────────────────────────
console.log('[2] error code partition');
{
  const rSet = new Set<string>(RETRYABLE_ERROR_CODES);
  const nSet = new Set<string>(NONRETRYABLE_ERROR_CODES);
  const overlap = [...rSet].filter((c) => nSet.has(c));
  check('retryable と non-retryable が重複しない', overlap.length === 0, overlap.join(','));
  check('ALL = retryable + non-retryable', ALL_ERROR_CODES.length === rSet.size + nSet.size);
  check('RETRY_LIMIT_REACHED は non-retryable', nSet.has('RETRY_LIMIT_REACHED'));
  check('SCHEMA_VALIDATION_FAILED は non-retryable', !isRetryableErrorCode('SCHEMA_VALIDATION_FAILED'));
  check('PROVIDER_TIMEOUT は retryable', isRetryableErrorCode('PROVIDER_TIMEOUT'));
  check('未知コードは非 retryable 扱い', !isRetryableErrorCode('SOMETHING_UNKNOWN'));
}

// ── 3. idempotency 決定論 ───────────────────────────────────────────
console.log('[3] idempotency determinism');
{
  const a = buildSelfAnalysisIdentity(baseInput());
  const b = buildSelfAnalysisIdentity(baseInput());
  check('同一入力 → 同一 key', a.idempotencyKey === b.idempotencyKey);
  check('key は 64 桁 hex', /^[0-9a-f]{64}$/.test(a.idempotencyKey));
  check('input_revision は 64 桁 hex', /^[0-9a-f]{64}$/.test(a.inputRevision));

  // profile のキー順が違っても同一 key（canonicalize）。
  const reordered = baseInput();
  reordered.profile = { tags: ['a', 'b'], grade: 'B3', name: 'x' };
  check('profile キー順非依存', buildSelfAnalysisIdentity(reordered).idempotencyKey === a.idempotencyKey);

  // 別 user → 別 key（server-authoritative owner 反映）。
  const otherUser = { ...baseInput(), userId: 'user-zzz' };
  check('別 user → 別 key', buildSelfAnalysisIdentity(otherUser).idempotencyKey !== a.idempotencyKey);

  // 入力変化 → 別 key（input revision 変更で再生成される）。
  const changedActivity = baseInput();
  changedActivity.activity = { items: [{ id: '2', title: 'u' }] };
  check('activity 変化 → 別 key', buildSelfAnalysisIdentity(changedActivity).idempotencyKey !== a.idempotencyKey);

  // conversation の壊れた要素は無視（正規化）→ key 不変。
  const noisyConv = baseInput();
  noisyConv.conversation = [
    { role: 'question', content: 'Q1' },
    { role: 'system', content: 'IGNORE' }, // 不正 role
    null,
    { role: 'answer', content: '  A1  ' }, // trim される
  ];
  check('conversation 正規化で key 不変', buildSelfAnalysisIdentity(noisyConv).idempotencyKey === a.idempotencyKey);

  // prompt/schema/model revision の変化 → 別 key。
  const bumpPrompt = { ...baseInput(), promptRevision: 'other-prompt' };
  check('prompt revision 変化 → 別 key', buildSelfAnalysisIdentity(bumpPrompt).idempotencyKey !== a.idempotencyKey);
  const bumpModel = { ...baseInput(), model: 'claude-other' };
  check('model 変化 → 別 key', buildSelfAnalysisIdentity(bumpModel).idempotencyKey !== a.idempotencyKey);

  // canonicalize は undefined を null に寄せて安定化。
  check('stableStringify undefined→null', stableStringify({ a: undefined }) === stableStringify({ a: null }));

  // raw 入力（profile 本文）が key/revision 文字列に平文で漏れない。
  check('raw profile 文字列が key に混入しない', !a.idempotencyKey.includes('B3') && !a.inputRevision.includes('B3'));
}

// ── 4. repository fencing / owner-scope source 契約 ──────────────────
console.log('[4] repository source contract');
{
  const repoSrc = readFileSync(
    join(process.cwd(), 'lib', 'careerGenerationJob', 'repository.ts'),
    'utf8',
  );
  check("server-only import", /import 'server-only'/.test(repoSrc));
  // complete/fail は fencing（status=running AND attempt_token AND user_id）で更新。
  check("complete/fail が status='running' で fencing", /\.eq\('status', 'running'\)/.test(repoSrc));
  check('complete/fail が attempt_token で fencing', /\.eq\('attempt_token', args\.attemptToken\)/.test(repoSrc));
  check('complete/fail が user_id で owner 制限', /\.eq\('user_id', args\.userId\)/.test(repoSrc));
  check('applied=1 行のみ適用（古い attempt 破棄）', /data\.length === 1/.test(repoSrc));
  // read は owner-scoped（user_id 必須）。
  check("read が user_id で owner 制限", /\.eq\('user_id', userId\)/.test(repoSrc));
  // claim は atomic RPC 委譲・非 retryable allowlist を渡す。
  check('claim が RPC 委譲', /admin\.rpc\(CLAIM_FN/.test(repoSrc));
  check('claim が non-retryable allowlist を渡す', /p_nonretryable_codes: \[\.\.\.NONRETRYABLE_ERROR_CODES\]/.test(repoSrc));
  // raw provider/DB message を route へ伝播しない（型付き storage error のみ）。
  check('storage error に raw message を載せない', /storage error`/.test(repoSrc) && /GenerationJobStorageError/.test(repoSrc));
  // client 指定 user ID を受け取らない（userId は引数で明示）。
  check('userId は明示引数（body/query から取らない）', /userId: string/.test(repoSrc) && !/req\.|request\.|body\./.test(repoSrc));
}

// ── 5. flag default OFF ─────────────────────────────────────────────
console.log('[5] pilot flag default');
{
  const flagSrc = readFileSync(
    join(process.cwd(), 'lib', 'careerGenerationJob', 'flag.server.ts'),
    'utf8',
  );
  check('pilot flag default OFF（=== true）', /=== 'true'/.test(flagSrc));
  check("undefined-table legacy fallback は non-production 限定", /NODE_ENV !== 'production'/.test(flagSrc));
}

console.log('');
if (failures === 0) {
  console.log('career-generation-job-core-qa: ALL PASS');
  process.exit(0);
} else {
  console.error(`career-generation-job-core-qa: ${failures} FAIL`);
  process.exit(1);
}
