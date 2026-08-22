/**
 * 就活版（career）基本情報入力ページ = 決済完了後のオンボーディング着地点。
 *
 * 実体は ProfileClient（'use client'）。この page は **server 側 route guard** を担う。
 *
 * ★ 有料 entitlement を持つ member だけが入力へ進める（AGENTS §16 / §24）。
 *     未認証           → /career/login?redirect=/career/profile
 *     未契約 / 判定不能 → /career/billing（fail-closed）
 *     契約あり         → 描画
 *   URL 直打ちで未契約ユーザーが入れる状態にしない。Stripe の success_url へ
 *   到達したこと・session_id・localStorage は判定材料にしない（権利の正本は
 *   Stripe → signed webhook → career_subscriptions → entitlement resolver のみ）。
 *
 * ★ 判定ロジックは lib/careerRouting/*（単一の出所）に委譲し、ここには条件式を書かない。
 * ★ 保存先は既存の Data Spine（localStorage canonical + career_profiles mirror）のまま。
 *   この導線変更のために新しい profile DB / onboarding 画面を作っていない。
 */

import { redirect } from 'next/navigation';

import {
  CAREER_ROUTES,
  resolveCareerGuardRedirect,
} from '@/lib/careerRouting/destination';
import { resolveCareerAccessState } from '@/lib/careerRouting/serverState';
import ProfileClient from './ProfileClient';

// cookie session と契約状態を読むため静的化・キャッシュしない。
export const dynamic = 'force-dynamic';

export default async function CareerProfilePage() {
  const state = await resolveCareerAccessState();
  const away = resolveCareerGuardRedirect(state, CAREER_ROUTES.basicInfo);
  if (away) redirect(away);

  return <ProfileClient />;
}
