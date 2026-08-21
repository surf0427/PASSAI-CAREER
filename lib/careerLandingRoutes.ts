// LP（app/page.tsx）の主要 CTA が指す CAREER canonical route の単一定義。
//
// 同義の CTA が Header 右上（PC / スマホ共通）と ページ下部 Closing CTA の
// 2 箇所に出るため、route literal を各所に直書きすると片方だけ変わって
// 導線が割れる（実際に「ログイン」だけ redirect が付いて割れていた）。
// ここを唯一の出所にして scripts/career-landing-cta-qa.ts で固定する。
//
// ★ Auth 方式・onboarding 判定・redirect sanitize は一切変更しない。
//   ここは「どの既存 route に飛ばすか」だけを持つ定数モジュール。

/**
 * ログイン系 CTA（「ログイン」）の遷移先。
 *
 * redirect クエリは **付けない**。付けないことで
 * `sanitizeCareerRedirect(null)` = `DEFAULT_CAREER_REDIRECT` = `/career/home`
 * という既存の canonical 既定先が効く。
 *   - 基本情報入力済みの再訪ユーザー … そのまま /career/home に着地
 *   - 未入力ユーザー                 … /career/home 側の既存 guard が
 *                                      /career/profile へ replace する
 * つまり初回・再訪のどちらも既存機構だけで正しい場所に着く。
 */
export const CAREER_LOGIN_PATH = '/career/login';

/**
 * 開始系 CTA（「始める」「PASSAI CAREERを始める」）の遷移先。
 *
 * 基本情報入力ページ。ログイン不要で開始でき、入力完了後は
 * ProfileClient が /career/home へ push する（既存挙動）。
 * LP の本文「まずは基本情報の入力から」と一致する。
 */
export const CAREER_START_PATH = '/career/profile';
