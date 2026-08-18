// PASSAI 就活版 — GD マルチ presence（接続状態）の単一ソース（STEP-GD-31）。
//
// 「切断（disconnect）」と「退室（leave）」を分離するための純ロジック。
//   - 退室(left_at) … ユーザーが明示的に抜けた。復帰しない。
//   - 切断(connection_state) … 通信断 / tab close / sleep / モバイル背面化。**復帰しうる**。
//
// スマホでは一時的な切断が日常的に起きるため、切断を即 left_at にしない。
// grace period を 2 段（disconnected → stale）で持ち、UI と cleanup の判断材料にする。
//
// ★ 本モジュールは純関数と定数のみ（DOM / Supabase / env に触れない）。
//   client（表示）と server（sweep 引数・API 応答）の双方から import する
//   ＝ 閾値がコードの 2 箇所にコピーされない（magic number 散乱の防止）。
//
// DB 側の対応:
//   career_gd_room_members.last_seen_at / connection_state（career_gd_realtime_apply.sql）
//   sweep は RPC career_gd_sweep_presence / _all が同じ閾値を引数で受け取る。

/** 参加者の接続状態（DB の connection_state と 1:1）。 */
export type GdConnectionState = 'online' | 'disconnected' | 'stale';

/**
 * クライアントが heartbeat を送る間隔（ミリ秒）。
 *
 * 15 秒: 3 秒ポーリングより十分疎く、DISCONNECT_AFTER_SEC(45s) の 1/3。
 * 1 回落としても即 disconnected にはならない（3 回連続で落ちて初めて判定される）。
 */
export const GD_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 最終 heartbeat からこの秒数を超えたら 'disconnected'（grace period）。
 *
 * 45 秒 = heartbeat 3 回ぶん。モバイルの瞬断・画面ロック直後の復帰を
 * 「切断」と誤判定しないための余裕。
 */
export const GD_DISCONNECT_AFTER_SEC = 45;

/**
 * 最終 heartbeat からこの秒数を超えたら 'stale'（実質もう戻ってこない）。
 *
 * 180 秒。ここまで来たら UI 上は「不在」として扱い、AI 補完人数・評価対象の
 * 判断材料にできる。★ それでも left_at は立てない（戻ってきたら online に復帰する）。
 */
export const GD_STALE_AFTER_SEC = 180;

/**
 * host が落ちてから、他の参加者へ「ホスト不在」を示すまでの秒数。
 *
 * host migration は本 STEP の非目標。room を即 cancel もしない
 * （host は再接続しうる）。時間切れ終了は server timer が host 不在でも成立するため、
 * ここは **表示のための閾値**に留める。
 */
export const GD_HOST_OFFLINE_NOTICE_SEC = GD_DISCONNECT_AFTER_SEC;

/** UI 表示ラベル（既存 GD design language に合わせた簡潔な日本語）。 */
export const GD_CONNECTION_LABELS: Readonly<Record<GdConnectionState, string>> = {
  online: 'オンライン',
  disconnected: '接続不安定',
  stale: '不在',
};

/**
 * last_seen_at（無ければ joined_at）と現在時刻から接続状態を導出する（純関数）。
 *
 * ★ DB の connection_state は sweep RPC が書き込む「配信可能な永続値」であり、
 *   本関数は「sweep がまだ走っていない瞬間」を埋めるクライアント側の即時導出。
 *   両者は同じ閾値を使うので結論は一致する（sweep が遅れても UI が先に気づくだけ）。
 *
 * @param lastSeenIso last_seen_at ?? joined_at（ISO 文字列）
 * @param nowMs       サーバ補正済みの現在時刻（clock drift 補正後を渡すこと）
 */
export function deriveGdConnectionState(
  lastSeenIso: string | null | undefined,
  nowMs: number,
): GdConnectionState {
  if (!lastSeenIso) return 'online'; // 情報が無いうちは online 側に倒す（誤検知で人を消さない）
  const seen = Date.parse(lastSeenIso);
  if (!Number.isFinite(seen)) return 'online';
  const elapsedSec = (nowMs - seen) / 1000;
  if (elapsedSec >= GD_STALE_AFTER_SEC) return 'stale';
  if (elapsedSec >= GD_DISCONNECT_AFTER_SEC) return 'disconnected';
  return 'online';
}

/**
 * DB の connection_state とクライアント側導出をマージする。
 *
 * 「より悪い方」を採る:
 *   - sweep 済みで stale なら、直後に heartbeat が来ていない限り stale のまま。
 *   - sweep 前でも、閾値を超えていればクライアントが先に disconnected を表示できる。
 * 逆に「DB が online / 導出も online」なら online。
 */
export function mergeGdConnectionState(
  persisted: GdConnectionState | null | undefined,
  derived: GdConnectionState,
): GdConnectionState {
  const rank: Record<GdConnectionState, number> = { online: 0, disconnected: 1, stale: 2 };
  const p = persisted && persisted in rank ? persisted : 'online';
  return rank[p] >= rank[derived] ? p : derived;
}

/** DB 値の正規化（未知値・NULL は online 扱い）。 */
export function asGdConnectionState(v: unknown): GdConnectionState {
  return v === 'disconnected' || v === 'stale' ? v : 'online';
}

/**
 * 「議論に実在している人間参加者」か。
 *
 * 満員判定・AI 補完人数・評価対象の判断で使う想定の共通述語。
 * ★ 現時点では **left_at のみ**を根拠にする（既存挙動と完全に同じ）。
 *   stale を除外すると「一時離席で評価対象から外れる」など product 影響が大きいため、
 *   接続状態は表示・観測に留め、既存の人数ロジックは変更しない（非破壊の原則）。
 */
export function isActiveHumanMember(m: { isAi: boolean; leftAt?: string | null }): boolean {
  return !m.isAi && !m.leftAt;
}
