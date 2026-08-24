// PASSAI 就活版 — GD 完全音声型 QA（STEP-GD-VOICE・登録済み・再実行可能）。
//
// 実行: npx tsx --tsconfig tsconfig.realtime-test.json scripts/gd-qa/voice.qa.ts
//       （npm run qa:careerGdVoice）
//
// 役割の分離:
//   qa:careerGd            … GD の product 仕様（お題 / テーマ / 部屋終了）
//   qa:careerGdProduction  … GD を本番運用できる状態か（flag / RLS / 切断 / timer）
//   qa:careerGdForestStage … 円卓 UI の見た目と発話インジケータ
//   qa:careerGdVoice       … **本 QA**。GD が完全音声型として成立しているか
//
// 検証の種別（正直に区別する）:
//   [UNIT]   純関数の入出力（発話区切りの境界・mime 選択・文字起こし採否・ICE 解析）
//   [STATIC] ソースの構造的検査（文字入力欄が無いこと・gate 順序・保存経路の非変更）
//
// ★ 本 QA が PASS しても「実機で声が届く」ことの証明にはならない。
//   マイク権限・Safari の録音・WebRTC の疎通は実機 / E2E でしか確かめられない
//   （docs/gd/gd_voice_current_state.md の「実機で確認すること」を参照）。

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  GD_TTS_DELIVERY_BY_PERSONA,
  GD_VOICE_MAX_TRANSCRIPT_CHARS,
  baseAudioMime,
  gdPersonaKeyFromParticipantId,
  gdSoloTtsDeliveryFor,
  gdTtsDeliveryFor,
  isAllowedGdAudioMime,
  isUsableGdTranscript,
  normalizeGdTranscript,
  parseGdIceServers,
  pickGdRecorderMimeType,
  shouldInitiateGdPeer,
} from '../../lib/careerGd/voice';
import {
  GD_VAD_IDLE_RECYCLE_MS,
  GD_VAD_MAX_SEGMENT_MS,
  GD_VAD_SILENCE_HANGOVER_MS,
  GD_VAD_SPEECH_ONSET_MS,
  GD_VAD_SPEECH_RMS,
  createGdSegmenterState,
  rmsOfFrame,
  tickGdSegmenter,
  type GdSegmenterState,
} from '../../lib/careerGd/voiceSegmenter';

