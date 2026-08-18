'use client';

// PASSAI 就活版 — GD マルチ Realtime Room 基盤（STEP-GD-24）。
//
// 公開GD・招待GD・ランダムマッチGD で共通利用できる Realtime Room 購読レイヤ。
// React Component から Supabase Realtime を直接触らせず、「購読 / 解除 / 再接続 /
// Presence」を本モジュールへ閉じ込める（唯一の React 側入口は hooks/useCareerGdRealtime.ts）。
//
// 責務:
//   ② room 状態同期  : career_gd_rooms（status / started_at / finished_at / theme / 人数）の変更購読
//   ③ participant同期 : career_gd_room_members（joined / left / role / host）の変更購読
//   ④ Presence       : 各ユーザーの online / offline / connecting
//   ⑤ 再接続         : 通信断で自動再接続し、再接続後は現在状態を取り直す（重複購読は禁止）
//
// 設計上の制約（重要・非破壊のため）:
//   - 既存アーキテクチャの「クライアントは room 系テーブルを直接叩かない」を尊重する。
//     postgres_changes は「変更が起きた」というシグナル（onSyncSignal）として扱い、UI が
//     信頼する実データの再取得は既存 API（GET /api/career/gd/room/[roomId]）経由に委ねる。
//     row の best-effort 写像（onRoomUpdate / onMemberUpsert / onMemberRemove）も提供するが、
//     現行 UI の正本は従来どおり API 経由のまま（ポーリングを残す）。
//   - ★ STEP-GD-31 で **実配信が有効化された**（supabase/career_gd_realtime_apply.sql）:
//       ① supabase_realtime publication へ rooms / members / messages を追加
//       ② authenticated へ membership-scoped な **SELECT のみ** の RLS policy を付与
//          （career_gd_is_room_member() で「在籍中の room」に限定。room UUID を知っていても
//            member でなければ 1 行も配信されない）
//       ③ career_gd_rooms は列単位 GRANT で join_code_hash を除外（member にも hash を渡さない）
//       ④ career_gd_room_results は **publication に入れない**（本人 FB を配信経路に載せない）
//     → mutation は従来どおり service_role の API route のみ。Realtime のために
//       書き込み権限を開けていない（security architecture を弱めていない）。
//   - DDL 未適用の環境では従来どおり postgres_changes が届かないが、Presence は channel 層で
//     機能し、実データは polling fallback で同期されるため GD は成立する（degraded mode）。
//   - 本モジュールでは Broadcast / 音声 / WebRTC は扱わない（音声は別 Phase）。

import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';

import { getCareerBrowserSupabaseClient } from '@/lib/careerSupabase/browserClient';
import type {
  CareerGdRoom,
  CareerGdRoomMember,
  CareerGdRoomMessage,
  GdFormat,
  GdRole,
  GdRoomStatus,
  GdRoomType,
  GdTheme,
} from '@/types/careerGd';

// ── 公開型 ───────────────────────────────────────────────────────────

// channel（購読）自体の接続状態。
export type GdRealtimeConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

// Presence が保持する 1 ユーザーの状態。offline は「presence から消えた」状態として UI 側で表す
// （presenceMap に存在しない = offline）。
export type GdPresenceState = 'online';

export type GdPresenceEntry = {
  key: string; // presence key（= participant_id）
  participantId: string;
  userId: string | null;
  displayName: string;
  onlineAt: string;
  state: GdPresenceState;
};

export type GdPresenceMap = Record<string, GdPresenceEntry>;

// このクライアント自身の同定情報（presence の track payload に使う）。
export type GdRealtimeSelfIdentity = {
  participantId: string;
  userId: string | null;
  displayName: string;
};

export type GdRealtimeRoomCallbacks = {
  onConnectionStateChange?: (state: GdRealtimeConnectionState) => void;
  onPresenceChange?: (presence: GdPresenceMap) => void;
  // best-effort 写像（DB が realtime 有効なときのみ発火）。
  onRoomUpdate?: (room: CareerGdRoom) => void;
  onMemberUpsert?: (member: CareerGdRoomMember) => void;
  onMemberRemove?: (memberId: string) => void;
  // STEP-GD-25: 新規発言（career_gd_room_messages INSERT）。clientMsgId は optimistic 対応付け用。
  onMessageInsert?: (message: CareerGdRoomMessage, clientMsgId: string | null) => void;
  // room / member / message いずれかに変更が起きた or 再接続した、という「再取得してね」シグナル。
  // UI 正本は API 経由（クライアントは room 系テーブルを直接叩かない）。
  onSyncSignal?: () => void;
};

