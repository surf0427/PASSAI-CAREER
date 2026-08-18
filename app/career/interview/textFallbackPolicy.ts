// PASSAI CAREER — 面接の「緊急テキスト回答」を出してよいかの判定（純関数・環境非依存）。
//
// STEP-CAREER-INTERVIEW-HARDENING-P0-2（Production Readiness Audit P0-2）。
//
// 背景:
//   新規面接は voice-first（テキスト/音声セレクタは廃止済み）だが、音声経路は環境依存で
//   失敗しうる（Firefox は SpeechRecognition 非対応 / マイク権限拒否 / ブラウザ都合の停止）。
//   これらのとき従来は「開始できない」「話しても認識されない」で **面接が続行不能**だった。
//
// 本 module の責務は 1 つだけ:
//   「今、緊急脱出路としてテキスト入力を出すべきか」を boolean で返すこと。
//
// ★ やらないこと（重要）:
//   - 廃止した text / voice セレクタを復活させない。**正常時は絶対に false**。
//   - 面接の mode を変えない（session.mode は 'voice' のまま。API へ送るのは従来どおり
//     `answer: string` で、AI から見た入力は 1 byte も変わらない）。
//
// ブラウザ API を触らない純関数なので、QA が deterministic に検証できる。

/** 音声が使えないと判断するまでの「認識エラー」回数（1 回で出す）。 */
export const VOICE_ERROR_THRESHOLD = 1;
/** 予期しない停止から復帰できなかった回数の閾値（連続失敗＝2 回で出す）。 */
export const UNEXPECTED_STOP_THRESHOLD = 2;

export type TextFallbackInput = {
  /** ブラウザが SpeechRecognition を持つか（false = Case A: 非対応環境）。 */
  sttSupported: boolean;
  /**
   * 音声認識エラーが発生した回数（Case B: 権限拒否・マイク無し・通信失敗など）。
   * useVoice の voiceError が「無し → 有り」に変化した回数を呼び出し側が数える。
   */
  voiceErrorCount: number;
  /**
   * 予期しない停止から自動再開できなかった回数（Case C: 連続失敗）。
   * useVoice の recognitionStopped が立った回数を呼び出し側が数える。
   */
  unexpectedStopCount: number;
};

/**
 * 緊急テキスト回答を提示すべきか。
 *
 * true になる条件（いずれか）:
 *   Case A … SpeechRecognition 非対応（Firefox 等）。この環境では音声で始められない。
 *   Case B … 認識エラーが 1 回でも起きた（権限拒否・マイク無し等）。
 *   Case C … 予期しない停止からの復帰に 2 回失敗した。
 *
 * ★ false のときの UI は従来どおり（録音ボタンのみ）。音声が正常な限りテキスト欄は出ない。
 */
export function shouldOfferTextFallback(input: TextFallbackInput): boolean {
  if (!input.sttSupported) return true;
  if (input.voiceErrorCount >= VOICE_ERROR_THRESHOLD) return true;
  return input.unexpectedStopCount >= UNEXPECTED_STOP_THRESHOLD;
}

/** 緊急テキスト回答を出すときの説明文（面接の文脈に合わせた文言）。 */
export const TEXT_FALLBACK_NOTICE =
  '音声入力を利用できないため、テキストでも回答できます。マイクが使える場合は「録音して回答」をそのままお使いください。';

/**
 * 音声認識が予期せず止まり、自動再開もできなかったときの文言。
 *
 * ★ lib/careerVoice の共通文言はプレゼン用（「録音して発表する」）なので、面接では
 *   ボタン名が一致する本文言を使う（同じ内容・同じ役割で、押す場所だけが違う）。
 */
export const INTERVIEW_RECOGNITION_STOPPED_MESSAGE =
  '音声認識が停止しました。「録音して回答」をもう一度押して再開してください。ここまでの認識結果は残っています。';
