/**
 * PASSAI 就活版 — GD 参加者間の音声メッシュ（STEP-GD-VOICE）。
 *
 * マルチ / フレンド / ランダムマッチで **参加者同士の実音声** を届ける。
 * SFU は使わず、WebRTC の全結合（mesh）を Supabase Realtime の broadcast で
 * シグナリングして張る。GD の想定人数は 4 / 6 / 8 人で、音声のみ（1 本あたり数十 kbps）
 * なので mesh で成立する（8 人 = 各自 7 本）。
 *
 * ★ 既存の同期経路は一切変えない。
 *   発言ログ・room 状態・presence は従来どおり API + postgres_changes が正本で、
 *   本 mesh は **音声メディアだけ**を運ぶ。シグナリングにも専用 channel
 *   （`career-gd-voice-<roomId>`）を使い、既存 channel の presence key と衝突させない。
 *
 * ★ glare（同時 offer）対策:
 *   participantId の辞書順で offer 側 / answer 側を決める（lib/careerGd/voice.ts の
 *   shouldInitiateGdPeer）。合意プロトコル無しで衝突が起きない決定的な規則。
 *
 * ★ TURN が無い場合の限界:
 *   既定は公開 STUN のみ。対称 NAT 配下の参加者とは P2P を確立できず、
 *   その相手の声だけが聞こえない状態になる。**これを無言にしない**ため、
 *   peer ごとの接続状態を UI へ通知する（onPeersChange）。本番で取りこぼしを消すには
 *   NEXT_PUBLIC_CAREER_GD_ICE_SERVERS に TURN を設定する。
 */

import type { RealtimeChannel } from '@supabase/supabase-js';

import { getCareerBrowserSupabaseClient } from '@/lib/careerSupabase/browserClient';
import { parseGdIceServers, shouldInitiateGdPeer, type GdIceServer } from './voice';

// ── シグナリングのメッセージ ────────────────────────────────────────

type SignalBase = { from: string; to?: string | null };
type HelloSignal = SignalBase & { kind: 'hello' | 'hello-ack' };
type OfferSignal = SignalBase & { kind: 'offer'; sdp: string };
type AnswerSignal = SignalBase & { kind: 'answer'; sdp: string };
type IceSignal = SignalBase & { kind: 'ice'; candidate: RTCIceCandidateInit };
type ByeSignal = SignalBase & { kind: 'bye' };

type GdVoiceSignal = HelloSignal | OfferSignal | AnswerSignal | IceSignal | ByeSignal;

const SIGNAL_EVENT = 'gd-voice-signal';

// ── peer の可視状態 ────────────────────────────────────────────────

export type GdPeerAudioState =
  | 'connecting' // シグナリング中 / ICE 探索中
  | 'connected' // 音声が流れている
  | 'failed' // P2P を張れなかった（TURN 不在の典型。相手の声が聞こえない）
  | 'closed'; // 相手が退出した

export type GdPeerAudio = {
  participantId: string;
  state: GdPeerAudioState;
  /** 相手の音声 stream（再生は呼び出し側が <audio> へ割り当てる）。 */
  stream: MediaStream | null;
};

export type GdVoiceMeshCallbacks = {
  onPeersChange?: (peers: Record<string, GdPeerAudio>) => void;
  /** シグナリング channel 自体の接続状態。false の間は誰とも繋がれない。 */
  onSignalingChange?: (connected: boolean) => void;
};

export type GdVoiceMeshOptions = {
  roomId: string;
  selfParticipantId: string;
  /** 自分のマイク stream（useCareerGdMic が所有）。 */
  localStream: MediaStream;
  iceServers?: GdIceServer[];
  callbacks?: GdVoiceMeshCallbacks;
};

type PeerEntry = {
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  state: GdPeerAudioState;
  /** remote description 確定前に届いた ICE candidate の待避場所。 */
  pendingCandidates: RTCIceCandidateInit[];
  /** 自分が offer 側か。 */
  initiator: boolean;
};

export class CareerGdVoiceMesh {
  private readonly roomId: string;
  private readonly selfId: string;
  private readonly localStream: MediaStream;
  private readonly iceServers: GdIceServer[];
  private readonly callbacks: GdVoiceMeshCallbacks;

  private channel: RealtimeChannel | null = null;
  private peers = new Map<string, PeerEntry>();
  private started = false;
  private disposed = false;

  constructor(options: GdVoiceMeshOptions) {
    this.roomId = options.roomId;
    this.selfId = options.selfParticipantId;
    this.localStream = options.localStream;
    this.iceServers = options.iceServers ?? parseGdIceServers(null);
    this.callbacks = options.callbacks ?? {};
  }

  // ── 起動 / 停止 ───────────────────────────────────────────────

  start(): void {
    if (this.started || this.disposed) return;
    if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
      // WebRTC 非対応。参加者の声は聞こえないが GD 自体（文字起こし・AI）は続行できる。
      this.callbacks.onSignalingChange?.(false);
      return;
    }
    const client = getCareerBrowserSupabaseClient();
    if (!client) {
      this.callbacks.onSignalingChange?.(false);
      return;
    }
    this.started = true;

