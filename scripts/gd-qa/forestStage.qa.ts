// PASSAI 就活版 — GD「Forest Circle」実行中 UI の決定的 QA（登録済み・再実行可能）。
//
// 実行:  npx tsx scripts/gd-qa/forestStage.qa.ts
// 対象:  app/career/gd/components/stage/**（presentation layer）
//        app/career/gd/session/page.tsx（ソロ）
//        app/career/gd/room/[roomId]/page.tsx（フレンド / オンライン）
//        app/globals.css（.gdf-* namespace）
//
// 目的:
//   ① 座席配置（純関数）の回帰防止 — 人数 3〜12 で破綻せず、index 0 が必ず手前中央。
//   ② 3 モードが **同じ** component を使い続けること（Solo だけ / Friend だけの旧 UI 化を防ぐ）。
//   ③ 既存 E2E / 進行ロジックの契約が UI 刷新で壊れていないこと（test hook・API・保存点）。
//   ④ アクセシビリティ / パフォーマンスの下限（reduced-motion・色だけに依存しない・重い描画を入れない）。
//
// 外部 AI・DB・env 非依存（純ロジック + ソース静的検査のみ）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeGdSeats, seatSizeFactor } from '../../app/career/gd/components/stage/seatLayout';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
/** 行コメントを落として「実装が実際に持っている」ことだけを見る。 */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

const SOLO = 'app/career/gd/session/page.tsx';
const ROOM = 'app/career/gd/room/[roomId]/page.tsx';
const STAGE_DIR = 'app/career/gd/components/stage';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name);
  }
}

// ══════════════════════════════════════════════════════════════
// [A] 座席配置（純関数）
// ══════════════════════════════════════════════════════════════
console.log('\n[A] 座席配置（participantCount から決める）');
{
  for (let n = 3; n <= 12; n++) {
    const seats = computeGdSeats(n);
    check(`A1 ${n}人ぶんの席が返る`, seats.length === n);
    // index 0 = 自分は必ず手前中央（x=0 / 最前）。
    check(`A2 ${n}人: index 0 が手前中央`, seats[0].x === 0 && seats[0].y === 1 && seats[0].depth === 1);
    // すべて単位円上（＝等間隔の円卓）。
    const onCircle = seats.every((s) => Math.abs(Math.hypot(s.x, s.y) - 1) < 1e-3);
    check(`A3 ${n}人: 全席が円周上`, onCircle);
    // 奥行きは 0〜1 に収まり、scale / zIndex が単調に対応する。
    const depthOk = seats.every((s) => s.depth >= 0 && s.depth <= 1);
    const scaleOk = seats.every((s) => s.scale >= 0.78 && s.scale <= 1);
    const zOk = seats.every((s) => s.zIndex >= 10 && s.zIndex <= 30);
    check(`A4 ${n}人: depth / scale / zIndex が範囲内`, depthOk && scaleOk && zOk);
    // 手前ほど大きく・手前ほど上に重なる。
    const monotone = seats.every((s) =>
      seats.every((t) => (s.depth > t.depth ? s.scale > t.scale && s.zIndex > t.zIndex : true)),
    );
    check(`A5 ${n}人: 手前ほど大きく前面`, monotone);
    // 席が重複しない（同じ座標に 2 人置かない）。
    const uniq = new Set(seats.map((s) => `${s.x}:${s.y}`));
    check(`A6 ${n}人: 座標が重複しない`, uniq.size === n);
  }
  // 決定的（SSR / CSR で同じ style 文字列になる）。
  check('A7 決定的', JSON.stringify(computeGdSeats(6)) === JSON.stringify(computeGdSeats(6)));
  // -0 を返さない（React の style 文字列がぶれない）。
  check('A8 -0 を含まない', !JSON.stringify(computeGdSeats(4)).includes('-0,') && !Object.is(computeGdSeats(4)[2].x, -0));
  // 人数が増えたら縮小係数が効く（重なり緩和）。
  check('A9 5人以下は等倍', seatSizeFactor(3) === 1 && seatSizeFactor(5) === 1);
  check('A10 6人以上で縮小', seatSizeFactor(6) < 1 && seatSizeFactor(8) < seatSizeFactor(6));
  check('A11 縮小の下限がある', seatSizeFactor(30) >= 0.62);
  check('A12 1人でも壊れない', computeGdSeats(1).length === 1 && computeGdSeats(0).length === 1);
}

