/*
 * scripts/career-supabase-env-inline-qa.ts
 *
 * PASSAI CAREER — CAREER 公開 env の client inline 安全性を静的に守る guard（dev-only）。
 *
 * 背景（P16-D login audit）: Next.js は client bundle へ `process.env.NEXT_PUBLIC_*` を **直接メンバ参照の
 *   ときだけ** build 時に inline する（値を hard-code 置換）。dynamic lookup（process.env[key] / const e =
 *   process.env / 分割代入 / Object.keys(process.env)）は inline されず、browser で undefined になる。
 *   本 QA は lib/careerSupabase/env.ts が **直接リテラル参照**を保ち、dynamic lookup を混入させないことを
 *   静的に検証する（将来の refactor で inline が壊れる regression を防ぐ）。
 *
 * ★ 値は一切表示しない（present/absent の boolean のみ）。実 Supabase 非接続・OTP 非送信・secret 非表示。
 * 使い方: npx tsx scripts/career-supabase-env-inline-qa.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) failures++; };

const ENV_TS = join(ROOT, 'lib/careerSupabase/env.ts');
const env = readFileSync(ENV_TS, 'utf8');

console.log('[1] direct literal NEXT_PUBLIC references (inline-safe form)');
check(/process\.env\.NEXT_PUBLIC_CAREER_SUPABASE_URL\b/.test(env), 'env.ts references process.env.NEXT_PUBLIC_CAREER_SUPABASE_URL (literal)');
check(/process\.env\.NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY\b/.test(env), 'env.ts references process.env.NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY (literal)');

console.log('[2] NO dynamic process.env lookup in lib/careerSupabase (would break inline)');
const DYNAMIC_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /process\.env\[/, label: 'process.env[computedKey]' },
  { re: /(?:const|let|var)\s+\w+\s*=\s*process\.env\s*[;\n]/, label: 'alias: const x = process.env' },
  { re: /\{[^}]*\}\s*=\s*process\.env/, label: 'destructure: { X } = process.env' },
  { re: /Object\.(keys|entries|values|assign)\(\s*process\.env/, label: 'Object.*(process.env)' },
  { re: /\.\.\.process\.env/, label: 'spread ...process.env' },
];
for (const f of readdirSync(join(ROOT, 'lib/careerSupabase')).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(join(ROOT, 'lib/careerSupabase', f), 'utf8');
  for (const p of DYNAMIC_PATTERNS) {
    check(!p.re.test(src), `lib/careerSupabase/${f}: no ${p.label}`);
  }
}

console.log('[3] Project A fallback ban（全環境・Project B 完全分離後の契約）');
// Project B 完全分離により、旧「development / test に限り受験版 env へ fallback」は **削除**された。
// fallback が残っていると CAREER env の設定漏れが Project A 接続で隠れ、split-brain を生む。
// → NODE_ENV による環境分岐そのものが存在しないことを契約として固定する。
check(!/NODE_ENV/.test(env), 'env.ts に NODE_ENV 分岐が無い（環境別 fallback を持たない）');
// ★ CAREER_SUPABASE_SERVICE_ROLE_KEY は SUPABASE_SERVICE_ROLE_KEY を部分文字列として含むため、
//   直前に CAREER_ が付かないものだけを Project A 参照として検出する。
check(!/(?<!CAREER_)NEXT_PUBLIC_SUPABASE_URL/.test(env), 'env.ts が Project A の URL env を参照しない');
check(!/(?<!CAREER_)NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(env), 'env.ts が Project A の anon key env を参照しない');
check(!/(?<!CAREER_)SUPABASE_SERVICE_ROLE_KEY/.test(env), 'env.ts が Project A の service role key env を参照しない');
check(/if\s*\(\s*!url\s*\|\|\s*!anonKey\s*\)\s*return null/.test(env), 'url または anonKey 欠落で null（→ client null → no-env）ロジック維持');

console.log('[4] safe presence probe（値非表示・現 dev 環境の boolean のみ・assert しない）');
{
  // tsx(Node) では process.env は runtime read（webpack inline ではない）。値は出さず present のみ。
  const urlPresent = typeof process.env.NEXT_PUBLIC_CAREER_SUPABASE_URL === 'string' && process.env.NEXT_PUBLIC_CAREER_SUPABASE_URL.trim() !== '';
  const anonPresent = typeof process.env.NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY === 'string' && process.env.NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY.trim() !== '';
  console.log(`  INFO  careerUrlPresent=${urlPresent} careerAnonKeyPresent=${anonPresent} careerEnvAvailable=${urlPresent && anonPresent}（現 dev 環境。build 環境とは別。値は非表示）`);
}

console.log('');
console.log(failures === 0 ? 'career-supabase-env-inline-qa: ALL PASS' : `career-supabase-env-inline-qa: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
