/*
 * scripts/career-aggregate-matching-guard-qa.ts
 *
 * PASSAI CAREER — Aggregated Insight ↔ matching 完全非接続 静的 guard（P14-B・H. Matching Static Guard）。
 *
 * 何を守るか（P14-A §Matching policy / §Consumer boundary）:
 *   1. aggregate module（lib/careerAggregate/**）が matching module を import しない。
 *   2. matching module（lib/matching/**, lib/career/matching/**, app/career/matching/**）が
 *      aggregate module を import しない。
 *   3. aggregate module に matching 用 adapter / mapper / converter（score / ranking / readiness /
 *      success / confidence / candidate generation への変換）が存在しない。
 *   4. consumer capability allowlist で matching が permanentlyProhibited=true。
 *   5. aggregate module が production consumer（consultation / mypage route・AI route）へ import されない。
 *
 * 設計（脆さ回避）: 行番号固定せず、対象 directory を限定し import 文字列で照合する。
 *
 * 使い方: npx tsx scripts/career-aggregate-matching-guard-qa.ts
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONSUMER_CAPABILITIES, isConsumerConnected } from '@/lib/careerAggregate/policy';

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
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const AGG_DIR = join(ROOT, 'lib/careerAggregate');
const MATCHING_DIRS = ['lib/matching', 'lib/career/matching', 'app/career/matching'].map((d) => join(ROOT, d));

const aggFiles = walk(AGG_DIR);
const matchingFiles = MATCHING_DIRS.flatMap(walk);

console.log('[0] 対象 file が見つかる');
{
  check('aggregate module file が存在', aggFiles.length > 0, `${aggFiles.length}`);
  check('matching module file が存在', matchingFiles.length > 0, `${matchingFiles.length}`);
}

console.log('[1] aggregate → matching import なし');
{
  const offenders: string[] = [];
  for (const f of aggFiles) {
    const src = readFileSync(f, 'utf8');
    // import 文中に matching を指す path があれば違反。
    if (/from\s+['"][^'"]*\/matching[^'"]*['"]/.test(src) || /from\s+['"]@\/lib\/matching[^'"]*['"]/.test(src)) {
      offenders.push(f);
    }
  }
  check('aggregate module が matching を import しない', offenders.length === 0, offenders.join(','));
}

console.log('[2] matching → aggregate import なし');
{
  const offenders: string[] = [];
  for (const f of matchingFiles) {
    const src = readFileSync(f, 'utf8');
    if (/from\s+['"][^'"]*careerAggregate[^'"]*['"]/.test(src)) offenders.push(f);
  }
  check('matching module が careerAggregate を import しない', offenders.length === 0, offenders.join(','));
}

console.log('[3] aggregate に matching 変換 utility が存在しない');
{
  // aggregate module 全体に、matching score/ranking/readiness/success への変換を示す識別子が無いこと。
  // （コメント内の禁止説明は許容するため、export 宣言や関数名に限定した token を照合）。
  const forbiddenSymbols = [
    'toMatchingScore', 'toMatchingContext', 'toMatchingPrompt', 'toReadiness', 'toSuccess',
    'toConfidence', 'toCandidate', 'buildMatchingContext', 'matchingAdapter', 'matchingMapper',
    'asMatchingInput', 'toRanking',
  ];
  const offenders: string[] = [];
  for (const f of aggFiles) {
    const src = readFileSync(f, 'utf8');
    for (const sym of forbiddenSymbols) {
      // 宣言/関数名として現れる形のみ（`function sym` / `const sym` / `export ... sym(` / `sym =`）。
      const re = new RegExp(`(function|const|let|export)\\s+[^\\n;]*\\b${sym}\\b|\\b${sym}\\s*[:=(]`);
      if (re.test(src)) offenders.push(`${f}:${sym}`);
    }
  }
  check('matching 変換 utility が存在しない', offenders.length === 0, offenders.join(','));
}

console.log('[4] consumer capability boundary');
{
  const matching = CONSUMER_CAPABILITIES.find((c) => c.consumer === 'matching');
  check('matching が capability allowlist に存在', matching !== undefined);
  check('matching は permanentlyProhibited=true', matching?.permanentlyProhibited === true);
  check('matching は futureAllowed=false', matching?.futureAllowed === false);
  check('全 consumer が現在 not_connected', CONSUMER_CAPABILITIES.every((c) => c.currentConnection === 'not_connected'));
  check('isConsumerConnected は常に false（production 非接続）', CONSUMER_CAPABILITIES.every((c) => isConsumerConnected(c.consumer) === false));
}

console.log('[5] aggregate module が production consumer へ import されていない');
{
  // consultation / mypage route・AI route・各機能 page から careerAggregate を import していないこと。
  const consumerDirs = ['app/career', 'app/api'].map((d) => join(ROOT, d));
  const consumerFiles = consumerDirs.flatMap(walk);
  const offenders: string[] = [];
  for (const f of consumerFiles) {
    const src = readFileSync(f, 'utf8');
    if (/from\s+['"][^'"]*careerAggregate[^'"]*['"]/.test(src)) offenders.push(f);
  }
  check('production consumer が careerAggregate を import しない（未接続）', offenders.length === 0, offenders.join(','));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