// どの購読を有効化するか。既定は GD-24 の presence + room + members（messages は無効）で、
// 既存挙動を変えない。STEP-GD-25 の messages 用 hook は messages のみを有効化した別 channel を使う。
export type GdRealtimeSubscriptions = {
  presence?: boolean;
  room?: boolean;
  members?: boolean;
  messages?: boolean;
};

const DEFAULT_SUBSCRIPTIONS: Required<GdRealtimeSubscriptions> = {
  presence: true,
  room: true,
  members: true,
  messages: false,
};

export type GdRealtimeRoomOptions = {
  roomId: string;
  self: GdRealtimeSelfIdentity;
  callbacks?: GdRealtimeRoomCallbacks;
  // 既定 `career-gd-room-<roomId>`。1 room で複数の関心（presence / messages）を別 channel に
  // 分けたいときに指定する（同一 topic の presence key 競合を避ける）。
  channelName?: string;
  subscriptions?: GdRealtimeSubscriptions;
};

// ── 内部: presence track payload の型 ────────────────────────────────
type GdPresenceMeta = {
  participantId: string;
  userId: string | null;
  displayName: string;
  onlineAt: string;
};

// ── 内部: DB row → client 型 の最小 client 写像 ─────────────────────
// server 側 app/api/.../roomMappers.ts と同等だが、server 専用モジュールを client bundle に
// 引き込まないため本ファイルに最小版を持つ（synced 対象フィールドのみ・秘匿情報は扱わない）。
type Row = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asStatus(v: unknown): GdRoomStatus {
  return v === 'waiting' || v === 'active' || v === 'finished' || v === 'cancelled' ? v : 'waiting';
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

function mapRoomRow(row: Row): CareerGdRoom {
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

function mapMemberRow(row: Row): CareerGdRoomMember {
  const persona = row.persona && typeof row.persona === 'object' ? (row.persona as Row) : null;
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
  };
  if (persona) {
    const a = persona.assertiveness;
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

function mapMessageRow(row: Row): CareerGdRoomMessage {
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

// ── 再接続バックオフ ─────────────────────────────────────────────────
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// ── Realtime Room 購読マネージャ ─────────────────────────────────────
// 1 room につき 1 channel。同一インスタンスの二重 subscribe は禁止（重複購読防止）。
export class CareerGdRealtimeRoom {
  private readonly roomId: string;
  private readonly self: GdRealtimeSelfIdentity;
  private readonly callbacks: GdRealtimeRoomCallbacks;
  private readonly channelName: string;
  private readonly subs: Required<GdRealtimeSubscriptions>;

  private channel: RealtimeChannel | null = null;
  private connectionState: GdRealtimeConnectionState = 'idle';
  private presence: GdPresenceMap = {};

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  // unsubscribe による意図的な切断か（true のときは自動再接続しない）。
  private intentionalClose = false;
  // 一度でも切断を経験したか（再接続後に現在状態を取り直すシグナル発火の判定に使う）。
  private everDisconnected = false;

  constructor(options: GdRealtimeRoomOptions) {
    this.roomId = options.roomId;
    this.self = options.self;
    this.callbacks = options.callbacks ?? {};
    this.channelName = options.channelName ?? `career-gd-room-${options.roomId}`;
    this.subs = { ...DEFAULT_SUBSCRIPTIONS, ...(options.subscriptions ?? {}) };
  }

  getConnectionState(): GdRealtimeConnectionState {
    return this.connectionState;
  }

  getPresence(): GdPresenceMap {
    return this.presence;
  }

  // 購読開始。既に channel があるなら何もしない（重複購読禁止）。
  subscribe(): void {
    if (this.channel) return;
    const client = getCareerBrowserSupabaseClient();
    if (!client) {
      // env 未設定 = Realtime 無効。UI は Presence 無し（全員 offline 表示）で継続する。
      this.setConnectionState('disconnected');
      return;
    }

    this.intentionalClose = false;
    this.setConnectionState('connecting');

    const channel = this.subs.presence
      ? client.channel(this.channelName, { config: { presence: { key: this.self.participantId } } })
      : client.channel(this.channelName);

    // ④ Presence（join / leave / sync いずれでも現在の presence を再構築）。
    if (this.subs.presence) {
      channel
        .on('presence', { event: 'sync' }, () => this.rebuildPresence())
        .on('presence', { event: 'join' }, () => this.rebuildPresence())
        .on('presence', { event: 'leave' }, () => this.rebuildPresence());
    }

    // ② room 状態同期。
    if (this.subs.room) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'career_gd_rooms', filter: `id=eq.${this.roomId}` },
        (payload: RealtimePostgresChangesPayload<Row>) => this.handleRoomChange(payload),
      );
    }

    // ③ participant 同期。
    if (this.subs.members) {
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'career_gd_room_members',
          filter: `room_id=eq.${this.roomId}`,
        },
        (payload: RealtimePostgresChangesPayload<Row>) => this.handleMemberChange(payload),
      );
    }

    // ⑤（STEP-GD-25）messages 同期。発言は append-only なので INSERT のみ購読する。
    if (this.subs.messages) {
      channel.on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'career_gd_room_messages',
          filter: `room_id=eq.${this.roomId}`,
        },
        (payload: RealtimePostgresChangesPayload<Row>) => this.handleMessageChange(payload),
      );
    }

    this.channel = channel;

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        this.reconnectAttempts = 0;
        this.setConnectionState('connected');
        // ⑤ 再接続後は現在状態を取り直す（初回接続では発火しない）。
        if (this.everDisconnected) {
          this.everDisconnected = false;
          this.callbacks.onSyncSignal?.();
        }
        if (this.subs.presence) {
          void channel.track({
            participantId: this.self.participantId,
            userId: this.self.userId,
            displayName: this.self.displayName,
            onlineAt: new Date().toISOString(),
          } satisfies GdPresenceMeta);
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        this.setConnectionState('disconnected');
        this.scheduleReconnect();
      } else if (status === 'CLOSED') {
        this.setConnectionState('disconnected');
        if (!this.intentionalClose) this.scheduleReconnect();
      }
    });
  }

  // 購読解除（意図的な切断）。タイマー・presence・channel をすべて片付ける。
  unsubscribe(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    const client = getCareerBrowserSupabaseClient();
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      try {
        void channel.untrack();
      } catch {
        // untrack 失敗は無視（このあと removeChannel する）。
      }
      if (client) void client.removeChannel(channel);
    }
    this.presence = {};
    this.callbacks.onPresenceChange?.(this.presence);
    this.setConnectionState('idle');
  }

  // 明示的な再接続。現在の channel を畳んでから貼り直す（重複購読しない）。
  reconnect(): void {
    this.everDisconnected = true;
    this.teardownChannel();
    this.subscribe();
  }

  // ── 内部 ───────────────────────────────────────────────────────────

  private setConnectionState(next: GdRealtimeConnectionState): void {
    if (this.connectionState === next) return;
    if (next === 'disconnected') this.everDisconnected = true;
    this.connectionState = next;
    // 同期的な React setState-in-effect を避けるため microtask に載せる。
    queueMicrotask(() => this.callbacks.onConnectionStateChange?.(next));
  }

  private rebuildPresence(): void {
    const channel = this.channel;
    if (!channel) return;
    const state = channel.presenceState<GdPresenceMeta>();
    const map: GdPresenceMap = {};
    for (const key of Object.keys(state)) {
      const entries = state[key];
      const meta = entries.length > 0 ? entries[0] : null;
      if (!meta) continue;
      map[key] = {
        key,
        participantId: meta.participantId ?? key,
        userId: meta.userId ?? null,
        displayName: meta.displayName ?? '',
        onlineAt: meta.onlineAt ?? '',
        state: 'online',
      };
    }
    this.presence = map;
    this.callbacks.onPresenceChange?.(map);
  }

  private handleRoomChange(payload: RealtimePostgresChangesPayload<Row>): void {
    const row = payload.new;
    if (row && typeof row === 'object' && Object.keys(row).length > 0) {
      this.callbacks.onRoomUpdate?.(mapRoomRow(row as Row));
    }
    this.callbacks.onSyncSignal?.();
  }

  private handleMemberChange(payload: RealtimePostgresChangesPayload<Row>): void {
    if (payload.eventType === 'DELETE') {
      const oldRow = payload.old as Row | undefined;
      const id = oldRow ? str(oldRow.id) : '';
      if (id) this.callbacks.onMemberRemove?.(id);
    } else {
      const row = payload.new;
      if (row && typeof row === 'object' && Object.keys(row).length > 0) {
        this.callbacks.onMemberUpsert?.(mapMemberRow(row as Row));
      }
    }
    this.callbacks.onSyncSignal?.();
  }

  private handleMessageChange(payload: RealtimePostgresChangesPayload<Row>): void {
    const row = payload.new;
    if (row && typeof row === 'object' && Object.keys(row).length > 0) {
      const r = row as Row;
      const clientMsgId = str(r.client_msg_id) || null;
      this.callbacks.onMessageInsert?.(mapMessageRow(r), clientMsgId);
    }
    this.callbacks.onSyncSignal?.();
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose) return;
      this.setConnectionState('connecting');
      this.teardownChannel();
      this.subscribe();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // channel だけを畳む（intentionalClose フラグは変えない = 再接続経路で使う）。
  private teardownChannel(): void {
    const client = getCareerBrowserSupabaseClient();
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      try {
        void channel.untrack();
      } catch {
        // 無視。
      }
      if (client) void client.removeChannel(channel);
    }
  }
}
