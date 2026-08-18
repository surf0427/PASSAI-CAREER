// PASSAI 就活版 — GD マルチ 同期モードの導出（STEP-GD-31・純関数）。
//
// Realtime を主同期にしつつ、落ちても GD を止めないための degraded model。
//
//   LIVE      … Realtime channel 接続済み。更新はほぼ即時。polling は低頻度の reconcile のみ。
//   DEGRADED  … Realtime が繋がっていない（無効 / 遮断 / 一時切断）。polling で通常どおり継続できる。
//   OFFLINE   … polling も heartbeat も連続失敗している。ネットワーク断の可能性が高い。
//
// ★ 設計意図:
//   Realtime が落ちただけで「エラー」を出さない。ユーザーにとっては GD が続くかどうかが全てで、
//   3 秒ポーリングで続くなら degraded であって failure ではない（要件 37）。
//   逆に本当に通信が切れている（OFFLINE）ときだけ、はっきり伝える。

import type { GdRealtimeConnectionState } from './realtimeRoom';

export type GdSyncMode = 'live' | 'degraded' | 'offline';

/** OFFLINE と判定するまでの連続失敗回数（heartbeat / poll 共通）。 */
export const GD_OFFLINE_FAILURE_THRESHOLD = 3;

/**
 * Realtime 接続時の reconcile 用ポーリング間隔（ms）。
 *
 * Realtime が主同期なので、polling は「取りこぼしの保険」に落とす。
 * 15 秒 = heartbeat と同周期。DB 負荷を 5 分の 1 に下げつつ、
 * Realtime が黙って死んでいても 15 秒で追いつく。
 */
export const GD_POLL_INTERVAL_LIVE_MS = 15_000;

/**
 * Realtime 非接続時のポーリング間隔（ms）。
 * 従来どおり 3 秒（既存 Online MVP と同じ体験を維持する）。
 */
export const GD_POLL_INTERVAL_FALLBACK_MS = 3_000;

/**
 * 同期モードを決める（純関数）。
 *
 * @param realtime  channel の接続状態
 * @param syncFailures polling / heartbeat の連続失敗回数
 */
export function deriveGdSyncMode(
  realtime: GdRealtimeConnectionState,
  syncFailures: number,
): GdSyncMode {
  // 通信そのものが死んでいる場合は Realtime の状態に関わらず offline。
  if (syncFailures >= GD_OFFLINE_FAILURE_THRESHOLD) return 'offline';
  return realtime === 'connected' ? 'live' : 'degraded';
}

/** 同期モードに応じたポーリング間隔。offline でも polling は止めない（復帰検知のため）。 */
export function gdPollIntervalMs(mode: GdSyncMode): number {
  return mode === 'live' ? GD_POLL_INTERVAL_LIVE_MS : GD_POLL_INTERVAL_FALLBACK_MS;
}

/** UI ラベル（既存 GD design language に合わせた最小表現）。 */
export const GD_SYNC_MODE_LABELS: Readonly<Record<GdSyncMode, string>> = {
  live: 'リアルタイム同期中',
  degraded: '通常同期中',
  offline: 'オフライン（再接続中）',
};

/**
 * ユーザーに「異常」として見せるべきか。
 * degraded は正常系の一部なので false（要件 37）。
 */
export function isGdSyncModeAlarming(mode: GdSyncMode): boolean {
  return mode === 'offline';
}
