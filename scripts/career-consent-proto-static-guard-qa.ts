/*
 * scripts/career-consent-proto-static-guard-qa.ts
 *
 * PASSAI CAREER — Consent persistence prototype 静的境界 + production 隔離 QA（P14-E・6-I / §9）。
 *
 * 使い方: npx tsx scripts/career-consent-proto-static-guard-qa.ts
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

const PROTO_DIR = join(ROOT, 'lib/careerConsent/prototype');
const protoFiles = walk(PROTO_DIR);
const protoSrc = new Map(protoFiles.map((f) => [f, readFileSync(f, 'utf8')]));
const MODEL = join(PROTO_DIR, 'localLedgerModel.ts');
const ADAPTER = join(PROTO_DIR, 'localRepositoryAdapter.ts');

console.log('[0] files');
{
  check('prototype model 存在', existsSync(MODEL));
  check('prototype adapter 存在', existsSync(ADAPTER));
}

console.log('[1] adapter は server-only');
{
  const src = existsSync(ADAPTER) ? readFileSync(ADAPTER, 'utf8') : '';
  check("adapter に import 'server-only'", /import ['"]server-only['"]/.test(src));
}

console.log('[2] prototype → 禁止 import なし');
{
  const forbidden: Array<{ re: RegExp; label: string }> = [
    { re: /from\s+['"][^'"]*\/matching[^'"]*['"]/, label: 'matching' },
    { re: /from\s+['"]@\/lib\/supabase[^'"]*['"]/, label: 'supabase client' },
    { re: /from\s+['"]@\/lib\/careerSupabase[^'"]*['"]/, label: 'careerSupabase' },
    { re: /from\s+['"]next\/server['"]/, label: 'next/server' },
    { re: /from\s+['"]@\/components[^'"]*['"]/, label: 'UI component' },
    { re: /getCareerServiceRoleSupabaseClient|getServiceRoleSupabaseClient/, label: 'service-role client' },
  ];
  const offenders: string[] = [];
  for (const [f, src] of protoSrc) for (const { re, label } of forbidden) if (re.test(src)) offenders.push(`${f}:${label}`);
  check('prototype が matching/supabase/service-role/UI/API を import しない', offenders.length === 0, offenders.join(','));
}

console.log('[3] matching → consent prototype import なし');
{
  const matchingFiles = ['lib/matching', 'lib/career/matching', 'app/career/matching'].map((d) => join(ROOT, d)).flatMap(walk);
  const off = matchingFiles.filter((f) => /careerConsent/.test(readFileSync(f, 'utf8')));
  check('matching が careerConsent を import しない', off.length === 0, off.join(','));
}

console.log('[4] production 隔離: app / AI route が prototype を import しない');
{
  const appFiles = ['app/career', 'app/api'].map((d) => join(ROOT, d)).flatMap(walk);
  const off = appFiles.filter((f) => /careerConsent\/prototype|consent_local_prototype/.test(readFileSync(f, 'utf8')));
  check('production consumer が prototype を import しない', off.length === 0, off.join(','));
}

console.log('[5] prohibited evidence 列名を model/adapter が持たない');
{
  const offenders: string[] = [];
  for (const [f, src] of protoSrc) {
    for (const bad of ['deviceFingerprint', 'userAgent', 'ipAddress', 'rawPolicy', 'policyText', 'noticeText']) {
      // 代入/宣言としての使用（コメントは除外するため property 形を検査）。
      if (new RegExp(`\\b${bad}\\s*[:=]`).test(src)) offenders.push(`${f}:${bad}`);
    }
  }
  check('model/adapter に prohibited evidence field なし', offenders.length === 0, offenders.join(','));
}

console.log('[6] current-state を source of truth にしない');
{
  const sqlPath = join(ROOT, 'supabase/prototype/consent_local_prototype.sql');
  const sql = existsSync(sqlPath) ? readFileSync(sqlPath, 'utf8') : '';
  check('materialized current-state table を作っていない', !/CREATE TABLE[^\n]*current_state/i.test(sql));
  // model にも current-state cache table 相当のフィールドが source of truth になっていない（events 配列が正）。
  const model = protoSrc.get(MODEL) ?? '';
  check('model の source of truth は events（append-only 配列）', /private events:/.test(model));
}

console.log('[7] prototype は production Supabase / env 実値を参照しない');
{
  const offenders: string[] = [];
  for (const [f, src] of protoSrc) {
    if (/process\.env\./.test(src)) offenders.push(`${f}:process.env`);
    if (/createClient\(/.test(src)) offenders.push(`${f}:createClient`);
  }
  check('prototype が env 実値 / Supabase client 生成をしない', offenders.length === 0, offenders.join(','));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
