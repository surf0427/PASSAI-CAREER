/*
 * scripts/career-landing-cta-qa.ts
 *
 * PASSAI CAREER — LP（app/page.tsx）主要 CTA 導線の固定ガード（dev-only / 静的 + unit）。
 *
 * 背景: 同義の CTA が Header 右上（PC / スマホ共通）と ページ下部 Closing CTA の
 *   2 箇所にあり、route literal を直書きしていたため片方だけ redirect クエリが付いて
 *   導線が割れていた（「ログイン」→ /career/login?redirect=/career/profile）。
 *   これだと基本情報入力済みの再訪ユーザーまで基本情報フォームに戻されるため、
 *   canonical 既定先 /career/home（DEFAULT_CAREER_REDIRECT）に統一した。
 *
 * 検証:
 *   [1] canonical 定数の値と、login 既定先が sanitizeCareerRedirect の既定と一致すること。
 *   [2] 同義 CTA の href 不一致 = 0（Header / ClosingCta が同じ定数を使う・直書きしない）。
 *   [3] 参照先 route が実在する（404 route 参照 = 0）。
 *   [4] LP から受験版 route / hard-coded deployment URL への誤導線 = 0。
 *
 * ★ 実 Supabase 非接続・ネットワーク非使用・secret 非表示。Auth 方式は一切変更しない。
 * 使い方: npx tsx scripts/career-landing-cta-qa.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAREER_LOGIN_PATH,
  CAREER_START_PATH,
} from '../lib/careerLandingRoutes';
import {
  DEFAULT_CAREER_REDIRECT,
  sanitizeCareerRedirect,
} from '../app/career/login/careerLoginRedirect';
import { resolveCareerStartDestination } from '../lib/careerRouting/destination';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failures++;
};

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** コメント行を除いた実コードだけを検査対象にする（説明コメントの旧 route 表記は許容）。 */
const codeOf = (src: string) =>
  src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const HEADER = read('app/components/Header.tsx');
const CLOSING = read('app/components/landing/ClosingCtaSection.tsx');
const headerCode = codeOf(HEADER);
const closingCode = codeOf(CLOSING);

console.log('[1] canonical 定数と CTA の役割分離');
check(CAREER_LOGIN_PATH === '/career/login', `CAREER_LOGIN_PATH = /career/login（実際: ${CAREER_LOGIN_PATH}）`);
check(CAREER_START_PATH === '/career/start', `CAREER_START_PATH = /career/start（実際: ${CAREER_START_PATH}）`);
// 2 つの CTA は役割が違う（既存復帰 / 新規獲得）。同じ画面へ飛ばさない。
// literal 型どうしの比較を型レベルで潰さないよう string へ widen して見る。
const loginHref: string = CAREER_LOGIN_PATH;
const startHref: string = CAREER_START_PATH;
check(loginHref !== startHref, '「ログイン」と「始める」が別 route（導線を混ぜない）');
// 「始める」は料金確認を飛ばしてログイン画面や基本情報入力へ直行しない。
check(
  startHref !== '/career/login' && startHref !== '/career/profile',
  '「始める」がログイン画面 / 基本情報入力へ直行しない',
);
// login CTA は redirect を付けない → 既存 sanitize の既定先（状態解決 dispatcher）が効く。
check(!CAREER_LOGIN_PATH.includes('?'), 'login CTA に redirect クエリを付けない（canonical 既定先に委ねる）');
check(
  sanitizeCareerRedirect(null) === DEFAULT_CAREER_REDIRECT && DEFAULT_CAREER_REDIRECT === '/career/start',
  'redirect 無しの login 着地は /career/start（状態解決 dispatcher）',
);

