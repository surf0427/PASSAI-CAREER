/*
 * scripts/career-legacy-bootstrap-boundary-qa.ts
 *
 * PASSAI CAREER — 受験版（Project A）legacy bootstrap が CAREER runtime から
 * **到達不能**であることの静的 guard（dev-only / 実 DB 非接続）。
 *
 * 背景:
 *   ルート layout（app/layout.tsx）は全ルート共通で受験版 AuthProvider を mount する。
 *   そのため CAREER のページを開いただけで Project A の identity 解決（profiles）と
 *   受験版 feature の restore が起動し、CAREER Supabase（Project B）に存在しない
 *   legacy table へ REST request が飛んで 404 になっていた。
 *
 * 検査内容:
 *   [1] AuthProvider が lib/examRuntimeRoutes の allowlist で route gate されていること。
 *   [2] EXAM_IDENTITY_PREFIXES に CAREER surface（'/' / '/career'）が混入していないこと。
 *   [3] AuthProvider（Project A identity）の consumer が受験版ルート配下だけであること。
 *   [4] legacy 5 table の識別子が CAREER runtime のファイルに 0 件であること。
 *
 * ★ 実 Supabase へ接続しない・env 実値を読まない・secret を表示しない。
 * 使い方: npx tsx scripts/career-legacy-bootstrap-boundary-qa.ts
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

import { EXAM_IDENTITY_PREFIXES, isExamIdentityPath } from '../lib/examRuntimeRoutes';

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

// ── 走査対象 ────────────────────────────────────────────────────
const CODE_DIRS = ['app', 'components', 'hooks', 'lib'];
const CODE_EXT = /\.(ts|tsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) walk(relative(ROOT, full), out);
    else if (CODE_EXT.test(entry)) out.push(relative(ROOT, full));
  }
  return out;
}

const FILES = CODE_DIRS.flatMap((d) => walk(d));

// ── CAREER runtime（Project B で閉じるべきコード）の判定 ───────────
//   career-supabase-project-boundary-qa.ts の SCAN 定義と同じ範囲。
const isCareerRuntimeFile = (f: string) =>
  f.startsWith('app/career/') ||
  f.startsWith('app/api/career/') ||
  f.startsWith('app/api/cron/gd-cleanup') ||
  f.startsWith('components/career/') ||
  /^lib\/career[^/]*\//.test(f) ||
  /^lib\/supabase\/career[^/]*\.tsx?$/.test(f);

// ── [1] AuthProvider の route gate ────────────────────────────────
console.log('\n[1] 受験版 AuthProvider の route gate');
{
  const p = 'app/components/AuthProvider.tsx';
  const src = readFileSync(join(ROOT, p), 'utf8');
  check(
    /from ['"]@\/lib\/examRuntimeRoutes['"]/.test(src),
    `${p} が lib/examRuntimeRoutes を import している`,
  );
  check(
    /isExamIdentityPath\(/.test(src) && /usePathname\(/.test(src),
    `${p} が usePathname + isExamIdentityPath で route gate している`,
  );
  // gate は resolveSession / ensureProfile より前に「早期 return」していること。
  const gateIdx = src.indexOf('if (!examIdentityRoute)');
  const sessionIdx = src.indexOf('await resolveSession()');
  const profileIdx = src.indexOf('await ensureProfile(');
  check(
    gateIdx > -1 && sessionIdx > gateIdx && profileIdx > gateIdx,
    `${p} の gate が resolveSession / ensureProfile より前にある`,
  );
  check(
    /\}, \[examIdentityRoute\]\);/.test(src),
    `${p} の bootstrap effect が examIdentityRoute に依存している`,
  );
  // 受験版ルート以外では context 値も inert（guest 確定）に倒すこと。
  // 内部 state をそのまま公開すると、CAREER→受験版→CAREER 遷移で member が漏れる。
  check(
    /const value: AuthContextValue = examIdentityRoute/.test(src),
    `${p} が受験版ルート以外で inert な context 値を公開している`,
  );
}

// ── [2] allowlist に CAREER surface が混入していないこと ──────────
console.log('\n[2] EXAM_IDENTITY_PREFIXES の健全性');
{
  const prefixes = EXAM_IDENTITY_PREFIXES as readonly string[];
  check(!prefixes.includes('/'), "'/'（CAREER LP）が allowlist に無い");
  check(
    !prefixes.some((p) => p === '/career' || p.startsWith('/career/')),
    "'/career*' が allowlist に無い",
  );
  check(
    prefixes.every((p) => p.startsWith('/') && !p.endsWith('/')),
    'prefix がすべて先頭 / ・末尾 / なしで正規化されている',
  );
  // 代表的な CAREER route が gate で落ちること。
  for (const route of ['/', '/career', '/career/profile', '/career/home', '/career/self-analysis']) {
    check(!isExamIdentityPath(route), `isExamIdentityPath('${route}') === false`);
  }
  // 代表的な受験版 route は通ること（受験版の挙動を壊していない）。
  for (const route of ['/home', '/input/basic', '/input/activity', '/diagnosis', '/self-analysis/run', '/account', '/mypage', '/pricing']) {
    check(isExamIdentityPath(route), `isExamIdentityPath('${route}') === true`);
  }
}

// ── [3] AuthProvider consumer の所在 ──────────────────────────────
console.log('\n[3] 受験版 AuthProvider consumer の所在');
{
  // route を持たない共有 shell / 受験版専用 hook。CAREER runtime からは import されない
  // ことを下で別途検査する。
  const SHARED_CONSUMER_ALLOWLIST = new Map<string, string>([
    ['app/layout.tsx', 'provider 本体の mount 元（gate は provider 内部）'],
    ['app/components/PlanGate.tsx', '受験版の課金認可ガード。CAREER route は PROTECTED_PREFIXES 外'],
    ['app/components/landing/PricingCheckoutButton.tsx', '/pricing の Stripe CTA（LP には非掲載）'],
    ['hooks/useActivityForm.ts', '受験版 /input/activity 専用 hook'],
  ]);

  const IMPORT_RE = /from ['"](?:@\/)?app\/components\/AuthProvider['"]/;
  const consumers = FILES.filter(
    (f) => f !== 'app/components/AuthProvider.tsx' && IMPORT_RE.test(readFileSync(join(ROOT, f), 'utf8')),
  );

  for (const f of consumers) {
    if (isCareerRuntimeFile(f)) {
      fail(`${f} : CAREER runtime が Project A identity を import している`);
      continue;
    }
    if (SHARED_CONSUMER_ALLOWLIST.has(f)) {
      check(true, `${f} : 共有 shell（${SHARED_CONSUMER_ALLOWLIST.get(f)}）`);
      continue;
    }
    if (!f.startsWith('app/')) {
      fail(`${f} : app/ 外の未登録 consumer。allowlist に理由付きで登録すること`);
      continue;
    }
    // app/<seg>/... → '/<seg>' が受験版 allowlist に載っているか。
    const route = '/' + f.slice('app/'.length).split('/')[0];
    check(isExamIdentityPath(route), `${f} : 受験版ルート ${route} 配下`);
  }

  // 共有 shell / 受験版 hook が CAREER runtime から import されていないこと。
  for (const shared of SHARED_CONSUMER_ALLOWLIST.keys()) {
    const mod = shared.replace(/\.(ts|tsx)$/, '');
    const re = new RegExp(`from ['"](?:@/)?${mod.replace(/[/.]/g, (m) => '\\' + m)}['"]`);
    const careerImporters = FILES.filter(
      (f) => isCareerRuntimeFile(f) && re.test(readFileSync(join(ROOT, f), 'utf8')),
    );
    check(careerImporters.length === 0, `${shared} を CAREER runtime が import していない`);
  }
}

// ── [4] legacy table 識別子の CAREER runtime 混入 ─────────────────
console.log('\n[4] legacy 5 table の CAREER runtime 到達');
{
  const LEGACY_TABLES = [
    'profiles',
    'basic_info_logs',
    'diagnosis_logs',
    'activity_logs',
    'self_analysis_logs',
  ] as const;

  // コメントを除去してから判定する。日本語コメント中の「受験版 profiles には依存しない」
  // のような **説明** を runtime 参照と誤判定しないため（＝分類: comment / 非到達）。
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const careerFiles = FILES.filter(isCareerRuntimeFile);
  const careerCode = new Map(
    careerFiles.map((f) => [f, stripComments(readFileSync(join(ROOT, f), 'utf8'))] as const),
  );

  for (const table of LEGACY_TABLES) {
    // runtime 参照 = クォートされた識別子（.from('x') / const TABLE = "x" / table map の値）。
    // career_profiles 等に誤反応しないよう、クォート境界ごと一致させる。
    const re = new RegExp(`(['\"\`])${table}\\1`);
    const hits = careerFiles.filter((f) => re.test(careerCode.get(f) ?? ''));
    check(
      hits.length === 0,
      `${table} : CAREER runtime reachable = 0${hits.length ? ` (${hits.join(', ')})` : ''}`,
    );
  }
}

// ── [5] CAREER entrypoint からの **静的** module 到達 ──────────────
//
// route gate は「実行されない」ことを保証するが、静的 import で繋がっていると
// Project A の client / env / table 境界が CAREER のページに同梱される。
// CAREER の entrypoint（/career 配下・CAREER LP・共有ルート layout）から
// legacy module へ **dynamic import を一度も跨がずに** 到達できないことを検査する。
console.log('\n[5] CAREER entrypoint からの静的 module 到達');
{
  const EXTS = ['.ts', '.tsx', '.js', '.jsx'];
  const resolveMod = (fromFile: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
    else if (spec.startsWith('.')) base = resolve(ROOT, dirname(fromFile), spec);
    else return null;
    for (const e of EXTS) if (existsSync(base + e)) return relative(ROOT, base + e);
    for (const e of EXTS) {
      const idx = join(base, 'index' + e);
      if (existsSync(idx)) return relative(ROOT, idx);
    }
    return null;
  };

  // 静的 import だけを辿る。`import('x')`（dynamic）は跨がない。
  //   1. `import ... from 'x'` / `export ... from 'x'`
  //   2. `import 'x'`（副作用のみの静的 import）
  const STATIC_IMPORT_RES = [
    /(?:^|[\s;}])(?:import|export)\s[^;'"]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;}])import\s+['"]([^'"]+)['"]/g,
  ];

  const CAREER_ENTRYPOINTS = [
    ...FILES.filter((f) => f.startsWith('app/career/') || f.startsWith('app/api/career/')),
    'app/layout.tsx', // CAREER route でも描画される共有ルート shell
    'app/page.tsx', // CAREER 専用 LP
  ].filter((f) => existsSync(join(ROOT, f)));

  const seen = new Set(CAREER_ENTRYPOINTS);
  const via = new Map<string, string>();
  const queue = [...CAREER_ENTRYPOINTS];
  while (queue.length) {
    const f = queue.shift() as string;
    let src: string;
    try {
      src = readFileSync(join(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '');
    for (const re of STATIC_IMPORT_RES) {
      for (const m of code.matchAll(re)) {
        const target = resolveMod(f, m[1]);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        via.set(target, f);
        queue.push(target);
      }
    }
  }

  // legacy 5 table を実際に叩く module（DB 境界 / orchestration / server context builder）。
  const LEGACY_MODULES = [
    'lib/supabase/profile.ts',
    'lib/supabase/basicInfoLogs.ts',
    'lib/supabase/diagnosisLogs.ts',
    'lib/supabase/activityLogs.ts',
    'lib/supabase/selfAnalysisLogs.ts',
    'lib/repository/basicInfoRepository.ts',
    'lib/repository/diagnosisRepository.ts',
    'lib/repository/activityRepository.ts',
    'lib/repository/selfAnalysisLogRepository.ts',
    'lib/contextBuilders/tutorContext.ts',
    'lib/billing/planGate.ts',
    'lib/billing/syncSubscription.ts',
  ];
  for (const mod of LEGACY_MODULES) {
    check(
      !seen.has(mod),
      `${mod} : CAREER entrypoint から静的到達しない${seen.has(mod) ? ` (via ${via.get(mod)})` : ''}`,
    );
  }
}

console.log(
  `\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — career legacy bootstrap boundary QA`,
);
process.exit(failures === 0 ? 0 : 1);
