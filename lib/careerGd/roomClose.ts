// PASSAI 就活版 — GD マルチ ルームの終了（論理削除）共通ヘルパー（server-only）。
//
// 修正2（部屋の削除・終了）/ 修正3（リーダー退出）で共用する。
//   - status が waiting / active の room を cancelled にする（論理削除）。
//   - finished は cancelled で上書きしない（結果整合性を守るため member cleanup もしない）。
//   - status='waiting' or 'active' 条件付き UPDATE でレース耐性を持たせ、
//     「部屋を終了」と「リーダー退出」が同時に走っても二重処理にならない。
//   - 参加者を退出扱い（left_at）にし、残存参加者情報を整理する（best-effort）。
//
// 再実行整合性（重要）:
//   room status を正本とし、member cleanup は「room が cancelled である限り」何度でも安全に
//   再実行できる（`left_at IS NULL` の member だけ更新するため冪等）。room の cancelled 更新は
//   成功したが member 更新が失敗した部分障害でも、次回 cancelRoom 呼び出し（close / host leave の
//   再試行・競合）で cleanup が再度走り、取りこぼした left_at が補正される。
//   → 「room は cancelled だが active member が残り続ける」状態を作らない。
//
// DB 操作は service-role クライアント（API ゲートウェイ方式）。呼び出し側で host 権限を検証する。

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cancelRoomCore } from './roomCloseCore';

export type { CancelRoomResult } from './roomCloseCore';

// room を cancelled にする（論理削除）。既に cancelled でも member cleanup は再実行する。
export function cancelRoom(admin: SupabaseClient, roomId: string) {
  return cancelRoomCore(admin, roomId);
}