// dispatcher は server で状態を解決し、必ず既存 route へ redirect する（UI を持たない）。
const START_PAGE = codeOf(read('app/career/start/page.tsx'));
check(/resolveCareerAccessState\(\)/.test(START_PAGE), '/career/start は server の状態 resolver を使う');
check(/resolveCareerStartDestination\(/.test(START_PAGE), '/career/start は共通の純関数で遷移先を決める');
check(/redirect\(/.test(START_PAGE), '/career/start は必ず redirect する（独自 UI を持たない）');
check(
  !/['"`]\/career\/[^'"`]*['"`]/.test(START_PAGE),
  '/career/start に route literal の直書きが無い（canonical 定数経由）',
);

// 未契約 / 未ログインの「始める」は料金画面（既存 /career/billing）に着く。新設していない。
check(
  resolveCareerStartDestination({ kind: 'guest' }) === '/career/billing',
  '未ログインの「始める」→ 料金画面（既存 /career/billing）',
);
check(
  resolveCareerStartDestination({ kind: 'unpaid' }) === '/career/billing',
  '未契約の「始める」→ 料金画面',
);
check(
  resolveCareerStartDestination({ kind: 'paid', basicInfoComplete: false }) === '/career/profile',
  '契約あり + 基本情報未完 →（既存の）基本情報入力',
);
check(
  resolveCareerStartDestination({ kind: 'paid', basicInfoComplete: true }) === '/career/home',
  '契約あり + 基本情報完了 → Home（再登録を求めない）',
);

// 未入力ユーザーは /career/home 側の既存 guard が /career/profile へ送る（第二の状態管理なし）。
check(
  /router\.replace\('\/career\/profile'\)/.test(codeOf(read('app/career/home/CareerHomeClient.tsx'))),
  '/career/home に「基本情報未完了 → /career/profile」の既存 guard がある',
);
// 開始 CTA の着地後は既存 ProfileClient が /career/home へ push する。
check(
  /router\.push\('\/career\/home'\)/.test(codeOf(read('app/career/profile/ProfileClient.tsx'))),
  '基本情報入力後は /career/home へ（既存 ProfileClient の挙動）',
);

console.log('[2] 同義 CTA の href 不一致 = 0');
check(
  /import \{[^}]*CAREER_LOGIN_PATH[^}]*CAREER_START_PATH[^}]*\} from '@\/lib\/careerLandingRoutes'/.test(headerCode),
  'Header が canonical 定数を import している',
);
check(
  /import \{[^}]*CAREER_LOGIN_PATH[^}]*CAREER_START_PATH[^}]*\} from '@\/lib\/careerLandingRoutes'/.test(closingCode),
  'ClosingCtaSection が canonical 定数を import している',
);
check(/LP_LOGIN_HREF = CAREER_LOGIN_PATH/.test(headerCode), 'Header ログイン = CAREER_LOGIN_PATH');
check(/LP_START_HREF = CAREER_START_PATH/.test(headerCode), 'Header 始める = CAREER_START_PATH');
check(/href=\{CAREER_LOGIN_PATH\}/.test(closingCode), 'Bottom ログイン = CAREER_LOGIN_PATH');
check(/href=\{CAREER_START_PATH\}/.test(closingCode), 'Bottom 始める = CAREER_START_PATH');
// CTA 側に route を直書きしない（片方だけ書き換わる drift の再発防止）。
// Header は LP 分岐（isLanding ? ... : ...）の中だけを見る。/career 配下の in-app ナビ
// （Home / 基本情報）は LP CTA ではないので検査対象外。
const LP_BRANCH = headerCode.slice(
  headerCode.indexOf('{isLanding ? ('),
  headerCode.indexOf(') : isLogoOnly ?'),
);
check(LP_BRANCH.length > 0, 'Header の LP 分岐ブロックを抽出できた');
for (const [label, code] of [['Header(LP 分岐)', LP_BRANCH], ['ClosingCtaSection', closingCode]] as const) {
  check(
    !/['"`]\/career\/[^'"`]*['"`]/.test(code),
    `${label} に /career/... の直書き literal が無い`,
  );
}

console.log('[3] 参照先 route が実在（404 route 参照 = 0）');
for (const p of [
  CAREER_LOGIN_PATH,
  CAREER_START_PATH,
  DEFAULT_CAREER_REDIRECT,
  '/career/register',
  '/career/billing',
  '/career/profile',
  '/career/home',
]) {
  check(existsSync(join(ROOT, 'app', p.replace(/^\//, ''), 'page.tsx')), `${p} に page.tsx が実在`);
}

console.log('[4] LP からの誤導線 = 0（受験版 route / deployment URL）');
const LANDING_FILES = [
  'app/page.tsx',
  'app/components/landing/HeroSection.tsx',
  'app/components/landing/ProblemSection.tsx',
  'app/components/landing/FeatureFlowSection.tsx',
  'app/components/landing/FaqSection.tsx',
  'app/components/landing/ClosingCtaSection.tsx',
];
// 受験版の認証 / ホーム / 基本情報 route。LP（就活版）から飛ばしてはいけない。
const EXAM_ROUTES = [/href=["'{]?['"]?\/login\b/, /['"]\/home['"]/, /['"]\/input\/basic['"]/, /['"]\/pricing['"]/];
for (const rel of LANDING_FILES) {
  const code = codeOf(read(rel));
  check(!EXAM_ROUTES.some((re) => re.test(code)), `${rel}: 受験版 route 参照が無い`);
  check(!/https?:\/\/[^'"`\s]*vercel\.app/.test(code), `${rel}: hard-coded Vercel deployment URL が無い`);
}
// Header の LP 分岐（isLanding）が受験版 navItems を出さないことは既存構造で担保。
check(
  /const isLanding = pathname === '\/'/.test(headerCode),
  'Header は LP を pathname === "/" で分岐（LP に受験版ナビを出さない）',
);

console.log('');
console.log(failures === 0 ? 'career-landing-cta-qa: ALL PASS' : `career-landing-cta-qa: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
