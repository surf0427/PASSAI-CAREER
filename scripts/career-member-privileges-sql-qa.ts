/*
 * scripts/career-member-privileges-sql-qa.ts
 *
 * PASSAI CAREER — supabase/career_member_privileges_apply.sql の **権限契約** 静的 QA。
 *
 * 背景:
 *   member (role `authenticated`) 用の 16 table に DML 権限が 1 つも無く、ログインしても
 *   mirror が保存されない状態だった（2026-08-18 に Project B の実 DB で確認）。
 *   その修復 DDL が本 QA の対象。GRANT は「1 つ足りない / 1 つ多い」がどちらも事故に
 *   直結する（前者＝保存されない、後者＝権限過剰）ため、静的に固定する。
 *
 * 何を守るか（supabase/career_member_privileges_apply.sql に対して）:
 *   - 対象 16 table すべてに REVOKE ALL ... FROM anon, authenticated がある。
 *   - table ごとの GRANT が **実コードの CRUD 要件と完全一致**する（過不足ゼロ）。
 *   - anon への GRANT が 1 つも無い。
 *   - `GRANT ALL` を使っていない。
 *   - TRUNCATE / TRIGGER / REFERENCES を明示的に GRANT していない。
 *   - RLS を無効化していない / policy を作り替えていない / schema を変更していない
 *     （本ファイルは権限だけを扱うという不変条件）。
 *   - BEGIN / COMMIT で囲まれている（部分適用を残さない）。
 *
 * 厳守 / 限界:
 *   - 本番 Supabase へ接続しない。repository の SQL 文字列を **読むだけ**（完全決定論）。
 *   - 本 QA が保証するのは **repository 上の SQL 契約** であり、実 DB への適用状態は
 *     保証しない（適用は operator が SQL Editor で行う）。
 *
 * 使い方: npx tsx scripts/career-member-privileges-sql-qa.ts
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

const SQL_PATH = join(process.cwd(), 'supabase', 'career_member_privileges_apply.sql');
const raw = readFileSync(SQL_PATH, 'utf8');

// コメント行（-- 始まり）を落としてから正規化する。
//   ヘッダの解説コメントに含まれる "GRANT ALL" 等の**説明文**を実 DDL と誤認しないため。
const sqlOnly = raw
  .split('\n')
  .map((line) => {
    const i = line.indexOf('--');
    return i === -1 ? line : line.slice(0, i);
  })
  .join('\n');
const norm = sqlOnly.toLowerCase().replace(/\s+/g, ' ');

/** 実コードから確定した、table ごとの authenticated 必要権限（過不足ゼロで一致させる）。 */
const REQUIRED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['career_accounts', ['select', 'insert', 'update']],
  ['career_profiles', ['select', 'insert', 'update']],
  ['career_activities', ['select', 'insert', 'update']],
  ['career_values', ['select', 'insert', 'update']],
  ['career_self_analysis_results', ['select', 'insert', 'update']],
  ['career_self_prs', ['select', 'insert', 'update']],
  ['career_es_logs', ['select', 'insert', 'update']],
  ['career_interview_sessions', ['select', 'insert', 'update']],
  ['career_interview_results', ['select', 'insert', 'update']],
  ['career_presentation_sessions', ['select', 'insert', 'update']],
  ['career_presentation_results', ['select', 'insert', 'update']],
  ['career_company_research_logs', ['select', 'insert', 'update']],
  ['career_matching_results', ['select', 'insert', 'update']],
  // 相談スレッドは UI に削除がある。
  ['career_consultation_threads', ['select', 'insert', 'update', 'delete']],
  // 利用イベントは append-only（update / delete policy が DDL に無い）。
  ['career_user_events', ['select', 'insert']],
  // Personal Memory は section 単位の upsert + deleteSection。
  ['career_personal_memory', ['select', 'insert', 'update', 'delete']],
];

console.log('career member privileges SQL contract QA');

