'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { Logo } from '@/app/components/Logo';
import { CAREER_LOGIN_PATH, CAREER_START_PATH } from '@/lib/careerLandingRoutes';
import { CAREER_ROUTES } from '@/lib/careerRouting/destination';

// ── Header ────────────────────────────────────────────────────────
// 上部ナビは「Home」と「基本情報」だけに限定する。
// 各機能（活動整理 / 自己分析 / 添削 / マッチング / 面接練習 など）への遷移は
// Home 画面内のカードから行う設計（「次にやるべきこと」をガイドする UX）。
// 機能を増やしてもここは増やさない前提のため、配列＋map ではなく直書きにする。
//
// LP（pathname === '/'）だけは別仕様：
//   - PC：Logo（左）/ アンカーナビ 3 本（中央）/「PASSAI CAREERを始める」ボタン（右）
//   - スマホ：アンカーナビは隠して、Logo + CTA だけ表示（圧迫回避）
// アンカーリンクは <a href="#..."> でページ内移動。スムーズスクロールと
// 固定ヘッダ分のオフセットは layout.tsx の <html> に
// `scroll-smooth scroll-pt-14` を付けて実現している。
//
// LP は PASSAI CAREER 専用（app/page.tsx）。アンカーは LP に実在する section id
// （#recommend / #features / #faq）だけを持つ。料金（#pricing）・比較（#compare）は
// LP からセクションごと廃止したためナビにも置かない（デッドアンカー防止）。

const LP_NAV_LINKS = [
  { href: '#recommend', label: 'おすすめ' },
  { href: '#features', label: '機能' },
  { href: '#faq', label: 'FAQ' },
] as const;

// LP ヘッダーの導線は CAREER 固定。route literal は lib/careerLandingRoutes.ts に集約し、
// ページ下部の Closing CTA と必ず同じ遷移先になるようにする。
// 2 つの CTA は **役割が違う**ので同じ画面へ飛ばさない:
//   - ログイン: 既存ユーザーの復帰入口。/career/login（redirect 無し → 認証後は
//               既定先 /career/start が server 側で状態を解決し、未契約なら料金、
//               基本情報未完なら基本情報、完了なら Home へ送る）
//   - 始める  : 新規ユーザー獲得入口。/career/start（状態解決 dispatcher）。
//               未ログイン / 未契約はまず料金ページ /career/billing に着き、
//               そこから メール登録 → Stripe Checkout → 基本情報 → Home と進む。
//               ログイン済み契約者を再登録・再入力に戻さない。
const LP_LOGIN_HREF = CAREER_LOGIN_PATH;
const LP_START_HREF = CAREER_START_PATH;

export function Header() {
  const pathname = usePathname();
  const isLanding = pathname === '/';

  // 認証ページと料金ページでは Home / 基本情報 のナビを出さず、ロゴのみ表示する。
  //   - 認証（/login, /career/login, /career/register）: 認証完了までユーザーを導くため、
  //     他ページへの導線は不要。
  //   - 料金（/pricing, /career/billing）: 課金コンバージョンページのため、離脱導線
  //     （Home / 基本情報）を封鎖して Checkout への集中度を上げる。
  //   ★ CAREER 側でこれが特に重要なのは、Home / 基本情報 が server guard 付き（未契約は
  //     /career/billing へ弾き返す）になったため。料金・登録画面にこのナビを出すと
  //     「押しても料金画面に戻るだけ」の空リンクになる。
  const isAuthPage =
    pathname === '/login' ||
    pathname === CAREER_ROUTES.login ||
    pathname === CAREER_ROUTES.register;
  const isPricingPage = pathname === '/pricing' || pathname === CAREER_ROUTES.pricing;
  // 公開の法務 / 事業者情報ページ。受験版・就活版どちらの footer からも到達するため、
  // 片方のアプリのナビ（Home / 基本情報）を出さない。
  //   ※ ここを出していると、就活版 LP → footer → /terms → 「Home」→ /home →
  //     PlanGate が未課金判定 → /pricing（受験版 Stripe ページ）へ落ちる誤導線になる。
  //     各ページ本文に「← トップに戻る」があるため、ナビを外しても行き止まりにならない。
  const PUBLIC_INFO_PATHS = ['/about', '/terms', '/privacy', '/contact', '/legal'];
  const isPublicInfoPage = PUBLIC_INFO_PATHS.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
  );
  // ロゴのみ（ナビ非表示）にするページ。
  const isLogoOnly = isAuthPage || isPricingPage || isPublicInfoPage;

  // 就活版（/career 配下）では Home / 基本情報 のナビを就活版ページへ向ける。
  // 受験版（それ以外）の既存挙動は変えない（従来どおり /home・/input/basic）。
  const isCareer = pathname.startsWith('/career');
  const navItems = isCareer
    ? [
        { label: 'Home', href: '/career/home' },
        { label: '基本情報', href: '/career/profile' },
      ]
    : [
        { label: 'Home', href: '/home' },
        { label: '基本情報', href: '/input/basic' },
      ];

  // ロゴのワードマーク出し分け。
  //   - LP（/）と /career 配下 … PASSAI CAREER（就活版の公開面）
  //   - それ以外              … PASSAI（受験版ページ・共通法務ページ＝親ブランド表記）
  // /pricing・/login は受験版の課金 / 認証ページのため 'default' のまま維持する。
  const logoVariant = isLanding || isCareer ? 'career' : 'default';

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-white border-b border-gray-200 shadow-sm">
      <div className="px-4 h-14 flex items-center gap-2 sm:gap-6">
        <Logo variant={logoVariant} />

        {isLanding ? (
          <>
            {/* LP 内アンカーナビ：PC のみ表示 */}
            <nav className="hidden sm:flex flex-1 justify-center items-center gap-4 lg:gap-6 text-sm">
              {LP_NAV_LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="font-medium text-slate-600 hover:text-brand-600 transition-colors"
                >
                  {link.label}
                </a>
              ))}
            </nav>

            {/* 右上アクション：「ログイン」→「始める」の順。
                スマホでは ml-auto で右端、PC は nav の flex-1 が押し出す。
                どちらも whitespace-nowrap で改行・崩れを防ぐ。 */}
            <div className="ml-auto sm:ml-0 flex items-center gap-2">
              <Link
                href={LP_LOGIN_HREF}
                className="px-2.5 sm:px-3 py-1.5 rounded-lg text-sm font-semibold text-slate-700 hover:text-brand-600 hover:bg-gray-100 transition-colors whitespace-nowrap"
              >
                ログイン
              </Link>
              <Link
                href={LP_START_HREF}
                className="px-2.5 sm:px-3 py-1.5 rounded-lg text-sm font-semibold bg-brand-600 text-white hover:bg-brand-700 transition-colors whitespace-nowrap"
              >
                始める
              </Link>
            </div>
          </>
        ) : isLogoOnly ? null : (
          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <NavLink key={item.href} href={item.href} pathname={pathname}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}
      </div>
    </header>
  );
}

function NavLink({
  href,
  pathname,
  children,
}: {
  href: string;
  pathname: string;
  children: ReactNode;
}) {
  const active = pathname === href || pathname.startsWith(href + '/');
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
        active ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {children}
    </Link>
  );
}
