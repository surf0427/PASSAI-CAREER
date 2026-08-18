/*
 * scripts/career-interview-voice-resilience-qa.ts
 *
 * PASSAI CAREER — 面接の音声レジリエンス QA（dev-only 常設・決定的）。
 *
 * 目的（Production Readiness Audit P0-2 の回帰ガード）:
 *   面接は voice-first（text / voice セレクタは廃止済み）である。その前提を保ったまま、
 *   **音声が失敗しても面接不能にならない**ことを固定する:
 *     1. ブラウザ都合の予期しない停止からは自動再開する
 *     2. 意図された停止・エラー・AI 生成中・面接終了後は **再開しない**（暴走させない）
 *     3. 再開できなかったときは必ずユーザーへ知らせる（無言で止めない）
 *     4. 音声が使えない環境／失敗時だけ緊急テキスト回答を出す（正常時は出さない）
 *
 *   ブラウザ API 非依存（判定はすべて純関数）＋ 画面ソースのセンチネル検査。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-interview-voice-resilience-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  RESTART_MAX_IN_WINDOW,
  decideRecognitionRestart,
  type RecognitionEndReason,
} from '@/lib/careerVoice/recognitionRestartPolicy';
import {
  INTERVIEW_RECOGNITION_STOPPED_MESSAGE,
  TEXT_FALLBACK_NOTICE,
  UNEXPECTED_STOP_THRESHOLD,
  VOICE_ERROR_THRESHOLD,
  shouldOfferTextFallback,
} from '@/app/career/interview/textFallbackPolicy';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};
const section = (t: string) => console.log(`\n── ${t} ──`);

const SESSION = read('app/career/interview/session/page.tsx');
const SETUP = read('app/career/interview/setup/page.tsx');
const VOICE = read('app/career/interview/useVoice.ts');

// 面接の runtime 条件（session 画面が useVoice へ渡す値）を再現するヘルパ。
//   autoRestartEnabled は常に true（面接は自動再開を有効化した）。
//   presenting は「ユーザーが今この瞬間、録音するつもりでいるか」＝ recording state。
const decide = (
  reason: RecognitionEndReason,
  recording: boolean,
  recentRestarts: number[] = [],
) =>
  decideRecognitionRestart({
    reason,
    autoRestartEnabled: true,
    presenting: recording,
    recentRestarts,
    now: 1_000_000,
  });

// ════════════════════════════════════════════════════════════════════
section('A. 面接が自動再開を有効化している（voice-first は維持）');

check(
  /useVoice\(\{\s*onFinalTranscript,\s*autoRestart:\s*true,\s*presenting:\s*recording\s*\}\)/.test(
    SESSION,
  ),
  'session: useVoice に autoRestart: true / presenting: recording を渡す',
);
check(
  SETUP.includes("mode: 'voice'"),
  'setup: 新規セッションは従来どおり mode: voice（text セレクタを復活させない）',
);
check(
  !/text\s*\/\s*voice\s*(の)?選択|回答方法を選/.test(SETUP),
  'setup: text / voice セレクタ UI を復活させていない',
);
check(
  VOICE.includes('decideRecognitionRestart'),
  'useVoice: 再開判定は共通の純関数ポリシーに委譲している（判定を画面に散らさない）',
);

// ════════════════════════════════════════════════════════════════════
section('B. Voice 1〜8（再開ポリシー）');

// Voice 1: 対応ブラウザでは voice が既定（フォールバックを出さない）。
check(
  shouldOfferTextFallback({
    sttSupported: true,
    voiceErrorCount: 0,
    unexpectedStopCount: 0,
  }) === false,
  'Voice 1: 対応ブラウザ・無失敗なら voice のまま（テキスト欄を出さない）',
);

// Voice 2: 予期しない onend → 自動再開。
check(decide('unexpected', true) === 'restart', 'Voice 2: 録音中の予期しない停止は自動再開する');

// Voice 3: ユーザーが自分で停止 → 再開しない（通知も不要）。
check(
  decide('manual_stop', true) === 'stop-silent',
  'Voice 3: 手動停止からは再開しない（無言で正しく止まる）',
);
check(
  /const handleStopRecording[\s\S]{0,160}setRecording\(false\)[\s\S]{0,80}stopListening\(\)/.test(
    SESSION,
  ),
  'Voice 3b: 停止ボタンは recording を畳んでから stopListening する',
);

// Voice 4: 権限拒否など error 由来 → 再開しない（loop を作らない）＋ フォールバックを出す。
check(decide('error', true) === 'stop-notify', 'Voice 4: エラー由来は再開せず必ず通知する');
check(
  shouldOfferTextFallback({
    sttSupported: true,
    voiceErrorCount: VOICE_ERROR_THRESHOLD,
    unexpectedStopCount: 0,
  }) === true,
  'Voice 4b: 権限拒否など認識エラー後はテキスト回答を出す',
);
// Case C（連続失敗）: 復帰できない停止が閾値に達したらテキスト回答を出す。
check(
  shouldOfferTextFallback({
    sttSupported: true,
    voiceErrorCount: 0,
    unexpectedStopCount: UNEXPECTED_STOP_THRESHOLD - 1,
  }) === false,
  `Voice 4d: 復帰できない停止 ${UNEXPECTED_STOP_THRESHOLD - 1} 回ではまだ voice のまま`,
);
check(
  shouldOfferTextFallback({
    sttSupported: true,
    voiceErrorCount: 0,
    unexpectedStopCount: UNEXPECTED_STOP_THRESHOLD,
  }) === true,
  `Voice 4e: 復帰できない停止が ${UNEXPECTED_STOP_THRESHOLD} 回続いたらテキスト回答を出す`,
);
// 暴走検出（短時間に再開しすぎたら止めて通知する）。
check(
  decide('unexpected', true, new Array(RESTART_MAX_IN_WINDOW).fill(999_999)) === 'stop-notify',
  `Voice 4c: 短時間に ${RESTART_MAX_IN_WINDOW} 回再開したら止めて通知する（restart loop 禁止）`,
);

// Voice 5: STT 非対応でも面接を続行できる。
check(
  shouldOfferTextFallback({
    sttSupported: false,
    voiceErrorCount: 0,
    unexpectedStopCount: 0,
  }) === true,
  'Voice 5: STT 非対応（Firefox 等）ではテキスト回答を出す',
);
check(
  !/&&\s*sttSupported/.test(SETUP.slice(SETUP.indexOf('const canStart'), SETUP.indexOf('async function handleStart'))),
  'Voice 5b: setup の開始 gate から sttSupported を外した（非対応でも開始できる）',
);
// ★ textarea は「フォールバック条件の中でだけ」出ること。条件ブロックの外に
//   素の <textarea> があると voice-only UX が壊れるので、出現位置で判定する。
const textareaAt = SESSION.indexOf('<textarea');
const fallbackGateAt = SESSION.indexOf('textFallbackOffered && ');
check(
  textareaAt > 0 &&
    fallbackGateAt > 0 &&
    fallbackGateAt < textareaAt &&
    SESSION.split('<textarea').length === 2,
  'Voice 5c: session の textarea はフォールバック条件の内側に 1 つだけ',
);
check(
  /value=\{answer\}[\s\S]{0,120}setAnswer\(e\.target\.value\)/.test(SESSION),
  'Voice 5d: テキスト入力は既存の answer state に入る（送信経路・API 契約は不変）',
);

// Voice 6: AI 生成中は再開しない（送信時に recording を畳む）。
check(decide('unexpected', false) === 'stop-silent', 'Voice 6: 録音意思が無ければ再開しない');
check(
  /const trimmed = answer\.trim\(\);[\s\S]{0,200}setRecording\(false\);/.test(SESSION),
  'Voice 6b: 回答送信の時点で recording を畳む（AI 生成中に再開しない）',
);

// Voice 7: 面接終了（評価フェーズ）でも再開しない。
check(
  /setPhase\('evaluating'\);[\s\S]{0,220}setRecording\(false\);/.test(SESSION),
  'Voice 7: 評価開始時に recording を畳む（終了後にマイクが復活しない）',
);
check(decide('time_limit', true) === 'stop-silent', 'Voice 7b: 時間切れ停止からは再開しない');

// Voice 8: unmount 時は再開せず後始末する。
check(decide('unmounted', true) === 'stop-silent', 'Voice 8: unmount 由来は再開しない');
check(
  /return \(\) => \{[\s\S]{0,240}unmountedRef\.current = true;[\s\S]{0,200}recognition\.abort\(\)/.test(
    VOICE,
  ),
  'Voice 8b: cleanup は unmount 印を付けてから abort する',
);
check(
  /window\.speechSynthesis\.cancel\(\)/.test(VOICE),
  'Voice 8c: TTS を止める経路がある（cancelSpeak）',
);
check(
  /cancelSpeak\(\)/.test(SESSION),
  'Voice 8d: session は送信・評価時に読み上げを止める',
);

// ════════════════════════════════════════════════════════════════════
section('C. 無言で止めない（停止の可視化）');

check(
  SESSION.includes('INTERVIEW_RECOGNITION_STOPPED_MESSAGE'),
  'session: 予期しない停止を UI に表示する',
);
check(
  /recognitionStopped && \([\s\S]{0,200}role="alert"/.test(SESSION),
  'session: 停止通知は role="alert" で伝える',
);
check(
  INTERVIEW_RECOGNITION_STOPPED_MESSAGE.includes('録音して回答'),
  '停止文言が面接のボタン名（録音して回答）と一致する',
);
check(
  TEXT_FALLBACK_NOTICE.length > 0 && SESSION.includes('TEXT_FALLBACK_NOTICE'),
  'フォールバックの説明文を必ず添える',
);

// ════════════════════════════════════════════════════════════════════
section('D. 面接 AI 契約への非干渉');

check(
  !/mode:\s*'text'/.test(SESSION.slice(SESSION.indexOf('const handleSubmit'))),
  'session: フォールバックで session.mode を text に倒さない',
);
check(
  !/interviewType|prompt|rubric/.test(read('app/career/interview/textFallbackPolicy.ts')),
  'fallback policy は面接 AI の語彙（mode / prompt / rubric）に触れない',
);
check(
  /body: JSON\.stringify\(\{[\s\S]{0,220}answer: trimmed/.test(SESSION),
  'turn API へ送るのは従来どおり answer: string（AI から見た入力は不変）',
);

console.log(`\n${fails === 0 ? 'ALL_PASS' : `FAIL(${fails})`}`);
process.exit(fails === 0 ? 0 : 1);
