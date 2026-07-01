// PASSAI 就活版 — GD Phase2 マルチGD 発言（messages）の共通ロジック（server-only）。
//
// 役割:
//   - room_id 単位で単調増加する seq をサーバ採番して 1 発言を保存する。
//   - client_msg_id による二重投稿防止（冪等）。同一 (room_id, client_msg_id) は
//     再挿入せず既存行を返す。
//
// seq 採番の方式（競合対策）:
//   1) 優先: DB 側 RPC `career_gd_post_message`（pg_advisory_xact_lock で room 単位に
//      直列化して max(seq)+1 を採番・挿入。トランザクション内で atomic）。
//   2) fallback: RPC 未適用の環境では、アプリ層で「max(seq)+1 を計算 → INSERT →
//      UNIQUE(room_id, seq) 違反(23505)なら再計算してリトライ」する。UNIQUE 制約が
//      重複 seq を必ず弾くため、競合しても seq が重複・欠番のまま壊れることはない
//      （最悪でもリトライ回数ぶん遅延するだけ）。
//   どちらの経路でも UNIQUE(room_id, client_msg_id) が二重投稿を防ぐ。
//
// service-role で DB 操作（RLS バイパス）。クライアントは本テーブルを直接叩かない。

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

export type PostMessageInput = {
  roomId: string;
  participantId: string;
  senderUserId: string | null; // 人間のみ。AI は null
  content: string;
  kind: 'speech' | 'system';
  clientMsgId: string | null; // 冪等キー（system 等で null 可）
};

export type PostMessageResult = {
  row: Record<string, unknown>;
  idempotent: boolean; // 既存 client_msg_id に一致して再挿入しなかった場合 true
};

const SEQ_RETRY = 8;

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === '23505';
}

// エラーが seq 一意制約（room_id, seq）違反か。message / details に制約名が含まれる。
function isSeqConflict(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const e = err as { message?: unknown; details?: unknown };
  const blob = `${typeof e.message === 'string' ? e.message : ''} ${typeof e.details === 'string' ? e.details : ''}`;
  return /career_gd_room_messages_seq_uniq|\(room_id, seq\)|_seq_uniq/.test(blob);
}

// RPC 未適用（関数が存在しない）ことを表す PostgREST エラーか。
function isMissingFunction(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  const msg = typeof e.message === 'string' ? e.message : '';
  return (
    e.code === 'PGRST202' ||
    e.code === '42883' || // undefined_function
    /Could not find the function|function .* does not exist|schema cache/i.test(msg)
  );
}

async function findByClientMsgId(
  admin: SupabaseClient,
  roomId: string,
  clientMsgId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await admin
    .from('career_gd_room_messages')
    .select('*')
    .eq('room_id', roomId)
    .eq('client_msg_id', clientMsgId)
    .maybeSingle();
  if (error) throw error;
  return (data as Record<string, unknown> | null) ?? null;
}

// アプリ層 fallback: max(seq)+1 を計算して INSERT。seq 競合はリトライ。
async function postViaAppLevel(admin: SupabaseClient, input: PostMessageInput): Promise<PostMessageResult> {
  // 冪等チェック（先に既存 client_msg_id を確認）。
  if (input.clientMsgId) {
    const existing = await findByClientMsgId(admin, input.roomId, input.clientMsgId);
    if (existing) return { row: existing, idempotent: true };
  }

  for (let attempt = 0; attempt < SEQ_RETRY; attempt++) {
    // 現在の最大 seq を取得（無ければ 0）。
    const { data: maxRow, error: maxErr } = await admin
      .from('career_gd_room_messages')
      .select('seq')
      .eq('room_id', input.roomId)
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxErr) throw maxErr;
    const nextSeq = (typeof maxRow?.seq === 'number' ? maxRow.seq : Number(maxRow?.seq) || 0) + 1;

    const { data: inserted, error: insErr } = await admin
      .from('career_gd_room_messages')
      .insert({
        room_id: input.roomId,
        participant_id: input.participantId,
        sender_user_id: input.senderUserId,
        seq: nextSeq,
        content: input.content,
        kind: input.kind,
        client_msg_id: input.clientMsgId,
      })
      .select('*')
      .single();

    if (!insErr && inserted) {
      return { row: inserted as Record<string, unknown>, idempotent: false };
    }

    // client_msg_id の競合 → 既存を冪等に返す。
    if (isUniqueViolation(insErr) && input.clientMsgId && !isSeqConflict(insErr)) {
      const existing = await findByClientMsgId(admin, input.roomId, input.clientMsgId);
      if (existing) return { row: existing, idempotent: true };
    }
    // seq 競合 → 採番し直してリトライ。
    if (isSeqConflict(insErr)) continue;

    // それ以外は失敗として投げる。
    throw insErr;
  }
  throw new Error('SEQ_RETRY_EXHAUSTED');
}

// メイン: RPC を試し、未適用なら app-level に fallback。
export async function postRoomMessage(
  admin: SupabaseClient,
  input: PostMessageInput,
): Promise<PostMessageResult> {
  // 1) DB 側 atomic RPC を試す。
  const { data, error } = await admin.rpc('career_gd_post_message', {
    p_room_id: input.roomId,
    p_participant_id: input.participantId,
    p_sender_user_id: input.senderUserId,
    p_content: input.content,
    p_kind: input.kind,
    p_client_msg_id: input.clientMsgId,
  });

  if (!error && data) {
    // RPC は 1 行（または 1 行配列）を返す。
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    if (row) {
      // RPC 経路では冪等かどうかを厳密には区別しないが、呼び出し側は message を使うだけ。
      // 既存 client_msg_id と一致した場合も同じ行が返るため実害はない。
      return { row, idempotent: false };
    }
  }

  // 2) RPC 未適用 → app-level fallback。それ以外の RPC エラーは投げる。
  if (error && !isMissingFunction(error)) {
    throw error;
  }
  return postViaAppLevel(admin, input);
}

// room の messages を取得（afterSeq 以降のみ・seq 昇順）。
export async function loadRoomMessages(
  admin: SupabaseClient,
  roomId: string,
  afterSeq: number | null,
): Promise<Record<string, unknown>[]> {
  let q = admin
    .from('career_gd_room_messages')
    .select('*')
    .eq('room_id', roomId)
    .order('seq', { ascending: true });
  if (afterSeq != null && Number.isFinite(afterSeq)) {
    q = q.gt('seq', afterSeq);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Record<string, unknown>[];
}
