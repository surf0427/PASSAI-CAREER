'use client';

// PASSAI 就活版 — GD マルチ 発言（messages）同期 Hook（STEP-GD-25）。
//
// STEP-GD-24 の Realtime 基盤（CareerGdRealtimeRoom）の上に、GD ルーム内の発言同期を載せる。
// 責務:
//   - 初回メッセージ取得 / 再読込復帰（既存 API GET messages）
//   - 送信（既存 API POST messages 経由・server の atomic seq RPC `career_gd_post_message` を利用）
//   - optimistic UI（sending / failed）と二重送信防止（client_msg_id）
//   - Realtime INSERT の即時反映（別 channel `career-gd-messages-<roomId>`・messages のみ購読）
//   - fallback: Realtime 無効環境でも periodic poll（afterSeq 差分）で破綻しない
//   - seq 昇順ソート・重複除去（id → room_id+seq / pending は client_msg_id 対応付け）
//
// 重要方針（STEP-GD-25 前提）:
//   - Realtime は正本にしない。正本は API / DB 保存済みデータ。Realtime は「即時反映」と
//     「変更検知後の再取得シグナル」に留める。クライアントは career_gd_* を直接 insert しない
//     （送信は必ず server API 経由）。

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CareerGdRealtimeRoom,
  type GdRealtimeConnectionState,
  type GdRealtimeSelfIdentity,
} from '@/lib/careerGd/realtimeRoom';
import type { CareerGdRoomMessage } from '@/types/careerGd';

// optimistic 状態。sent（確定）は serverMessages 側に移すため pending は sending / failed のみ。
export type GdPendingStatus = 'sending' | 'failed';

export type GdPendingMessage = {
  clientMsgId: string;
  content: string;
  status: GdPendingStatus;
  createdAt: string;
};

export type UseCareerGdMessagesArgs = {
  roomId: string;
  self: GdRealtimeSelfIdentity | null; // 未確定（未ログイン / member 未取得）なら null
  enabled?: boolean; // active のときだけ true（送信・購読を有効化）。既定 true。
  initialMessages?: CareerGdRoomMessage[]; // 再読込復帰用のシード
  pollIntervalMs?: number; // fallback poll 間隔（既定 3000ms）
};

export type UseCareerGdMessagesResult = {
  messages: CareerGdRoomMessage[]; // 確定メッセージ（seq 昇順）
  pendingMessages: GdPendingMessage[]; // optimistic（末尾表示・createdAt 昇順）
  sendMessage: (body: string) => void;
  resendMessage: (clientMsgId: string) => void;
  isSending: boolean;
  error: string | null;
  refreshMessages: () => void;
  connectionState: GdRealtimeConnectionState;
  latestSeq: number; // 確定済みの最大 seq（fallback poll の afterSeq に使える）
};

const DEFAULT_POLL_MS = 3000;
const MESSAGE_MAX_CHARS = 600; // server（messages route）の MAX_CONTENT_CHARS と揃える。

