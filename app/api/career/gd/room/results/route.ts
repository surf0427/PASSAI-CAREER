// PASSAI 就活版 — GD 結果履歴 hydrate API（STEP-GD-20-L）。
//
// GET /api/career/gd/room/results
//   - member ログイン必須（未ログインは 401）。
//   - **自分（session.user.id）の career_gd_room_results だけ**を返す。user_id は body/query で
//     受け取らず、必ずセッションの user id を server 側で強制する（他人結果の取得は不可能）。
//   - theme / room_type / 人数（人間・AI）は career_gd_rooms / career_gd_room_members を join して補完。
//   - service-role で DB 操作（RLS bypass だが user_id 条件で自分の行に限定）。RLS/GRANT 未適用でも動作する。
//   - 返却に PII を含めない: user_id / email / join_code_hash / sender_user_id / 生 IP は返さない。
//
// クライアント（app/career/gd/MultiGdHistorySection）は本 API を叩いて localStorage(careerGdRoomLogs)
// へ merge only（重複は roomId で排除・local 優先）。DB 取得失敗でも localStorage 表示は壊れない。

import {
  authenticateGdMember,
  getGdAdmin,
  isUndefinedTable,
  dbNotAppliedResponse,
} from '../roomAuth';
import type {
  CareerGdRoomResultHistoryItem,
  CareerGdRoomResultsResponse,
  GdFormat,
  CareerGdEvaluation,
  CareerGdRankingEntry,
  CareerGdMatchingHints,
} from '@/types/careerGd';

export const maxDuration = 30;

type Row = Record<string, unknown>;

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asFormat(v: unknown): GdFormat {
  return v === 'case' || v === 'abstract' ? v : 'free';
}
function asRoomType(v: unknown): CareerGdRoomResultHistoryItem['roomType'] {
  return v === 'public_lobby' || v === 'invite' || v === 'random_match' ? v : 'unknown';
}

// finishedAt - startedAt（無ければ time_limit_sec）。
function durationSecOf(room: Row | undefined): number {
  if (!room) return 0;
  const started = str(room.started_at);
  const finished = str(room.finished_at);
  if (started && finished) {
    const d = (new Date(finished).getTime() - new Date(started).getTime()) / 1000;
    if (Number.isFinite(d) && d > 0) return Math.round(d);
  }
  return typeof room.time_limit_sec === 'number' ? room.time_limit_sec : 0;
}

export async function GET() {
  // ── 認証（member 必須。user_id はセッションからのみ取得） ──
  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const userId = auth.userId;

  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // ── 自分の結果行のみ取得（user_id はサーバ強制・created_at 降順） ──
  const { data: resultData, error: resultErr } = await admin
    .from('career_gd_room_results')
    .select('id, room_id, participant_id, self_feedback, ranking, matching_hints, overall_summary, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (resultErr) {
    if (isUndefinedTable(resultErr)) return dbNotAppliedResponse();
    console.error('Career GD results hydrate: results error', resultErr.message ?? resultErr);
    return jsonError('RESULTS_FETCH_FAILED', '結果履歴の取得に失敗しました。', 500);
  }
  const resultRows = (resultData ?? []) as Row[];
  if (resultRows.length === 0) {
    const empty: CareerGdRoomResultsResponse = { results: [] };
    return Response.json(empty);
  }

  const roomIds = [...new Set(resultRows.map((r) => str(r.room_id)).filter(Boolean))];

  // ── room（theme/format/room_type/所要時間） ──
  const roomById = new Map<string, Row>();
  {
    const { data, error } = await admin
      .from('career_gd_rooms')
      .select('id, format, theme, room_type, time_limit_sec, started_at, finished_at')
      .in('id', roomIds);
    if (error && !isUndefinedTable(error)) {
      console.error('Career GD results hydrate: rooms error', error.message ?? error);
    }
    for (const r of (data ?? []) as Row[]) roomById.set(str(r.id), r);
  }

  // ── members（人間・AI 人数の集計） ──
  const humanByRoom = new Map<string, number>();
  const aiByRoom = new Map<string, number>();
  {
    const { data, error } = await admin
      .from('career_gd_room_members')
      .select('room_id, is_ai')
      .in('room_id', roomIds);
    if (error && !isUndefinedTable(error)) {
      console.error('Career GD results hydrate: members error', error.message ?? error);
    }
    for (const m of (data ?? []) as Row[]) {
      const rid = str(m.room_id);
      if (!rid) continue;
      if (m.is_ai === true) aiByRoom.set(rid, (aiByRoom.get(rid) ?? 0) + 1);
      else humanByRoom.set(rid, (humanByRoom.get(rid) ?? 0) + 1);
    }
  }

  const items: CareerGdRoomResultHistoryItem[] = resultRows.map((row) => {
    const roomId = str(row.room_id);
    const room = roomById.get(roomId);
    const theme = room?.theme && typeof room.theme === 'object' ? (room.theme as Row) : null;
    const humanCount = humanByRoom.get(roomId) ?? 0;
    const aiCount = aiByRoom.get(roomId) ?? 0;
    return {
      roomId,
      resultId: str(row.id),
      roomType: asRoomType(room?.room_type),
      theme: theme && str(theme.title) ? str(theme.title) : null,
      format: asFormat(room?.format),
      participantCount: humanCount + aiCount,
      humanParticipantCount: humanCount,
      aiParticipantCount: aiCount,
      createdAt: str(row.created_at),
      durationSec: durationSecOf(room),
      participantId: str(row.participant_id),
      evaluation: (row.self_feedback ?? {}) as CareerGdEvaluation,
      ranking: (Array.isArray(row.ranking) ? row.ranking : []) as CareerGdRankingEntry[],
      matchingHints: (row.matching_hints ?? { hints: [], summary: '' }) as CareerGdMatchingHints,
      consultationSummary: str(row.overall_summary),
    };
  });

  const res: CareerGdRoomResultsResponse = { results: items };
  return Response.json(res);
}
