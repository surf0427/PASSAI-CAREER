/*
 * scripts/career-login-redirect-qa.ts
 *
 * PASSAI CAREER — CAREER ログインフローの受験版整合ガード（dev-only / 静的 + unit）。
 *
 * 背景: CAREER のメール OTP ログインは、認証成功後に旧「表示用ID（display_user_id）
 *   設定」画面（/career/onboarding/profile）へ強制遷移していた。受験版 app/login を
 *   source of truth として、認証後は表示IDの有無に関わらず safeRedirect へ遷移する
 *   方式へ統一した。本 QA はその整合が将来の refactor で崩れる regression を防ぐ。
 *
 * 検証:
 *   [1] sanitizeCareerRedirect の redirect matrix（open-redirect ガード / 既定先）。
 *   [2] login/page.tsx が表示ID未設定を理由に onboarding へ強制遷移しないこと（静的）。
 *   [3] login/page.tsx の認証成功後遷移が受験版と同型（safeRedirect へフル遷移）。
 *   [4] display_user_id が nullable のまま（DB destructive change なし / DROP NOT NULL 維持）。
 *
 * ★ 実 Supabase 非接続・OTP 非送信・secret 非表示。
 * 使い方: npx tsx scripts/career-login-redirect-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_CAREER_REDIRECT,
  sanitizeCareerRedirect,
} from '../app/career/login/careerLoginRedirect';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failures++;
};

console.log('[1] sanitizeCareerRedirect redirect matrix');
// 既定先は状態解決 dispatcher（/career/start）。ログイン直後の宛先は server が決める。
const DEFAULT = '/career/start';
check(DEFAULT_CAREER_REDIRECT === DEFAULT, `DEFAULT_CAREER_REDIRECT === ${DEFAULT}`);

// redirect 未指定 → 既定先。
check(sanitizeCareerRedirect(null) === DEFAULT, `null → ${DEFAULT}`);
check(sanitizeCareerRedirect(undefined) === DEFAULT, `undefined → ${DEFAULT}`);
check(sanitizeCareerRedirect('') === DEFAULT, `empty → ${DEFAULT}`);

// 正当な CAREER 内部 path → そのまま通す（query / hash 保持）。
check(sanitizeCareerRedirect('/career') === '/career', '/career passthrough（namespace 境界そのもの）');
check(sanitizeCareerRedirect('/career/') === '/career/', '/career/ passthrough');
check(sanitizeCareerRedirect('/career/home') === '/career/home', '/career/home passthrough');
check(sanitizeCareerRedirect('/career/profile') === '/career/profile', '/career/profile passthrough');
check(
  sanitizeCareerRedirect('/career/profile?tab=basic') === '/career/profile?tab=basic',
  '/career/profile?tab=basic query 保持 passthrough',
);
check(
  sanitizeCareerRedirect('/career/mypage#latest') === '/career/mypage#latest',
  '/career/mypage#latest hash 保持 passthrough',
);
check(
  sanitizeCareerRedirect('/career/company-research/view?id=123') === '/career/company-research/view?id=123',
  '/career/company-research/view?id=123 query 保持 passthrough',
);

// 非 CAREER 同一 origin path → 既定先へフォールバック（受験版 namespace 遷移を禁止）。
check(sanitizeCareerRedirect('/login') === DEFAULT, '/login blocked → default');
check(sanitizeCareerRedirect('/home') === DEFAULT, '/home blocked → default');
check(sanitizeCareerRedirect('/account') === DEFAULT, '/account blocked → default');
check(sanitizeCareerRedirect('/pricing') === DEFAULT, '/pricing blocked → default');
// namespace 境界の厳格性: prefix 一致だけで通してはならない。
check(sanitizeCareerRedirect('/careerish') === DEFAULT, '/careerish blocked → default（/career/ 境界厳格）');
check(sanitizeCareerRedirect('/career-old/home') === DEFAULT, '/career-old/home blocked → default');

// login self-redirect（ループ源）→ 既定先へフォールバック。
check(sanitizeCareerRedirect('/career/login') === DEFAULT, '/career/login blocked → default（self-redirect 防止）');
check(sanitizeCareerRedirect('/career/login/') === DEFAULT, '/career/login/ blocked → default');
check(
  sanitizeCareerRedirect('/career/login?redirect=/career/profile') === DEFAULT,
  '/career/login?redirect=... blocked → default（query 付きでも pathname で判定）',
);
check(sanitizeCareerRedirect('/career/login#otp') === DEFAULT, '/career/login#otp blocked → default');
// 新規登録も同じ OTP 基盤の入口。認証後の戻り先にはなり得ない（self-redirect ループ防止）。
check(sanitizeCareerRedirect('/career/register') === DEFAULT, '/career/register blocked → default（self-redirect 防止）');
check(sanitizeCareerRedirect('/career/register/') === DEFAULT, '/career/register/ blocked → default');
check(
  sanitizeCareerRedirect('/career/register?redirect=/career/billing') === DEFAULT,
  '/career/register?redirect=… blocked → default',
);

// 危険な redirect（外部オリジンへの open-redirect / scheme）→ 既定先へフォールバック。
check(sanitizeCareerRedirect('https://example.com/career/home') === DEFAULT, 'https://…/career/home blocked → default');
check(sanitizeCareerRedirect('http://example.com') === DEFAULT, 'http://example.com blocked → default');
check(sanitizeCareerRedirect('//example.com/career/home') === DEFAULT, 'protocol-relative //…/career/home blocked → default');
check(sanitizeCareerRedirect('/\\example.com') === DEFAULT, 'backslash /\\ escape blocked → default');
check(sanitizeCareerRedirect('javascript:alert(1)') === DEFAULT, 'javascript: scheme blocked → default');

// URL 正規化後に CAREER 外へ抜ける値 → 既定先へフォールバック。
check(sanitizeCareerRedirect('/career/../login') === DEFAULT, '/career/../login（正規化で /login）blocked → default');

// OTP フォーム本体は login / register で共有する唯一の実装
// （app/career/components/CareerEmailOtpForm.tsx）。page.tsx は mode を渡すだけの薄い層。
const OTP_FORM = 'app/career/components/CareerEmailOtpForm.tsx';

console.log('[2] OTP フォームは表示ID未設定を理由に onboarding へ強制遷移しない');
const LOGIN = readFileSync(join(ROOT, OTP_FORM), 'utf8');
// コメント行を除いた実コードのみを検査対象にする（説明コメントに旧名が残るのは許容）。
const loginCode = LOGIN.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
check(!/ONBOARDING_PATH/.test(loginCode), 'ONBOARDING_PATH 定数を使っていない（コード）');
check(!/needsOnboarding/.test(loginCode), 'needsOnboarding 分岐が無い（コード）');
check(!/onboarding\/profile/.test(loginCode), '/career/onboarding/profile への遷移が無い（コード）');
check(!/\bdisplayUserId\b/.test(loginCode), 'display_user_id を遷移判定に参照しない（コード）');
check(!/ensureCareerAccount/.test(loginCode), 'ログインページで行 bootstrap しない（provider に委譲）');

console.log('[3] 認証成功後の遷移が受験版と同型（safeRedirect へフル遷移）');
// login / register の両 page が同じフォーム実装だけを使う（auth 実装の二重化を禁止）。
for (const rel of ['app/career/login/page.tsx', 'app/career/register/page.tsx']) {
  const pageSrc = readFileSync(join(ROOT, rel), 'utf8');
  check(
    /CareerEmailOtpForm/.test(pageSrc),
    `${rel} は共有 OTP フォームを使う（独自 auth を実装しない）`,
  );
  check(
    !/verifyCareerEmailOtp|sendCareerEmailOtp|createBrowserClient|password/i.test(pageSrc),
    `${rel} に独自の認証実装が無い`,
  );
}
check(
  /window\.location\.assign\(safeRedirect\)/.test(loginCode),
  'verify 成功後は window.location.assign(safeRedirect)（受験版と同型）',
);
check(
  /router\.replace\(safeRedirect\)/.test(loginCode),
  '既ログインで /career/login に来たら router.replace(safeRedirect)',
);
check(
  /sanitizeCareerRedirect/.test(loginCode),
  'redirect は sanitizeCareerRedirect でサニタイズ',
);
// 既ログイン分岐に表示ID条件が混入していないこと（member なら常に safeRedirect）。
check(
  !/status === 'member'[\s\S]*displayUserId/.test(loginCode),
  '既ログイン分岐に display_user_id 条件が無い',
);

console.log('[4] display_user_id は nullable のまま（DB destructive change なし）');
const SQL = readFileSync(join(ROOT, 'supabase/career_accounts_apply.sql'), 'utf8');
check(/display_user_id\s+text\s+UNIQUE/i.test(SQL), 'display_user_id text UNIQUE（列は維持）');
check(/ALTER\s+COLUMN\s+display_user_id\s+DROP\s+NOT\s+NULL/i.test(SQL), 'DROP NOT NULL 維持（null 許容 = ログイン時 lazy 作成可）');
check(!/display_user_id[^\n]*NOT NULL(?![^\n]*DROP)/i.test(SQL.replace(/DROP NOT NULL/gi, '')), 'display_user_id に NOT NULL 制約を付けていない');

console.log('');
console.log(failures === 0 ? 'career-login-redirect-qa: ALL PASS' : `career-login-redirect-qa: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
