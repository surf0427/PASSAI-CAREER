// PASSAI CAREER — purpose 別 server-driven base context の判定（NEXT-6 / Data Spine）。
//
// 背景（退役対象の bridge architecture）:
//   現行は `client selector → request body → server → Orchestrator` で、profile / activity / values が
//   毎リクエスト request body に載っている。Layer 1 が server から読めるようになった（NEXT-2）ので、
//   purpose 単位で `Layer 1 → server loader → Orchestrator` へ段階移行する。
//
// 本 module は **純関数のみ**（flag parse + 採否判定）。実 I/O は baseContext.server.ts。
//
// 厳守:
//   - **default OFF**。flag 未設定なら request body 経路のまま＝出力 byte 完全互換。
//   - server source を採用するのは「全 Source が権威的に読めた」かつ「実データがある」ときだけ。
//     読めない / 空 の member から context を奪わない（product output を壊さない）。
//   - big-bang をしない: purpose ごとに opt-in。いつでも env を空にして即 rollback できる。

import type { CareerContextPurpose } from '@/lib/careerContext/purpose';
import { CAREER_CONTEXT_PURPOSES } from '@/lib/careerContext/purpose';
import type { CareerSourceKind, CareerSourceReadStatus } from '@/lib/careerSourceData/types';
import { isSourceRevisionAuthoritative } from '@/lib/careerSourceData/types';

// base context（profile / activity / values）の由来 Source。
export const BASE_CONTEXT_SOURCE_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
];

/**
 * `CAREER_SERVER_CONTEXT_PURPOSES`（comma 区切り）を purpose 集合へ parse する（純粋）。
 * 未知 purpose は無視（typo で全 purpose が有効化される事故を防ぐ）。空 / 不正 → 空集合（default OFF）。
 */
export function parseServerContextPurposes(raw: unknown): CareerContextPurpose[] {
  if (typeof raw !== 'string') return [];
  const known = new Set<string>(CAREER_CONTEXT_PURPOSES);
  const out: CareerContextPurpose[] = [];
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (p === '' || !known.has(p)) continue;
    if (!out.includes(p as CareerContextPurpose)) out.push(p as CareerContextPurpose);
  }
  return out;
}

export function isServerContextEnabledForPurpose(
  purpose: CareerContextPurpose,
  enabledPurposes: readonly CareerContextPurpose[],
): boolean {
  return enabledPurposes.includes(purpose);
}

// 採否の理由（観測用。route 挙動は decision のみで決まる）。
//   sync_unverified: client canonical と mirror の一致を検証できなかった（D-S1 veto）。
//     → server context を使わず、**request body bridge（＝client canonical そのもの）** へ倒す。
export type BaseContextDecisionReason =
  | 'flag_off'
  | 'source_unavailable'
  | 'source_empty'
  | 'sync_unverified'
  | 'server_source';

export type BaseContextDecision = {
  useServerSource: boolean;
  reason: BaseContextDecisionReason;
};

/**
 * base context を server Source から取るか、従来どおり request body から取るかを決める（純粋）。
 *
 * ★ D-R2 closure: server Source を使うのは「client canonical と mirror の一致を検証できたとき」だけ。
 *   検証できない場合の fallback は **request body bridge**（＝リクエスト端末の canonical そのもの）なので、
 *   「古い mirror content を prompt へ載せる」ことが構造的に起きない。product 出力も劣化しない。
 *
 * @param flagOn          purpose が server context へ opt-in 済みか
 * @param statuses        profile/activity/values の read status
 * @param hasServerData   読めた Source に実データがあるか（3 つとも空なら request body へ fallback）
 * @param syncVerified    3 Source すべてが client canonical と一致したか（D-R2 veto）
 */
export function decideBaseContextSource(
  flagOn: boolean,
  statuses: Readonly<Record<CareerSourceKind, CareerSourceReadStatus>>,
  hasServerData: boolean,
  syncVerified: boolean,
): BaseContextDecision {
  if (!flagOn) return { useServerSource: false, reason: 'flag_off' };
  const authoritative = BASE_CONTEXT_SOURCE_KINDS.every((k) =>
    isSourceRevisionAuthoritative(statuses[k]),
  );
  if (!authoritative) return { useServerSource: false, reason: 'source_unavailable' };
  // ★ 検証できないなら server Source を使わない（bridge へ倒す）。空判定より先に評価する。
  if (!syncVerified) return { useServerSource: false, reason: 'sync_unverified' };
  if (!hasServerData) return { useServerSource: false, reason: 'source_empty' };
  return { useServerSource: true, reason: 'server_source' };
}
