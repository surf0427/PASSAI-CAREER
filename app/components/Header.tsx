'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore, type ReactNode } from 'react';
import { Logo } from '@/app/components/Logo';
import {
  isCareerVariantByEnv,
  isCareerVariantByHostname,
} from '@/lib/appVariant';

// 就活版（CAREER）デプロイ判定を SSR 安全に読む（/career/home 等の mount フラグと同形）。
//   - server / hydration: env（NEXT_PUBLIC_APP_VARIANT）だけで判定し SSR と一致させる。
//   - client 確定後: env に加え hostname（passai-career.*）フォールバックも見る。
// これにより hydration mismatch も setState-in-effect も避けつつ、env 未設定の
// vercel ドメインでも CAREER 導線に切り替わる。
const subscribeNoop = () => () => {};
const getCareerSiteSnapshot = () =>
  isCareerVariantByEnv() || isCareerVariantByHostname(window.location.hostname);
const getCareerSiteServerSnapshot = () => isCareerVariantByEnv();

// ── Header ────────────────────────────────────────────────────────
// 上部ナビは「Home」と「基本情報」だけに限定する。
// 各機能（活動整理 / 自己分析 / 添削 / マッチング / 面接練習 など）への遷移は
// Home 画面内のカードから行う設計（「次にやるべきこと」をガイドする UX）。
// 機能を増やしてもここは増やさない前提のため、配列＋map ではなく直書きにする。
//
// LP（pathname === '/'）だけは別仕様：
//   - PC：Logo（左）/ アンカーナビ 5 本（中央）/「PASSAIを始める」ボタン（右）
//   - スマホ：アンカーナビは隠して、Logo +「PASSAIを始める」だけ表示（圧迫回避）
// アンカーリンクは <a href="#..."> でページ内移動。スムーズスクロールと
// 固定ヘッダ分のオフセットは layout.tsx の <html> に
// `scroll-smooth scroll-pt-14` を付けて実現している。

const LP_NAV_LINKS = [
  { href: '#recommend', label: 'おすすめ' },
  { href: '#features', label: '機能' },
  { href: '#pricing', label: '料金' },
  { href: '#compare', label: '比較' },
  { href: '#faq', label: 'FAQ' },
] as const;

export function Header() {
  const pathname = usePathname();
  const isLanding = pathname === '/';

  // 就活版（CAREER）デプロイでは LP ヘッダーの「ログイン」「PASSAIを始める」を
  // 受験版導線（/login → /home → /input/basic）ではなく CAREER 側へ向ける。
  const isCareerSite = useSyncExternalStore(
    subscribeNoop,
    getCareerSiteSnapshot,
    getCareerSiteServerSnapshot,
  );
  // 未ログイン→ログイン後は CAREER 基本情報（/career/profile）へ着地させる。
  // /career/login は redirect（同一オリジン相対パスのみ）を尊重する。
  const lpLoginHref = isCareerSite
    ? '/career/login?redirect=%2Fcareer%2Fprofile'
    : '/login';
  // 「始める」は CAREER では基本情報入力（guest 可・localStorage canonical）へ、
  // 受験版では従来どおり課金（/pricing）へ。
  const lpStartHref = isCareerSite ? '/career/profile' : '/pricing';
  // 認証ページ（/login）と料金ページ（/pricing）では Home / 基本情報 のナビを
  // 出さず、ロゴのみ表示する。
  //   - /login: ログイン完了までユーザーを導くため、他ページへの導線は不要。
  //   - /pricing: 課金コンバージョンページのため、離脱導線（Home / 基本情報）を
  //     封鎖して Checkout への集中度を上げる。
  const isAuthPage = pathname === '/login';
  const isPricingPage = pathname === '/pricing';
  // ロゴのみ（ナビ非表示）にするページ。
  const isLogoOnly = isAuthPage || isPricingPage;

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

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-white border-b border-gray-200 shadow-sm">
      <div className="px-4 h-14 flex items-center gap-2 sm:gap-6">
        <Logo />

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

            {/* 右上アクション：「ログイン」→「PASSAIを始める」の順。
                スマホでは ml-auto で右端、PC は nav の flex-1 が押し出す。
                どちらも whitespace-nowrap で改行・崩れを防ぐ。 */}
            <div className="ml-auto sm:ml-0 flex items-center gap-2">
              <Link
                href={lpLoginHref}
                className="px-2.5 sm:px-3 py-1.5 rounded-lg text-sm font-semibold text-slate-700 hover:text-brand-600 hover:bg-gray-100 transition-colors whitespace-nowrap"
              >
                ログイン
              </Link>
              <Link
                href={lpStartHref}
                className="px-2.5 sm:px-3 py-1.5 rounded-lg text-sm font-semibold bg-brand-600 text-white hover:bg-brand-700 transition-colors whitespace-nowrap"
              >
                PASSAIを始める
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