// ══════════════════════════════════════════════════════════════
// [B] 3 モード共通化（Solo / Friend / Online で別 UI を作らない）
// ══════════════════════════════════════════════════════════════
console.log('\n[B] Solo / Friend / Online が同じ Forest Circle を使う');
{
  const solo = codeOnly(read(SOLO));
  const room = codeOnly(read(ROOM));
  for (const [label, src] of [['solo', solo], ['room(friend/online)', room]] as const) {
    check(`B1 ${label} が GdCircleStage を描画する`, /<GdCircleStage\b/.test(src));
    check(`B2 ${label} が共通 stage から import する`, /from '(\.\.\/)+components\/stage'/.test(src));
    check(`B3 ${label} が useRecentSpeaker を使う`, src.includes('useRecentSpeaker('));
    check(`B4 ${label} が自分を先頭（手前中央）へ並べ替える`, /\.sort\(/.test(src) && src.includes('stageParticipants'));
    check(`B5 ${label} が Forest の外殻を使う`, src.includes('gdf-shell'));
  }
  // room は friend（invite）/ online（public_lobby・random_match）の共通実装であること。
  check('B6 room は status 別 view の単一実装のまま', room.includes('function ActiveView(') && room.includes('roomType'));
  // Avatar / 背景 / レイアウトは stage 側だけに存在する（ページ側に複製しない）。
  for (const [label, src] of [['solo', solo], ['room', room]] as const) {
    check(`B7 ${label} が独自の Avatar SVG を持たない`, !src.includes('<svg'));
    check(`B8 ${label} が座席座標を自前計算しない`, !src.includes('Math.cos') && !src.includes('Math.sin'));
  }
}

// ══════════════════════════════════════════════════════════════
// [C] Speaking Indicator（既存 state の写像であること）
// ══════════════════════════════════════════════════════════════
console.log('\n[C] 発話インジケータ');
{
  const avatar = read(`${STAGE_DIR}/ParticipantAvatar.tsx`);
  const stage = read(`${STAGE_DIR}/GdCircleStage.tsx`);
  const css = read('app/globals.css');
  check('C1 「・・・」は 3 つのドットで描く', (avatar.match(/gdf-seat__dot/g) ?? []).length >= 3);
  check('C2 ドットにアニメーションがある', css.includes('@keyframes gdf-dot') && css.includes('animation: gdf-dot'));
  check('C3 発話ドットは吹き出し（文章は出さない）', avatar.includes('gdf-seat__bubble') && !avatar.includes('message.content'));
  check('C4 発言中は色だけでなくテキストでも示す', avatar.includes("'発言中'") && avatar.includes("'考え中'"));
  check('C5 発言中は足元リング / グローで強調', css.includes('.gdf-seat[data-speech=\'speaking\'] .gdf-seat__ring') && css.includes('drop-shadow'));
  check('C6 強調は控えめな拡大にとどめる', css.includes('--gdf-boost: 1.07'));
  check('C7 発話状態を読み上げにも渡す', stage.includes('aria-live="polite"'));

  const solo = codeOnly(read(SOLO));
  const room = codeOnly(read(ROOM));
  // solo: 既存 phase='ai-thinking' と発言ログを使う（新しい進行 state を作らない）。
  check('C8 solo は既存 phase を thinking に写す', solo.includes("phase === 'ai-thinking' && p.id === aiSpeakerId"));
  check('C9 solo は transcript の最新発言を speaker に使う', solo.includes('lastSpeech') && solo.includes("u.kind !== 'system'"));
  check('C10 solo は入力中を自分の発言中に写す', solo.includes('selfTyping'));
  check(
    'C10b solo の speaking は同時に 1 人だけ（実発言が最優先）',
    solo.includes('recentSpeakerId === p.id || (!recentSpeakerId && selfTyping)'),
  );
  // room: 既存 messages / pendingMessages を使う。
  check('C11 room は確定 message の最新を speaker に使う', room.includes('lastMessage') && room.includes("messages[i].kind !== 'system'"));
  check('C12 room は optimistic 送信中を自分の発言中に写す', room.includes("pendingMessages.some((m) => m.status === 'sending')"));
  check(
    'C12b room の speaking は同時に 1 人だけ（確定発言が最優先）',
    room.includes('recentSpeakerId === m.participantId || (!recentSpeakerId && selfSpeaking)'),
  );
  // 進行ロジックの新規追加が無いこと（speaker を server / DB に持たせていない）。
  check(
    'C13 speaker 用の新 API / endpoint を作っていない',
    !/\/api\/career\/gd\/[a-z/[\]-]*(speak|presence|indicator)/i.test(room + solo),
  );
}

// ══════════════════════════════════════════════════════════════
// [D] 既存契約の非退行（E2E test hook / 進行 / 保存）
// ══════════════════════════════════════════════════════════════
console.log('\n[D] 既存契約の非退行');
{
  const room = read(ROOM);
  const solo = read(SOLO);
  // ① E2E が参照する test hook を維持している。
  check('D1 roster の data-testid=gd-member-row が残る', room.includes("testId: 'gd-member-row'"));
  check('D2 gd-member-row に data-ai / data-connection が残る', room.includes("'data-ai'") && room.includes("'data-connection'"));
  check('D3 参加者数の表示（参加者（n / m））が残る', room.includes('参加者（{humanCount} / {room.plannedParticipantCount}）'));
  check('D4 同期モードバッジが残る', room.includes('gd-sync-mode') || room.includes('<SyncModeBadge'));
  check('D5 残り時間の testid が残る', room.includes('data-testid="gd-remaining-time"'));
  check('D6 optimistic 発言の testid が残る', room.includes('data-testid="gd-pending-message"'));
  check('D7 発言入力の id が残る', room.includes('id="gd-input"'));
  // ② 操作（ボタン名）を変えていない。
  for (const label of ['発言する', 'AIに発言してもらう', 'GDを終了する', '生成中…']) {
    check(`D8 room の操作ラベル維持: ${label}`, room.includes(label));
  }
  for (const label of ['発言する →', 'AIの発言を進める', 'GDを終了して評価を見る →', '評価を作成中…']) {
    check(`D9 solo の操作ラベル維持: ${label}`, solo.includes(label));
  }
  // ③ 進行・同期・保存のロジックがそのまま残っている。
  for (const anchor of [
    'useCareerGdMessages',
    'useCareerGdTimer',
    'useCareerGdRealtime',
    'useCareerGdHeartbeat',
    'useCareerGdServerClock',
    '/ai-turn',
    '/finish',
    'ExitControls',
    'recordCareerEvent',
    'appendGdRoomLog',
  ]) {
    check(`D10 room の既存ロジック維持: ${anchor}`, room.includes(anchor));
  }
  for (const anchor of [
    '/api/career/gd/turn',
    '/api/career/gd/feedback',
    'appendGdResult(result)',
    'upsertCareerGdSoloResultsToSupabase',
    'recordCareerEvent',
    'MAX_UTTERANCES',
  ]) {
    check(`D11 solo の既存ロジック維持: ${anchor}`, solo.includes(anchor));
  }
  // ④ 待機 / 終了画面は今回の対象外（実行中 UI だけを変える）。
  check('D12 waiting の MembersCard は温存', room.includes('function MembersCard('));
  check('D13 finished の結果導線は温存', room.includes('function FinishedView(') && room.includes('GdEvaluationDetail'));
  // ⑤ API 契約 / DB / realtime を触っていない。
  //   実行中 UI 刷新で room の API 呼び出し先（9 箇所）を増減させていないこと。
  check('D14 room の fetch 箇所数が変わっていない', (room.match(/fetch\(/g) ?? []).length === 9);
  for (const endpoint of ['/start', '/ai-turn', '/finish', '/close', '/leave', '/result']) {
    check(`D14b room の endpoint 維持: ${endpoint}`, room.includes(`}${endpoint}\``));
  }
}

// ══════════════════════════════════════════════════════════════
// [E] パフォーマンス / 素材（重い描画を持ち込まない・外部素材を使わない）
// ══════════════════════════════════════════════════════════════
console.log('\n[E] パフォーマンスと素材');
{
  const files = [
    `${STAGE_DIR}/GdCircleStage.tsx`,
    `${STAGE_DIR}/ParticipantAvatar.tsx`,
    `${STAGE_DIR}/ForestBackdrop.tsx`,
    `${STAGE_DIR}/seatLayout.ts`,
    `${STAGE_DIR}/useRecentSpeaker.ts`,
  ];
  for (const rel of files) {
    const src = codeOnly(read(rel));
    const name = rel.split('/').pop();
    check(
      `E1 ${name}: WebGL / canvas / 動画を使わない`,
      !/three|WebGL|getContext\(|<canvas|<video|requestAnimationFrame/i.test(src),
    );
    check(`E2 ${name}: 外部素材（画像 / 外部 URL）を読み込まない`, !/https?:\/\/|<img\b/i.test(src));
    // SVG の url() 参照は内部 id（#...）のみ＝外部アセットを引かない。
    const urlRefs = src.match(/url\(([^)]*)\)/g) ?? [];
    check(`E2b ${name}: url() は内部 id 参照のみ`, urlRefs.every((u) => u.startsWith('url(#')));
    check(`E3 ${name}: 描画にランダムを使わない（hydration 安定）`, !/Math\.random\(/.test(src));
  }
  const css = read('app/globals.css');
  // 常時大量の particle を置かない（灯りは 3 個まで）。
  check('E4 灯りは少数のみ', (css.match(/\.gdf-lamp--/g) ?? []).length <= 3);
}

// ══════════════════════════════════════════════════════════════
// [F] アクセシビリティ
// ══════════════════════════════════════════════════════════════
console.log('\n[F] アクセシビリティ');
{
  const stage = read(`${STAGE_DIR}/GdCircleStage.tsx`);
  const avatar = read(`${STAGE_DIR}/ParticipantAvatar.tsx`);
  const css = read('app/globals.css');
  const room = read(ROOM);
  const solo = read(SOLO);
  check('F1 ステージに aria-label がある', stage.includes('aria-label="GD参加者ステージ'));
  check('F2 参加者名が DOM に存在する', avatar.includes('participant.displayName'));
  check('F3 装飾 SVG は aria-hidden', avatar.includes('aria-hidden="true"') && read(`${STAGE_DIR}/ForestBackdrop.tsx`).includes('aria-hidden="true"'));
  check('F4 接続状態に aria-label がある', avatar.includes('aria-label={GD_CONNECTION_LABELS[connection]}'));
  check('F5 prefers-reduced-motion で「・・・」を静止させる', /@media \(prefers-reduced-motion: reduce\)[\s\S]*gdf-seat__dot[\s\S]*animation: none/.test(css));
  check('F6 reduced-motion で拡大演出も止める', /@media \(prefers-reduced-motion: reduce\)[\s\S]*--gdf-boost: 1;/.test(css));
  check('F7 発言入力に label が結び付いている', room.includes('htmlFor="gd-input"') && solo.includes('htmlFor="gd-solo-input"'));
  check('F8 操作は button / link のまま（keyboard 操作を壊さない）', room.includes('type="button"') && solo.includes('type="button"'));
  check('F9 focus リングを消していない', css.includes('.gdf-btn:focus-visible') && css.includes('.gdf-field:focus'));
}

// ══════════════════════════════════════════════════════════════
// [G] レスポンシブ（React ではなく CSS で解決している）
// ══════════════════════════════════════════════════════════════
console.log('\n[G] レスポンシブ');
{
  const css = read('app/globals.css');
  const stage = read(`${STAGE_DIR}/GdCircleStage.tsx`);
  check('G1 半径 / 中心を CSS 変数で持つ', css.includes('--gdf-rx') && css.includes('--gdf-ry') && css.includes('--gdf-cy'));
  check('G2 sm / lg の breakpoint で円を作り替える', css.includes('@media (min-width: 640px)') && css.includes('@media (min-width: 1024px)'));
  check('G3 横スクロール前提にしていない', !css.includes('.gdf-stage { overflow-x: auto') && css.includes('.gdf-stage'));
  check('G4 画面幅の分岐を React 側に持ち込まない', !/window\.(innerWidth|matchMedia)/.test(stage));
  check('G5 人数に応じた縮小を CSS 側でも用意', css.includes("[data-count='8']"));
}

console.log(`\nGD Forest Circle stage QA: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
