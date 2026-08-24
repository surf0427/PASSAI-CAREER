/*
 * scripts/career-presentation-self-view-qa.ts
 *
 * PASSAI CAREER — プレゼン発表中セルフビュー（カメラ）QA（dev-only 常設・決定的）。
 *
 * 守りたい契約:
 *   1. 発表中画面に自分のカメラ映像が出る（getUserMedia → srcObject → 鏡像表示）
 *   2. video 専用（audio: false）。既存マイク（useVoice / Web Speech API）と競合しない
 *   3. lifecycle: 無効化 / unmount で track を必ず stop（カメラランプを残さない）
 *   4. 権限拒否・カメラ無し・非対応でもプレゼンは続行でき、無言で終わらない
 *   5. 映像を server / DB / Storage / localStorage / AI へ送らない
 *   6. 発表資料・transcript・timer・評価の既存 UI を壊さない
 *
 * ブラウザ API は再現せず、実装ソースの静的契約として固定する。
 *
 * 使い方: npx tsx scripts/career-presentation-self-view-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};
const section = (t: string) => console.log(`\n── ${t} ──`);

const COMPONENT_PATH = 'app/career/presentation/SelfViewCamera.tsx';
const PAGE_PATH = 'app/career/presentation/session/page.tsx';
// コメントは「使っていない API」を説明のために書いているため、禁止 API 走査は
// コメントを除いた実コードに対して行う（説明文で誤検知しない）。
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const component = read(COMPONENT_PATH);
const componentCode = stripComments(component);
const page = read(PAGE_PATH);
const useVoiceSrc = read('app/career/interview/useVoice.ts');

// ════════════════════════════════════════════════════════════════════
section('A. CASE 1: 権限許可時にセルフビューが出る');

check(component.includes("'use client'"), 'client component である（ブラウザ API を使える）');
check(
  /navigator\.mediaDevices[\s\S]{0,200}getUserMedia/.test(component),
  'navigator.mediaDevices.getUserMedia でカメラを取得する',
);
check(
  /videoRef\.current\.srcObject = stream/.test(component),
  '取得した MediaStream を video.srcObject へ接続する',
);
check(/<video/.test(component), 'video 要素を描画する');
check(/\bautoPlay\b/.test(component), 'video に autoPlay を付ける');
check(/\bplaysInline\b/.test(component), 'video に playsInline を付ける（iPhone Safari で全画面化しない）');
check(/\bmuted\b/.test(component), 'video に muted を付ける（ハウリング・自動再生ブロックを避ける）');
check(
  /transform: 'scaleX\(-1\)'/.test(component),
  '自然な鏡像で表示する（scaleX(-1)）',
);

// ════════════════════════════════════════════════════════════════════
section('B. CASE 9: audio を掴まない（既存マイク・音声認識と競合しない）');

check(
  /getUserMedia\(\{ video: true, audio: false \}\)/.test(component),
  'getUserMedia は video: true / audio: false（マイクを一切要求しない）',
);
check(
  !/audio:\s*true/.test(component),
  'audio: true を要求する箇所が無い',
);
check(
  !/getUserMedia/.test(useVoiceSrc) && /SpeechRecognition/.test(useVoiceSrc),
  '既存の文字起こしは Web Speech API 側で完結しており getUserMedia を使っていない',
);
check(
  !/useVoice|startListening|stopListening|recognition|transcript/i.test(componentCode),
  'セルフビューは音声認識 / transcript の state に一切触れない',
);

// ════════════════════════════════════════════════════════════════════
section('C. CASE 4 / 5 / 6: lifecycle と track 停止');

check(
  /getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/.test(component),
  'stream.getTracks().forEach(t => t.stop()) で解放する',
);
check(
  (component.match(/getTracks\(\)\.forEach/g) ?? []).length >= 2,
  'cleanup 経路と「cleanup 後に解決した stream」の両方で stop する',
);
check(
  /return \(\) => \{[\s\S]{0,120}cancelled = true;[\s\S]{0,120}stopStream\(\);/.test(component),
  'effect cleanup（unmount / ページ離脱）で必ず stopStream する',
);
check(
  /if \(cancelled\) \{\s*stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\);/.test(component),
  'React Strict Mode の再 mount で、遅れて解決した stream も即 stop する（track リーク無し）',
);
check(
  /if \(!enabled\) \{\s*stopStream\(\);/.test(component),
  'カメラ OFF は CSS で隠すだけでなく stream を停止する',
);
check(
  /streamRef\.current = null;/.test(component),
  '停止後に streamRef を null へ戻す（二重生成・古い stream の再利用を防ぐ）',
);
check(
  /カメラをオンにする/.test(component) && /カメラをオフにする/.test(component),
  '発表中に ON / OFF を切り替えられる',
);

// ════════════════════════════════════════════════════════════════════
section('D. CASE 2 / 3: 権限拒否・カメラ不在でもプレゼンを止めない');

check(
  /NotAllowedError/.test(component) && /SecurityError/.test(component),
  '権限拒否（NotAllowedError / SecurityError）を識別する',
);
check(
  /NotFoundError/.test(component),
  'カメラ非搭載（NotFoundError）を識別する',
);
check(
  /mediaDevices\?\.getUserMedia\s*\?[\s\S]{0,200}: Promise\.reject\(MEDIA_DEVICES_UNAVAILABLE\)/.test(
    component,
  ),
  'mediaDevices 自体が無い環境（非 secure context 等）でも throw せず、権限拒否と同じ catch 経路へ流す',
);
check(
  /name: 'NotSupportedError'/.test(component) &&
    /if \(name === 'NotSupportedError'\) return 'unsupported';/.test(component),
  'mediaDevices 不在は unsupported として fallback 表示になる',
);
check(
  /setEnabled\(false\);/.test(componentCode) && !/setInterval|setTimeout/.test(componentCode),
  '失敗時はオフ状態へ戻すだけで、タイマーによる自動再要求をしない',
);
check(
  /プレゼンはそのまま続けられます/.test(component),
  '利用できないときは「プレゼンはそのまま続けられます」と明示する（無言の console error にしない）',
);
check(
  /role="status"/.test(component),
  'fallback メッセージを画面に出す（支援技術にも伝わる）',
);
check(
  !/throw /.test(component),
  'カメラ失敗で例外を投げない（session を crash させない）',
);
check(
  /\.catch\(\(err\) => \{/.test(component),
  'getUserMedia の reject を必ず捕捉する',
);
// 失敗しても自動で再要求しない（無限 permission request の禁止）。
check(
  !/setEnabled\(true\)/.test(component),
  '失敗後に自動で再取得しない（再試行はユーザー操作のときだけ）',
);

// ════════════════════════════════════════════════════════════════════
section('E. Privacy: 映像を外に出さない');

for (const forbidden of [
  'MediaRecorder',
  'toDataURL',
  'toBlob',
  'getContext',
  'canvas',
  'createSignedUrl',
  'localStorage',
  'sessionStorage',
  'supabase',
  'fetch(',
  'FormData',
  'base64',
]) {
  check(
    !componentCode.includes(forbidden),
    `映像を外へ出す手段を持たない（${forbidden} を使っていない）`,
  );
}
check(
  /保存も送信もされません/.test(component),
  '保存・送信しないことを画面上でも明示する',
);

// ════════════════════════════════════════════════════════════════════
section('F. 発表画面への統合（CASE 7 / 8・既存 UI を壊さない）');

check(
  /import \{ SelfViewCamera \} from '\.\.\/SelfViewCamera';/.test(page),
  'session ページが SelfViewCamera を import している',
);
check(/<SelfViewCamera/.test(page), '発表中画面にセルフビューを描画している');

const themeIdx = page.indexOf('{/* テーマ・条件 */}');
const selfViewIdx = page.indexOf('<SelfViewCamera');
const voiceIdx = page.indexOf('{/* 録音（音声モード） */}');
const transcriptIdx = page.indexOf('{/* 文字起こし / 原稿');
check(themeIdx > 0 && selfViewIdx > themeIdx, 'お題・制限時間カードより後に置かれている（お題を覆わない）');
check(voiceIdx > selfViewIdx, '録音操作カードより前に置かれている（controls を覆わない）');
check(transcriptIdx > voiceIdx, '文字起こし欄は従来どおり録音カードの後にある');
// 資料は お題カード内の details。セルフビューはその外側なので、資料を開いても隠れない。
check(
  page.indexOf('発表資料（評価に使用されます）') < selfViewIdx,
  '発表資料の折りたたみと同時に表示できる（資料カードの外に置いている）',
);
check(
  /mb-5 lg:col-start-2[\s\S]{0,120}<SelfViewCamera \/>/.test(page),
  'lg 未満は既存カードと同じ縦リズム（mb-5）で並ぶ',
);
// 映像サイズ: カード幅いっぱい（上限 520px）。旧 240px サムネイルには戻さない。
check(
  /mt-3 mx-auto w-full max-w-\[520px\]/.test(component),
  '映像はカード幅いっぱいに広がる（上限 520px・中央寄せ）',
);
check(
  !/max-w-\[280px\]/.test(component) && !/sm:w-60/.test(component),
  '旧サムネイルサイズ（280px / w-60=240px）に戻っていない',
);
check(
  /aspect-\[4\/3\]/.test(component),
  '4:3 の固定比率で描画する（顔だけでなく上半身・姿勢が入る縦幅）',
);
// 見出しと ON/OFF を 1 行に畳み、残りをすべて映像に回す。
check(
  /flex flex-wrap items-center justify-between gap-2/.test(component),
  '見出しと ON/OFF は 1 行にまとめ、縦を映像に回している',
);
check(
  component.indexOf('<video') < component.indexOf('発表中の表情・姿勢・目線'),
  '映像が説明文より前（カード上部）にあり、最初に目に入る',
);

