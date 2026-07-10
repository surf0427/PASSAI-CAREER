/*
 * scripts/career-consent-proto-schema-qa.ts
 *
 * PASSAI CAREER — Consent persistence LOCAL PROTOTYPE schema 静的 QA（P14-E・6-A / §9 隔離）。
 *
 * live Postgres が無いため、prototype SQL の **構造**を静的検査する（columns / constraints /
 * prohibited fields / append-only policies / RPC security / production 隔離）。
 *
 * 使い方: npx tsx scripts/career-consent-proto-schema-qa.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const SQL_PATH = join(process.cwd(), 'supabase/prototype/consent_local_prototype.sql');

console.log('[0] production 隔離（§9）');
{
  check('prototype SQL が prototype/ 配下に存在', existsSync(SQL_PATH));
  check('*_apply.sql 命名ではない（apply 運用に混入しない）', !SQL_PATH.endsWith('_apply.sql'));
}
const sql = existsSync(SQL_PATH) ? readFileSync(SQL_PATH, 'utf8') : '';

console.log('[1] DO NOT APPLY マーカー');
{
  check('DO NOT APPLY TO PRODUCTION 明記', /DO NOT APPLY TO PRODUCTION/i.test(sql));
  check('LOCAL PROTOTYPE ONLY 明記', /LOCAL PROTOTYPE ONLY/i.test(sql));
}

console.log('[2] tables');
{
  check('career_consent_policies', /CREATE TABLE IF NOT EXISTS career_consent_policies/.test(sql));
  check('career_consent_events', /CREATE TABLE IF NOT EXISTS career_consent_events/.test(sql));
  check('career_consent_withdrawal_outbox', /CREATE TABLE IF NOT EXISTS career_consent_withdrawal_outbox/.test(sql));
}

console.log('[3] ledger constraints');
{
  check('UNIQUE(subject_user_id, server_sequence)', /UNIQUE \(subject_user_id, server_sequence\)/.test(sql));
  check('UNIQUE(subject_user_id, idempotency_key)', /UNIQUE \(subject_user_id, idempotency_key\)/.test(sql));
  check('server_sequence >= 1 check', /server_sequence >= 1/.test(sql));
  check('idempotency_key length > 0 check', /length\(idempotency_key\) > 0/.test(sql));
  check('payload_digest length > 0 check', /length\(payload_digest\) > 0/.test(sql));
  check('scope CHECK enum', /career_consent_events_scope_chk CHECK/.test(sql));
  check('action CHECK enum', /career_consent_events_action_chk CHECK/.test(sql));
  check('active policy 部分 unique index', /career_consent_policies_active_uniq[\s\S]*WHERE active/.test(sql));
}

console.log('[4] prohibited evidence columns が存在しない');
{
  const colDef = (name: string) => new RegExp(`\\n\\s*${name}\\s+(text|varchar|inet|jsonb|bytea)\\b`, 'i');
  for (const bad of ['ip', 'ip_address', 'user_agent', 'ua', 'device_fingerprint', 'fingerprint', 'reason', 'free_text', 'raw_policy', 'policy_text', 'notice_text', 'terms_text', 'email']) {
    check(`列 ${bad} が存在しない`, !colDef(bad).test(sql));
  }
}

console.log('[5] append-only（events に UPDATE/DELETE policy なし）');
{
  check('owner SELECT policy あり', /career_consent_events owner select[\s\S]*FOR SELECT TO authenticated/.test(sql));
  check('events に FOR UPDATE policy なし', !/career_consent_events[\s\S]*FOR UPDATE/.test(sql));
  check('events に FOR DELETE policy なし', !/career_consent_events[\s\S]*FOR DELETE/.test(sql));
  check('events に INSERT policy なし（RPC 経由のみ）', !/POLICY[^\n]*career_consent_events[^\n]*FOR INSERT/.test(sql));
}

console.log('[6] RPC security');
{
  check('SECURITY DEFINER', /SECURITY DEFINER/.test(sql));
  check('SET search_path 固定', /SET search_path = public, pg_temp/.test(sql));
  check('REVOKE ALL ... FROM PUBLIC', /REVOKE ALL ON FUNCTION career_consent_append_prototype[\s\S]*FROM PUBLIC/.test(sql));
  check('authenticated/anon への GRANT EXECUTE なし', !/GRANT EXECUTE ON FUNCTION career_consent_append_prototype[\s\S]*TO (authenticated|anon)/.test(sql));
  check('advisory xact lock 採番', /pg_advisory_xact_lock/.test(sql));
  check('MAX(server_sequence)+1', /MAX\(server_sequence\)[\s\S]{0,12}\+ 1/.test(sql));
  check('client recorded_at を使わず now()', /recorded_at[\s\S]*now\(\)/.test(sql));
  check('withdrawal outbox 同一 txn INSERT', /consent_withdrawn'[\s\S]*INSERT INTO career_consent_withdrawal_outbox/.test(sql));
}

console.log('[7] receipt view（internal 列を出さない・INVOKER）');
{
  check('security_invoker = true', /security_invoker = true/.test(sql));
  const view = sql.slice(sql.indexOf('career_consent_receipt_min'));
  const selectLine = view.slice(0, 300);
  check('receipt view に subject_user_id を出さない', !/SELECT[\s\S]*subject_user_id/.test(selectLine));
  check('receipt view に server_sequence を出さない', !/SELECT[\s\S]*server_sequence/.test(selectLine));
  check('receipt view に idempotency_key を出さない', !/SELECT[\s\S]*idempotency_key/.test(selectLine));
  check('receipt view に payload_digest を出さない', !/SELECT[\s\S]*payload_digest/.test(selectLine));
}

console.log('[8] subject FK は PROVISIONAL（auth.users CASCADE を確定していない）');
{
  check('subject_user_id に auth.users FK を確定していない', !/subject_user_id[^\n]*REFERENCES auth\.users/.test(sql));
  check('PROVISIONAL 明記', /PROVISIONAL/.test(sql));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