const ROOT = path.resolve(__dirname, '..', '..');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name);
  }
}

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/** コメントを落として「実際のコード」だけを見る（説明文の語で誤検出しないため）。 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

const SOLO = 'app/career/gd/session/page.tsx';
const ROOM = 'app/career/gd/room/[roomId]/page.tsx';
const VOICE_BAR = 'app/career/gd/components/voice/GdVoiceBar.tsx';
const STT_ROUTE = 'app/api/career/gd/voice/stt/route.ts';
const TTS_ROUTE = 'app/api/career/gd/voice/tts/route.ts';
const CAP_ROUTE = 'app/api/career/gd/voice/capabilities/route.ts';

// ══════════════════════════════════════════════════════════════
// [A] UNIT — 発話区切りの状態機械（GD の進行そのもの）
// ══════════════════════════════════════════════════════════════
console.log('\n[A] 発話区切り（voiceSegmenter）');
{
  const LOUD = GD_VOICE_SPEECH_LOUD();
  const QUIET = 0;

  // ① 無音のままでは何も起きない。
  {
    let st = createGdSegmenterState(0);
    let action = 'none';
    for (let t = 0; t <= 5_000; t += 100) {
      const r = tickGdSegmenter(st, { rms: QUIET, now: t });
      st = r.state;
      if (r.action !== 'none') action = r.action;
    }
    check('A1 無音では発話にならず cut も起きない', action === 'none' && !st.speaking && !st.hadSpeech);
  }

  // ② onset 未満の短い音は発話に昇格しない（咳・物音を弾く）。
  {
    let st = createGdSegmenterState(0);
    const r1 = tickGdSegmenter(st, { rms: LOUD, now: 0 });
    st = r1.state;
    const r2 = tickGdSegmenter(st, { rms: LOUD, now: GD_VAD_SPEECH_ONSET_MS - 1 });
    st = r2.state;
    check('A2 onset 未満は発話にならない', !st.speaking && !st.hadSpeech);
    const r3 = tickGdSegmenter(st, { rms: LOUD, now: GD_VAD_SPEECH_ONSET_MS });
    st = r3.state;
    check('A3 onset 到達で発話になる', st.speaking && st.hadSpeech && r3.speakingChanged);
  }

  // ③ 発話 → 無音 hangover で 1 発言が確定する（cut）。境界をちょうどで検証。
  {
    let st = createGdSegmenterState(0);
    st = tickGdSegmenter(st, { rms: LOUD, now: 0 }).state;
    st = tickGdSegmenter(st, { rms: LOUD, now: GD_VAD_SPEECH_ONSET_MS }).state;
    const speakStop = GD_VAD_SPEECH_ONSET_MS + 500;
    st = tickGdSegmenter(st, { rms: QUIET, now: speakStop }).state;
    const justBefore = tickGdSegmenter(st, {
      rms: QUIET,
      now: speakStop + GD_VAD_SILENCE_HANGOVER_MS - 1,
    });
    check('A4 hangover 未満では確定しない', justBefore.action === 'none');
    const atBoundary = tickGdSegmenter(justBefore.state, {
      rms: QUIET,
      now: speakStop + GD_VAD_SILENCE_HANGOVER_MS,
    });
    check('A5 hangover 到達で発言が確定する（cut）', atBoundary.action === 'cut');
    check('A6 cut 後は状態がリセットされる', !atBoundary.state.speaking && !atBoundary.state.hadSpeech);
  }

  // ④ 発話中の間（フィラー）で切れない — 短い無音を挟んでも 1 発言に保つ。
  {
    let st = createGdSegmenterState(0);
    st = tickGdSegmenter(st, { rms: LOUD, now: 0 }).state;
    st = tickGdSegmenter(st, { rms: LOUD, now: GD_VAD_SPEECH_ONSET_MS }).state;
    let cut = false;
    // 「話す → 0.6 秒黙る → また話す」を 3 回繰り返しても切れないこと。
    let t = GD_VAD_SPEECH_ONSET_MS;
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 6; k++) {
        t += 100;
        const r = tickGdSegmenter(st, { rms: QUIET, now: t });
        st = r.state;
        if (r.action === 'cut') cut = true;
      }
      t += 100;
      const r = tickGdSegmenter(st, { rms: LOUD, now: t });
      st = r.state;
      if (r.action === 'cut') cut = true;
    }
    check('A7 発話中の短い間（0.6秒）では発言が分断されない', !cut);
  }

  // ⑤ ミュートの扱い。
  {
    // 発話中にミュート → その発話は捨てずに確定させる。
    let st = createGdSegmenterState(0);
    st = tickGdSegmenter(st, { rms: LOUD, now: 0 }).state;
    st = tickGdSegmenter(st, { rms: LOUD, now: GD_VAD_SPEECH_ONSET_MS }).state;
    const muted = tickGdSegmenter(st, { rms: LOUD, now: 500, muted: true });
    check('A8 発話中のミュートは、その発言を確定させる（捨てない）', muted.action === 'cut');

    // ミュート中はどれだけ大きな音でも発話にならない。
    let st2 = createGdSegmenterState(0);
    for (let t = 0; t <= 5_000; t += 100) {
      st2 = tickGdSegmenter(st2, { rms: LOUD, now: t, muted: true }).state;
    }
    check('A9 ミュート中は発話として検出しない', !st2.speaking && !st2.hadSpeech);
  }

  // ⑥ 無音のまま長時間 → recycle（クリップを捨てて録音を作り直す＝課金しない）。
  {
    let st = createGdSegmenterState(0);
    const r = tickGdSegmenter(st, { rms: QUIET, now: GD_VAD_IDLE_RECYCLE_MS });
    check('A10 無音が続いたら recycle（送信しない）', r.action === 'recycle');
    st = r.state;
    check('A11 recycle 後も発話履歴は空のまま', !st.hadSpeech);
  }

  // ⑦ 長時間の連続発話 → 強制分割。発話は続いている扱いにする。
  {
    let st = createGdSegmenterState(0);
    st = tickGdSegmenter(st, { rms: LOUD, now: 0 }).state;
    st = tickGdSegmenter(st, { rms: LOUD, now: GD_VAD_SPEECH_ONSET_MS }).state;
    const r = tickGdSegmenter(st, { rms: LOUD, now: GD_VAD_MAX_SEGMENT_MS });
    check('A12 最大長で強制分割する（cut）', r.action === 'cut');
    check('A13 強制分割後も発話中として継続する', r.state.speaking && r.state.hadSpeech);
  }

  // ⑧ 決定性（同じ入力なら同じ出力。副作用で state を壊していない）。
  {
    const base: GdSegmenterState = createGdSegmenterState(0);
    const a = tickGdSegmenter(base, { rms: LOUD, now: 200 });
    const b = tickGdSegmenter(base, { rms: LOUD, now: 200 });
    check(
      'A14 純関数（同じ入力 → 同じ出力・入力を破壊しない）',
      JSON.stringify(a.state) === JSON.stringify(b.state) &&
        base.aboveSince === null &&
        base.speaking === false,
    );
  }

  // ⑨ RMS 計算。
  {
    check('A15 無音フレームの RMS は 0', rmsOfFrame(new Float32Array(16)) === 0);
    const full = new Float32Array(16).fill(1);
    check('A16 フルスケールの RMS は 1', Math.abs(rmsOfFrame(full) - 1) < 1e-9);
    check('A17 空フレームでも例外にならない', rmsOfFrame(new Float32Array(0)) === 0);
  }
}

function GD_VOICE_SPEECH_LOUD(): number {
  // しきい値の「上」であることだけが意味を持つ値。定数が変わっても追随する。
  return GD_VAD_SPEECH_RMS * 2;
}

// ══════════════════════════════════════════════════════════════
// [B] UNIT — 音声の共有プリミティブ
// ══════════════════════════════════════════════════════════════
console.log('\n[B] 音声プリミティブ（voice.ts）');
{
  // ① 録音 mime の選択。Safari は webm を録れないので mp4 が選ばれること。
  const chromeLike = pickGdRecorderMimeType((m) => m.startsWith('audio/webm'));
  check('B1 Chrome 系は webm/opus を選ぶ', chromeLike === 'audio/webm;codecs=opus');
  const safariLike = pickGdRecorderMimeType((m) => m === 'audio/mp4');
  check('B2 Safari 系は audio/mp4 を選ぶ（webm を選ばない）', safariLike === 'audio/mp4');
  const noneSupported = pickGdRecorderMimeType(() => false);
  check('B3 全滅ならブラウザ既定に委ねる（空文字列）', noneSupported === '');
  const throwing = pickGdRecorderMimeType(() => {
    throw new Error('isTypeSupported threw');
  });
  check('B4 isTypeSupported が throw しても落ちない', throwing === '');

  // ② server 側の mime 受理。codec 付きで届くのが常態。
  check('B5 codec 付き webm を受理する', isAllowedGdAudioMime('audio/webm;codecs=opus'));
  check('B6 codec 付き mp4 を受理する', isAllowedGdAudioMime('audio/mp4;codecs=mp4a.40.2'));
  check('B7 base mime を正しく切り出す', baseAudioMime('audio/webm;codecs=opus') === 'audio/webm');
  check('B8 音声以外は拒否する', !isAllowedGdAudioMime('video/mp4') && !isAllowedGdAudioMime(''));

  // ③ 文字起こしの採否。Whisper の無音時定型出力を発言にしない。
  check('B9 空文字は採用しない', !isUsableGdTranscript('') && !isUsableGdTranscript('   '));
  check('B10 記号のみは採用しない', !isUsableGdTranscript('。。。') && !isUsableGdTranscript('...'));
  check('B11 Whisper の無音定型出力を弾く', !isUsableGdTranscript('ご視聴ありがとうございました'));
  check('B12 英語の定型出力も弾く', !isUsableGdTranscript('  Thank you for watching  '));
  check('B13 実発言は採用する', isUsableGdTranscript('私はA案が良いと思います'));
  check(
    'B14 定型文を含むだけの長文は弾かない（完全一致のみ）',
    isUsableGdTranscript('ご視聴ありがとうございましたという結びが良いと思います'),
  );

  // ④ 文字起こしの正規化。既存の発言上限と一致させる。
  const long = 'あ'.repeat(GD_VOICE_MAX_TRANSCRIPT_CHARS + 50);
  check('B15 発言上限で切り詰める', normalizeGdTranscript(long).length === GD_VOICE_MAX_TRANSCRIPT_CHARS);
  check('B16 上限は既存の発言上限（600）と一致', GD_VOICE_MAX_TRANSCRIPT_CHARS === 600);

  // ⑤ persona ごとに声が違う（音声 GD では声が話者の識別子そのもの）。
  const personaKeys = Object.keys(GD_TTS_DELIVERY_BY_PERSONA).filter((k) => k !== 'moderator');
  const voices = personaKeys.map((k) => GD_TTS_DELIVERY_BY_PERSONA[k].voice);
  check('B17 AI persona は 10 タイプそろっている', personaKeys.length === 10);
  check('B18 persona ごとに声が重複しない', new Set(voices).size === voices.length);
  check(
    'B19 進行アナウンスの声は参加者と重複しない',
    !voices.includes(GD_TTS_DELIVERY_BY_PERSONA.moderator.voice),
  );
  check('B20 未知 persona は既定の声へ倒す', gdTtsDeliveryFor('unknown-key').voice.length > 0);
  check(
    'B21 速度は OpenAI の許容範囲に収まる',
    Object.values(GD_TTS_DELIVERY_BY_PERSONA).every((d) => d.speed >= 0.25 && d.speed <= 4),
  );

  // ⑥ ソロ GD の声（persona_key を持たないので index で決定的に割り当てる）。
  check(
    'B22 ソロは index で決定的に声が決まる',
    gdSoloTtsDeliveryFor(0).voice === gdSoloTtsDeliveryFor(0).voice &&
      gdSoloTtsDeliveryFor(0).voice !== gdSoloTtsDeliveryFor(1).voice,
  );
  check('B23 ソロの index は範囲外でも壊れない', gdSoloTtsDeliveryFor(999).voice.length > 0);
  check('B24 ソロの負値・NaN でも壊れない', gdSoloTtsDeliveryFor(-1).voice.length > 0 && gdSoloTtsDeliveryFor(NaN).voice.length > 0);

  // ⑦ participantId からの persona 復元（aiMembers.ts の決定的 ID 形式に依存）。
  check(
    'B25 AI の participantId から persona を復元できる',
    gdPersonaKeyFromParticipantId('gdai-room-123-leader') === 'leader',
  );
  check('B26 人間の participantId からは復元しない', gdPersonaKeyFromParticipantId('u-abc') === null);
  check('B27 未知 persona は復元しない', gdPersonaKeyFromParticipantId('gdai-r-nosuch') === null);

  // ⑧ ICE 設定の解析。壊れた env で GD を止めない。
  check('B28 未設定なら既定 STUN', parseGdIceServers(undefined).length >= 1);
  check('B29 壊れた JSON でも既定へ倒す', parseGdIceServers('{oops').length >= 1);
  check('B30 配列でなければ既定へ倒す', parseGdIceServers('{"urls":"x"}').length >= 1);
  const turn = parseGdIceServers('[{"urls":"turn:t.example:3478","username":"u","credential":"c"}]');
  check(
    'B31 TURN 設定を解釈できる',
    turn.length === 1 && turn[0].username === 'u' && turn[0].credential === 'c',
  );
  check('B32 不正エントリだけなら既定へ倒す', parseGdIceServers('[{"nope":1}]').length >= 1);

  // ⑨ glare 回避（どちらが offer を出すかが決定的で、必ず片側だけ）。
  check(
    'B33 offer 側は辞書順で決定的に 1 人だけ',
    shouldInitiateGdPeer('a', 'b') === true && shouldInitiateGdPeer('b', 'a') === false,
  );
}

// ══════════════════════════════════════════════════════════════
// [C] STATIC — GD 実行画面に文字入力が存在しない（本 STEP の中核要件）
// ══════════════════════════════════════════════════════════════
console.log('\n[C] 文字入力の不在');
{
  for (const [label, rel] of [
    ['solo', SOLO],
    ['room', ROOM],
    ['voiceBar', VOICE_BAR],
  ] as const) {
    const src = codeOnly(read(rel));
    check(`C1 ${label}: <textarea> が存在しない`, !src.includes('<textarea'));
    check(`C2 ${label}: <input> が存在しない`, !src.includes('<input'));
    check(`C3 ${label}: <Textarea> / <Input> コンポーネントも無い`, !/<(Textarea|Input)[\s/>]/.test(src));
    check(`C4 ${label}: contentEditable を使っていない`, !src.includes('contentEditable'));
  }

  const solo = codeOnly(read(SOLO));
  const room = codeOnly(read(ROOM));
  // 旧テキスト経路の残骸が消えていること（残っていると二重経路になる）。
  check('C5 solo: draft state が残っていない', !/\bdraft\b/.test(solo));
  check('C6 room: input state が残っていない', !/const \[input, setInput\]/.test(room));
  check('C7 room: Enter 送信ハンドラが残っていない', !room.includes('onInputKeyDown'));
  check('C8 「発言する」ボタンが両画面から消えている', !solo.includes('発言する') && !room.includes('発言する'));

  // 音声 UI へ置き換わっていること。
  check('C9 solo: GdVoiceBar を使っている', solo.includes('<GdVoiceBar'));
  check('C10 room: GdVoiceBar を使っている', room.includes('<GdVoiceBar'));
  for (const [label, src] of [['solo', solo], ['room', room]] as const) {
    check(`C11 ${label}: マイク Hook を使っている`, src.includes('useCareerGdMic'));
    check(`C12 ${label}: 文字起こし Hook を使っている`, src.includes('useCareerGdVoiceCapture'));
    check(`C13 ${label}: 読み上げ Hook を使っている`, src.includes('useCareerGdTts'));
  }
  // 参加者間の実音声はマルチだけ（ソロには相手がいない）。
  check('C14 room: 参加者間音声 mesh を使っている', room.includes('useCareerGdVoiceMesh'));
  check('C15 solo: mesh は使わない（相手がいない）', !solo.includes('useCareerGdVoiceMesh'));
}

// ══════════════════════════════════════════════════════════════
// [D] STATIC — 既存の発言保存経路を変えていない
// ══════════════════════════════════════════════════════════════
console.log('\n[D] 保存経路の非変更');
{
  const room = codeOnly(read(ROOM));
  const solo = codeOnly(read(SOLO));
  // マルチ: 既存 messages API（seq 採番 / 冪等 / server timer 検証）をそのまま使う。
  check('D1 room: 既存 sendMessage（messages API）で保存する', room.includes('sendMessage(content)'));
  check('D2 room: useCareerGdMessages を使い続けている', room.includes('useCareerGdMessages'));
  const messagesRoute = codeOnly(read('app/api/career/gd/room/[roomId]/messages/route.ts'));
  check('D3 messages route の seq 採番が変わっていない', messagesRoute.includes('postRoomMessage'));
  check('D4 messages route の期限検証が残っている', messagesRoute.includes('finishRoomIfExpired'));
  // ソロ: localStorage transcript のまま。
  check('D5 solo: localStorage 保存（upsertGdSession）を使い続けている', solo.includes('upsertGdSession'));
  check('D6 solo: 評価 API（/feedback）を使い続けている', solo.includes('/api/career/gd/feedback'));
  check('D7 solo: 結果保存（appendGdResult）が残っている', solo.includes('appendGdResult'));
  // 音声 route は発言を保存しない（保存経路を二重化しない）。
  const stt = codeOnly(read(STT_ROUTE));
  check('D8 stt route は messages を保存しない', !stt.includes('postRoomMessage'));
  check('D9 stt route は DB へ書き込まない', !stt.includes('.insert(') && !stt.includes('.update('));
}

// ══════════════════════════════════════════════════════════════
// [E] STATIC — 音声 route の gate 順序・保存しない・課金しない
// ══════════════════════════════════════════════════════════════
console.log('\n[E] 音声 route の契約');
{
  for (const [label, rel] of [
    ['stt', STT_ROUTE],
    ['tts', TTS_ROUTE],
  ] as const) {
    const src = codeOnly(read(rel));

    // ① kill switch が最初（OFF の間は auth も provider も触らない）。
    const gate = src.indexOf('requireCareerGdEnabled');
    const identity = src.indexOf('resolveCareerRequestIdentity');
    const paid = src.indexOf('requireCareerAiAccess');
    const rate = src.indexOf('enforceRateLimit');
    const provider = Math.max(src.indexOf('transcribeAudio'), src.indexOf('synthesizeSpeech'));
    check(`E1 ${label}: kill switch が最初`, gate > 0 && gate < identity);
    check(`E2 ${label}: identity → 有料ゲートの順`, identity > 0 && identity < paid);
    check(`E3 ${label}: 有料ゲートが provider 呼び出しより前`, paid > 0 && paid < provider);
    check(`E4 ${label}: rate limit が provider 呼び出しより前`, rate > 0 && rate < provider);

    // ② 課金しない（GD の quota 消費点は評価のみ、という既存契約を音声で崩さない）。
    check(`E5 ${label}: recordUsage を呼ばない`, !src.includes('recordUsage'));
    check(`E6 ${label}: Daily Quota を消費しない`, !src.includes('enforceCareerDailyQuota'));

    // ③ 保存しない（音声バイナリは DB / Storage に残さない）。
    check(`E7 ${label}: Storage へ保存しない`, !src.includes('.storage'));
    check(`E8 ${label}: service-role で DB を触らない`, !src.includes('ServiceRoleSupabaseClient'));

    // ④ 秘密を返さない。
    check(`E9 ${label}: env 値を応答に含めない`, !/Response\.json\([^)]*process\.env/.test(src));
  }

  const stt = codeOnly(read(STT_ROUTE));
  check('E10 stt: サイズ上限を検査する', stt.includes('GD_VOICE_MAX_CLIP_BYTES'));
  check('E11 stt: mime を許可リストで検査する', stt.includes('isAllowedGdAudioMime'));
  check('E12 stt: 無音・雑音は usable=false で返す（エラーにしない）', stt.includes('isUsableGdTranscript'));

  const tts = codeOnly(read(TTS_ROUTE));
  check('E13 tts: 話者ごとの声を解決する', tts.includes('gdTtsDeliveryFor') && tts.includes('gdSoloTtsDeliveryFor'));
  check('E14 tts: 音声をキャッシュさせない', tts.includes("'cache-control': 'no-store'"));

  const cap = codeOnly(read(CAP_ROUTE));
  check('E15 capabilities: kill switch を通す', cap.includes('requireCareerGdEnabled'));
  check('E16 capabilities: boolean 以外を返さない', cap.includes('getGdVoiceCapabilities'));
  const capServer = codeOnly(read('lib/careerGd/voice.server.ts'));
  check('E17 capabilities: env 名・key を応答に出さない', !capServer.includes('OPENAI_API_KEY:') );
  check('E18 capabilities: server-only 境界', capServer.includes("import 'server-only'"));
}

// ══════════════════════════════════════════════════════════════
// [F] STATIC — 失敗しても GD が無言で壊れない
// ══════════════════════════════════════════════════════════════
console.log('\n[F] 縮退とフォールバック');
{
  const ttsHook = codeOnly(read('hooks/useCareerGdTts.ts'));
  check('F1 サーバ TTS 失敗時はブラウザ合成へ降格する', ttsHook.includes('speechSynthesis'));
  check('F2 降格したことを UI へ伝える', ttsHook.includes('setDegraded(true)'));
  check('F3 読み上げは直列（同時に 2 つ鳴らさない）', ttsHook.includes('playingRef'));
  check('F4 同じ発言を二度読み上げない', ttsHook.includes('spokenIdsRef'));
  // 読み上げ無効中に「読み上げ済み」の印を付けると、有効化後もその発言は永久に鳴らない。
  // 印を付けるのは必ず enabled 判定の **後** であること。
  {
    const enabledGuard = ttsHook.indexOf('if (!enabledRef.current) return;');
    const markSpoken = ttsHook.indexOf('spokenIdsRef.current.add(req.id)');
    check('F4b 無効中は「読み上げ済み」の印を付けない', enabledGuard > 0 && enabledGuard < markSpoken);
  }

  const micHook = codeOnly(read('hooks/useCareerGdMic.ts'));
  check('F5 マイクは必ずユーザー操作起点で取得する（自動取得しない）', !/useEffect\([^)]*getUserMedia/.test(micHook));
  check('F6 権限拒否を専用文言で案内する', micHook.includes('NotAllowedError'));
  check('F7 ミュートは track.stop ではなく enabled で行う（Safari の再プロンプト回避）', micHook.includes('track.enabled = !next'));
  check('F8 離脱時にマイクを解放する', micHook.includes('track.stop()'));
  check('F9 iOS の音声再生解除のため AudioContext を resume する', micHook.includes('ctx.resume()'));
  check('F10 エコーキャンセルを有効にする（自分のスピーカー音の二重取り込み防止）', micHook.includes('echoCancellation: true'));

  const captureHook = codeOnly(read('hooks/useCareerGdVoiceCapture.ts'));
  check('F11 極小クリップは送らない（無音で課金しない）', captureHook.includes('MIN_CLIP_BYTES'));
  check('F12 recycle のクリップは破棄する', captureHook.includes("action !== 'cut'"));
  check('F13 録音器が壊れたら作り直す', captureHook.includes('recorder.onerror'));
  check('F14 STT 失敗を UI へ出す（無言で失敗させない）', captureHook.includes('setError('));

  const voiceBar = codeOnly(read(VOICE_BAR));
  check('F15 マイク失敗を必ず表示する', voiceBar.includes('gd-voice-mic-error'));
  check('F16 相手と繋がらないことを表示する', voiceBar.includes('failedPeerNames'));
  check('F17 状態を色だけでなく文言でも伝える', voiceBar.includes('gdf-voice__label'));

  const mesh = codeOnly(read('lib/careerGd/voiceMesh.ts'));
  check('F18 mesh: glare を決定的に回避する', mesh.includes('shouldInitiateGdPeer'));
  check('F19 mesh: remoteDescription 前の ICE を捨てない', mesh.includes('pendingCandidates'));
  check('F20 mesh: 接続失敗を UI へ通知する', mesh.includes("'failed'"));
  check('F21 mesh: 専用 channel を使い既存 channel と衝突しない', mesh.includes('career-gd-voice-'));
  check('F22 mesh: 既存の発言同期テーブルを購読しない', !mesh.includes('postgres_changes'));
}

// ══════════════════════════════════════════════════════════════
// [G] STATIC — 既存の面接 TTS 経路を壊していない（非破壊拡張）
// ══════════════════════════════════════════════════════════════
console.log('\n[G] 面接 TTS への非破壊性');
{
  const tts = codeOnly(read('lib/interviewAi/tts.ts'));
  check('G1 明示指定が無ければ env → interviewType 既定の順は不変', tts.includes("explicitVoice || process.env.INTERVIEW_AI_TTS_VOICE || delivery.voice"));
  check('G2 明示 instructions が無ければ従来の delivery.instructions', tts.includes('explicitInstructions || delivery.instructions'));
  check('G3 speed は OpenAI 許容範囲へクランプされる', tts.includes('Math.min(4, Math.max(0.25,'));
  // 面接の呼び出し側が voice を渡していない＝挙動が変わらないこと。
  const interviewTtsRoute = codeOnly(read('app/api/interview-ai/tts/route.ts'));
  check('G4 面接 route は voice を明示指定していない（従来挙動のまま）', !/voice\s*:/.test(interviewTtsRoute));
}

// ══════════════════════════════════════════════════════════════
// [H] STATIC — 音声が使えない環境では GD を開始させない（早期失敗）
// ══════════════════════════════════════════════════════════════
console.log('\n[H] 早期失敗（開始前ゲート）');
{
  const capHook = codeOnly(read('hooks/useCareerGdVoiceCapabilities.ts'));
  check('H1 server の可用性を照会する', capHook.includes('/api/career/gd/voice/capabilities'));
  check('H2 ブラウザの録音対応も判定する', capHook.includes('MediaRecorder') && capHook.includes('getUserMedia'));
  check(
    'H3 理由ごとに状態を分ける（server / browser / unknown）',
    capHook.includes("'server-unavailable'") &&
      capHook.includes("'browser-unsupported'") &&
      capHook.includes("'unknown'"),
  );
  check('H4 TTS 不可では GD を止めない（stt だけが必須）', capHook.includes('data.stt !== true'));

  // ソロ: テーマ生成（AI コスト）より前で止める。
  const setup = codeOnly(read('app/career/gd/setup/page.tsx'));
  check('H5 solo setup: 可用性を照会する', setup.includes('useCareerGdVoiceCapabilities'));
  check('H6 solo setup: 開始ボタンをゲートする', setup.includes('disabled={loading || !voiceReady}'));
  check('H7 solo setup: AI 呼び出し前に return する', setup.includes('if (!voiceReady) return;'));
  const themeCall = setup.indexOf("'/api/career/gd/theme'");
  const guardCall = setup.indexOf('if (!voiceReady) return;');
  check('H8 solo setup: ゲートがテーマ生成より前にある', guardCall > 0 && guardCall < themeCall);
  check('H9 solo setup: 理由を画面に出す', setup.includes('gd-voice-unavailable'));

  // マルチ: host の開始をゲートする（他の参加者を巻き込まない）。
  const room = codeOnly(read(ROOM));
  check('H10 room waiting: 可用性を照会する', room.includes('useCareerGdVoiceCapabilities'));
  check('H11 room waiting: host の開始ボタンをゲートする', room.includes('disabled={starting || !voiceReady}'));
  check('H12 room waiting: 理由を全参加者に出す', room.includes('gd-voice-unavailable'));
}

console.log(`\nGD voice QA: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
