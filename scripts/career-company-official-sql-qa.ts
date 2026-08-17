/*
 * scripts/career-company-official-sql-qa.ts
 *
 * PASSAI CAREER — Company Data Spine DDL の静的契約 QA（**実 DB へ接続しない**）。
 *
 * 既存 `scripts/career-generation-job-sql-contract-qa.ts` と同じ役割:
 *   適用前の SQL ファイルが、コード側の前提と一致していることをテキストで固定する。
 *
 * 何を守るか:
 *   Q-1 NOT APPLIED であることの明示 / 冪等性 / 破壊的変更が無いこと
 *   Q-2 出典必須（facts.source_id NOT NULL）
 *   Q-3 AI 派生物が facts と別 table
 *   Q-4 job 台帳が company-scoped（user_id を持たない）
 *   Q-5 RLS / GRANT（write policy を作らない・job 台帳を露出しない・anon へ付与しない）
 *   Q-6 claim RPC が 6 outcome / fencing / service_role 限定
 *   Q-7 コード側の table 名・enum 値と一致（drift 防止）
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-company-official-sql-qa.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAREER_COMPANY_OFFICIAL_TABLES,
  COMPANY_FACT_GROUPS,
  COMPANY_FACT_EXTRACTION_METHODS,
  COMPANY_SOURCE_TYPES,
} from '@/types/careerCompanyOfficial';
import {
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  NONRETRYABLE_ERROR_CODES,
  ROUTE_MAX_DURATION_SECONDS,
} from '@/lib/careerCompanyPrefetch/constants';

const ROOT = process.cwd();
const SQL_PATH = join(ROOT, 'supabase/career_company_official_facts_apply.sql');

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

check('Q-0 DDL ファイルが存在する', existsSync(SQL_PATH));
const sql = existsSync(SQL_PATH) ? readFileSync(SQL_PATH, 'utf8') : '';

/** `--` コメントを落とした実 SQL（説明文を静的検査に混ぜないため）。 */
const sqlCode = sql
  .split('\n')
  .map((line) => {
    const at = line.indexOf('--');
    return at >= 0 ? line.slice(0, at) : line;
  })
  .join('\n');

