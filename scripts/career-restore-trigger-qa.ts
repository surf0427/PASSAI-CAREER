/*
 * scripts/career-restore-trigger-qa.ts
 *
 * PASSAI CAREER — career backfill / restore の起動点 QA（dev-only 常設・決定的）。
 *
 * 目的（Production Readiness Audit P1-1 の回帰ガード）:
 *   career の durable mirror（career_* テーブル）は **Project B** の auth.uid() に
 *   紐づく owner-scoped RLS で守られている。にもかかわらず backfill / restore の起動点が
 *   受験版 **Project A** の AuthProvider にあったため、
 *     - CAREER ログイン（Project B）では一度も起動しない
 *     - 起動しても user_id namespace が違うので 0 行 / RLS 拒否
 *   となり、別端末でプレゼン履歴が空になっていた。
 *
 *   本 QA は「起動点が Project B 側にあり、Project A 側には無い」ことを固定する。
 *
 *   外部 AI 非実行・Supabase 非接続（ソースの architecture 契約を検査する）。
 *
 * 使い方: npx tsx scripts/career-restore-trigger-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};
const section = (t: string) => console.log(`\n── ${t} ──`);

const CAREER_PROVIDER = 'app/career/components/CareerAuthProvider.tsx';
const EXAM_PROVIDER = 'app/components/AuthProvider.tsx';

const careerProviderSrc = read(CAREER_PROVIDER);
const examProviderSrc = read(EXAM_PROVIDER);
const careerProviderCode = stripComments(careerProviderSrc);
const examProviderCode = stripComments(examProviderSrc);

// ════════════════════════════════════════════════════════════════════
section('A. 起動点は Project B（CareerAuthProvider）にある');

check(
  careerProviderCode.includes('backfillCareerOnce'),
  'CareerAuthProvider が backfillCareerOnce を起動する',
);
check(
  careerProviderCode.includes('restoreCareerOnce'),
  'CareerAuthProvider が restoreCareerOnce を起動する',
);
check(
  /backfillCareerOnce[\s\S]{0,200}restoreCareerOnce/.test(careerProviderCode),
  'backfill（上り）→ restore（下り）の順で起動する',
);

// member 確定後に起動していること（guest で走らせない）。
const memberAt = careerProviderCode.indexOf("setStatus('member')");
const syncAt = careerProviderCode.indexOf('careerBackfill');
check(memberAt >= 0 && syncAt >= 0 && memberAt < syncAt, 'member 確定後に起動する（guest では走らない）');

// 認証フローをブロックしない（fire-and-forget）。
check(
  /void import\('@\/lib\/repository\/careerBackfill'\)/.test(careerProviderCode),
  'await せず fire-and-forget で起動する（ログインをブロックしない）',
);
check(
  /\.catch\(\(\) => \{\}\)/.test(careerProviderCode),
  '同期失敗をログイン失敗にしない（例外を握りつぶす）',
);
check(
  /void import\(/.test(careerProviderCode),
  'dynamic import で browser-only repository を server bundle に引き込まない',
);

// ════════════════════════════════════════════════════════════════════
section('B. Project A（受験版 AuthProvider）からは起動しない');

check(
  !examProviderCode.includes('careerBackfill'),
  '受験版 AuthProvider は careerBackfill を起動しない',
);
check(
  !examProviderCode.includes('careerRestore'),
  '受験版 AuthProvider は careerRestore を起動しない',
);
check(
  !examProviderCode.includes('backfillCareerOnce') && !examProviderCode.includes('restoreCareerOnce'),
  '受験版 AuthProvider に career 同期の呼び出しが残っていない',
);
// 受験版固有の backfill（basicInfo / essay 等）は従来どおり残っていること（unrelated regression 防止）。
check(
  examProviderCode.includes('backfillBasicInfoLogOnce'),
  '受験版固有の backfill は従来どおり残っている（巻き込み regression が無い）',
);
check(
  examProviderCode.includes('backfillEssayWorkspacesOnce'),
  '受験版 essay backfill は従来どおり残っている',
);

// ════════════════════════════════════════════════════════════════════
section('C. userId namespace が Project B である');

check(
  careerProviderCode.includes('resolveCareerSession'),
  'CareerAuthProvider の session は resolveCareerSession（Project B）由来',
);
check(
  /const syncUserId = session\.userId;/.test(careerProviderCode),
  '同期に渡す userId は Project B セッション由来',
);
check(
  !/lib\/supabase\/auth|getBrowserSupabaseClient\b/.test(careerProviderCode),
  'CareerAuthProvider は Project A の auth を参照しない',
);

// ════════════════════════════════════════════════════════════════════
section('D. backfill / restore の中身は Project B client のみ（境界不変）');

const MIRRORS = [
  'lib/supabase/careerPresentation.ts',
  'lib/supabase/careerProfile.ts',
  'lib/supabase/careerActivity.ts',
  'lib/supabase/careerValues.ts',
  'lib/supabase/careerSelfAnalysis.ts',
  'lib/supabase/careerMatching.ts',
  'lib/supabase/careerEs.ts',
  'lib/supabase/careerInterview.ts',
  'lib/supabase/careerConsultation.ts',
  'lib/supabase/careerCompanyResearch.ts',
];
for (const m of MIRRORS) {
  const src = read(m);
  check(
    src.includes('getCareerBrowserSupabaseClient') && !/getBrowserSupabaseClient\b/.test(src),
    `${m.replace('lib/supabase/', '')}: Project B client のみを使う`,
  );
}

// ════════════════════════════════════════════════════════════════════
section('E. restore は local を壊さない（マージ方針の維持）');

const restoreSrc = read('lib/repository/careerRestore.ts');
check(
  restoreSrc.includes('mergeById'),
  '履歴系は id マージ（local 優先）で復元する',
);
check(
  /listCareerPresentationResultsFromSupabase/.test(restoreSrc),
  'プレゼン評価履歴が restore 対象に含まれる',
);
check(
  /savePresentationResults\(sortByCreatedDesc\(mergeById\(loadPresentationResults\(\), remote\)\)\)/.test(
    restoreSrc,
  ),
  'プレゼン履歴は local 優先マージ（remote で上書きしない）',
);
check(
  restoreSrc.includes('backfillDone') && restoreSrc.includes('markBackfillDone'),
  'feature 単位の冪等 flag（1 端末 1 回）が維持されている',
);

// ★ flag は userId ごとに分かれるため、Project 切替で誤って「実行済み」にならない。
const flagSrc = read('lib/repository/backfillFlag.ts');
check(
  /loadRecord\(\)\[userId\]\?\.\[feature\]/.test(flagSrc),
  'backfill flag は userId 単位（Project B の userId で改めて 1 回走る）',
);

// ════════════════════════════════════════════════════════════════════
console.log(`\n${fails === 0 ? '✅ PASS' : `❌ FAIL (${fails})`}`);
process.exit(fails === 0 ? 0 : 1);
