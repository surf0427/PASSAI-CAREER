/*
 * scripts/career-event-sql-contract-qa.ts
 *
 * PASSAI CAREER — career_user_events の **repository SQL/RLS 契約** 静的 QA（P9-H 常設 harness）。
 *
 * 背景（P9-F/G で残った既知ギャップ）:
 *   sanitize / timeline / writer は QA 済みだが、DDL（unique index / RLS / append-only）の契約は
 *   SQL レビュー頼みで自動検査が無かった。P9-H でその契約を静的に固定する。
 *
 * 何を守るか（repository 上の supabase/career_events_apply.sql に対して）:
 *   - table 主要 column の存在（id / user_id / event_type / feature / company_id /
 *     client_event_id / score_band / metadata / created_at / occurred_at）。
 *   - user_id は auth.users への FK（ON DELETE CASCADE）。company_id / client_event_id は nullable。
 *   - (user_id, client_event_id) の **partial UNIQUE index**（WHERE client_event_id IS NOT NULL）。
 *     feature / company_id を unique key に含めない・global unique でない。
 *   - RLS enabled。owner SELECT/INSERT のみ（auth.uid() = user_id）。
 *   - UPDATE / DELETE policy が無い（append-only）。anon/public/service_role の公開 policy が無い。
 *
 * 厳守 / 限界:
 *   - 本番 Supabase へ接続しない。repository の SQL 文字列を **読むだけ**（完全決定論）。
 *   - 本 QA が保証するのは **repository 上の SQL 契約** であり、デプロイ済み Supabase schema との
 *     一致は保証しない（migration 適用状態は別管理）。
 *   - 本格的な SQL parser は使わない。空白・改行・大小文字差は正規化して緩く照合する。
 *
 * 使い方: npx tsx scripts/career-event-sql-contract-qa.ts
 * 終了コード: 全 assertion PASS → 0 / いずれか FAIL → 1。
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

const SQL_PATH = join(process.cwd(), 'supabase', 'career_events_apply.sql');
const raw = readFileSync(SQL_PATH, 'utf8');
// 大小文字無視・空白/改行を単一スペースへ正規化した照合用文字列。
const norm = raw.toLowerCase().replace(/\s+/g, ' ');

function has(re: RegExp): boolean {
  return re.test(norm);
}

// ── 1. table 主要 column ───────────────────────────────────────────
console.log('[1] table columns');
{
  const REQUIRED_COLUMNS = [
    'id', 'user_id', 'event_type', 'feature', 'company_id', 'client_event_id',
    'score_band', 'metadata', 'created_at', 'occurred_at',
  ];
  check('create table career_user_events が存在', has(/create table if not exists career_user_events/));
  for (const col of REQUIRED_COLUMNS) {
    // column 名の後に型が続く形（col <type>）で存在すること（word boundary で誤検知を抑える）。
    check(`column: ${col}`, new RegExp(`\\b${col}\\b\\s+(uuid|text|jsonb|timestamptz)`).test(norm));
  }
}

// ── 2. FK / owner / nullable ───────────────────────────────────────
console.log('[2] FK / owner / nullable');
{
  check(
    'user_id は auth.users への FK',
    has(/user_id\s+uuid\s+not null\s+references\s+auth\.users\s*\(\s*id\s*\)/),
  );
  check('退会時 FK ON DELETE CASCADE', has(/references\s+auth\.users\s*\(\s*id\s*\)\s+on delete cascade/));
  check('company_id は nullable', has(/company_id\s+uuid\s+null\b/));
  check('client_event_id は nullable', has(/client_event_id\s+text\s+null\b/));
  // 他ユーザー ID を自由入力保存する設計でない（user_id は列であり INSERT policy で auth.uid 拘束）。
  check('user_id を default で外部固定していない', !has(/user_id\s+uuid[^,]*default/));
}

// ── 3. partial UNIQUE index ────────────────────────────────────────
console.log('[3] unique index (user_id, client_event_id) partial');
{
  // create unique index ... on career_user_events (user_id, client_event_id) ... where client_event_id is not null
  const uniqRe =
    /create unique index[^;]*career_user_events\s*\(\s*user_id\s*,\s*client_event_id\s*\)[^;]*where\s+client_event_id\s+is not null/;
  check('partial unique index が存在', has(uniqRe));
  check('unique key に user_id を含む', /career_user_events\s*\(\s*user_id\s*,/.test(norm));
  check('unique key に client_event_id を含む', /user_id\s*,\s*client_event_id\s*\)/.test(norm));
  check('WHERE client_event_id IS NOT NULL の partial index', has(/where\s+client_event_id\s+is not null/));
  // unique index の対象列に feature / company_id を含めない（global unique / 過剰 unique の防止）。
  const uniqStmt = (norm.match(uniqRe) ?? [''])[0];
  check('unique key に feature を含めない', !/\(\s*[^)]*\bfeature\b[^)]*\)/.test(uniqStmt));
  check('unique key に company_id を含めない', !/\(\s*[^)]*\bcompany_id\b[^)]*\)/.test(uniqStmt));
  // client_event_id 単独の global unique index を作っていない（user 別に閉じる前提）。
  check(
    'client_event_id 単独 global unique を作らない',
    !/create unique index[^;]*career_user_events\s*\(\s*client_event_id\s*\)/.test(norm),
  );
}

// ── 4. RLS enabled + owner-only policy ─────────────────────────────
console.log('[4] RLS / owner policy');
{
  check('RLS enable', has(/enable row level security/));
  check('owner SELECT policy（for select / authenticated）', has(/for select to authenticated/));
  check('owner INSERT policy（for insert / authenticated）', has(/for insert to authenticated/));
  check('SELECT は auth.uid() = user_id（using）', has(/for select to authenticated using\s*\(\s*auth\.uid\(\)\s*=\s*user_id\s*\)/));
  check('INSERT は auth.uid() = user_id（with check）', has(/for insert to authenticated with check\s*\(\s*auth\.uid\(\)\s*=\s*user_id\s*\)/));
}

// ── 5. append-only（UPDATE / DELETE policy 無し）＋ 非公開 ───────────
console.log('[5] append-only / no public policy');
{
  check('user 向け UPDATE policy が無い', !has(/for update/));
  check('user 向け DELETE policy が無い', !has(/for delete/));
  check('anon への policy が無い', !has(/to anon\b/));
  check('public role への policy が無い', !has(/create policy[^;]*to public\b/));
  check('service_role 公開 policy が無い', !has(/to service_role\b/));
}

console.log('');
console.log('注記: 本 QA は repository 上の SQL 契約のみを保証する。デプロイ済み Supabase schema との一致は保証しない。');
console.log('');
if (failures === 0) {
  console.log('career-event-sql-contract-qa: ALL PASS');
  process.exit(0);
} else {
  console.error(`career-event-sql-contract-qa: ${failures} FAIL`);
  process.exit(1);
}
