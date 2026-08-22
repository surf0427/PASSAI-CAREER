// 就活版（CAREER）ログインの遷移先解決ヘルパー（純関数・テスト可能に切り出し）。
//
// 受験版 `app/login/page.tsx` とは「認証成功後の処理方式（session確立・フル遷移・
// bootstrap委譲）」を揃えるが、**許可 namespace は CAREER 専用に絞る**。受験版の
// sanitizeNext は単一 "/" 始まりの同一 origin path を全許可するため、CAREER で流用すると
// 受験版 route（/home 等）や login self-redirect ループを許してしまう。ここでは pathname を
// URL parser で正規化し、`/career` 名前空間内 かつ login 自身でない場合のみ許可する。
//   - identity は auth.users.id。display_user_id は遷移先の判定に **使わない**。
//   - 表示ID未設定を理由に /career/onboarding/profile へ強制遷移しない（受験版と整合）。

import { CAREER_ROUTES } from '@/lib/careerRouting/destination';

/**
 * redirect 未指定 / 不正 / CAREER 外時の既定遷移先。
 *
 * ★ 状態解決 dispatcher（/career/start）に委ねる。ログイン直後に固定で /career/home へ
 *   送ると、未契約ユーザーが料金画面を飛ばして Home に着き、基本情報未入力ユーザーが
 *   Home 側の client guard に頼ることになる。dispatcher なら server が
 *   「未契約 → 料金 / 基本情報未完 → 基本情報 / 完了 → Home」を 1 箇所で決められる。
 *   判定ロジックの本体は lib/careerRouting/destination.ts（純関数・単一の出所）。
 */
export const DEFAULT_CAREER_REDIRECT = CAREER_ROUTES.start;

// pathname 判定用のダミー同一 origin base（値は表示にも遷移にも使わない）。
const INTERNAL_BASE = 'http://career.internal';

/**
 * 認証画面自身（redirect ループ源）を弾く。
 * ログイン（/career/login）と新規登録（/career/register）は同じ OTP 基盤の入口なので
 * どちらも「認証後の戻り先」にはなり得ない。配下 path（/career/login/... 等）も対象。
 */
function isCareerAuthPath(pathname: string): boolean {
  return (
    pathname === CAREER_ROUTES.login ||
    pathname.startsWith(CAREER_ROUTES.login + '/') ||
    pathname === CAREER_ROUTES.register ||
    pathname.startsWith(CAREER_ROUTES.register + '/')
  );
}

/** `/career` 名前空間の内部 path か。/careerish・/career-foo は境界外（false）。 */
function isCareerNamespace(pathname: string): boolean {
  return pathname === '/career' || pathname.startsWith('/career/');
}

/**
 * 認証後の遷移先を **CAREER 内部 path のみ** に制限する。
 *
 * 許可: /career, /career/, /career/* （query / hash は保持）。
 * 拒否 →（DEFAULT_CAREER_REDIRECT = /career/start へ fallback）:
 *   - null / undefined / 空文字
 *   - 外部 / protocol-relative / scheme付き（http(s):, //, /\, javascript: 等）
 *   - 非 CAREER 同一 origin path（/login, /home, /account, /pricing, /careerish 等）
 *   - 認証画面への self-redirect（/career/login, /career/register とその配下）
 *   - URL 正規化後に CAREER 外/別 origin となる値（/career/../login 等）
 *
 * 単純な文字列 prefix だけでなく URL parser で pathname を正規化して判定する。
 */
export function sanitizeCareerRedirect(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_CAREER_REDIRECT;
  // 同一 origin の絶対 path 参照のみ受け付ける（外部・protocol-relative・backslash を除外）。
  if (!raw.startsWith('/')) return DEFAULT_CAREER_REDIRECT;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return DEFAULT_CAREER_REDIRECT;

  let url: URL;
  try {
    url = new URL(raw, INTERNAL_BASE);
  } catch {
    return DEFAULT_CAREER_REDIRECT;
  }
  // 正規化の結果 base origin を抜けた（backslash トリック等）→ 拒否。
  if (url.origin !== INTERNAL_BASE) return DEFAULT_CAREER_REDIRECT;

  const { pathname } = url;
  if (!isCareerNamespace(pathname)) return DEFAULT_CAREER_REDIRECT;
  if (isCareerAuthPath(pathname)) return DEFAULT_CAREER_REDIRECT;

  // 正常な CAREER path は query / hash を保持して相対 path で返す。
  return `${pathname}${url.search}${url.hash}`;
}
