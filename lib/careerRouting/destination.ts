/**
 * PASSAI CAREER — 「今このユーザーをどの画面へ送るか」の **唯一の判定ロジック**（純関数）。
 *
 * 背景（AGENTS §17 と同じ思想）:
 *   新規登録導線（始める → 料金 → 登録 → Checkout → 基本情報 → Home）と
 *   既存復帰導線（ログイン → 状態に応じた画面）で、同じ優先順位判定が
 *   login page / start dispatcher / success page / page guard の 4 箇所に必要になる。
 *   ここを唯一の出所にして、条件式のコピペ（＝片方だけ直って導線が割れる）を防ぐ。
 *
 * ★ 本 module は **権利を与えない**。与えられた state を路線図に翻訳するだけ。
 *   paid の正本は常に server（lib/careerBilling/entitlement.ts）であり、
 *   `success_url` / session_id / localStorage / client state は判定材料にしない。
 *
 * ★ server-only な I/O を含まない（`import 'server-only'` を書かない）。
 *   そのため server component / client component / QA script の全部から同じ実装を使える。
 */

import type { CareerProfile } from '@/types/careerProfile';

/** 導線が参照する canonical route。literal の直書きをここに集約する。 */
export const CAREER_ROUTES = {
  /** 既存ユーザー向けログイン（email OTP）。 */
  login: '/career/login',
  /** 新規ユーザー向けメールアドレス登録（同じ OTP 基盤・UI 文言だけ新規向け）。 */
  register: '/career/register',
  /**
   * 新規ユーザー向けの **公開 Pricing**（買う前）。
   * 受験版 `/pricing` と同じ位置づけ: public・未契約者の着地先・購入 CTA を持つ。
   */
  pricing: '/career/pricing',
  /**
   * 既存ユーザー向けの **契約状態確認 / 契約管理**（買った後）。
   * 受験版のマイページ内 BillingCard 相当。Stripe を正本に現契約を表示し、
   * 取得できなければ fail-closed（＝申し込みを受け付けない）で正しい。
   * 新規獲得導線をここへ着地させない。
   */
  billing: '/career/billing',
  /** 基本情報入力（既存機能。onboarding 画面を新設しない）。 */
  basicInfo: '/career/profile',
  /** 機能入口ランチャー。 */
  home: '/career/home',
  /** 状態解決 dispatcher（「始める」とログイン後の着地）。 */
  start: '/career/start',
} as const;

/**
 * server が解決したユーザー状態。
 *
 *   guest       … 未認証（server session 無し / anonymous）
 *   unpaid      … 認証済みだが有効な契約が無い
 *   unavailable … 判定不能（課金 DDL 未適用 / service_role 未設定 / DB エラー）
 *                 → **fail-closed**。unpaid と同じ扱いに倒す（「確認できないから通す」はしない）。
 *   paid        … 認証済み + 有効な契約あり
 */
export type CareerAccessState =
  | { kind: 'guest' }
  | { kind: 'unpaid' }
  | { kind: 'unavailable' }
  | { kind: 'paid'; basicInfoComplete: boolean };

/**
 * 「始める」CTA / ログイン直後の着地先。
 *
 * 優先順位（受験版の「未課金は必ず /pricing」と同じ思想）:
 *   1. 未認証            → Pricing（新規は必ず料金を先に見る。いきなりログイン画面へ送らない）
 *   2. 未契約 / 判定不能 → Pricing（契約管理ページ /career/billing ではない）
 *   3. 契約あり + 基本情報未完 → 基本情報
 *   4. 契約あり + 基本情報完了 → Home
 */
export function resolveCareerStartDestination(state: CareerAccessState): string {
  if (state.kind === 'paid') {
    return state.basicInfoComplete ? CAREER_ROUTES.home : CAREER_ROUTES.basicInfo;
  }
  // guest / unpaid / unavailable はいずれも公開 Pricing。
  // guest をログイン画面へ送らないのが新規導線の要（料金 → 登録 の順を守る）。
  // 契約管理ページ（billing）へは送らない: 未契約者に見せるべき画面ではない。
  return CAREER_ROUTES.pricing;
}

/**
 * 有料ページ（基本情報 / Home）の server guard の判定。
 *
 * @param selfPath ログイン後に戻す自分自身の path（CAREER 名前空間内の相対 path）。
 * @returns 追い出し先の path。`null` なら描画してよい。
 */
export function resolveCareerGuardRedirect(
  state: CareerAccessState,
  selfPath: string,
): string | null {
  if (state.kind === 'paid') return null;
  if (state.kind === 'guest') {
    return `${CAREER_ROUTES.login}?redirect=${encodeURIComponent(selfPath)}`;
  }
  // unpaid / unavailable → 公開 Pricing（fail-closed。判定不能を「通す」に倒さない）。
  return CAREER_ROUTES.pricing;
}

/**
 * 基本情報（/career/profile）の入力が完了しているか。
 *
 * 判定条件は ProfileClient の validateForm が **必須**にしている項目と同一:
 *   ニックネーム / 大学 / 学部 / 学年 / 卒業予定年（学科・性別は任意なので見ない）。
 * 保存は 5 項目すべて揃わないと通らないため、「保存済み ⇔ 完了」が成立する。
 *
 * ★ マイページの hasBasicProfileContent（`some` = 何か入っていれば true）とは意味が違う。
 *   あちらは「充実度の表示」、こちらは「導線を進めてよいか」の判定なので `every` で見る。
 */
export function isCareerBasicInfoComplete(profile: CareerProfile | null): boolean {
  if (!profile) return false;
  const pref = profile.preferences?.[0];
  const required = [
    profile.name,
    pref?.university,
    pref?.faculty,
    profile.grade,
    profile.graduationYear,
  ];
  return required.every((v) => typeof v === 'string' && v.trim() !== '');
}
