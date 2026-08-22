/**
 * 就活版（career）Home = 機能入口ランチャー。
 *
 * 実体は CareerHomeClient（'use client'）。この page は **server 側 route guard** を担う。
 *
 * ★ 有料 entitlement を持つ member だけが到達できる（AGENTS §16 / §24）。
 *     未認証           → /career/login?redirect=/career/home
 *     未契約 / 判定不能 → /career/pricing（fail-closed。登録済み・未決済もここ）
 *     契約あり         → 描画（基本情報が未完了なら client 側が /career/profile へ送る）
 *   URL 直打ちや Stripe success への到達では突破できない。権利の正本は
 *   Stripe → signed webhook → career_subscriptions → entitlement resolver のみ。
 *
 * ★ 判定ロジックは lib/careerRouting/*（単一の出所）に委譲し、ここには条件式を書かない。
 */

import { redirect } from 'next/navigation';

import {
  CAREER_ROUTES,
  resolveCareerGuardRedirect,
} from '@/lib/careerRouting/destination';
import { resolveCareerAccessState } from '@/lib/careerRouting/serverState';
import CareerHomeClient from './CareerHomeClient';

// cookie session と契約状態を読むため静的化・キャッシュしない。
export const dynamic = 'force-dynamic';

export default async function CareerHomePage() {
  const state = await resolveCareerAccessState();
  const away = resolveCareerGuardRedirect(state, CAREER_ROUTES.home);
  if (away) redirect(away);

  return <CareerHomeClient />;
}
