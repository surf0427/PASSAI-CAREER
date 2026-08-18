// PASSAI 就活版 — GD Phase2 マルチGD AI 発言生成 API（STEP-GD-14）。
//
// POST /api/career/gd/room/[roomId]/ai-turn
//   - member ログイン必須。room 参加者のみ。room.status='active' のときだけ。
//   - AI member のうち「次に発言すべき 1 名」を決定的に選ぶ
//     （直前の発言者を避け、発言回数が最少の AI を joined 順で選ぶ）。
//   - theme / members / 直近 messages / persona を使って短い GD 発言を生成する。
//   - 生成成功時のみ messages に保存（seq はサーバ採番）。失敗時は保存しない。
//   - AI 発言にも冪等キー（client_msg_id）を付与し、二重 AI 補完を防ぐ。
//   - 応答に service_role key / pepper / env 値は含めない。

import type { GdFormat, GdParticipant, GdUtterance, GdRole } from '@/types/careerGd';
import { anthropic } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import { buildTurnSystem, buildTurnUser, CAREER_GD_MODEL } from '../../../gdPrompt';
import {
  authenticateGdMember,
  getGdAdmin,
  isUndefinedTable,
  dbNotAppliedResponse,
} from '../../roomAuth';
import { mapMessageRow } from '../../roomMappers';
import { postRoomMessage, loadRoomMessages } from '../../roomMessages';

import { requireCareerGdEnabled } from '@/lib/careerGdGate/flags.server';
import { finishRoomIfExpired } from '../../roomLifecycle';
import { reportGdFailure } from '../../../gdObservability';
import { enforceRateLimit, CAREER_GD_RATE_LIMITS } from '@/lib/rateLimit';
export const maxDuration = 80;

const MAX_UTTERANCE_CHARS = 400;
const MAX_TRANSCRIPT = 40;
const AI_TURN_TIMEOUT_MS = 40_000;

type Row = Record<string, unknown>;

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

const ROLES: GdRole[] = ['facilitator', 'scribe', 'timekeeper', 'presenter', 'member'];

// member 行 → GdParticipant（プロンプト用）。
function memberToParticipant(m: Row): GdParticipant {
  const persona = m.persona && typeof m.persona === 'object' ? (m.persona as Row) : null;
  const a = persona?.assertiveness;
  const p: GdParticipant = {
    id: String(m.participant_id),
    type: m.is_ai === true ? 'ai' : 'user',
    displayName: (typeof m.display_name === 'string' && m.display_name) || '参加者',
    role: ROLES.includes(m.role as GdRole) ? (m.role as GdRole) : 'member',
  };
  if (persona) {
    p.persona = {
      assertiveness: a === 1 || a === 2 || a === 3 ? a : 2,
      style: (typeof persona.style === 'string' && persona.style) || '一般型',
    };
  }
  return p;
}

// message 行 → GdUtterance（プロンプト用）。
function messageToUtterance(row: Row): GdUtterance {
  return {
    id: String(row.id),
    participantId: String(row.participant_id),
    content: typeof row.content === 'string' ? row.content : '',
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    ...(row.kind === 'system' ? { kind: 'system' as const } : {}),
  };
}

// 次に発言すべき AI member を選ぶ（決定的）。
//   - 退室していない AI members が対象。
//   - 直前の発言者は避ける（AI が連続で 2 回話さない。AI が 1 名だけなら例外的に許容）。
//   - 発言回数（speech）が最少の AI を選び、同数なら joined 順（配列順）で先頭。
function pickNextAiMember(aiMembers: Row[], messages: Row[]): Row | null {
  if (aiMembers.length === 0) return null;
  const speechCount = new Map<string, number>();
  let lastSpeaker = '';
  let lastSeq = -1;
  for (const msg of messages) {
    if (msg.kind === 'system') continue;
    const pid = String(msg.participant_id);
    speechCount.set(pid, (speechCount.get(pid) ?? 0) + 1);
    const seq = typeof msg.seq === 'number' ? msg.seq : Number(msg.seq) || 0;
    if (seq > lastSeq) {
      lastSeq = seq;
      lastSpeaker = pid;
    }
  }
  const candidates = aiMembers.filter((m) => aiMembers.length === 1 || String(m.participant_id) !== lastSpeaker);
  const pool = candidates.length > 0 ? candidates : aiMembers;
  let best: Row | null = null;
  let bestCount = Infinity;
  for (const m of pool) {
    const c = speechCount.get(String(m.participant_id)) ?? 0;
    if (c < bestCount) {
      bestCount = c;
      best = m;
    }
  }
  return best;
}

