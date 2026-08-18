/*
 * scripts/career-presentation-voice-qa.ts
 *
 * PASSAI CAREER — 音声認識の停止・復帰・可視化 QA（dev-only 常設・決定的）。
 *
 * 目的（Production Readiness Audit P1-3 の回帰ガード）:
 *   「マイクを押したのに無反応」「発表中に録音が黙って止まる」を二度と作らない。
 *
 *   1. 再開判定（decideRecognitionRestart）が純関数として正しいこと
 *      - 手動停止 / 時間切れ / unmount → 再開しない・通知しない
 *      - 予期しない停止 → 再開する
 *      - エラー / 暴走（rolling window 超過）→ 再開しないが **必ず通知する**
 *   2. useVoice の実装が上記契約に沿い、面接（autoRestart 既定 false）を壊さないこと
 *   3. プレゼン session ページが voiceError / 停止通知を **画面に出す**こと
 *   4. 音声非対応ブラウザで textarea フォールバックが維持されていること
 *
 *   ブラウザ API は再現しない（純関数 + センチネルで固定する）。
 *
 * 使い方: npx tsx scripts/career-presentation-voice-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  RECOGNITION_STOPPED_MESSAGE,
  RESTART_MAX_IN_WINDOW,
  RESTART_WINDOW_MS,
  decideRecognitionRestart,
  pruneRestarts,
  type RecognitionEndReason,
} from '@/lib/careerVoice/recognitionRestartPolicy';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};
const section = (t: string) => console.log(`\n── ${t} ──`);

const NOW = 1_000_000;
const decide = (
  reason: RecognitionEndReason,
  over: Partial<Parameters<typeof decideRecognitionRestart>[0]> = {},
) =>
  decideRecognitionRestart({
    reason,
    autoRestartEnabled: true,
    presenting: true,
    recentRestarts: [],
    now: NOW,
    ...over,
  });

// ════════════════════════════════════════════════════════════════════
section('A. 意図された停止では再開しない・通知もしない');

check(decide('manual_stop') === 'stop-silent', '手動停止 → 再開しない（無通知）');
check(decide('time_limit') === 'stop-silent', '制限時間到達 → 再開しない（無通知）');
check(decide('unmounted') === 'stop-silent', 'unmount → 再開しない（無通知）');

// ════════════════════════════════════════════════════════════════════
section('B. 予期しない停止は再開する');

check(decide('unexpected') === 'restart', 'ブラウザ都合の停止 → 自動再開する');
check(
  decide('unexpected', { recentRestarts: [NOW - 1000, NOW - 2000] }) === 'restart',
  '数回の再開なら継続して再開する（長い発表を許す）',
);
check(
  decide('unexpected', { recentRestarts: [NOW - (RESTART_WINDOW_MS + 5000)] }) === 'restart',
  'window の外の古い再開は暴走判定に数えない',
);

// ════════════════════════════════════════════════════════════════════
section('C. 再開しない場合は必ず通知する（無言停止をゼロにする）');

check(decide('error') === 'stop-notify', 'エラー由来の停止 → 再開せず通知する');

const stormy = Array.from({ length: RESTART_MAX_IN_WINDOW }, (_, i) => NOW - i * 100);
check(
  decide('unexpected', { recentRestarts: stormy }) === 'stop-notify',
  `短時間に ${RESTART_MAX_IN_WINDOW} 回再開 → 暴走とみなし停止＋通知（無限ループを作らない）`,
);

check(
  decide('unexpected', { autoRestartEnabled: false }) === 'stop-notify',
  '自動再開が無効でも、予期しない停止は通知する',
);
check(
  decide('manual_stop', { autoRestartEnabled: false }) === 'stop-silent',
  '自動再開が無効なら手動停止は無通知（面接の従来挙動）',
);
check(
  decide('unexpected', { presenting: false }) === 'stop-silent',
  '発表を終えていれば再開しない（評価後に勝手にマイクが復活しない）',
);

check(RECOGNITION_STOPPED_MESSAGE.length > 0, '停止時の定型文が定義されている');
check(
  RECOGNITION_STOPPED_MESSAGE.includes('保存されています'),
  '停止文言は「ここまでの文字起こしは残る」と伝える（不安を作らない）',
);

// ════════════════════════════════════════════════════════════════════
section('D. rolling window の刈り込み');

check(
  pruneRestarts([NOW - 1, NOW - RESTART_WINDOW_MS - 1], NOW).length === 1,
  'window 外の再開時刻は捨てる',
);
check(pruneRestarts([], NOW).length === 0, '空配列でも落ちない');

// ════════════════════════════════════════════════════════════════════
section('E. useVoice の実装契約（面接を壊さない）');

const hook = read('app/career/interview/useVoice.ts');

check(/autoRestart = false/.test(hook), 'autoRestart の既定は false（面接は従来挙動）');
check(/presenting = false/.test(hook), 'presenting の既定は false');
check(hook.includes('decideRecognitionRestart'), 'onend は共通の判定関数を使う');
check(hook.includes("setRecognitionStopped(true)"), 'stop-notify で停止フラグを立てる');
check(
  /endReasonRef\.current = reason === 'time_limit' \? 'time_limit' : 'manual_stop'/.test(hook),
  'stopListening は受け取った reason を正規化する（onClick の MouseEvent を誤解釈しない）',
);
check(
  /unmountedRef\.current = true;\s*\n\s*endReasonRef\.current = 'unmounted';/.test(hook),
  'unmount は abort より先に印を付ける（破棄時に再開しない）',
);
check(hook.includes('RESTART_DELAY_MS'), '再開は遅延を挟む（即時 start の InvalidStateError を避ける）');
check(
  hook.includes('recognitionStopped') && hook.includes('clearRecognitionStopped'),
  '停止状態と解除関数を公開している',
);
// deps に autoRestart/presenting を入れて recognition を作り直していないこと（発話取りこぼし防止）。
const initEffect = hook.slice(hook.indexOf('// recognition 初期化'), hook.indexOf('const startListening'));
check(
  /\}, \[\]\);\s*$/.test(initEffect.trim()),
  'recognition 初期化 effect の deps は空（発話中に認識器を作り直さない）',
);

// ════════════════════════════════════════════════════════════════════
section('F. 面接 session は従来どおり（autoRestart を渡していない）');

const interview = read('app/career/interview/session/page.tsx');
check(!/autoRestart/.test(interview), '面接は autoRestart を渡していない（挙動不変）');
check(interview.includes('voiceError'), '面接は従来どおり voiceError を表示している');

// ════════════════════════════════════════════════════════════════════
section('G. プレゼン session が失敗をユーザーに見せる');

const page = read('app/career/presentation/session/page.tsx');

check(/autoRestart: true/.test(page), 'プレゼンは autoRestart を有効にしている');
check(/presenting,/.test(page), 'プレゼンは presenting を hook へ渡している');
check(page.includes('voiceError'), 'voiceError を受け取っている');
check(
  /\{voiceError && \(/.test(page) && /role="alert"/.test(page),
  'voiceError を role="alert" で表示している（無反応をゼロにする）',
);
check(
  /\{recognitionStopped && \(/.test(page),
  '自動再開できなかった停止を表示している（無言停止をゼロにする）',
);
check(page.includes('recognitionStoppedMessage'), '停止文言は共通定数を使う（面接と表現を揃える）');
check(page.includes('再接続中…'), '再開待ちの状態を表示している（止まったと誤解させない）');

// ════════════════════════════════════════════════════════════════════
section('H. タイマー整合（認識の中断で経過時間が止まらない）');

check(
  /if \(!presenting\) return;\s*\n\s*const id = setInterval/.test(page),
  'タイマーは presenting で駆動する（listening ではない）',
);
check(
  /stopListening\('time_limit'\)/.test(page),
  '制限時間到達は time_limit として停止する（自動再開しない）',
);
check(
  !/setElapsed\(\(s\) => \{[\s\S]*?stopListening\(\)/.test(page),
  '状態更新関数の中で stopListening を呼んでいない',
);

// ════════════════════════════════════════════════════════════════════
section('I. 音声非対応ブラウザのフォールバック維持');

check(
  page.includes('このブラウザは音声認識に未対応です'),
  '非対応ブラウザの案内が残っている',
);
check(
  /sttSupported \? \(/.test(page),
  '録音 UI は sttSupported で分岐している',
);
// textarea は sttSupported に関係なく常に描画されること（音声不可＝機能不能にしない）。
const textareaBlock = page.slice(page.indexOf('{/* 文字起こし / 原稿'));
check(
  textareaBlock.includes('<Textarea') && !textareaBlock.includes('sttSupported'),
  '文字起こし/原稿の textarea は sttSupported に依存せず常に使える',
);
check(
  /disabled=\{evaluating \|\| !transcript\.trim\(\)\}/.test(page),
  '手入力だけでも評価へ進める（音声非対応で機能不能にならない）',
);

// ════════════════════════════════════════════════════════════════════
console.log(`\n${fails === 0 ? '✅ PASS' : `❌ FAIL (${fails})`}`);
process.exit(fails === 0 ? 0 : 1);