// ── お題の可視性（拡大の最重要条件）──────────────────────────────
// lg 以上ではお題とセルフビューを同じ行に置く。カメラを大きくしてもお題は
// ファーストビューから押し出されない。
check(
  /lg:grid lg:grid-cols-\[minmax\(0,1fr\)_460px\] xl:grid-cols-\[minmax\(0,1fr\)_520px\]/.test(page),
  'lg 以上は「左=情報 / 右=大きいセルフビュー」の 2 カラム',
);
check(
  /lg:col-start-1 lg:row-start-1/.test(page),
  'お題カードは左カラムの 1 行目（最上部）に固定される',
);
check(
  /lg:col-start-2 lg:row-start-1 lg:row-span-2/.test(page),
  'セルフビューは右カラムでお題と同じ行から始まる（同時に見える）',
);
check(
  /lg:self-start lg:sticky lg:top-6/.test(page),
  'セルフビューは sticky。self-start 付きで grid item が伸びず sticky が効く',
);
check(
  /lg:col-start-1 lg:row-start-2/.test(page),
  '録音・文字起こしは左カラムの 2 行目（カメラに覆われない）',
);
check(
  /max-w-3xl lg:max-w-6xl xl:max-w-7xl/.test(page),
  'lg 以上でのみコンテナを広げる（lg 未満の 1 カラムは従来幅のまま）',
);
check(
  /Card|Button/.test(component) &&
    /from '@\/components\/ui\/Card'/.test(component) &&
    /from '@\/components\/ui\/Button'/.test(component),
  '既存デザインシステム（Card / Button）を使っている',
);

