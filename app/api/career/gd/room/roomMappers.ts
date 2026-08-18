// PASSAI 就活版 — GD Phase2 room 系テーブル行 → クライアント型への変換（server 側）。
//
// join_code_hash / pepper 等の秘密はクライアントへ出さない（本モジュールでは扱わない）。
// snake_case DB 行 → camelCase の client 型（types/careerGd.ts）へ写すだけの純粋関数。

import { asGdConnectionState } from '@/lib/careerGd/presence';
import type {
  CareerGdRoom,
  CareerGdRoomMember,
  CareerGdRoomMessage,
  GdRoomStatus,
  GdRoomType,
  GdFormat,
  GdRole,
  GdTheme,
} from '@/types/careerGd';

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStatus(v: unknown): GdRoomStatus {
  return v === 'waiting' || v === 'active' || v === 'finished' || v === 'cancelled'
    ? v
    : 'waiting';
}

function asFormat(v: unknown): GdFormat {
  return v === 'case' || v === 'abstract' ? v : 'free';
}

function asRoomType(v: unknown): GdRoomType {
  return v === 'public_lobby' || v === 'random_match' ? v : 'invite';
}

function asRole(v: unknown): GdRole {
  return v === 'facilitator' || v === 'scribe' || v === 'timekeeper' || v === 'presenter' || v === 'member'
    ? v
    : 'member';
}

function asTheme(v: unknown): GdTheme | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Row;
  if (!str(t.title) && !str(t.description)) return null;
  return {
    title: str(t.title),
    description: str(t.description),
    format: asFormat(t.format),
    ...(Array.isArray(t.constraints)
      ? { constraints: (t.constraints as unknown[]).filter((c): c is string => typeof c === 'string') }
      : {}),
  };
}

// career_gd_rooms 行 → CareerGdRoom（join_code_hash は含めない）。
export function mapRoomRow(row: Row): CareerGdRoom {
  return {
    id: str(row.id),
    hostUserId: str(row.host_user_id),
    status: asStatus(row.status),
    roomType: asRoomType(row.room_type),
    format: asFormat(row.format),
    theme: asTheme(row.theme),
    timeLimitSec: typeof row.time_limit_sec === 'number' ? row.time_limit_sec : 900,
    plannedParticipantCount:
      typeof row.planned_participant_count === 'number' ? row.planned_participant_count : 4,
    codeExpiresAt: str(row.code_expires_at),
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

// career_gd_room_members 行 → CareerGdRoomMember。
export function mapMemberRow(row: Row): CareerGdRoomMember {
  const persona =
    row.persona && typeof row.persona === 'object'
      ? (row.persona as Row)
      : null;
  const member: CareerGdRoomMember = {
    id: str(row.id),
    roomId: str(row.room_id),
    userId: (row.user_id as string | null) ?? null,
    isAi: row.is_ai === true,
    isHost: row.is_host === true,
    participantId: str(row.participant_id),
    displayName: str(row.display_name) || '参加者',
    role: asRole(row.role),
    joinedAt: str(row.joined_at),
    leftAt: (row.left_at as string | null) ?? null,
    // STEP-GD-31: presence（切断検知）。career_gd_realtime_apply.sql 未適用の環境では
    //   列が無く undefined になるため、lastSeenAt=null / connectionState='online' に倒れる
    //   （＝従来と同じ「全員オンライン扱い」で degrade する。表示が壊れない）。
    lastSeenAt: (row.last_seen_at as string | null) ?? null,
    connectionState: asGdConnectionState(row.connection_state),
  };
  if (persona) {
    const a = persona.assertiveness;
    // persona jsonb は buildAiRoomMembers が入れた CareerGdAiPersona（snake_case キー）。
    // 秘匿情報は含まない（persona_key / 説明・話し方・強み弱みはいずれも表示・プロンプト用の公開情報）。
    const p: NonNullable<CareerGdRoomMember['persona']> = {
      assertiveness: a === 1 || a === 2 || a === 3 ? a : 2,
      style: str(persona.style) || '一般型',
    };
    if (str(persona.persona_key)) p.personaKey = str(persona.persona_key);
    if (str(persona.role)) p.personaRole = str(persona.role);
    if (str(persona.persona_summary)) p.personaSummary = str(persona.persona_summary);
    if (str(persona.speaking_style)) p.speakingStyle = str(persona.speaking_style);
    if (Array.isArray(persona.strengths)) {
      p.strengths = (persona.strengths as unknown[]).filter((s): s is string => typeof s === 'string');
    }
    if (Array.isArray(persona.weaknesses)) {
      p.weaknesses = (persona.weaknesses as unknown[]).filter((s): s is string => typeof s === 'string');
    }
    member.persona = p;
  }
  return member;
}

// career_gd_room_messages 行 → CareerGdRoomMessage。
export function mapMessageRow(row: Row): CareerGdRoomMessage {
  return {
    id: str(row.id),
    roomId: str(row.room_id),
    participantId: str(row.participant_id),
    senderUserId: (row.sender_user_id as string | null) ?? null,
    seq: typeof row.seq === 'number' ? row.seq : Number(row.seq) || 0,
    content: str(row.content),
    kind: row.kind === 'system' ? 'system' : 'speech',
    createdAt: str(row.created_at),
  };
}
