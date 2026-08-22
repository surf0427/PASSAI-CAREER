/**
 * PASSAI CAREER — 「始める」CTA の着地点（server dispatcher）。
 *
 * LP の「始める」は **新規ユーザー獲得導線の入口**であり、押した瞬間の宛先は
 * その人の状態で変わる:
 *
 *   未ログイン / 未契約 / 判定不能 → /career/billing（まず料金・プランを見せる）
 *   契約あり + 基本情報 未完了     → /career/profile
 *   契約あり + 基本情報 完了       → /career/home
 *
 * ログイン済みユーザーに再登録や再入力を要求しないための dispatcher であり、
 * このページ自身は UI を持たない（必ず redirect する）。
 *
 * ★ 判定は server session と Project B の実データのみ。query / localStorage は見ない。
 * ★ 料金ページを新設していない。canonical な料金ページは既存の /career/billing。
 */

import { redirect } from 'next/navigation';

import { resolveCareerStartDestination } from '@/lib/careerRouting/destination';
import { resolveCareerAccessState } from '@/lib/careerRouting/serverState';

// cookie session を読むため静的化・キャッシュしない。
export const dynamic = 'force-dynamic';

export default async function CareerStartPage() {
  const state = await resolveCareerAccessState();
  redirect(resolveCareerStartDestination(state));
}
