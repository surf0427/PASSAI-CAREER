/**
 * PASSAI CAREER — AI route 用の有料ゲート（server-only・全 cost-bearing route 共通）。
 *
 * ★ 商品仕様（2026-08-21 決定）:
 *     Guest              … Career の AI 本実行 **不可**
 *     ログイン済み未契約 … Career の AI 本実行 **不可**
 *     有効な契約あり     … 実行可（この後 Daily Quota へ進む）
 *   以前の「guest 利用を正式に許可する」という仕様は廃止された。
 *
 * ★ 置く位置（順序が重要）:
 *     1. request guard（body 上限 / identity 解決 / burst rate limit）
 *     2. **本ゲート（有料 entitlement）**
 *     3. Daily Quota（lib/careerQuota/enforce.ts）
 *     4. AI 実行
 *   ★ 未契約 / guest は **Quota を消費してはいけない**ので、必ず quota より前に置く。
 *   ★ AI provider へ到達する前に必ず通す（未契約からの AI 原価を 0 にする）。
 *
 * ★ paid gate と quota unit は別概念:
 *     paid gate … AI 原価が発生する **すべての** route に必要
 *     quota     … 商品仕様で決めた 8 anchor だけ（lib/careerQuota/anchors.ts）
 *   quota を消費しない subflow（ES 深掘り / 面接 turn / GD AI 発言 など）にも
 *   本ゲートは必要である。
 *
 * ★ fail-closed: 契約状態が確認できないときは AI を実行しない。
 */

import 'server-only';

import type { CareerRequestIdentity } from '@/lib/careerApi/requestGuard';

import {
  loginRequiredResponse,
  requireCareerPaidAccessForUser,
} from './entitlement';

/**
 * 有料 AI 実行の可否を判定する。拒否なら Response、許可なら null。
 *
 * @param identity 入口 guard が server session から確定した identity
 *                 （client 申告値は絶対に渡さない）。
 */
export async function requireCareerAiAccess(
  identity: CareerRequestIdentity,
): Promise<Response | null> {
  if (identity.kind !== 'member') return loginRequiredResponse();
  const gate = await requireCareerPaidAccessForUser(identity.userId);
  return gate.kind === 'reject' ? gate.response : null;
}

/**
 * member 確定済み route（GD マルチなど）用。userId は **必ず server session 由来**。
 */
export async function requireCareerAiAccessForUser(
  userId: string,
): Promise<Response | null> {
  const gate = await requireCareerPaidAccessForUser(userId);
  return gate.kind === 'reject' ? gate.response : null;
}