// ── 1. トランザクション境界 ────────────────────────────────────────────────
check('BEGIN で開始する', /(^|\s)begin;/.test(norm));
check('COMMIT で終了する', /(^|\s)commit;/.test(norm));

// ── 2. 権限リセット（TRUNCATE/TRIGGER/REFERENCES を落とすため）────────────
for (const [table] of REQUIRED) {
  const re = new RegExp(
    `revoke all on public\\.${table}\\s+from anon, authenticated;`,
  );
  check(`REVOKE ALL FROM anon, authenticated — ${table}`, re.test(norm));
}

// ── 3. GRANT が必要権限と完全一致（過不足ゼロ）────────────────────────────
for (const [table, privs] of REQUIRED) {
  // `grant <privs> on public.<table> to authenticated;` を 1 本だけ持つこと。
  const re = new RegExp(
    `grant ([a-z, ]+?) on public\\.${table} to authenticated;`,
    'g',
  );
  const matches = [...norm.matchAll(re)];
  if (matches.length !== 1) {
    check(`GRANT は 1 文だけ — ${table}`, false, `${matches.length} 文見つかった`);
    continue;
  }
  const granted = matches[0][1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
  const expected = [...privs].sort();
  check(
    `GRANT が要件と完全一致 — ${table} [${expected.join(',')}]`,
    granted.length === expected.length && granted.every((p, i) => p === expected[i]),
    `実際: [${granted.join(',')}]`,
  );
}

// ── 4. 与えてはいけないもの ────────────────────────────────────────────────
check('anon への GRANT が存在しない', !/grant [^;]*to [^;]*anon/.test(norm));
check('GRANT ALL を使っていない', !/grant all/.test(norm));
check(
  'TRUNCATE を GRANT していない',
  !/grant [^;]*truncate[^;]*to/.test(norm),
);
check('TRIGGER を GRANT していない', !/grant [^;]*trigger[^;]*to/.test(norm));
check(
  'REFERENCES を GRANT していない',
  !/grant [^;]*references[^;]*to/.test(norm),
);
check(
  'service_role へ権限を足していない（本 STEP の対象外）',
  !/(grant|revoke)[^;]*service_role/.test(norm),
);

// ── 5. 権限以外を変更していない（本ファイルの不変条件）────────────────────
check('RLS を無効化していない', !/disable row level security/.test(norm));
check('policy を作成・削除していない', !/(create|drop) policy/.test(norm));
check('table を作成・変更・削除していない', !/(create|alter|drop) table/.test(norm));
check('column を変更していない', !/(add|drop) column/.test(norm));
// TRUNCATE **文**（データ破棄）の検出。`GRANT ..., TRUNCATE ON ...` は上の
// 「TRUNCATE を GRANT していない」が担当するので、ここでは文だけを見る。
check(
  'TRUNCATE 文を実行していない',
  !/(^|;|\s)truncate\s+(table\s+|only\s+|public\.)/.test(norm),
);
check('DELETE / UPDATE 文でデータを触っていない', !/(^|\s)(delete from|update public\.)/.test(norm));

// ── 6. 対象 table の網羅（取りこぼし検知）──────────────────────────────────
const grantedTables = [...norm.matchAll(/grant [a-z, ]+ on public\.([a-z_]+) to /g)].map(
  (m) => m[1],
);
const uniqueGranted = [...new Set(grantedTables)].sort();
const expectedTables = REQUIRED.map(([t]) => t).sort();
check(
  `GRANT 対象 table が ${expectedTables.length} 件ちょうど`,
  uniqueGranted.length === expectedTables.length &&
    uniqueGranted.every((t, i) => t === expectedTables[i]),
  `実際: ${uniqueGranted.length} 件 [${uniqueGranted.join(', ')}]`,
);

console.log(
  failures === 0
    ? '\ncareer-member-privileges-sql-qa: ALL PASS'
    : `\ncareer-member-privileges-sql-qa: ${failures} FAIL`,
);
process.exit(failures === 0 ? 0 : 1);