/** `CREATE TABLE ... (` 〜 `\n);` を切り出す。 */
function tableBody(table: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`);
  if (start < 0) return '';
  const end = sql.indexOf('\n);', start);
  return end < 0 ? '' : sql.slice(start, end);
}

// ════════════════════════════════════════════════════════════════════
console.log('[Q-1] 適用状態 / 冪等性 / 非破壊');

check('Q-1a NOT APPLIED を明示している', sql.includes('NOT APPLIED'));
check('Q-1b 前提 DDL（identity apply）を明記', sql.includes('career_company_identity_apply.sql'));
check(
  'Q-1c BEGIN / COMMIT で包む（トランザクション適用）',
  sqlCode.includes('BEGIN;') &&
    sqlCode.trimEnd().endsWith('COMMIT;') &&
    sqlCode.indexOf('BEGIN;') < sqlCode.lastIndexOf('COMMIT;'),
);
check(
  'Q-1d 全 CREATE TABLE が IF NOT EXISTS（再実行安全）',
  (sql.match(/CREATE TABLE /g) ?? []).length === (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length,
);
check(
  'Q-1e 全 CREATE INDEX が IF NOT EXISTS',
  (sql.match(/CREATE (UNIQUE )?INDEX /g) ?? []).length ===
    (sql.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g) ?? []).length,
);
check('Q-1f POLICY は DROP IF EXISTS → CREATE（冪等）', (sql.match(/DROP POLICY IF EXISTS/g) ?? []).length >= 3);
check('Q-1g 関数は CREATE OR REPLACE', sql.includes('CREATE OR REPLACE FUNCTION'));

// ★ 破壊的変更が無いこと。
check('Q-1h DROP TABLE を含まない', !/DROP TABLE/i.test(sql));
check('Q-1i DROP COLUMN を含まない', !/DROP COLUMN/i.test(sql));
check('Q-1j TRUNCATE / DELETE FROM を含まない', !/TRUNCATE|DELETE FROM/i.test(sql));
check('Q-1k ALTER は ADD COLUMN IF NOT EXISTS / RLS 有効化のみ', (() => {
  const alters = sqlCode.match(/ALTER TABLE[\s\S]*?;/g) ?? [];
  return (
    alters.length > 0 &&
    alters.every((a) => /ADD COLUMN IF NOT EXISTS/.test(a) || /ENABLE ROW LEVEL SECURITY/.test(a))
  );
})());
check(
  'Q-1l corporate_number は nullable（既存行を壊さない）',
  sql.includes('ADD COLUMN IF NOT EXISTS corporate_number text') && !/corporate_number text NOT NULL/.test(sql),
);
check(
  'Q-1m corporate_number の UNIQUE は NULL を許す部分 index',
  sql.includes('career_company_master_corporate_number_uniq') && sql.includes('WHERE corporate_number IS NOT NULL'),
);

// ════════════════════════════════════════════════════════════════════
console.log('[Q-2] 出典必須（provenance without exception）');
{
  const facts = tableBody('career_company_official_facts');
  check('Q-2a facts table が存在する', facts !== '');
  check('Q-2b ★ source_id が NOT NULL（出典なき事実を作れない）', /source_id\s+uuid\s+NOT NULL/.test(facts));
  check('Q-2c source_id は sources への FK', facts.includes('REFERENCES public.career_company_sources (id)'));
  check('Q-2d ON DELETE RESTRICT（出典だけ消える状態を作らせない）', /career_company_sources \(id\) ON DELETE RESTRICT/.test(facts));
  check('Q-2e fact_value は object かつ value を持つ CHECK', facts.includes("jsonb_typeof(fact_value) = 'object'") && facts.includes("fact_value ? 'value'"));
  check('Q-2f 履歴用の superseded_by がある（上書き削除しない）', facts.includes('superseded_by'));
  check('Q-2g valid_until（TTL）列がある', facts.includes('valid_until'));

  const sources = tableBody('career_company_sources');
  check('Q-2h sources table が存在する', sources !== '');
  check('Q-2i source_url は http(s) のみ CHECK', sources.includes("source_url LIKE 'https://%'"));
  check('Q-2j ★ 本文全文の列が無い（content_hash のみ）', sources.includes('content_hash') && !/\bbody\b|\bhtml\b|raw_content/.test(sources));
  check('Q-2k fetched_at / published_at を持つ', sources.includes('fetched_at') && sources.includes('published_at'));
}

// ════════════════════════════════════════════════════════════════════
console.log('[Q-3] AI 派生物の分離');
{
  const derived = tableBody('career_company_derived');
  check('Q-3a derived table が存在する', derived !== '');
  check('Q-3b derived は model / prompt_revision を持つ（出所が AI だと分かる）', derived.includes('model') && derived.includes('prompt_revision'));
  check('Q-3c derived は based_on_fact_keys でトレースできる', derived.includes('based_on_fact_keys'));
  check(
    'Q-3d ★ facts table のコメントが AI 生成物の混入を禁じている',
    sql.includes('AI-generated content MUST NOT be stored here'),
  );
  check(
    'Q-3e ★ derived のコメントが facts への昇格を禁じている',
    sql.includes('MUST NEVER be promoted into career_company_official_facts'),
  );
}

// ════════════════════════════════════════════════════════════════════
console.log('[Q-4] job 台帳が company-scoped');
{
  const jobs = tableBody('career_company_enrichment_jobs');
  check('Q-4a job table が存在する', jobs !== '');
  check('Q-4b ★ user_id 列が無い', !jobs.includes('user_id'));
  check('Q-4c ★ auth.users への参照が無い', !jobs.includes('auth.users'));
  check('Q-4d natural key が (company_id, task, idempotency_key)', jobs.includes('UNIQUE (company_id, task, idempotency_key)'));
  check('Q-4e attempt fencing の列がある', jobs.includes('attempt_token') && jobs.includes('lease_expires_at') && jobs.includes('attempt_count'));
  check('Q-4f status に partial がある（部分成功を failed に丸めない）', jobs.includes("'partial'"));
  check('Q-4g status CHECK が 5 値', jobs.includes("status IN ('pending','running','completed','partial','failed')"));
  check('Q-4h ★ 企業名 / URL / HTML / prompt 本文の列が無い', !/company_name|source_url|html|prompt_text/.test(jobs));
  check('Q-4i hash revision のみ保存', jobs.includes('fetcher_revision') && jobs.includes('schema_revision'));
  check('Q-4j status 整合の CHECK 制約がある', jobs.includes('career_company_enrichment_jobs_invariants'));
  check('Q-4k stale reclaim 用の部分 index がある', sql.includes("career_company_enrichment_jobs_running_lease_idx") && sql.includes("WHERE status = 'running'"));
  check('Q-4l updated_at trigger を冪等に張る', sql.includes('career_company_enrichment_jobs_set_updated_at') && sql.includes('pg_trigger'));
}

// ════════════════════════════════════════════════════════════════════
console.log('[Q-5] RLS / GRANT');

for (const table of [
  'career_company_sources',
  'career_company_official_facts',
  'career_company_derived',
  'career_company_enrichment_jobs',
]) {
  check(`Q-5a ${table} は RLS 有効`, sql.includes(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`));
  check(`Q-5b ${table} に anon 付与が無い`, !new RegExp(`GRANT[^;]*ON public\\.${table}[^;]*TO[^;]*anon`).test(sql));
}

