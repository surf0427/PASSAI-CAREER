'use client';

/**
 * PASSAI 就活版 — GD 参加者間音声メッシュの React ラッパ（STEP-GD-VOICE）。
 *
 * lib/careerGd/voiceMesh.ts（純粋な WebRTC + シグナリング）を GD 画面の
 * ライフサイクルへ接続し、相手の音声 stream を実際に鳴らすところまで面倒を見る。
 *
 * ★ 再生は <audio> 要素を DOM に置かず、ここで生成した要素へ srcObject を割り当てる。
 *   Safari は srcObject を持つ要素が GC されると音が止まるため、要素を ref で保持し続ける。
 * ★ ソロ GD では使わない（peers が存在しない）。呼び出し側が enabled=false にする。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { parseGdIceServers } from '@/lib/careerGd/voice';
import { CareerGdVoiceMesh, type GdPeerAudio } from '@/lib/careerGd/voiceMesh';

export type UseCareerGdVoiceMeshArgs = {
  roomId: string;
  selfParticipantId: string;
  /** 自分のマイク stream（useCareerGdMic が所有）。null の間は接続しない。 */
  localStream: MediaStream | null;
  /** GD が active かつマルチのときだけ true。 */
  enabled: boolean;
  /**
   * 今この room に在籍する **人間参加者の participantId**（自分を含めてよい）。
   *
   * ★ signaling の認可境界。Supabase Broadcast の channel には既定で認可が無いため、
   *   ここに無い participantId からの signal は一切処理しない
   *   （= 非参加者・退室者は peer になれず、音声を聞くことも差し込むこともできない）。
   *   名簿は既存の membership 認可済み API（GET room）由来のものをそのまま渡すこと。
   */
  allowedPeerIds: string[];
};

export type UseCareerGdVoiceMeshResult = {
  /** participantId → 接続状態と stream。 */
  peers: Record<string, GdPeerAudio>;
  /** シグナリング channel が繋がっているか。false = 誰とも音声接続できない。 */
  signalingConnected: boolean;
  /** P2P を張れなかった相手の participantId 一覧（UI で必ず可視化する）。 */
  failedPeerIds: string[];
};

export function useCareerGdVoiceMesh({
  roomId,
  selfParticipantId,
  localStream,
  enabled,
  allowedPeerIds,
}: UseCareerGdVoiceMeshArgs): UseCareerGdVoiceMeshResult {
  const [peers, setPeers] = useState<Record<string, GdPeerAudio>>({});
  const [signalingConnected, setSignalingConnected] = useState(false);

  // 名簿は ref で保持する。deps に入れると参加者の増減のたびに mesh が作り直され、
  // 確立済みの音声接続が全部切れてしまう（名簿は「照合に使う最新値」でしかない）。
  const allowedRef = useRef<Set<string>>(new Set(allowedPeerIds));
  const allowedKey = allowedPeerIds.join(',');
  const meshRef = useRef<CareerGdVoiceMesh | null>(null);

  // participantId → 再生用の <audio>。DOM には挿さないが参照を保持し続ける
  //   （Safari で srcObject を持つ要素が回収されると音が消えるため）。
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  const iceServers = useMemo(
    () => parseGdIceServers(process.env.NEXT_PUBLIC_CAREER_GD_ICE_SERVERS),
    [],
  );

  useEffect(() => {
    if (!enabled || !localStream || !roomId || !selfParticipantId) return;

    const mesh = new CareerGdVoiceMesh({
      roomId,
      selfParticipantId,
      localStream,
      iceServers,
      // 自分自身は peer にならないので、照合は「名簿にいるか」だけで足りる。
      isAllowedPeer: (participantId) => allowedRef.current.has(participantId),
      callbacks: {
        onPeersChange: setPeers,
        onSignalingChange: setSignalingConnected,
      },
    });
    meshRef.current = mesh;
    mesh.start();

    return () => {
      mesh.stop();
      meshRef.current = null;
      setPeers({});
      setSignalingConnected(false);
    };
  }, [enabled, localStream, roomId, selfParticipantId, iceServers]);

  // 名簿が変わったら ref を更新し、改めて自分の存在を告知する。
  //   ★ 告知し直さないと、「相手の join を自分の名簿がまだ知らない瞬間に
  //     相手の hello が届いて弾いた」ケースから復帰できない（hello は再送されない）。
  useEffect(() => {
    allowedRef.current = new Set(allowedPeerIds);
    meshRef.current?.announce();
    // allowedKey は名簿の内容ハッシュ。配列の参照ではなく中身が変わったときだけ走らせる。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- allowedKey が allowedPeerIds の内容を代表する
  }, [allowedKey]);

  // peers の stream を実際に再生する（要素の生成・付け替え・後片付け）。
  useEffect(() => {
    const elements = audioElementsRef.current;
    const alive = new Set<string>();

    for (const [participantId, peer] of Object.entries(peers)) {
      if (!peer.stream) continue;
      alive.add(participantId);
      let el = elements.get(participantId);
      if (!el) {
        el = new Audio();
        el.autoplay = true;
        // 自分の声を返さないため muted は使わない（相手の声なので鳴らす）。
        el.setAttribute('playsinline', 'true');
        elements.set(participantId, el);
      }
      if (el.srcObject !== peer.stream) {
        el.srcObject = peer.stream;
        // iOS は autoplay 属性だけでは鳴らないことがあるため明示的に play する
        // （マイク許可の操作で AudioContext を解除済みなので通る）。
        void el.play().catch(() => {});
      }
    }

    // 退出した相手の要素を片付ける。
    for (const [participantId, el] of elements) {
      if (alive.has(participantId)) continue;
      try {
        el.pause();
        el.srcObject = null;
      } catch {
        // 無視。
      }
      elements.delete(participantId);
    }
  }, [peers]);

  // アンマウント時に全要素を確実に止める。
  useEffect(() => {
    const elements = audioElementsRef.current;
    return () => {
      for (const [, el] of elements) {
        try {
          el.pause();
          el.srcObject = null;
        } catch {
          // 無視。
        }
      }
      elements.clear();
    };
  }, []);

  const failedPeerIds = useMemo(
    () =>
      Object.values(peers)
        .filter((p) => p.state === 'failed')
        .map((p) => p.participantId),
    [peers],
  );

  return { peers, signalingConnected, failedPeerIds };
}
