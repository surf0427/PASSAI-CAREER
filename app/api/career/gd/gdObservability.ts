// PASSAI 就活版 — GD server API の観測（STEP-GD-31・server-only）。
//
// 既存の `lib/sentry/capture.ts`（captureRouteException）へ委譲する薄い層。
// GD 専用の並行 observability architecture は作らない。
//
// ★ ここに集約する理由:
//   GD は route が 20 本以上あり、各 route で tags を手書きすると
//   feature 名や route 名が揺れて集計できなくなる。入口を 1 つにする。
//
// ★ 出してよいもの / 出してはいけないもの（要件 35）:
//   OK  … route 名 / error code / HTTP status / 所要 ms / 件数などの metadata
//   NG  … 合言葉平文・join_code_hash・transcript 本文・private feedback・
//         Data Spine 本文・service role key・pepper・auth cookie・user_id / room_id
//   room_id / user_id は UUID（識別子）なので **tags にも extra にも入れない**。
//   captureRouteException のシグネチャ自体が上記以外を受け付けないため、
//   本モジュールを通す限り構造的に混入しない。

import 'server-only';

import { captureRouteException } from '@/lib/sentry/capture';

/** GD の観測単位（route 名。Sentry の tag 値になる）。 */
export type GdRouteName =
  | 'gd/room/create'
  | 'gd/room/join'
  | 'gd/room/get'
  | 'gd/room/start'
  | 'gd/room/messages'
  | 'gd/room/ai-turn'
  | 'gd/room/finish'
  | 'gd/room/leave'
  | 'gd/room/close'
  | 'gd/room/result'
  | 'gd/room/results'
  | 'gd/room/heartbeat'
  | 'gd/lobby/create'
  | 'gd/lobby/join'
  | 'gd/lobby/rooms'
  | 'gd/match/enter'
  | 'gd/match/status'
  | 'gd/match/cancel'
  | 'gd/theme'
  | 'gd/turn'
  | 'gd/feedback'
  | 'gd/cron/cleanup'
  | 'gd/context/user-spine'
  | 'gd/context/company-spine'
  | 'gd/realtime/subscribe';

/**
 * GD の失敗を Sentry へ送る（no-throw / Sentry 未初期化なら no-op）。
 *
 * @param error  例外 or 失敗を表す値（本文を含む可能性があるものは渡さない）
 * @param route  GD route 名
 * @param code   アプリ内 error code（ROOM_NOT_JOINABLE 等・レスポンスの `error` と揃える）
 * @param status HTTP status
 * @param durationMs 計測できている場合のみ
 */
export function captureGdFailure(
  error: unknown,
  route: GdRouteName,
  code: string,
  status?: number,
  durationMs?: number | null,
): void {
  try {
    captureRouteException(
      error,
      { route, feature: 'career-gd', status: status ?? null },
      { status: status ?? null, code, durationMs: durationMs ?? null },
    );
  } catch {
    // 観測が本処理を落とさない（Sentry 初期化前などでも安全）。
  }
}

/**
 * 失敗を「metadata だけ」でサーバログにも残す。
 *
 * Sentry を設定していない環境（local / preview）でも運用者が気づけるようにするための最小限。
 * ★ 可変部分は route / code / status のみ。本文・識別子は絶対に連結しない。
 */
export function logGdFailure(route: GdRouteName, code: string, status?: number): void {
  console.error(`career-gd failure route=${route} code=${code} status=${status ?? '-'}`);
}

/** Sentry + サーバログをまとめて行う（route の catch / 早期 return から 1 行で呼ぶ）。 */
export function reportGdFailure(
  error: unknown,
  route: GdRouteName,
  code: string,
  status?: number,
  durationMs?: number | null,
): void {
  logGdFailure(route, code, status);
  captureGdFailure(error, route, code, status, durationMs);
}