check(
  'Q-5c ★ 書き込み policy を 1 つも作らない（default deny・service_role 経由のみ）',
  // ★ RPC 内の `SELECT ... FOR UPDATE`（行ロック）は policy ではないので、
  //   CREATE POLICY 文の中だけを見る。
  (sqlCode.match(/CREATE POLICY[\s\S]*?;/g) ?? []).every((p) => /FOR SELECT/i.test(p)),
);
check(
  'Q-5d ★ job 台帳には SELECT policy を作らない（運用台帳を露出しない）',
  !sql.includes('"career_company_enrichment_jobs read"') &&
    !/CREATE POLICY[^;]*career_company_enrichment_jobs/.test(sql),
);
check(
  'Q-5e ★ job 台帳に authenticated の SELECT を付与しない',
  !/GRANT SELECT ON public\.career_company_enrichment_jobs\s+TO authenticated/.test(sql),
);
check(
  'Q-5f 企業の公開事実 3 table は authenticated が read できる',
  sql.includes('GRANT SELECT ON public.career_company_sources        TO authenticated') &&
    sql.includes('GRANT SELECT ON public.career_company_official_facts TO authenticated') &&
    sql.includes('GRANT SELECT ON public.career_company_derived        TO authenticated'),
);
check('Q-5g REVOKE が GRANT より前にある', sql.indexOf('REVOKE ALL ON public.career_company_sources') < sql.indexOf('GRANT SELECT ON public.career_company_sources'));

