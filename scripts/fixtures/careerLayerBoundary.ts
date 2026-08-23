/*
 * scripts/fixtures/careerLayerBoundary.ts
 *
 * QA 用の共有ヘルパ — **Layer 4 / Layer 5（オフライン設計物）が production の
 * runtime data authority になっていないこと**を検証する。
 *
 * ── 何を守っているのか（本来の invariant）────────────────────────────────
 *   Data Spine の Layer 4（集合知の集計）/ Layer 5（Company Knowledge）は
 *   consent・moderation・PII 判定を伴う設計物で、production へ通電する前に
 *   決着すべき論点が残っている。よって守りたいのは
 *
 *       「production が Layer 4/5 の **データ権威**（repository / projection /
 *         supabase read / governance / batch）に依存していないこと」
 *
 *   であって、「その directory 名を含む import が 1 つも無いこと」ではない。
 *
 * ── なぜ緩めるのではなく作り直すのか ────────────────────────────────────
 *   旧 QA は禁止判定を **directory 名の substring** で行っていた。その後、
 *   Company Identity / Company Data Spine の実装が
 *     - lib/careerCompanyKnowledge/identity.ts の normalizeCompanyName / resolveCompany
 *     - lib/careerContextRenderers/companyOfficialContext.ts の renderCompanyOfficialForPurpose
 *   という **純粋関数**を正当に再利用するようになった（どちらも I/O を一切持たない）。
 *   directory 名判定はこれを「禁止 consumer」と誤検出して落ちていた。
 *
 *   ここで判定ごと消すと、本来止めたい repository / projection / governance の
 *   通電まで素通しになる（false negative）。そこで
 *     - **file 単位の allowlist**（純粋ユーティリティだけを名指しで許可）
 *     - allowlist 対象が **本当に純粋か**を毎回検証（許可が穴に化けない）
 *     - それ以外の Layer 4/5 は従来どおり禁止
 *   という形へ作り直す。許可を増やすには「純粋であること」を通す必要がある。
 *
 * ★ 型だけの import（@/types/...）は runtime に何も持ち込まないため対象外。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * production から import してよい Layer 4/5 の **純粋ユーティリティ**（file 単位）。
 *
 * ★ ここへ足してよいのは「I/O を一切持たない純関数だけを export する module」に限る。
 *   足したら assertSanctionedPureModules() が purity を検証するので、
 *   repository / supabase / fetch を持つ module は allowlist に入れても QA が落ちる。
 */
export const SANCTIONED_PURE_LAYER_MODULES: readonly string[] = [
  // 企業名の正規化・同定（Company Identity が再利用する純粋ロジック）。
  'lib/careerCompanyKnowledge/identity.ts',
  // 企業公式情報の prompt 描画（Company Data Spine の live 経路。値の取得は呼び出し側）。
  'lib/careerContextRenderers/companyOfficialContext.ts',
];

/** allowlist した module が持っていてはいけない I/O / データ権威の痕跡。 */
const IMPURITY_MARKERS: readonly { re: RegExp; label: string }[] = [
  { re: /from\s+['"][^'"]*supabase[^'"]*['"]/i, label: 'supabase client import' },
  { re: /createClient\s*\(/, label: 'createClient()' },
  { re: /\bfetch\s*\(/, label: 'fetch()' },
  { re: /localStorage|sessionStorage/, label: 'browser storage' },
  { re: /import\s+['"]server-only['"]/, label: "import 'server-only'" },
  { re: /process\.env/, label: 'process.env' },
  { re: /from\s+['"][^'"]*(repository|Repository)[^'"]*['"]/, label: 'repository import' },
];

/** 行コメント / ブロックコメントを落とす（説明文の語を拾わない）。 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

export type PurityViolation = { file: string; markers: string[] };

/**
 * allowlist した module が本当に純粋かを検証する。
 * 返り値が空でなければ「許可が穴になっている」＝ QA を落とすべき状態。
 */
export function assertSanctionedPureModules(root: string): PurityViolation[] {
  const out: PurityViolation[] = [];
  for (const rel of SANCTIONED_PURE_LAYER_MODULES) {
    let src: string;
    try {
      src = readFileSync(join(root, rel), 'utf8');
    } catch {
      // allowlist に挙げた file が消えた／リネームされた = manifest の陳腐化。
      out.push({ file: rel, markers: ['file not found (manifest stale)'] });
      continue;
    }
    const code = stripComments(src);
    const markers = IMPURITY_MARKERS.filter((m) => m.re.test(code)).map((m) => m.label);
    if (markers.length > 0) out.push({ file: rel, markers });
  }
  return out;
}

/** import specifier が allowlist 済みの純粋 module を指しているか。 */
export function isSanctionedPureImport(spec: string): boolean {
  return SANCTIONED_PURE_LAYER_MODULES.some((rel) => {
    const withoutExt = rel.replace(/\.tsx?$/, '');
    // '@/lib/x/y' / '../lib/x/y' / 'lib/x/y' のいずれの書き方でも末尾一致で判定する。
    return spec.endsWith(withoutExt.replace(/^lib\//, 'lib/')) || spec.endsWith(withoutExt.slice(withoutExt.indexOf('lib/')));
  });
}

/**
 * 絶対パス / repo 相対パスが allowlist 済みの純粋 module 自身か。
 *
 * import graph の推移的到達性チェックで「到達先が純粋ユーティリティなら許可」
 * と判定するために使う（到達先が repository / projection なら従来どおり違反）。
 */
export function isSanctionedPureFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  return SANCTIONED_PURE_LAYER_MODULES.some((rel) => norm.endsWith(rel));
}

/** 型だけの import か（runtime に何も持ち込まない）。 */
export function isTypeOnlySpecifier(spec: string): boolean {
  return spec.startsWith('@/types/') || spec.startsWith('../types/') || spec.includes('/types/');
}

/**
 * src が **禁止された** Layer 4/5 module を import しているかを返す。
 *
 * @param forbiddenModules directory 名の集合（例: careerCompanyKnowledge）
 * @returns 違反した import specifier（allowlist / type-only は除外済み）
 */
export function findForbiddenLayerImports(
  src: string,
  forbiddenModules: readonly string[],
): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (!forbiddenModules.some((mod) => spec.includes(mod))) continue;
    if (isTypeOnlySpecifier(spec)) continue;
    if (isSanctionedPureImport(spec)) continue;
    out.push(spec);
  }
  return out;
}

/** `findForbiddenLayerImports` が 1 件でも返す file を抽出するヘルパ。 */
export function filterFilesWithForbiddenLayerImports(
  files: readonly string[],
  forbiddenModules: readonly string[],
): { file: string; specs: string[] }[] {
  const out: { file: string; specs: string[] }[] = [];
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const specs = findForbiddenLayerImports(src, forbiddenModules);
    if (specs.length > 0) out.push({ file: f, specs });
  }
  return out;
}
