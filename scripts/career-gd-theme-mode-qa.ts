// PASSAI 就活版 — GD お題モードの静的 regression QA（登録済み・再実行可能）。
//
// 実行: npx tsx scripts/career-gd-theme-mode-qa.ts
//
// 守る不変条件（プロダクト判断）:
//   solo   → 自分でお題 / AIにお題を作ってもらう の両方が使える（既存仕様を維持）
//   online → 作成者が入力したお題のみ（AIお題生成なし・GD形式の選択なし）
//   friend → 作成者が入力したお題のみ（AIお題生成なし・GD形式の選択なし）
//
// AI 呼び出し・DB・env に依存しないソース静的検査のみ（CI で再実行できる）。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error('FAIL:', name, detail ? `— ${detail}` : '');
  }
}

// コメント（説明文で「AIにテーマ〜」等に言及する）を除いた実コードだけを検査対象にする。
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function read(rel: string): string {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) {
    fail++;
    console.error('FAIL: missing file', rel);
    return '';
  }
  return stripComments(readFileSync(p, 'utf8'));
}

// ── 対象ファイル ─────────────────────────────────────────────
const SOLO_SETUP = 'app/career/gd/setup/page.tsx';
const THEME_ROUTE = 'app/api/career/gd/theme/route.ts';
const THEME_STEP = 'app/career/gd/components/ThemeSetupStep.tsx';

// online（公開GD部屋） / friend（合言葉ルーム）の作成・一覧 UI。
const ONLINE_FRIEND_UI = [
  'app/career/gd/rooms/create/page.tsx', // online: GD部屋を作る
  'app/career/gd/room/create/page.tsx', // friend: 合言葉ルームを作る
  'app/career/gd/rooms/page.tsx', // online: 募集中の部屋一覧
  'app/career/gd/lobby/page.tsx', // online: 旧公開ロビー（作成導線はウィザードへ）
  THEME_STEP, // online / friend 共用のお題入力ステップ
];

const THEME_API = '/api/career/gd/theme';

console.log('[A] solo は AIお題生成を維持している');

{
  const route = read(THEME_ROUTE);
  check('solo: AIお題生成 route が存在する', route.includes('export async function POST'));
  check('solo: AIお題生成 route が anthropic を呼ぶ', route.includes('anthropic'));

  const setup = read(SOLO_SETUP);
  check('solo: setup が AIお題生成 API を呼ぶ', setup.includes(THEME_API));
  // solo の GD形式選択は既存仕様として維持する（online/friend だけ廃止）。
  check('solo: GDの形式 選択 UI が残っている', setup.includes('GDの形式'));
  check('solo: GD_FORMAT_DESCRIPTIONS を使っている', setup.includes('GD_FORMAT_DESCRIPTIONS'));
}

console.log('\n[B] online / friend は AIお題生成を持たない');

for (const rel of ONLINE_FRIEND_UI) {
  const src = read(rel);
  check(`${rel}: AIお題生成 API を呼ばない`, !src.includes(THEME_API));
  check(`${rel}: 「AIにテーマを作ってもらう」導線が無い`, !src.includes('AIにテーマ'));
  check(`${rel}: AI生成の再生成 UI が無い`, !src.includes('AIで再生成'));
}

console.log('\n[C] online / friend は GD形式の選択 UI を持たない');

for (const rel of ONLINE_FRIEND_UI) {
  const src = read(rel);
  check(`${rel}: 「GDの形式」ラベルが無い`, !src.includes('GDの形式'));
  check(`${rel}: 形式カードの説明（GD_FORMAT_DESCRIPTIONS）が無い`, !src.includes('GD_FORMAT_DESCRIPTIONS'));
  check(`${rel}: 形式セレクタ（GD_FORMAT_LABELS）が無い`, !src.includes('GD_FORMAT_LABELS'));
}

{
  // 作成 payload は既定値（GD_DEFAULT_FORMAT）を送るだけで、ユーザー選択の state を持たない。
  for (const rel of ['app/career/gd/rooms/create/page.tsx', 'app/career/gd/room/create/page.tsx']) {
    const src = read(rel);
    check(`${rel}: format の選択 state を持たない`, !/useState<GdFormat>/.test(src));
    check(`${rel}: GD_DEFAULT_FORMAT を送る`, src.includes('GD_DEFAULT_FORMAT'));
  }
}

console.log('\n[D] AIお題生成 API の client 呼び出しは solo のみ');

{
  // repo 全体で theme API を参照する app/ 配下のファイルを列挙し、許可リストと一致させる。
  const allowed = new Set([SOLO_SETUP, THEME_ROUTE]);
  const found = new Set<string>();
  const stack = [path.join(ROOT, 'app')];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const rel = path.relative(ROOT, full);
      if (rel === THEME_ROUTE) continue; // route 自身
      const src = stripComments(readFileSync(full, 'utf8'));
      if (src.includes(THEME_API)) found.add(rel);
    }
  }
  for (const rel of found) {
    check(`AIお題生成 API を呼ぶのは許可済みファイルのみ: ${rel}`, allowed.has(rel));
  }
  check('solo setup が呼び出し元として検出される', found.has(SOLO_SETUP));
}

console.log('\n[E] online / friend の作成 API は手入力お題を必須にする');

for (const rel of [
  'app/api/career/gd/lobby/create/route.ts',
  'app/api/career/gd/room/create/route.ts',
]) {
  const src = read(rel);
  check(`${rel}: parseRoomThemeInput で検証する`, src.includes('parseRoomThemeInput'));
  check(`${rel}: 未確定お題は THEME_REQUIRED で拒否する`, src.includes('THEME_REQUIRED'));
  check(`${rel}: お題の AI 自動生成 fallback を持たない`, !src.includes(THEME_API) && !src.includes('buildRoomTheme'));
}

console.log(`\ncareer GD theme mode QA: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