// ════════════════════════════════════════════════════════════════════
console.log('[Q-6] claim RPC');
{
  const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.career_company_enrichment_job_claim');
  const fn = fnStart >= 0 ? sql.slice(fnStart) : '';
  check('Q-6a claim RPC が存在する', fn !== '');
  check('Q-6b ★ 引数に user_id が無い', !/p_user_id/.test(fn.slice(0, 800)));
  check('Q-6c SECURITY DEFINER + search_path 固定', fn.includes('SECURITY DEFINER') && fn.includes('SET search_path = public, pg_temp'));
  for (const outcome of [
    'CLAIMED_NEW',
    'CLAIMED_RETRY',
    'CLAIMED_REFRESH',
    'ALREADY_RUNNING',
    'ALREADY_COMPLETED',
    'FAILED_NON_RETRYABLE',
    'RETRY_LIMIT_REACHED',
  ]) {
    check(`Q-6d outcome ${outcome} を返す`, fn.includes(`'${outcome}'`));
  }
  check('Q-6e ON CONFLICT DO NOTHING で原子的に新規 claim', fn.includes('ON CONFLICT (company_id, task, idempotency_key) DO NOTHING'));
  check('Q-6f 競合時は FOR UPDATE で直列化', fn.includes('FOR UPDATE'));
  check('Q-6g lease 切れのみ reclaim（実行中は横取りしない）', fn.includes('lease_expires_at <= now()'));
  check('Q-6h ★ reclaim で facts / sources を消さない', !/DELETE FROM public\.career_company_(facts|sources)/.test(fn));
  check('Q-6i 引数検証で早期 RAISE', fn.includes("RAISE EXCEPTION 'career_company_enrichment_job_claim"));
  check(
    'Q-6j service_role 限定（anon / authenticated から REVOKE）',
    sql.includes('REVOKE ALL ON FUNCTION public.career_company_enrichment_job_claim') &&
      sql.includes('GRANT EXECUTE ON FUNCTION public.career_company_enrichment_job_claim'),
  );

  // ── TTL refresh lifecycle（★ terminal state != permanent state）─────
  //
  //   idempotency_key は company_id / task / revision だけから作られ、時間成分を持たない。
  //   したがって terminal 行（completed / partial / failed）を「二度と取得しない」と解釈すると、
  //   1 度成功した企業は fetcher_revision を上げるコード変更でしか再取得できなくなる。
  //   ここは「cooldown 付きの休止」であることを SQL テキストで固定する。
  //   判定の意味論は lib/careerCompanyPrefetch/refreshPolicy.ts と
  //   scripts/career-company-prefetch-ttl-qa.ts が実行して検証する（本 QA は DDL 側の契約）。

  /** IF v_refresh_due THEN 〜 END IF; の本体（refresh 分岐だけを見る）。 */
  const refreshBranch = (() => {
    const start = fn.indexOf('IF v_refresh_due THEN');
    if (start < 0) return '';
    const end = fn.indexOf('END IF;', start);
    return end < 0 ? '' : fn.slice(start, end);
  })();

  check(
    'Q-6k ★ cooldown を引数で受け取る（TTL 判定を DB に埋め込まない）',
    fn.includes('p_refresh_after_seconds') && fn.includes('p_failure_cooldown_seconds'),
  );
  check(
    'Q-6k2 cooldown 引数も検証して RAISE（0 / NULL で永久 refresh にしない）',
    /p_refresh_after_seconds IS NULL OR p_refresh_after_seconds <= 0/.test(fn) &&
      /p_failure_cooldown_seconds IS NULL OR p_failure_cooldown_seconds <= 0/.test(fn),
  );
  check(
    'Q-6l ★ terminal から cooldown 経過で再 claim できる（CLAIMED_REFRESH）',
    refreshBranch !== '' && refreshBranch.includes("'CLAIMED_REFRESH'"),
  );
  check(
    'Q-6l2 refresh 判定は terminal 時刻 + cooldown <= now()',
    /v_refresh_due\s*:=\s*v_terminal_at IS NOT NULL[\s\S]*?v_terminal_at \+ make_interval\(secs => v_cooldown\) <= now\(\)/.test(fn),
  );
  check(
    'Q-6l3 completed は refresh cooldown / それ以外は failure cooldown',
    /v_cooldown\s*:=\s*CASE WHEN v_row\.status = 'completed'[\s\S]*?p_refresh_after_seconds[\s\S]*?p_failure_cooldown_seconds/.test(fn),
  );
  check(
    'Q-6l4 terminal 時刻は completed_at / failed_at から採る',
    /v_terminal_at\s*:=\s*CASE[\s\S]*?completed_at[\s\S]*?failed_at[\s\S]*?END;/.test(fn),
  );

  // ★ 判定順（ここが崩れると「実行中の横取り」か「永久ブロック」のどちらかが復活する）。
  check(
    'Q-6m ★ ALREADY_RUNNING が refresh 判定より前（実行中の job を横取りしない）',
    fn.indexOf("'ALREADY_RUNNING'") >= 0 &&
      fn.indexOf("'ALREADY_RUNNING'") < fn.indexOf('v_refresh_due :='),
  );
  check(
    'Q-6n ★ refresh 分岐が ALREADY_COMPLETED より前（completed を永久 terminal にしない）',
    fn.indexOf("'CLAIMED_REFRESH'") >= 0 &&
      fn.indexOf("'CLAIMED_REFRESH'") < fn.indexOf("'ALREADY_COMPLETED'"),
  );
  check(
    'Q-6n2 ★ refresh 分岐が FAILED_NON_RETRYABLE / RETRY_LIMIT_REACHED より前',
    fn.indexOf("'CLAIMED_REFRESH'") < fn.indexOf("'FAILED_NON_RETRYABLE'") &&
      fn.indexOf("'CLAIMED_REFRESH'") < fn.indexOf("'RETRY_LIMIT_REACHED'"),
  );
  check(
    'Q-6n3 cooldown 未経過の completed は従来どおり deduped',
    fn.includes("RETURN QUERY SELECT 'ALREADY_COMPLETED'::text"),
  );

  // ★ 新サイクルは attempt 予算を戻す（attempt_count を生涯上限にしない）。
  check(
    'Q-6o ★ refresh で attempt_count を 1 へリセットする',
    /attempt_count = 1\b/.test(refreshBranch),
  );
  check(
    'Q-6o2 refresh で terminal 列（error_code / completed_at / failed_at）を消す',
    /error_code = NULL/.test(refreshBranch) &&
      /completed_at = NULL/.test(refreshBranch) &&
      /failed_at = NULL/.test(refreshBranch),
  );
  check(
    'Q-6o3 refresh は新しい attempt_token と lease を発行する（fencing を維持）',
    /attempt_token = gen_random_uuid\(\)/.test(refreshBranch) &&
      /lease_expires_at = now\(\) \+ make_interval\(secs => p_lease_seconds\)/.test(refreshBranch),
  );
  check(
    'Q-6o4 ★ refresh でも facts / sources を消さない（last-known-good を残す）',
    !/DELETE|TRUNCATE/i.test(refreshBranch),
  );

  // ★ refresh_cycle_count（attempt_count はサイクル内・こちらがサイクル数）。
  const jobs = tableBody('career_company_enrichment_jobs');
  check('Q-6p refresh_cycle_count 列がある', jobs.includes('refresh_cycle_count'));
  check(
    'Q-6p2 refresh_cycle_count は既存環境へも非破壊に追加される',
    sql.includes('ADD COLUMN IF NOT EXISTS refresh_cycle_count int NOT NULL DEFAULT 1'),
  );
  check('Q-6p3 refresh_cycle_count >= 1 の不変条件がある', jobs.includes('refresh_cycle_count >= 1'));
  check(
    'Q-6p4 ★ refresh のたびに refresh_cycle_count が進む',
    /refresh_cycle_count = COALESCE\(v_row\.refresh_cycle_count, 1\) \+ 1/.test(refreshBranch),
  );

  // ★ 引数が 8 → 10 に増えた。CREATE OR REPLACE は signature 違いだと overload 追加になる。
  check(
    'Q-6q 旧 signature（8 引数）を DROP してから作り直す',
    sql.indexOf('DROP FUNCTION IF EXISTS public.career_company_enrichment_job_claim(') >= 0 &&
      sql.indexOf('DROP FUNCTION IF EXISTS public.career_company_enrichment_job_claim(') <
        sql.indexOf('CREATE OR REPLACE FUNCTION public.career_company_enrichment_job_claim'),
  );
  check(
    'Q-6q2 GRANT / REVOKE が新 signature（10 引数）を指す',
    (sql.match(/text, text, text, text, text, int, int, text\[\], int, int/g) ?? []).length >= 2,
  );
  check(
    'Q-6q3 旧 signature への GRANT / REVOKE が残っていない',
    !/(REVOKE|GRANT)[\s\S]{0,120}career_company_enrichment_job_claim\(\s*\n?\s*text, text, text, text, text, int, int, text\[\]\s*\n?\s*\)/.test(sql),
  );
}

