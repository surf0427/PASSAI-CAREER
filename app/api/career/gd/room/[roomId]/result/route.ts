// PASSAI 就活版 — GD Phase2 マルチGD 簡易結果 API（STEP-GD-14 の最小土台）。
//
// POST /api/career/gd/room/[roomId]/result
//   - member ログイン必須。room 参加者（人間）のみ。room.status='finished' のときだけ。
//   - 本格採点は次 STEP。ここでは **実測できる発言参加量**のみを根拠にした暫定結果を作る
//     （根拠のない断定・でっち上げの数値評価はしない）。
//   - career_gd_room_results に (room_id, user_id) UNIQUE で upsert（二重実行に強い）。
//   - ranking（発言量ベース）は全員に共有。self_feedback は本人ぶん。
//   - 応答に service_role key / pepper / env 値は含めない。

import type {
  GdCompanyGrade,
  CareerGdRoomParticipationRank,
  CareerGdRoomSimpleFeedback,
  CareerGdRoomResultView,
} from '@/types/careerGd';
import {
  authenticateGdMember,
  getGdAdmin,
  isUndefinedTable,
  dbNotAppliedResponse,
} from '../../roomAuth';
import { loadRoomMessages } from '../../roomMessages';

export const maxDuration = 30;

type Row = Record<string, unknown>;

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

// 発言量から暫定 self_feedback を組み立てる（断定を避け、実測値のみを根拠にする）。
function buildSelfFeedback(selfCount: number, totalCount: number): CareerGdRoomSimpleFeedback {
  const strengths: string[] = [];
  const improvements: string[] = [];
  const nextPracticeTasks: string[] = [];

  if (selfCount === 0) {
    improvements.push('今回は発言が記録されていません。次回はまず1回、自分の考えを声に出すことを目標にしましょう。');
    nextPracticeTasks.push('最初の5分以内に一度発言する練習をする。');
  } else if (selfCount <= 2) {
    strengths.push('議論に参加し、自分の意見を発信できました。');
    improvements.push('発言回数を少し増やし、他の人の意見への反応も加えるとより貢献度が伝わります。');
    nextPracticeTasks.push('相手の発言を受けて「それに加えて」と続ける発言を意識する。');
  } else {
    strengths.push('複数回発言し、積極的に議論へ貢献できました。');
    improvements.push('発言量は十分です。次は結論に向けて論点を整理する発言を意識するとさらに良くなります。');
    nextPracticeTasks.push('議論の後半で、出た意見をまとめる発言を1回入れる。');
  }

  const share = totalCount > 0 ? Math.round((selfCount / totalCount) * 100) : 0;
  const participationSummary =
    totalCount === 0
      ? 'このルームではまだ発言が記録されていません。'
      : `全体の発言 ${totalCount} 回のうち、あなたの発言は ${selfCount} 回（約 ${share}%）でした。`;

  return { participationSummary, speechCount: selfCount, totalSpeechCount: totalCount, strengths, improvements, nextPracticeTasks };
}

export async function POST(_req: Request, ctx: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await ctx.params;
  if (!roomId) return jsonError('BAD_REQUEST', 'ルームIDが不正です。', 400);

  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // room 取得。
  const { data: roomRow, error: roomErr } = await admin
    .from('career_gd_rooms')
    .select('*')
    .eq('id', roomId)
    .maybeSingle();
  if (roomErr) {
    if (isUndefinedTable(roomErr)) return dbNotAppliedResponse();
    console.error('Career GD result: room lookup error', roomErr.message);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  if (!roomRow) return jsonError('ROOM_NOT_FOUND', 'ルームが見つかりません。', 404);
  if ((roomRow as Row).status !== 'finished') {
    return jsonError('ROOM_NOT_FINISHED', 'このルームはまだ終了していません。結果は終了後に表示できます。', 409);
  }

  // members 取得。
  const { data: memberData, error: memberErr } = await admin
    .from('career_gd_room_members')
    .select('*')
    .eq('room_id', roomId)
    .order('joined_at', { ascending: true });
  if (memberErr) {
    if (isUndefinedTable(memberErr)) return dbNotAppliedResponse();
    console.error('Career GD result: members lookup error', memberErr.message);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  const memberRows = (memberData ?? []) as Row[];
  const currentRow = memberRows.find((m) => m.user_id === auth.userId) ?? null;
  if (!currentRow) return jsonError('NOT_A_MEMBER', 'このルームの参加者ではありません。', 403);
  const selfParticipantId = String(currentRow.participant_id);

  // messages 取得（発言量の集計に使う）。
  let messageRows: Row[];
  try {
    messageRows = await loadRoomMessages(admin, roomId, null);
  } catch (e) {
    if (isUndefinedTable(e)) return dbNotAppliedResponse();
    console.error('Career GD result: messages load error', e);
    return jsonError('ROOM_FETCH_FAILED', '発言の取得に失敗しました。', 500);
  }

  // 発言回数を集計（speech のみ）。
  const speechCount = new Map<string, number>();
  let totalSpeech = 0;
  for (const msg of messageRows) {
    if (msg.kind === 'system') continue;
    const pid = String(msg.participant_id);
    speechCount.set(pid, (speechCount.get(pid) ?? 0) + 1);
    totalSpeech += 1;
  }

  // ranking（発言量ベース・全員共有）。企業評価の断定はしない。
  const ranking: CareerGdRoomParticipationRank[] = memberRows
    .filter((m) => m.left_at == null)
    .map((m) => ({
      participantId: String(m.participant_id),
      displayName: (typeof m.display_name === 'string' && m.display_name) || '参加者',
      isAi: m.is_ai === true,
      speechCount: speechCount.get(String(m.participant_id)) ?? 0,
      rank: 0,
    }))
    .sort((a, b) => b.speechCount - a.speechCount)
    .map((entry, i) => ({ ...entry, rank: i + 1 }));

  const selfCount = speechCount.get(selfParticipantId) ?? 0;
  const selfFeedback = buildSelfFeedback(selfCount, totalSpeech);
  const selfCompanyGrade: GdCompanyGrade = 'B'; // 暫定プレースホルダ（本格採点は次 STEP）
  const overallSummary =
    totalSpeech === 0
      ? '今回のGDでは発言が記録されませんでした。次回はまず発言することを目標にしましょう。'
      : `今回のGDでは全体で ${totalSpeech} 回の発言がありました。ここでは発言量をもとにした暫定的な振り返りを表示しています。`;
  const matchingHints = { summary: selfFeedback.participationSummary };

  // upsert（(room_id, user_id) UNIQUE で二重実行に強い）。
  const { error: upErr } = await admin
    .from('career_gd_room_results')
    .upsert(
      {
        room_id: roomId,
        user_id: auth.userId,
        participant_id: selfParticipantId,
        self_feedback: selfFeedback,
        ranking,
        self_company_grade: selfCompanyGrade,
        overall_summary: overallSummary,
        matching_hints: matchingHints,
      },
      { onConflict: 'room_id,user_id' },
    );
  if (upErr) {
    if (isUndefinedTable(upErr)) return dbNotAppliedResponse();
    console.error('Career GD result: upsert error', upErr.message);
    return jsonError('RESULT_SAVE_FAILED', '結果の保存に失敗しました。時間をおいて再度お試しください。', 500);
  }

  const result: CareerGdRoomResultView = {
    roomId,
    participantId: selfParticipantId,
    provisional: true,
    selfCompanyGrade,
    selfFeedback,
    ranking,
    overallSummary,
    matchingHints,
    createdAt: new Date().toISOString(),
  };
  return Response.json({ result });
}
