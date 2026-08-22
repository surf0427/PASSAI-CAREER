// LP（app/page.tsx）の主要 CTA が指す CAREER canonical route の単一定義。
//
// 同義の CTA が Header 右上（PC / スマホ共通）と ページ下部 Closing CTA の
// 2 箇所に出るため、route literal を各所に直書きすると片方だけ変わって
// 導線が割れる（実際に「ログイン」だけ redirect が付いて割れていた）。
// ここを唯一の出所にして scripts/career-landing-cta-qa.ts で固定する。
//
// ★ Auth 方式・onboarding 判定・redirect sanitize は一切変更しない。
//   ここは「どの既存 route に飛ばすか」だけを持つ定数モジュール。

import { CAREER_ROUTES } from '@/lib/careerRouting/destination';

/**
 * ログイン系 CTA（「ログイン」）の遷移先。**既存ユーザー専用の入口**。
 *
 * redirect クエリは **付けない**。付けない場合、ログイン成功後は状態解決 dispatcher
 * （/career/start）へフル遷移し、server がその人の状態に応じた画面を決める:
 *   未契約 → /career/billing ／ 契約あり+基本情報未完 → /career/profile ／ 完了 → /career/home
 * 明示的な redirect が付いている場合（checkout 再開など）は従来どおり
 * `sanitizeCareerRedirect` が許可した CAREER 内部 path をそのまま優先する。
 *
 * ★ 新規登録導線（「始める」）とは UI を分ける。ここは再訪ユーザーの復帰専用。
 */
export const CAREER_LOGIN_PATH = CAREER_ROUTES.login;

/**
 * 開始系 CTA（「始める」「PASSAI CAREERを始める」）の遷移先。
 *
 * ★ 新規ユーザー獲得導線の入口 = **公開 Pricing**（/career/pricing）。
 *   受験版が LP の #pricing / `/pricing` で「まず料金を見せてから購入」に統一している
 *   のと同じ思想。契約管理ページ（/career/billing）へは絶対に着地させない
 *   （新規ユーザーに「現在お申し込みを受け付けているプランはありません」を見せない）。
 *
 * ★ ログイン済みユーザーが押した場合も Pricing で状態を提示する（契約中なら
 *   「すでにご利用中です」＋次の一歩）。再登録・再決済を要求しない。
 *   ログイン直後の宛先解決は別途 dispatcher（CAREER_ROUTES.start）が担当する。
 *
 * 判定ロジックの本体は lib/careerRouting/destination.ts（純関数・単一の出所）。
 */
export const CAREER_START_PATH = CAREER_ROUTES.pricing;