// ════════════════════════════════════════════════════════════════════
console.log('[Q-7] コード側との一致（drift 防止）');

check('Q-7a table 名がコードと一致（sources）', sql.includes(CAREER_COMPANY_OFFICIAL_TABLES.sources));
check('Q-7b table 名がコードと一致（facts）', sql.includes(CAREER_COMPANY_OFFICIAL_TABLES.facts));
check('Q-7c table 名がコードと一致（derived）', sql.includes(CAREER_COMPANY_OFFICIAL_TABLES.derived));
check('Q-7d table 名がコードと一致（jobs）', sql.includes(CAREER_COMPANY_OFFICIAL_TABLES.jobs));

check(
  'Q-7e fact_group の CHECK がコードの enum と一致',
  COMPANY_FACT_GROUPS.every((g) => sql.includes(`'${g}'`)) &&
    sql.includes("fact_group IN ('identity','profile','navigation','ir','recruiting','news')"),
);
check(
  'Q-7f extraction_method の CHECK がコードの enum と一致',
  COMPANY_FACT_EXTRACTION_METHODS.every((m) => sql.includes(`'${m}'`)),
);
check('Q-7g source_type の CHECK がコードの enum と一致', COMPANY_SOURCE_TYPES.every((t) => sql.includes(`'${t}'`)));

check(
  'Q-7h lease は route maxDuration より長い（正常実行中の reclaim 競合回避）',
  LEASE_SECONDS > ROUTE_MAX_DURATION_SECONDS,
);
check('Q-7i MAX_ATTEMPTS がコード側で定義されている', MAX_ATTEMPTS >= 1);
check(
  'Q-7j RETRY_LIMIT_REACHED が non-retryable allowlist にある（無限 reclaim を防ぐ）',
  (NONRETRYABLE_ERROR_CODES as readonly string[]).includes('RETRY_LIMIT_REACHED'),
);

// ★ Layer 5（LOCKED）を巻き込んでいない。
check(
  'Q-7k Layer 5 Community table を作らない（LOCKED を解錠しない）',
  !sqlCode.includes('career_company_knowledge_contributions') &&
    !sqlCode.includes('career_company_knowledge_moderation') &&
    !sqlCode.includes('career_company_knowledge_consent_snapshots'),
);
check(
  'Q-7l 個人データ table（applications / research logs）に触れない',
  !sqlCode.includes('career_company_applications') && !sqlCode.includes('career_company_research_logs'),
);

console.log('');
if (failures > 0) {
  console.error(`company official SQL QA: ${failures} FAILED`);
  process.exit(1);
}
console.log('company official SQL QA: ALL PASS');