    const channel = client.channel(`career-gd-voice-${this.roomId}`, {
      config: { broadcast: { self: false } },
    });
    channel.on('broadcast', { event: SIGNAL_EVENT }, (payload) => {
      const signal = (payload as { payload?: unknown }).payload as GdVoiceSignal | undefined;
      if (signal) void this.handleSignal(signal);
    });
    this.channel = channel;

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        this.callbacks.onSignalingChange?.(true);
        // 参加を告知する。既存メンバーは hello-ack を返し、双方が相手を知る。
        void this.send({ kind: 'hello', from: this.selfId });
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        this.callbacks.onSignalingChange?.(false);
      }
    });
  }

  stop(): void {
    this.disposed = true;
    this.started = false;
    if (this.channel) {
      void this.send({ kind: 'bye', from: this.selfId }).catch(() => {});
      try {
        void this.channel.unsubscribe();
      } catch {
        // 無視。
      }
      this.channel = null;
    }
    for (const [, entry] of this.peers) {
      this.closePeer(entry);
    }
    this.peers.clear();
    this.emitPeers();
    this.callbacks.onSignalingChange?.(false);
  }

  // ── シグナリング送信 ─────────────────────────────────────────

  private async send(signal: GdVoiceSignal): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    try {
      await channel.send({ type: 'broadcast', event: SIGNAL_EVENT, payload: signal });
    } catch {
      // 送信失敗は握りつぶす（相手側の hello / 再接続で回復する）。
    }
  }

  // ── peer 生成 ────────────────────────────────────────────────

  private ensurePeer(peerId: string): PeerEntry {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
    const entry: PeerEntry = {
      pc,
      stream: null,
      state: 'connecting',
      pendingCandidates: [],
      initiator: shouldInitiateGdPeer(this.selfId, peerId),
    };

    // 自分のマイクを相手へ送る。
    for (const track of this.localStream.getAudioTracks()) {
      try {
        pc.addTrack(track, this.localStream);
      } catch {
        // 既に追加済み等は無視。
      }
    }

    pc.ontrack = (e) => {
      const [remoteStream] = e.streams;
      entry.stream = remoteStream ?? new MediaStream([e.track]);
      this.emitPeers();
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        void this.send({
          kind: 'ice',
          from: this.selfId,
          to: peerId,
          candidate: e.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case 'connected':
          entry.state = 'connected';
          break;
        case 'failed':
          // ★ ここを無言にしない。TURN 不在で最も起きやすい失敗であり、
          //   「相手の声だけが聞こえない」を UI が説明できる唯一の手がかり。
          entry.state = 'failed';
          break;
        case 'closed':
          entry.state = 'closed';
          break;
        case 'disconnected':
          entry.state = 'connecting';
          break;
        default:
          break;
      }
      this.emitPeers();
    };

    this.peers.set(peerId, entry);
    this.emitPeers();
    return entry;
  }

  private closePeer(entry: PeerEntry): void {
    try {
      entry.pc.ontrack = null;
      entry.pc.onicecandidate = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.close();
    } catch {
      // 無視。
    }
  }

  private emitPeers(): void {
    const out: Record<string, GdPeerAudio> = {};
    for (const [participantId, entry] of this.peers) {
      out[participantId] = { participantId, state: entry.state, stream: entry.stream };
    }
    this.callbacks.onPeersChange?.(out);
  }

  // ── シグナリング受信 ─────────────────────────────────────────

  private async handleSignal(signal: GdVoiceSignal): Promise<void> {
    if (this.disposed) return;
    const from = signal.from;
    if (!from || from === this.selfId) return;
    // 宛先付きメッセージは自分宛だけ処理する（broadcast は全員に届くため）。
    if (signal.to && signal.to !== this.selfId) return;

    switch (signal.kind) {
      case 'hello': {
        // 新規参加者へ自分の存在を返す（相手はこれで自分を知る）。
        void this.send({ kind: 'hello-ack', from: this.selfId, to: from });
        await this.beginNegotiationIfInitiator(from);
        break;
      }
      case 'hello-ack': {
        await this.beginNegotiationIfInitiator(from);
        break;
      }
      case 'offer': {
        const entry = this.ensurePeer(from);
        try {
          await entry.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
          await this.flushCandidates(entry);
          const answer = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(answer);
          await this.send({
            kind: 'answer',
            from: this.selfId,
            to: from,
            sdp: answer.sdp ?? '',
          });
        } catch {
          entry.state = 'failed';
          this.emitPeers();
        }
        break;
      }
      case 'answer': {
        const entry = this.peers.get(from);
        if (!entry) return;
        try {
          await entry.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          await this.flushCandidates(entry);
        } catch {
          entry.state = 'failed';
          this.emitPeers();
        }
        break;
      }
      case 'ice': {
        const entry = this.peers.get(from);
        if (!entry) return;
        // remote description 未設定の間に届いた candidate は捨てず待避する
        // （捨てると接続候補が減り、張れるはずの P2P が失敗する）。
        if (!entry.pc.remoteDescription) {
          entry.pendingCandidates.push(signal.candidate);
          return;
        }
        try {
          await entry.pc.addIceCandidate(signal.candidate);
        } catch {
          // 不正 candidate は無視（他の candidate で接続できる）。
        }
        break;
      }
      case 'bye': {
        const entry = this.peers.get(from);
        if (entry) {
          this.closePeer(entry);
          this.peers.delete(from);
          this.emitPeers();
        }
        break;
      }
      default:
        break;
    }
  }

  private async beginNegotiationIfInitiator(peerId: string): Promise<void> {
    const entry = this.ensurePeer(peerId);
    if (!entry.initiator) return; // answer 側は相手の offer を待つ（glare 回避）
    if (entry.pc.signalingState !== 'stable') return; // 交渉中なら二重に始めない
    if (entry.pc.remoteDescription) return; // 既に確立済み
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      await this.send({
        kind: 'offer',
        from: this.selfId,
        to: peerId,
        sdp: offer.sdp ?? '',
      });
    } catch {
      entry.state = 'failed';
      this.emitPeers();
    }
  }

  private async flushCandidates(entry: PeerEntry): Promise<void> {
    const pending = entry.pendingCandidates;
    entry.pendingCandidates = [];
    for (const candidate of pending) {
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch {
        // 個別失敗は無視。
      }
    }
  }
}