function newClientMsgId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `c-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// ⑧ 重複除去キー: message id 優先、無ければ room_id + seq。
// （確定メッセージは client_msg_id をクライアントに返さないため id / seq で一意化する）
function keyOf(m: CareerGdRoomMessage): string {
  return m.id ? `id:${m.id}` : `seq:${m.roomId}:${m.seq}`;
}

// seq 昇順 → created_at 昇順で安定ソートし重複除去する。
function mergeConfirmed(
  prev: CareerGdRoomMessage[],
  incoming: CareerGdRoomMessage[],
): CareerGdRoomMessage[] {
  if (incoming.length === 0) return prev;
  const map = new Map<string, CareerGdRoomMessage>();
  for (const m of prev) map.set(keyOf(m), m);
  for (const m of incoming) map.set(keyOf(m), m);
  const arr = [...map.values()];
  arr.sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt));
  return arr;
}

export function useCareerGdMessages({
  roomId,
  self,
  enabled = true,
  initialMessages,
  pollIntervalMs = DEFAULT_POLL_MS,
}: UseCareerGdMessagesArgs): UseCareerGdMessagesResult {
  const [messages, setMessages] = useState<CareerGdRoomMessage[]>(() =>
    mergeConfirmed([], initialMessages ?? []),
  );
  const [pending, setPending] = useState<GdPendingMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<GdRealtimeConnectionState>('idle');

  const latestSeq = messages.reduce((max, m) => (m.seq > max ? m.seq : max), 0);
  const latestSeqRef = useRef(latestSeq);
  useEffect(() => {
    latestSeqRef.current = latestSeq;
  }, [latestSeq]);

  // resend が content を参照できるよう最新の pending を ref に保持する。
  const pendingRef = useRef<GdPendingMessage[]>(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const selfMetaRef = useRef<GdRealtimeSelfIdentity | null>(self);
  useEffect(() => {
    selfMetaRef.current = self;
  }, [self]);

  const managerRef = useRef<CareerGdRealtimeRoom | null>(null);

  // ── メッセージ取得（初回=full / poll=diff）───────────────────────────
  const fetchMessages = useCallback(
    async (mode: 'full' | 'diff') => {
      if (!roomId) return;
      const afterSeq = mode === 'diff' ? latestSeqRef.current : null;
      const url =
        afterSeq != null
          ? `/api/career/gd/room/${encodeURIComponent(roomId)}/messages?afterSeq=${afterSeq}`
          : `/api/career/gd/room/${encodeURIComponent(roomId)}/messages`;
      try {
        const res = await fetch(url);
        const data = (await res.json().catch(() => null)) as
          | { messages?: CareerGdRoomMessage[] }
          | null;
        if (!res.ok || !data?.messages) return;
        if (data.messages.length > 0) {
          setMessages((prev) => mergeConfirmed(prev, data.messages ?? []));
        }
      } catch {
        // poll の一時失敗は無視（次周期 / realtime / 手動更新で回復）。
      }
    },
    [roomId],
  );

  // fetchMessages を realtime コールバックから安定参照するための ref。
  const fetchMessagesRef = useRef(fetchMessages);
  useEffect(() => {
    fetchMessagesRef.current = fetchMessages;
  }, [fetchMessages]);

  const refreshMessages = useCallback(() => {
    void fetchMessages('diff');
  }, [fetchMessages]);

  // ── 送信（optimistic → API POST → 確定 or failed）───────────────────
  const postMessage = useCallback(
    async (clientMsgId: string, content: string) => {
      try {
        const res = await fetch(`/api/career/gd/room/${encodeURIComponent(roomId)}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, clientMsgId }),
        });
        const data = (await res.json().catch(() => null)) as
          | { message?: CareerGdRoomMessage; error?: string; detail?: string }
          | null;
        if (!res.ok || !data?.message) {
          throw new Error(data?.detail ?? '発言の投稿に失敗しました。');
        }
        // 確定: pending から外し、確定メッセージへ置き換える（key は client_msg_id 優先）。
        const confirmed = data.message;
        setMessages((prev) => mergeConfirmed(prev, [confirmed]));
        setPending((prev) => prev.filter((p) => p.clientMsgId !== clientMsgId));
      } catch (e) {
        setPending((prev) =>
          prev.map((p) => (p.clientMsgId === clientMsgId ? { ...p, status: 'failed' } : p)),
        );
        setError(e instanceof Error ? e.message : '発言の投稿に失敗しました。');
      }
    },
    [roomId],
  );

  const sendMessage = useCallback(
    (body: string) => {
      const content = body.trim().slice(0, MESSAGE_MAX_CHARS);
      if (!content) return; // ⑨ trim 後に空なら送信不可
      const clientMsgId = newClientMsgId();
      const createdAt = new Date().toISOString();
      setError(null);
      setPending((prev) => [...prev, { clientMsgId, content, status: 'sending', createdAt }]);
      void postMessage(clientMsgId, content);
    },
    [postMessage],
  );

  const resendMessage = useCallback(
    (clientMsgId: string) => {
      const target = pendingRef.current.find((p) => p.clientMsgId === clientMsgId);
      if (!target || target.status === 'sending') return;
      setError(null);
      setPending((prev) =>
        prev.map((p) => (p.clientMsgId === clientMsgId ? { ...p, status: 'sending' } : p)),
      );
      // 同一 client_msg_id で再送 → server は冪等に同じ message を返す（二重登録しない）。
      void postMessage(clientMsgId, target.content);
    },
    [postMessage],
  );

  const participantId = self?.participantId ?? '';

  // ── Realtime 購読（messages のみ・presence とは別 channel）───────────
  useEffect(() => {
    if (!enabled || !roomId || !participantId) return;
    const identity = selfMetaRef.current;
    if (!identity) return;

    const manager = new CareerGdRealtimeRoom({
      roomId,
      self: identity,
      channelName: `career-gd-messages-${roomId}`,
      subscriptions: { presence: false, room: false, members: false, messages: true },
      callbacks: {
        onConnectionStateChange: (state) => setConnectionState(state),
        onMessageInsert: (message, clientMsgId) => {
          setMessages((prev) => mergeConfirmed(prev, [message]));
          if (clientMsgId) {
            setPending((prev) => prev.filter((p) => p.clientMsgId !== clientMsgId));
          }
        },
        // 再接続後などは diff 再取得（正本は API）。
        onSyncSignal: () => void fetchMessagesRef.current('diff'),
      },
    });
    managerRef.current = manager;
    manager.subscribe();

    return () => {
      manager.unsubscribe();
      managerRef.current = null;
    };
  }, [enabled, roomId, participantId]);

  // ── 初回 full fetch + fallback poll（Realtime 無効でも破綻しない）─────
  useEffect(() => {
    if (!enabled || !roomId) return;
    void fetchMessages('full');
    const id = setInterval(() => void fetchMessages('diff'), pollIntervalMs);
    return () => clearInterval(id);
  }, [enabled, roomId, pollIntervalMs, fetchMessages]);

  const pendingSorted =
    pending.length <= 1
      ? pending
      : [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    messages,
    pendingMessages: pendingSorted,
    sendMessage,
    resendMessage,
    isSending: pending.some((p) => p.status === 'sending'),
    error,
    refreshMessages,
    connectionState,
    latestSeq,
  };
}
