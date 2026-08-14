/*
 * scripts/career-consent-static-guard-qa.ts
 *
 * PASSAI CAREER — Consent Ledger 静的境界 guard（P14-C・I. Static Guard）。
 *
 * 何を守るか（P14-C §20 / §22-I）:
 *   Consent source-of-truth guard:
 *     - mutable boolean-only source of truth なし / defaultConsent=true なし / missing→grant fallback なし
 *     - version なし grant / scope なし grant なし（型で必須）/ client timestamp authoritative なし
 *     - localStorage を source of truth にしない / raw policy text 保存なし
 *   Domain boundary guard:
 *     - careerConsent → matching / Supabase client / AI route / UI component import なし
 *     - matching → careerConsent import なし
 *     - careerConsent が production consumer（app）へ接続されていない
 *     - company knowledge scope の Layer 4 流用なし
 *
 * 対象 directory を限定し、過剰な文字列一致で無関係コードを壊さない。
 *
 * 使い方: npx tsx scripts/career-consent-static-guard-qa.ts
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { DEFAULT_CONSENT_MANIFEST } from '@/lib/careerConsent/policy';

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

const CONSENT_DIR = join(ROOT, 'lib/careerConsent');
const consentFiles = walk(CONSENT_DIR);
const consentSrc = new Map(consentFiles.map((f) => [f, readFileSync(f, 'utf8')]));

console.log('[0] 対象 file');
{
  check('careerConsent module file が存在', consentFiles.length > 0, `${consentFiles.length}`);
}

console.log('[1] source-of-truth guard');
{
  const offenders: string[] = [];
  for (const [f, src] of consentSrc) {
    if (/defaultConsent\s*[:=]\s*true/.test(src)) offenders.push(`${f}:defaultConsent=true`);
    // 実使用のみ検知（コメント上の「localStorage を使わない」等の言及は除外）。
    if (/\blocalStorage\s*[.[]/.test(src) || /window\.localStorage/.test(src)) offenders.push(`${f}:localStorage`);
    if (/from\s+['"][^'"]*safeStorage['"]/.test(src)) offenders.push(`${f}:safeStorage`);
    // mutable boolean-only setter を source of truth にしていない（setConsent(true/false) の実装がない）。
    if (/function\s+setConsent\s*\(/.test(src) || /setConsent\s*=\s*\(/.test(src)) offenders.push(`${f}:setConsent`);
    // raw policy text を **保存** する形（property 代入）。denylist の string literal（'policyText',）は
    // 除外し、実際の代入（policyText: value）だけを検知する。
    if (/\b(policyText|noticeText|termsText|rawPolicy)\s*:/.test(src)) offenders.push(`${f}:rawPolicyText`);
  }
  check('mutable boolean / localStorage / setConsent / raw policy text なし', offenders.length === 0, offenders.join(','));
}

console.log('[2] domain boundary: careerConsent → 禁止 import なし');
{
  const forbidden: Array<{ re: RegExp; label: string }> = [
    { re: /from\s+['"][^'"]*\/matching[^'"]*['"]/, label: 'matching' },
    { re: /from\s+['"]@\/lib\/supabase[^'"]*['"]/, label: 'supabase client' },
    { re: /from\s+['"]@\/lib\/careerSupabase[^'"]*['"]/, label: 'careerSupabase' },
    { re: /from\s+['"]next\/server['"]/, label: 'next/server (API)' },
    { re: /from\s+['"]@\/components[^'"]*['"]/, label: 'UI component' },
    { re: /from\s+['"]react['"]/, label: 'react' },
  ];
  const offenders: string[] = [];
  for (const [f, src] of consentSrc) {
    for (const { re, label } of forbidden) if (re.test(src)) offenders.push(`${f}:${label}`);
  }
  check('careerConsent が matching/Supabase/AI route/UI を import しない', offenders.length === 0, offenders.join(','));
}

console.log('[3] domain boundary: matching → careerConsent import なし');
{
  const matchingFiles = ['lib/matching', 'lib/career/matching', 'app/career/matching'].map((d) => join(ROOT, d)).flatMap(walk);
  const offenders = matchingFiles.filter((f) => /from\s+['"][^'"]*careerConsent[^'"]*['"]/.test(readFileSync(f, 'utf8')));
  check('matching が careerConsent を import しない', offenders.length === 0, offenders.join(','));
}

console.log('[4] production consumer は gated capture surface に限る');
{
  // ★ NEXT-7 で契約を更新（弱体化ではない）:
  //   consent capture surface（/api/career/consent）だけが careerConsent を import してよい。
  //   それ以外の app ファイルからの import は従来どおり禁止（AI route / matching / 機能画面へ
  //   consent を持ち込ませない）。さらに許可した 1 ファイルには **fail-closed の実体検査**を課す。
  const ALLOWED_APP_IMPORTERS: readonly string[] = ['app/api/career/consent/route.ts'];
  const appFiles = ['app/career', 'app/api'].map((d) => join(ROOT, d)).flatMap(walk);
  const importers = appFiles.filter((f) =>
    /from\s+['"][^'"]*careerConsent[^'"]*['"]/.test(readFileSync(f, 'utf8')),
  );
  const rel = (f: string) => f.slice(ROOT.length + 1).split(sep).join('/');
  const offenders = importers.map(rel).filter((f) => !ALLOWED_APP_IMPORTERS.includes(f));
  check(
    'gated capture surface 以外の app ファイルが careerConsent を import しない',
    offenders.length === 0,
    offenders.join(','),
  );

  // 許可した surface の fail-closed 実体（gate 評価・production repository 未接続・service role 不使用）。
  const routePath = join(ROOT, 'app/api/career/consent/route.ts');
  if (existsSync(routePath)) {
    const src = readFileSync(routePath, 'utf8');
    check('capture surface が gate を評価する', /loadConsentCaptureGate\(\)/.test(src));
    check('capture surface は gate 閉時に何も書かない', /if\s*\(!gate\.enabled\)\s*return\s+disabledResponse/.test(src));
    check('capture surface の production repository は未接続', /repository:\s*null/.test(src));
    check('capture surface が service role を使わない', !/serviceRole|SERVICE_ROLE/.test(src));
  } else {
    check('capture surface が存在する', false, 'app/api/career/consent/route.ts が無い');
  }
}

console.log('[5] Layer 5 分離');
{
  check('company_knowledge_contribution は usableInLayer4=false', DEFAULT_CONSENT_MANIFEST.company_knowledge_contribution.usableInLayer4 === false);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