export async function POST(_req: Request, ctx: { params: Promise<{ roomId: string }> }) {
  // ── STEP-GD-31: GD kill switch（server flag が最終権限）──
  //    OFF なら body parse / auth / DB / AI へ到達する前に 404。UI flag は権限に影響しない。
  const gdGate = requireCareerGdEnabled();
  if (gdGate) return gdGate;

  const { roomId } = await ctx.params;
  if (!roomId) return jsonError('BAD_REQUEST', 'ルームIDが不正です。', 400);

  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;

  // STEP-GD-31: AI 発言は Anthropic 課金に直結するため user 単位の上限を掛ける。
  const limited = await enforceRateLimit(auth.userId, CAREER_GD_RATE_LIMITS.aiTurn);
  if (limited) return limited;

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
    reportGdFailure(roomErr, 'gd/room/ai-turn', 'ROOM_FETCH_FAILED', 500);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  if (!roomRow) return jsonError('ROOM_NOT_FOUND', 'ルームが見つかりません。', 404);

  // members 取得。
  const { data: memberData, error: memberErr } = await admin
    .from('career_gd_room_members')
    .select('*')
    .eq('room_id', roomId)
    .order('joined_at', { ascending: true });
  if (memberErr) {
    if (isUndefinedTable(memberErr)) return dbNotAppliedResponse();
    reportGdFailure(memberErr, 'gd/room/ai-turn', 'ROOM_FETCH_FAILED', 500);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  const memberRows = (memberData ?? []) as Row[];
  const currentRow = memberRows.find((m) => m.user_id === auth.userId) ?? null;
  if (!currentRow) return jsonError('NOT_A_MEMBER', 'このルームの参加者ではありません。', 403);
  // ── STEP-GD-31: server-side timer enforcement ──
  //    時間切れ後に AI 発言（＝ Anthropic 課金）が走り続けないよう、生成前に DB 側 now() で判定する。
  if ((roomRow as Row).status === 'active') {
    const expiry = await finishRoomIfExpired(admin, roomId);
    if (expiry.kind === 'finished') {
      return jsonError('ROOM_TIME_EXPIRED', '制限時間が終了したため、AI発言は生成できません。', 409);
    }
  }

  if ((roomRow as Row).status !== 'active') {
    return jsonError('ROOM_NOT_ACTIVE', 'このルームは進行中ではありません。', 409);
  }

  const aiMembers = memberRows.filter((m) => m.is_ai === true && m.left_at == null);
  if (aiMembers.length === 0) {
    return jsonError('NO_AI_MEMBER', 'このルームにはAIメンバーがいません。', 409);
  }

  // messages 取得（全件・古い順）。
  let messageRows: Row[];
  try {
    messageRows = await loadRoomMessages(admin, roomId, null);
  } catch (e) {
    if (isUndefinedTable(e)) return dbNotAppliedResponse();
    reportGdFailure(e, 'gd/room/ai-turn', 'MESSAGES_FETCH_FAILED', 500);
    return jsonError('ROOM_FETCH_FAILED', '発言の取得に失敗しました。', 500);
  }

  const speaker = pickNextAiMember(aiMembers, messageRows);
  if (!speaker) return jsonError('NO_AI_MEMBER', '発言できるAIメンバーがいません。', 409);
  const speakerParticipantId = String(speaker.participant_id);

  // プロンプト材料。
  const theme = (roomRow as Row).theme;
  const themeObj = theme && typeof theme === 'object' ? (theme as Row) : {};
  const themeTitle = typeof themeObj.title === 'string' ? themeObj.title : '';
  if (!themeTitle) return jsonError('THEME_NOT_READY', 'テーマが未設定です。', 409);

  const participants = memberRows.filter((m) => m.left_at == null).map(memberToParticipant);
  const speakerParticipant = participants.find((p) => p.id === speakerParticipantId);
  if (!speakerParticipant) return jsonError('NO_AI_MEMBER', '発言者を特定できませんでした。', 409);

  const transcript = messageRows.slice(-MAX_TRANSCRIPT).map(messageToUtterance);
  const format: GdFormat =
    (roomRow as Row).format === 'case' || (roomRow as Row).format === 'abstract'
      ? ((roomRow as Row).format as GdFormat)
      : 'free';

  const system = buildTurnSystem(speakerParticipant, format);
  const user = buildTurnUser({
    theme: {
      title: themeTitle,
      description: typeof themeObj.description === 'string' ? themeObj.description : '',
      constraints: Array.isArray(themeObj.constraints)
        ? (themeObj.constraints as unknown[]).filter((c): c is string => typeof c === 'string')
        : [],
    },
    speaker: speakerParticipant,
    participants,
    transcript,
    wrapUp: false,
  });

  // 生成（失敗時は保存しない）。
  let content = '';
  try {
    const message = await anthropic.messages.create(
      {
        model: CAREER_GD_MODEL,
        max_tokens: 300,
        temperature: 0.8,
        system,
        messages: [{ role: 'user', content: user }],
      },
      { signal: createTimeoutSignal(AI_TURN_TIMEOUT_MS) },
    );
    const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';
    content = raw.trim().slice(0, MAX_UTTERANCE_CHARS);
  } catch (error) {
    reportGdFailure(error, 'gd/room/ai-turn', 'AI_TURN_FAILED', 500);
    return jsonError('AI_REQUEST_FAILED', 'AI発言の生成に失敗しました。時間をおいて再度お試しください。', 502);
  }
  if (!content) {
    return jsonError('AI_GD_EMPTY', 'AI発言を生成できませんでした。', 502);
  }

  // 冪等キー: 同じ AI の「これまでの発言回数」を含めることで、二重リクエストで
  // 同一 AI・同一ターンなら同じ client_msg_id になり、dedup で 1 件に収束する。
  const priorCount = messageRows.filter((m) => String(m.participant_id) === speakerParticipantId).length;
  const clientMsgId = `ai-${speakerParticipantId}-${priorCount}`;

  try {
    const { row } = await postRoomMessage(admin, {
      roomId,
      participantId: speakerParticipantId,
      senderUserId: null,
      content,
      kind: 'speech',
      clientMsgId,
    });
    return Response.json({ message: mapMessageRow(row), speakerParticipantId });
  } catch (e) {
    if (isUndefinedTable(e)) return dbNotAppliedResponse();
    reportGdFailure(e, 'gd/room/ai-turn', 'AI_TURN_SAVE_FAILED', 500);
    return jsonError('MESSAGE_POST_FAILED', 'AI発言の保存に失敗しました。', 500);
  }
}
