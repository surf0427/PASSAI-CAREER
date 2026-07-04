'use client';

// PASSAI 就活版 — GD マルチ Realtime Room の React Hook（STEP-GD-24）。
//
// Component から Supabase Realtime を直接触らせないための唯一の React 側入口。
// 実際の購読 / 解除 / 再接続 / Presence は lib/careerGd/realtimeRoom.ts の
// CareerGdRealtimeRoom（非 React）へ委譲する。
//
// 返却:
//   room            : 最後に realtime で観測した room（best-effort。DB が realtime 有効な時のみ更新）
//   participants    : 最後に realtime で観測した参加者一覧（同上）
//   connectionState : channel の接続状態（idle / connecting / connected / disconnected）
//   presenceMap     : online なユーザー（key = participant_id）。存在しない = offline
//   reconnect()     : 明示的な再接続
//   subscribe()     : 明示的な購読開始（通常は enabled で自動）
//   unsubscribe()   : 明示的な購読解除
//
// 非破壊のため、UI が信頼する実データ（room / members / messages）の正本は従来どおり
// 既存 API 経由のポーリングに委ねる。本 hook の room / participants は「共通 Realtime 基盤」
// としての公開値であり、onSyncSignal（realtime 変更・再接続の通知）で API 再取得を促す。

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CareerGdRealtimeRoom,
  type GdPresenceMap,
  type GdRealtimeConnectionState,
  type GdRealtimeSelfIdentity,
} from '@/lib/careerGd/realtimeRoom';
import type { CareerGdRoom, CareerGdRoomMember } from '@/types/careerGd';

export type UseCareerGdRealtimeArgs = {
  roomId: string;
  // このクライアント自身の同定情報。未確定（未ログイン / member 未取得）なら null。
  self: GdRealtimeSelfIdentity | null;
  // false の間は購読しない（未ログイン / 終了済み room など）。既定 true。
  enabled?: boolean;
  // realtime で変更を観測した / 再接続した、という通知。UI 正本の再取得（API）に使う。
  onSyncSignal?: () => void;
};

export type UseCareerGdRealtimeResult = {
  room: CareerGdRoom | null;
  participants: CareerGdRoomMember[];
  connectionState: GdRealtimeConnectionState;
  presenceMap: GdPresenceMap;
  reconnect: () => void;
  subscribe: () => void;
  unsubscribe: () => void;
};

export function useCareerGdRealtime({
  roomId,
  self,
  enabled = true,
  onSyncSignal,
}: UseCareerGdRealtimeArgs): UseCareerGdRealtimeResult {
  const [room, setRoom] = useState<CareerGdRoom | null>(null);
  const [participants, setParticipants] = useState<CareerGdRoomMember[]>([]);
  const [connectionState, setConnectionState] = useState<GdRealtimeConnectionState>('idle');
  const [presenceMap, setPresenceMap] = useState<GdPresenceMap>({});

  const managerRef = useRef<CareerGdRealtimeRoom | null>(null);

  // onSyncSignal は render ごとに identity が変わり得るので ref 経由で最新を参照する
  // （購読の貼り直しを避ける）。
  const onSyncRef = useRef<(() => void) | undefined>(onSyncSignal);
  useEffect(() => {
    onSyncRef.current = onSyncSignal;
  }, [onSyncSignal]);

  // presence の track payload に使う自己情報も ref で最新を保持する（identity 変化で
  // 貼り直したいのは participantId のみ）。
  const selfMetaRef = useRef<GdRealtimeSelfIdentity | null>(self);
  useEffect(() => {
    selfMetaRef.current = self;
  }, [self]);

  const participantId = self?.participantId ?? '';

  useEffect(() => {
    if (!enabled || !roomId || !participantId) return;
    const identity = selfMetaRef.current;
    if (!identity) return;

    const manager = new CareerGdRealtimeRoom({
      roomId,
      self: identity,
      callbacks: {
        onConnectionStateChange: (state) => setConnectionState(state),
        onPresenceChange: (presence) => setPresenceMap(presence),
        onRoomUpdate: (next) => setRoom(next),
        onMemberUpsert: (member) =>
          setParticipants((prev) => {
            const idx = prev.findIndex((m) => m.id === member.id);
            if (idx === -1) return [...prev, member];
            const nextList = prev.slice();
            nextList[idx] = member;
            return nextList;
          }),
        onMemberRemove: (memberId) =>
          setParticipants((prev) => prev.filter((m) => m.id !== memberId)),
        onSyncSignal: () => onSyncRef.current?.(),
      },
    });
    managerRef.current = manager;
    manager.subscribe();

    return () => {
      manager.unsubscribe();
      managerRef.current = null;
    };
    // participantId で購読の identity を固定する（displayName / userId 変化では貼り直さない）。
  }, [enabled, roomId, participantId]);

  const reconnect = useCallback(() => {
    managerRef.current?.reconnect();
  }, []);
  const subscribe = useCallback(() => {
    managerRef.current?.subscribe();
  }, []);
  const unsubscribe = useCallback(() => {
    managerRef.current?.unsubscribe();
  }, []);

  return { room, participants, connectionState, presenceMap, reconnect, subscribe, unsubscribe };
}
