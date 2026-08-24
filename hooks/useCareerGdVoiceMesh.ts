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

import { parseGdIceServers, type GdIceServer } from '@/lib/careerGd/voice';
import { CareerGdVoiceMesh, type GdPeerAudio } from '@/lib/careerGd/voiceMesh';
import { normalizeIssuedIceServers } from '@/lib/careerGd/turnIce';

/**
 * ICE 取得の打ち切り（ms）。
 * ここを過ぎたら STUN のみで音声接続を試みる。応答待ちで音声が始まらないのが最悪なので、
 * 「TURN が無くても始める」を優先する（TURN 不在は UI に出る）。
 */
const GD_ICE_FETCH_TIMEOUT_MS = 5_000;

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
  /**
   * TURN が実際に載っているか（server 発行の結果）。
   * false = STUN のみ ＝ 対称 NAT 配下の相手とは P2P を張れないことがある。
   * ★ 無言にしないため、呼び出し側は UI へ出すこと。
   */
  turnConfigured: boolean;
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

  // build 時 inline の **STUN のみ**フォールバック。TURN は絶対にここへ置かない
  //   （bundle へ出るため）。server から ICE を取れなかったときだけ使う。
  const fallbackIceServers = useMemo(
    () => parseGdIceServers(process.env.NEXT_PUBLIC_CAREER_GD_ICE_SERVERS),
    [],
  );

  // ICE の正本は server（GET /api/career/gd/voice/ice）。TURN credential は
  //   認証済み member にだけ短命で配られるので、client bundle には一切残らない。
  //   ★ 取得が終わるまで mesh を起動しない。起動後に ICE 構成を差し替えると、
  //     確立済みの peer 接続を張り直すことになり音声が切れる。
  const [ice, setIce] = useState<{
    servers: GdIceServer[];
    turnConfigured: boolean;
    ready: boolean;
  }>({ servers: fallbackIceServers, turnConfigured: false, ready: false });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // 応答が無いまま音声が始まらない状態を作らない。必ず打ち切って fallback で進む。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GD_ICE_FETCH_TIMEOUT_MS);

    const load = async () => {
      try {
        const res = await fetch('/api/career/gd/voice/ice', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`ice ${res.status}`);
        const data = (await res.json()) as { iceServers?: unknown; turnConfigured?: unknown };
        if (cancelled) return;
        // 応答は信用せず検証してから使う（壊れていても例外にしない）。
        const servers = normalizeIssuedIceServers(data.iceServers);
        if (servers.length > 0) {
          setIce({ servers, turnConfigured: data.turnConfigured === true, ready: true });
        } else {
          setIce({ servers: fallbackIceServers, turnConfigured: false, ready: true });
        }
      } catch {
        if (cancelled) return;
        // 取得失敗でも GD を止めない。STUN のみで接続を試み、TURN 不在は UI に出る。
        setIce({ servers: fallbackIceServers, turnConfigured: false, ready: true });
      } finally {
        clearTimeout(timer);
      }
    };
    void load();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
    // room / 有効状態が変わったら取り直す（古い credential を持ち越さない）。
  }, [enabled, roomId, fallbackIceServers]);

  useEffect(() => {
    if (!enabled || !localStream || !roomId || !selfParticipantId) return;
    if (!ice.ready) return; // ICE 未確定の間は起動しない

    const mesh = new CareerGdVoiceMesh({
      roomId,
      selfParticipantId,
      localStream,
      iceServers: ice.servers,
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
  }, [enabled, localStream, roomId, selfParticipantId, ice.ready, ice.servers]);

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

  return { peers, signalingConnected, failedPeerIds, turnConfigured: ice.turnConfigured };
}
