'use client';

/**
 * PASSAI 就活版 — GD の音声コントロール（STEP-GD-VOICE）。
 *
 * 旧「あなたの発言」textarea + 「発言する」ボタンの置き換え。
 * ★ ここには **文字を入力する要素を一切置かない**。GD 中にユーザーが行う操作は
 *   「マイクを有効にする」（初回 1 回）と「ミュート」だけで、発言そのものは
 *   話すだけで確定する（区切り判定は lib/careerGd/voiceSegmenter）。
 *
 * 表示する情報は「今どうなっているか」と「うまくいっていないとき何をすればよいか」に絞る。
 * 特に **無言で失敗している状態を作らない**ことを最優先にしている:
 *   マイク拒否・録音不可・相手と繋がらない・読み上げ降格は、すべて文言として出す。
 */

import type { ReactNode } from 'react';

import type { GdMicStatus } from '@/hooks/useCareerGdMic';
import type { GdCaptureStatus } from '@/hooks/useCareerGdVoiceCapture';

export type GdVoiceBarProps = {
  /** マイクの取得状態。 */
  micStatus: GdMicStatus;
  micError: string | null;
  muted: boolean;
  onEnableMic: () => void;
  onToggleMute: () => void;

  /** 文字起こしの状態。 */
  captureStatus: GdCaptureStatus;
  /** 自分が今話していると判定されているか。 */
  selfSpeaking: boolean;
  captureError: string | null;
  /** 「聞き取れませんでした」の直近発生回数（0 なら表示しない）。 */
  unusableCount: number;

  /** サーバ読み上げが使えずブラウザ合成へ降格しているか。 */
  ttsDegraded: boolean;

  /**
   * 参加者間音声の状態。ソロ GD では null を渡す（表示自体を出さない）。
   */
  peerAudio: {
    signalingConnected: boolean;
    /** P2P を張れなかった相手の表示名。空なら全員と繋がっている。 */
    failedPeerNames: string[];
    /** 音声が繋がっている相手の人数。 */
    connectedCount: number;
    /** 自分以外の人間参加者の人数。 */
    humanPeerCount: number;
  } | null;

  /** 制限時間切れなど、発言を受け付けない状態。 */
  disabled: boolean;
  /** 右側に置く操作（「GDを終了する」等）。 */
  actions?: ReactNode;
};

function micStateLabel(
  micStatus: GdMicStatus,
  captureStatus: GdCaptureStatus,
  selfSpeaking: boolean,
  muted: boolean,
  disabled: boolean,
): { label: string; tone: 'idle' | 'live' | 'speaking' | 'busy' | 'off' } {
  if (disabled) return { label: '発言を受け付けていません', tone: 'off' };
  if (micStatus !== 'ready') return { label: 'マイク未接続', tone: 'off' };
  if (muted) return { label: 'ミュート中（あなたの声は届きません）', tone: 'off' };
  if (selfSpeaking) return { label: 'あなたが話しています', tone: 'speaking' };
  if (captureStatus === 'transcribing') return { label: '発言を記録しています…', tone: 'busy' };
  return { label: '聞き取り中（そのまま話してください）', tone: 'live' };
}

export function GdVoiceBar({
  micStatus,
  micError,
  muted,
  onEnableMic,
  onToggleMute,
  captureStatus,
  selfSpeaking,
  captureError,
  unusableCount,
  ttsDegraded,
  peerAudio,
  disabled,
  actions,
}: GdVoiceBarProps) {
  const ready = micStatus === 'ready';
  const state = micStateLabel(micStatus, captureStatus, selfSpeaking, muted, disabled);

  return (
    <div className="gdf-panel" data-testid="gd-voice-bar">
      <p className="gdf-panel__label">音声</p>

      {/* ── 状態表示（発言中インジケータ本体）── */}
      <div className="gdf-voice" data-state={state.tone} data-testid="gd-voice-state">
        <span className="gdf-voice__dot" aria-hidden />
        <span className="gdf-voice__label">{state.label}</span>
      </div>

      {/* ── 操作（マイク有効化 / ミュート）── */}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {/* 音声 GD の主操作（マイク / ミュート）は指で押す前提なので tap target を広げる。 */}
        <div className="gdf-controls gdf-controls--voice">
          {!ready ? (
            <button
              type="button"
              className="gdf-btn gdf-btn--primary"
              onClick={onEnableMic}
              disabled={micStatus === 'requesting' || micStatus === 'unsupported'}
              data-testid="gd-voice-enable"
            >
              {micStatus === 'requesting' ? 'マイクを準備中…' : '🎤 マイクを有効にする'}
            </button>
          ) : (
            <button
              type="button"
              className={`gdf-btn ${muted ? 'gdf-btn--primary' : 'gdf-btn--ghost'}`}
              onClick={onToggleMute}
              disabled={disabled}
              aria-pressed={muted}
              data-testid="gd-voice-mute"
            >
              {muted ? '🔇 ミュート解除' : '🎙 ミュートする'}
            </button>
          )}
        </div>
        {actions}
      </div>

      {/* ── 案内・失敗（無言で失敗させない）── */}
      {!ready && micStatus !== 'requesting' && !micError && (
        <p className="gdf-note mt-2">
          GDは音声で進行します。「マイクを有効にする」を押して、マイクの使用を許可してください。
        </p>
      )}

      {micError && (
        <p className="gdf-alert mt-2" role="alert" data-testid="gd-voice-mic-error">
          {micError}
        </p>
      )}

      {ready && captureError && (
        <p className="gdf-alert mt-2" role="alert" data-testid="gd-voice-capture-error">
          {captureError}
        </p>
      )}

      {ready && !captureError && unusableCount > 0 && (
        <p className="gdf-note mt-2" data-testid="gd-voice-unusable">
          直前の音声を聞き取れませんでした。マイクに少し近づいて、もう一度話してください。
        </p>
      )}

      {/* ── 参加者間音声（マルチのみ）── */}
      {peerAudio && (
        <div className="mt-2" data-testid="gd-voice-peers">
          {!peerAudio.signalingConnected ? (
            <p className="gdf-alert">
              参加者どうしの音声接続を準備できませんでした。他の参加者の声が聞こえない場合は、ページを再読み込みしてください。
            </p>
          ) : peerAudio.failedPeerNames.length > 0 ? (
            <p className="gdf-alert">
              {peerAudio.failedPeerNames.join('、')}
              さんと音声がつながりませんでした（通信環境による制限）。発言内容は文字起こしで共有されます。
            </p>
          ) : (
            <p className="gdf-note">
              参加者の音声: {peerAudio.connectedCount} / {peerAudio.humanPeerCount} 人と接続中
            </p>
          )}
        </div>
      )}

      {/* ── 読み上げの降格（音は出るが声質が落ちている）── */}
      {ttsDegraded && (
        <p className="gdf-note mt-2" data-testid="gd-voice-tts-degraded">
          読み上げ音声を簡易モードで再生しています（内容は同じです）。
        </p>
      )}
    </div>
  );
}
