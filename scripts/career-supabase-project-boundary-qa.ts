/*
 * scripts/career-supabase-project-boundary-qa.ts
 *
 * PASSAI CAREER — Supabase **Project 境界**の静的 guard（dev-only / 実 DB 非接続）。
 *
 * 背景:
 *   Project A（受験版 / NEXT_PUBLIC_SUPABASE_*）と Project B（就活版 / NEXT_PUBLIC_CAREER_SUPABASE_*）
 *   は物理的に別の Supabase プロジェクト。auth.uid() 空間が分かれているため、career runtime が
 *   一箇所でも Project A の client / auth / env を掴むと、identity は Project B・data は Project A に
 *   書かれる **split-brain** が発生する（docs/auth/career_login_design.md）。
 *
 *   この QA は「career runtime から Project A への依存 = 0」を **静的に固定**し、将来の refactor で
 *   誤って再接続する regression を防ぐ。
 *
 * 検査内容:
 *   [1] career runtime から Project A の client/auth/env module を import していないこと
 *       （`@/...` alias・相対 path の両方を解決して判定する）。
 *   [2] career runtime が lib/supabase/ から import してよいのは allowlist だけ（default-deny）。
 *   [3] career runtime に Project A の client factory 識別子が出現しないこと。
 *   [4] lib/careerSupabase/env.ts に Project A の env 名が存在しないこと。
 *   [5] career env boundary が CAREER 専用 env を直接リテラル参照していること。
 *
 * ★ 実 Supabase へ接続しない・env 実値を読まない・secret を表示しない。
 * 使い方: npx tsx scripts/career-supabase-project-boundary-qa.ts
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

const ROOT = process.cwd();

let failures = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failures++;
};
const fail = (msg: string) => {
  console.log(`  FAIL  ${msg}`);
  failures++;
};

// ── career runtime の scan 対象 ────────────────────────────────
//
// 「career runtime」= Project B で閉じなければならないコード全部。
// app/api/cron/gd-cleanup は app/api/career/** の外だが career_gd_* を掃除する career runtime。
// lib/supabase/career*.ts は物理配置こそ受験版 dir だが中身は career mirror（career runtime）。
const SCAN_DIRS = [
  'app/career',
  'app/api/career',
  'app/api/cron/gd-cleanup',
  'components/career',
];
const SCAN_DIR_PREFIXES = [{ base: 'lib', prefix: 'career' }]; // lib/career*/**
const SCAN_FILE_GLOBS = [{ dir: 'lib/supabase', prefix: 'career' }]; // lib/supabase/career*.ts

// ── Project A（受験版）側の禁止 module（repo-root 相対・拡張子なし）──────
const FORBIDDEN_MODULES = new Map<string, string>([
  ['lib/supabase/browserClient', 'Project A browser Supabase client'],
  ['lib/supabase/serverClient', 'Project A server Supabase client'],
  ['lib/supabase/serviceRoleClient', 'Project A service-role Supabase client'],
  ['lib/supabase/auth', 'Project A auth (session/OTP) helper'],
  ['lib/supabase/env', 'Project A Supabase env boundary'],
  ['app/components/AuthProvider', 'Project A (受験版) identity provider'],
]);

// ── lib/supabase/ から career runtime が import してよい module（default-deny の例外）──
//
// allowlist は「Project A の env / client / auth に一切依存しない純粋 helper」だけ。
// 実コードを読んで確認済み:
//   - lib/supabase/retryingFetch.ts : `import 'server-only'` のみ。process.env 参照なし・client 生成なし。
//   - lib/supabase/email.ts         : import 0 件。純粋な文字列 validator。
// lib/supabase/career* は career mirror 本体（= scan 対象側）なので当然許可。
const LIB_SUPABASE_ALLOWLIST = new Set([
  'lib/supabase/retryingFetch',
  'lib/supabase/email',
]);
const isCareerMirrorModule = (mod: string) =>
  mod.startsWith('lib/supabase/career');

// ── Project A の client factory 識別子（コード中に出たら誤配線）──────────
const FORBIDDEN_IDENTIFIERS = [
  'getBrowserSupabaseClient',
  'getServerSupabaseClient',
  'getServiceRoleSupabaseClient',
  'getSupabaseServiceRoleKey',
];

// ── file 収集 ────────────────────────────────────────────────
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

function collectCareerRuntimeFiles(): string[] {
  const files = new Set<string>();
  for (const d of SCAN_DIRS) walk(join(ROOT, d)).forEach((f) => files.add(f));
  for (const { base, prefix } of SCAN_DIR_PREFIXES) {
    const baseDir = join(ROOT, base);
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSync(baseDir)) {
      if (!entry.startsWith(prefix)) continue;
      const p = join(baseDir, entry);
      if (statSync(p).isDirectory()) walk(p).forEach((f) => files.add(f));
    }
  }
  for (const { dir, prefix } of SCAN_FILE_GLOBS) {
    const d = join(ROOT, dir);
    if (!existsSync(d)) continue;
    for (const entry of readdirSync(d)) {
      if (entry.startsWith(prefix) && /\.(ts|tsx)$/.test(entry)) {
        files.add(join(d, entry));
      }
    }
  }
  return [...files].sort();
}

// ── comment を潰す（識別子検査を「実コードのみ」に限定するため）──────────
function stripComments(src: string): string {
  // block comment / line comment を同じ長さの空白へ置換（行番号を保つ）。
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

// ── import specifier 抽出（static / re-export / dynamic / require）──────
function extractSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** import specifier を repo-root 相対の module path（拡張子なし）へ解決。外部 package は null。 */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let abs: string;
  if (spec.startsWith('@/')) {
    abs = join(ROOT, spec.slice(2));
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    abs = resolve(dirname(fromFile), spec);
  } else {
    return null; // bare package
  }
  return relative(ROOT, abs).split('\\').join('/').replace(/\.(ts|tsx|js|jsx)$/, '');
}

