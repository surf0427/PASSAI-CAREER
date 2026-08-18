// PASSAI 就活版 — GD マルチ 参加者 heartbeat API（STEP-GD-31）。
//
// POST /api/career/gd/room/[roomId]/heartbeat
//   - member ログイン必須。room 参加者本人のみ（非参加者は 403）。
//   - 自分の member 行の last_seen_at を now() にし、connection_state を 'online' へ戻す。
//   - ついでに presence sweep（他参加者の切断検知）と timer enforcement を回す。
//
// ★ なぜ Presence だけでは足りないか:
//   Supabase Realtime の Presence は「channel に繋がっているか」しか分からず、
//   ① Realtime が無効 / 遮断された環境では常に空になる
//   ② サーバ側（AI 補完人数・cleanup・評価対象の判断）から参照できない
//   ③ 履歴として残らない（後追いで「いつ落ちたか」を調べられない）
//   そこで **Presence（即時性）+ DB heartbeat（権威性・可観測性）** の二重構成にする。
//
// ★ disconnect ≠ leave:
//   本 API は left_at を一切触らない。切断は connection_state だけで表現し、
//   再接続すれば online へ戻る（同じ member 行が復活する＝ duplicate member を作らない）。
//
// ★ ID 差し替え不可:
//   更新対象は「session の user_id と一致する自分の行」だけ（RPC の WHERE 句で固定）。
//   participantId をクライアントから受け取らないため、他人の presence は更新できない。

import {
  authenticateGdMember,
  getGdAdmin,
  isUndefinedTable,
  dbNotAppliedResponse,
} from '../../roomAuth';
import { mapMemberRow } from '../../roomMappers';
import { finishRoomIfExpired, sweepRoomPresence } from '../../roomLifecycle';
import { reportGdFailure } from '../../../gdObservability';
import { requireCareerGdEnabled } from '@/lib/careerGdGate/flags.server';
import { enforceRateLimit, CAREER_GD_RATE_LIMITS } from '@/lib/rateLimit';

export const maxDuration = 15;

type Row = Record<string, unknown>;

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

/** Postgres の「関数未定義」= career_gd_realtime_apply.sql 未適用。 */
function isUndefinedFunction(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === '42883' ||
    e.code === 'PGRST202' ||
    (typeof e.message === 'string' &&
      /function .* does not exist|could not find the function/i.test(e.message))
  );
}

export async function POST(_req: Request, ctx: { params: Promise<{ roomId: string }> }) {
  // ── STEP-GD-31: GD kill switch（server flag が最終権限）──
  const gdGate = requireCareerGdEnabled();
  if (gdGate) return gdGate;

  const { roomId } = await ctx.params;
  if (!roomId) return jsonError('BAD_REQUEST', 'ルームIDが不正です。', 400);

  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;

  // heartbeat は高頻度（既定 15 秒間隔）。暴走クライアント・スクリプトによる
  // 書き込み増幅を防ぐため user 単位の上限を掛ける（正常クライアントは十分下回る）。
  const limited = await enforceRateLimit(auth.userId, CAREER_GD_RATE_LIMITS.heartbeat);
  if (limited) return limited;

  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // ── 1) 自分の presence を更新（RPC。未適用環境では app 層 fallback）──
  let memberRow: Row | null = null;
  try {
    const { data, error } = await admin.rpc('career_gd_heartbeat', {
      p_room_id: roomId,
      p_user_id: auth.userId,
    });
    if (error) {
      if (!isUndefinedFunction(error)) {
        if (isUndefinedTable(error)) return dbNotAppliedResponse();
        reportGdFailure(error, 'gd/room/heartbeat', 'HEARTBEAT_FAILED', 500);
        return jsonError('HEARTBEAT_FAILED', '接続状態の更新に失敗しました。', 500);
      }
      // ── fallback: RPC 未適用。列があれば直接 UPDATE、無ければ membership 確認だけ行う。
      const { data: upd, error: updErr } = await admin
        .from('career_gd_room_members')
        .update({ last_seen_at: new Date().toISOString(), connection_state: 'online' })
        .eq('room_id', roomId)
        .eq('user_id', auth.userId)
        .is('left_at', null)
        .select('*');
      if (updErr) {
        // 列自体が無い（realtime DDL 未適用）→ presence 機能だけを degrade させ、
        // membership 確認に切り替える。GD 本体は従来どおり動く。
        const { data: mine } = await admin
          .from('career_gd_room_members')
          .select('*')
          .eq('room_id', roomId)
          .eq('user_id', auth.userId)
          .is('left_at', null)
          .maybeSingle();
        if (!mine) return jsonError('NOT_A_MEMBER', 'このルームの参加者ではありません。', 403);
        memberRow = mine as Row;
      } else {
        memberRow = ((upd ?? [])[0] as Row | undefined) ?? null;
      }
    } else {
      memberRow = (Array.isArray(data) ? data[0] : data) as Row | null;
    }
  } catch (e) {
    reportGdFailure(e, 'gd/room/heartbeat', 'HEARTBEAT_FAILED', 500);
    return jsonError('HEARTBEAT_FAILED', '接続状態の更新に失敗しました。', 500);
  }

  // 自分の行が無い = 非参加者 or 退室済み。退室後に heartbeat で復活させない。
  if (!memberRow || !memberRow.id) {
    return jsonError('NOT_A_MEMBER', 'このルームの参加者ではありません。', 403);
  }

  // ── 2) ついでにライフサイクルを進める ──
  //    heartbeat は「誰かが部屋を見ている」最も確実な信号なので、ここで
  //    期限切れ finish と他参加者の切断検知を回す（never-throw）。
  const expiry = await finishRoomIfExpired(admin, roomId);
  const sweep = await sweepRoomPresence(admin, roomId);

  return Response.json({
    ok: true,
    member: mapMemberRow(memberRow),
    // クライアントの clock offset 補正に使う（room GET と同じ契約）。
    serverNow: new Date().toISOString(),
    // 期限切れで今 finished 化された場合、クライアントは即座に結果画面へ遷移できる。
    roomFinished: expiry.kind === 'finished',
    // 観測用（PII なし・件数のみ）。
    swept: { disconnected: sweep.disconnected, stale: sweep.stale },
  });
}
