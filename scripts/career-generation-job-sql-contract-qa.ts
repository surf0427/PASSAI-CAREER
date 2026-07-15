/*
 * scripts/career-generation-job-sql-contract-qa.ts
 *
 * PASSAI CAREER — career_generation_jobs migration の **SQL/RLS/GRANT 契約** 静的 QA。
 * STEP-CAREER-GENJOB-01（members pilot）。
 *
 * 背景: local Postgres / supabase CLI が無いため、migration を live DB へ適用した QA は
 *   後続 STEP（fake provider / integration）に委ねる。本 QA は supabase/*.sql の
 *   **文字列契約**（columns / invariants / fencing / RLS / GRANT-REVOKE / claim function）を
 *   決定論的に固定し、リグレッションを防ぐ。
 *
 * 厳守 / 限界:
 *   - 本番 Supabase へ接続しない。SQL を読むだけ（完全決定論）。
 *   - デプロイ済み schema との一致は保証しない（適用状態は別管理）。
 *   - 本格 parser は使わず、空白/改行/大小文字を正規化して緩く照合する。
 *
 * 使い方: npx tsx scripts/career-generation-job-sql-contract-qa.ts
 * 終了コード: 全 PASS → 0 / いずれか FAIL → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const SQL_PATH = join(process.cwd(), 'supabase', 'career_generation_jobs_apply.sql');
const raw = readFileSync(SQL_PATH, 'utf8');
const norm = raw.toLowerCase().replace(/\s+/g, ' ');
const has = (re: RegExp): boolean => re.test(norm);

// ── 1. table + columns ──────────────────────────────────────────────
console.log('[1] table columns');
{
  check('create table if not exists career_generation_jobs', has(/create table if not exists career_generation_jobs/));
  const COLS: Array<[string, string]> = [
    ['id', 'uuid'], ['user_id', 'uuid'], ['feature', 'text'], ['operation', 'text'],
    ['idempotency_key', 'text'], ['input_revision', 'text'], ['prompt_revision', 'text'],
    ['output_schema_revision', 'text'], ['model', 'text'], ['status', 'text'],
    ['attempt_token', 'uuid'], ['lease_expires_at', 'timestamptz'], ['attempt_count', 'int'],
    ['result', 'jsonb'], ['error_code', 'text'], ['provider_duration_ms', 'int'],
    ['total_duration_ms', 'int'], ['ttft_ms', 'int'], ['started_at', 'timestamptz'],
    ['completed_at', 'timestamptz'], ['failed_at', 'timestamptz'],
    ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'],
  ];
  for (const [col, ty] of COLS) {
    check(`column ${col} ${ty}`, new RegExp(`\\b${col}\\b\\s+${ty}`).test(norm));
  }
}

// ── 2. FK / natural key / no client-fixed user_id default ────────────
console.log('[2] FK / natural key');
{
  check('user_id FK auth.users(id) NOT NULL', has(/user_id\s+uuid\s+not null\s+references\s+auth\.users\s*\(\s*id\s*\)/));
  check('ON DELETE CASCADE', has(/references\s+auth\.users\s*\(\s*id\s*\)\s+on delete cascade/));
  check('unique (user_id, idempotency_key)', has(/unique\s*\(\s*user_id\s*,\s*idempotency_key\s*\)/));
  check('user_id を default 固定していない', !has(/user_id\s+uuid[^,]*default/));
}

// ── 3. status + invariants CHECK ────────────────────────────────────
console.log('[3] status / invariants');
{
  check("status CHECK 4 値", has(/check\s*\(\s*status in\s*\(\s*'queued'\s*,\s*'running'\s*,\s*'completed'\s*,\s*'failed'\s*\)/));
  // completed は result + completed_at 必須・error/failed_at 無し（incomplete を completed 扱いしない）。
  check('completed → result NOT NULL', has(/status = 'completed'\s+and result is not null\s+and completed_at is not null/));
  check('completed → error_code/failed_at NULL', has(/status = 'completed'[^)]*error_code is null and failed_at is null/));
  // failed は result 無し・error_code + failed_at 必須。
  check('failed → result NULL', has(/status = 'failed'\s+and result is null/));
  check('failed → error_code/failed_at NOT NULL', has(/status = 'failed'[^)]*error_code is not null and failed_at is not null/));
  // running は fencing 列（attempt_token / lease）必須・result 無し。
  check('running → started_at/attempt_token/lease NOT NULL', has(/status = 'running'\s+and started_at is not null and attempt_token is not null and lease_expires_at is not null/));
  check('running → result NULL', has(/status = 'running'[^)]*result is null/));
  // queued は result/error/完了時刻なし。
  check('queued → result/error/timestamps NULL', has(/status = 'queued'\s+and result is null and error_code is null\s+and completed_at is null and failed_at is null/));
  // 数値は 0 以上。
  check('attempt_count >= 0', has(/attempt_count >= 0/));
  check('duration >= 0 ガード', has(/provider_duration_ms is null or provider_duration_ms >= 0/));
}

// ── 4. updated_at trigger ───────────────────────────────────────────
console.log('[4] updated_at trigger');
{
  check('set_updated_at trigger を張る', has(/create trigger career_generation_jobs_set_updated_at/));
  check('trigger 存在チェック（冪等）', has(/from pg_trigger where tgname = 'career_generation_jobs_set_updated_at'/));
}

// ── 5. RLS — owner SELECT のみ / 書き込み policy 無し ─────────────────
console.log('[5] RLS');
{
  check('RLS enable', has(/alter table public\.career_generation_jobs enable row level security/));
  check('owner SELECT policy (authenticated)', has(/for select to authenticated\s+using\s*\(\s*auth\.uid\(\)\s*=\s*user_id\s*\)/));
  // 書き込み policy は張らない（browser 書き込み禁止）。
  check('authenticated INSERT policy 無し', !has(/for insert to authenticated/));
  check('authenticated UPDATE policy 無し', !has(/for update to authenticated/));
  check('authenticated DELETE policy 無し', !has(/for delete to authenticated/));
  check('anon への policy 無し', !has(/to anon\b/));
  check('service_role 公開 policy 無し', !has(/create policy[^;]*to service_role/));
}

// ── 6. GRANT/REVOKE — browser direct write を塞ぐ ────────────────────
console.log('[6] GRANT / REVOKE');
{
  check('REVOKE ALL FROM anon', has(/revoke all on public\.career_generation_jobs from anon/));
  check('REVOKE ALL FROM authenticated', has(/revoke all on public\.career_generation_jobs from authenticated/));
  check('GRANT SELECT TO authenticated', has(/grant select on public\.career_generation_jobs to authenticated/));
  // authenticated への書き込み GRANT は無い。
  check('authenticated へ INSERT/UPDATE/DELETE を GRANT しない',
    !has(/grant[^;]*\b(insert|update|delete)\b[^;]*on public\.career_generation_jobs to authenticated/));
  check('service_role に ALL', has(/grant all on public\.career_generation_jobs to service_role/));
}

// ── 7. atomic claim function + fencing + outcomes + execute grant ────
console.log('[7] claim function');
{
  check('claim function 定義', has(/create or replace function public\.career_generation_job_claim/));
  check('SECURITY DEFINER', has(/security definer/));
  check('search_path 固定', has(/set search_path = public, pg_temp/));
  check('ON CONFLICT DO NOTHING（原子的 new-claim）', has(/on conflict \(user_id, idempotency_key\) do nothing/));
  check('FOR UPDATE（競合を直列化）', has(/for update/));
  // 6 outcome を全て返す。
  for (const outcome of ['claimed_new', 'claimed_retry', 'already_running', 'already_completed', 'failed_non_retryable', 'retry_limit_reached']) {
    check(`outcome '${outcome}'`, has(new RegExp(`'${outcome}'::text`)));
  }
  // stale running を terminal failed に確定（永久 running 防止）。
  check('retry 上限で stale running を failed 化', has(/set status = 'failed', error_code = 'retry_limit_reached'/));
  // reclaim は新 attempt_token + attempt_count+1。
  check('reclaim で新 attempt_token', has(/attempt_token = gen_random_uuid\(\)/));
  check('reclaim で attempt_count\\+1', has(/attempt_count = v_row\.attempt_count \+ 1/));
  // 非 retryable 判定は allowlist（引数配列）で。
  check('非 retryable は引数 allowlist で判定', has(/error_code = any \(p_nonretryable_codes\)/));
  // execute は service_role のみ。
  check('EXECUTE を public/anon/authenticated から REVOKE', has(/revoke all on function public\.career_generation_job_claim[^;]*from public, anon, authenticated/));
  check('EXECUTE を service_role に GRANT', has(/grant execute on function public\.career_generation_job_claim[^;]*to service_role/));
}

console.log('');
console.log('注記: 本 QA は repository 上の SQL 契約のみを保証する。live Supabase 適用検証は後続 STEP。');
if (failures === 0) {
  console.log('career-generation-job-sql-contract-qa: ALL PASS');
  process.exit(0);
} else {
  console.error(`career-generation-job-sql-contract-qa: ${failures} FAIL`);
  process.exit(1);
}