// ═══════════════════════════════════════════════════════════════
console.log('PASSAI CAREER — Supabase project boundary QA (Project A ⇄ Project B)');
console.log('');

const files = collectCareerRuntimeFiles();
console.log(`[0] career runtime scan scope`);
check(files.length > 0, `career runtime files found (${files.length})`);
console.log('');

// ── [1] 禁止 module import ────────────────────────────────────
console.log('[1] NO import of Project A client/auth/env from career runtime');
{
  let violations = 0;
  for (const file of files) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, 'utf8');
    const code = stripComments(src);
    const lines = code.split('\n');
    for (const spec of extractSpecifiers(code)) {
      const mod = resolveSpecifier(spec, file);
      if (!mod) continue;
      const why = FORBIDDEN_MODULES.get(mod);
      if (!why) continue;
      const lineNo = lines.findIndex((l) => l.includes(spec)) + 1;
      fail(`${rel}:${lineNo || '?'} imports "${spec}" → ${mod} (${why})`);
      violations++;
    }
  }
  if (violations === 0) {
    check(true, 'no career runtime file imports a Project A client/auth/env module');
  }
}
console.log('');

// ── [2] lib/supabase/ は default-deny + allowlist ──────────────
console.log('[2] career runtime imports from lib/supabase/ are allowlisted only');
{
  let violations = 0;
  for (const file of files) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, 'utf8');
    const code = stripComments(src);
    const lines = code.split('\n');
    for (const spec of extractSpecifiers(code)) {
      const mod = resolveSpecifier(spec, file);
      if (!mod || !mod.startsWith('lib/supabase/')) continue;
      if (LIB_SUPABASE_ALLOWLIST.has(mod) || isCareerMirrorModule(mod)) continue;
      if (FORBIDDEN_MODULES.has(mod)) continue; // [1] で報告済み（二重計上しない）
      const lineNo = lines.findIndex((l) => l.includes(spec)) + 1;
      fail(`${rel}:${lineNo || '?'} imports non-allowlisted Project A module "${mod}"`);
      violations++;
    }
  }
  if (violations === 0) {
    check(true, 'only project-neutral helpers (retryingFetch / email) + career mirrors are imported');
  }
}
console.log('');

// ── [3] Project A client factory 識別子 ────────────────────────
console.log('[3] NO Project A client factory identifiers in career runtime code');
{
  let violations = 0;
  for (const file of files) {
    const rel = relative(ROOT, file);
    const code = stripComments(readFileSync(file, 'utf8'));
    const lines = code.split('\n');
    for (const ident of FORBIDDEN_IDENTIFIERS) {
      // CAREER 版（getCareerServerSupabaseClient 等）に誤 match しないよう境界を付ける。
      const re = new RegExp(`(?<![A-Za-z0-9_])${ident}(?![A-Za-z0-9_])`);
      lines.forEach((line, i) => {
        if (re.test(line)) {
          fail(`${rel}:${i + 1} references Project A factory "${ident}"`);
          violations++;
        }
      });
    }
  }
  if (violations === 0) {
    check(true, 'career runtime uses only getCareer* factories');
  }
}
console.log('');

// ── [4] career env boundary に Project A env 名が無いこと ───────
console.log('[4] lib/careerSupabase/env.ts contains NO Project A env names');
{
  const envPath = join(ROOT, 'lib/careerSupabase/env.ts');
  const env = readFileSync(envPath, 'utf8');
  // ★ CAREER_SUPABASE_SERVICE_ROLE_KEY は SUPABASE_SERVICE_ROLE_KEY を部分文字列として含む。
  //   naive な substring 検査だと誤検知するため、直前に CAREER_ が付かないものだけを拾う。
  const forbidden: Array<[string, RegExp]> = [
    ['NEXT_PUBLIC_SUPABASE_URL', /(?<!CAREER_)NEXT_PUBLIC_SUPABASE_URL/],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', /(?<!CAREER_)NEXT_PUBLIC_SUPABASE_ANON_KEY/],
    ['SUPABASE_SERVICE_ROLE_KEY', /(?<!CAREER_)SUPABASE_SERVICE_ROLE_KEY/],
  ];
  for (const [name, re] of forbidden) {
    check(!re.test(env), `lib/careerSupabase/env.ts has no reference to ${name}`);
  }
  check(
    !/NODE_ENV/.test(env),
    'lib/careerSupabase/env.ts has no NODE_ENV branch (no dev-only fallback to Project A)',
  );
}
console.log('');

// ── [5] CAREER env の直接リテラル参照（inline 保全）─────────────
console.log('[5] career env boundary reads CAREER-only env by direct literal reference');
{
  const env = readFileSync(join(ROOT, 'lib/careerSupabase/env.ts'), 'utf8');
  check(
    /process\.env\.NEXT_PUBLIC_CAREER_SUPABASE_URL\b/.test(env),
    'reads process.env.NEXT_PUBLIC_CAREER_SUPABASE_URL (literal)',
  );
  check(
    /process\.env\.NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY\b/.test(env),
    'reads process.env.NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY (literal)',
  );
  check(
    /process\.env\.CAREER_SUPABASE_SERVICE_ROLE_KEY\b/.test(env),
    'reads process.env.CAREER_SUPABASE_SERVICE_ROLE_KEY (literal)',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
if (failures === 0) {
  console.log('ALL PASS — career runtime has ZERO Project A dependency.');
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S) — career runtime still depends on Project A.`);
  process.exit(1);
}