// ════════════════════════════════════════════════════════════════════
section('G. Regression: 既存プレゼン機能に触れていない');

check(
  /materialFile: session\.materialFile/.test(page),
  '発表資料ファイルの評価送信は従来どおり',
);
check(
  /material: session\.material \?\? ''/.test(page),
  '発表資料テキストの評価送信は従来どおり',
);
check(
  /'\/api\/career\/presentation\/evaluate'/.test(page),
  '評価 API の呼び出し先は不変',
);
check(
  /const durationSec = isVoice \? elapsed : 0;/.test(page),
  'durationSec（タイマー実測）のロジックは不変',
);
check(
  /startListening\(\);/.test(page) && /stopListening\('manual_stop'\)/.test(page),
  '録音の開始 / 停止ロジックは不変',
);
// handleEvaluate 本体（宣言 〜 useCallback の deps 配列）だけを見る。
const evaluateStart = page.indexOf('const handleEvaluate');
const evaluateEnd = page.indexOf('}, [session, evaluating, transcript,', evaluateStart);
check(evaluateStart > 0 && evaluateEnd > evaluateStart, 'handleEvaluate の範囲を特定できる');
check(
  !/SelfView|camera|Camera|MediaStream/.test(page.slice(evaluateStart, evaluateEnd)),
  '評価処理はカメラに一切依存しない（カメラ不可でも評価できる）',
);

// ════════════════════════════════════════════════════════════════════
console.log(`\n${fails === 0 ? '✅ PASS' : `❌ FAIL (${fails})`}`);
process.exit(fails === 0 ? 0 : 1);
