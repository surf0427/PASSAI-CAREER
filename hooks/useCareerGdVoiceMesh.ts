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
}: UseCareerGdVoiceMeshArgs): UseCareerGdVoiceMeshResult {
  const [peers, setPeers] = useState<Record<string, GdPeerAudio>>({});
  const [signalingConnected, setSignalingConnected] = useState(false);

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
      callbacks: {
        onPeersChange: setPeers,
        onSignalingChange: setSignalingConnected,
      },
    });
    mesh.start();

    return () => {
      mesh.stop();
      setPeers({});
      setSignalingConnected(false);
    };
  }, [enabled, localStream, roomId, selfParticipantId, iceServers]);

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
