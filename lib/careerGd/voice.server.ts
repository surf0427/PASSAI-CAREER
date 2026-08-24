/**
 * PASSAI 就活版 — GD 音声機能の server 側可用性判定（STEP-GD-VOICE）。
 *
 * ★ なぜ「flag」ではなく「可用性」なのか:
 *   GD は音声でしか進行できない仕様なので、「GD は ON だが音声だけ OFF」という
 *   運用状態を作れてはいけない（それは壊れた商品であって縮退ではない）。
 *   したがって音声専用の kill switch は持たず、**provider env が揃っているか**だけを見る。
 *   止めたいときは CAREER_GD_ENABLED を落とす（GD ごと止まる）。
 *
 * ★ secret は返さない。返すのは boolean だけ（key の有無すら値としては出さない）。
 */

import 'server-only';

export type GdVoiceCapabilities = {
  /**
   * 文字起こしが使えるか。**false なら GD を開始させてはいけない**
   * （ユーザーが発言する手段が無くなるため）。
   */
  stt: boolean;
  /**
   * サーバ読み上げが使えるか。false でも GD は成立する
   * （client がブラウザの speechSynthesis へ降格する）。
   */
  tts: boolean;
};

/** provider が openai に設定され、かつ API key があるか。 */
function openaiReady(provider: string | undefined): boolean {
  return provider === 'openai' && !!process.env.OPENAI_API_KEY;
}

/**
 * 現在の env で音声機能が使えるかを返す。
 *
 * 判定は lib/interviewAi/{stt,tts}.ts の provider 分岐と**同じ条件**にしてある。
 * ここと実装がずれると「使えると言われたのに 502 が返る」という切り分け不能な
 * 状態になるため、片方だけを変更しないこと。
 */
export function getGdVoiceCapabilities(): GdVoiceCapabilities {
  return {
    stt: openaiReady(process.env.INTERVIEW_AI_STT_PROVIDER),
    tts: openaiReady(process.env.INTERVIEW_AI_TTS_PROVIDER),
  };
}
