// PASSAI 就活版 — GD E2E 共通ヘルパー（STEP-GD-20-H）。
// storageState（テスト member の auth cookie）は E2E_STORAGE_DIR から読む。
// 作成した room id は E2E_MANIFEST に追記し、テスト後の cleanup / DB 検証に使う。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

// storageState（テスト member の auth cookie）と room manifest の場所。
// 秘密を含むため tracked にはせず、既定は repo 直下の gitignore 済み .e2e-tmp/。
// 実行時に E2E_STORAGE_DIR / E2E_MANIFEST で上書きできる（本 QA は scratchpad を指定して実行）。
const STORAGE_DIR = process.env.E2E_STORAGE_DIR || path.join(process.cwd(), '.e2e-tmp', 'storage');
const MANIFEST = process.env.E2E_MANIFEST || path.join(process.cwd(), '.e2e-tmp', 'e2e-manifest.json');

export function storagePath(memberIndex: number): string {
  return path.join(STORAGE_DIR, `member${memberIndex}.json`);
}

// member index の認証済み context+page を作る。
export async function memberContext(
  browser: Browser,
  memberIndex: number,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: storagePath(memberIndex) });
  const page = await context.newPage();
  return { context, page };
}

// 作成した room を manifest に記録（cleanup 用）。重複は無視。
export function recordRoom(roomId: string): void {
  if (!roomId) return;
  let rooms: string[] = [];
  if (existsSync(MANIFEST)) {
    try {
      rooms = JSON.parse(readFileSync(MANIFEST, 'utf8')).rooms || [];
    } catch {
      rooms = [];
    }
  }
  if (!rooms.includes(roomId)) rooms.push(roomId);
  writeFileSync(MANIFEST, JSON.stringify({ rooms }, null, 2));
}

// /career/gd/room/<uuid> の URL から roomId を取り出す。
export function roomIdFromUrl(url: string): string {
  const m = url.match(/\/career\/gd\/room\/([0-9a-f-]{36})/i);
  return m ? m[1] : '';
}

// 公開ロビーの特定 room カード（data-room-id で一意特定）。
export function lobbyCard(page: Page, roomId: string): Locator {
  return page.locator(`[data-room-id="${roomId}"]`);
}

// マルチGD の作成 API は「作成者が入力したお題」を必須で受け取る（AI生成は使わない）。
// API 直叩きテスト用の最小の有効お題。
export const E2E_GD_THEME = {
  title: 'E2Eお題: これからの働き方',
  description: 'E2E 用のお題です。チームで結論をまとめてください。',
  format: 'free' as const,
};

// 部屋作成ウィザード step2（お題入力）を埋めて確定する。
// オンライン／フレンドマッチは manual theme 一本化のため、AI生成ボタンは存在しない。
export async function confirmGdTheme(page: Page, title: string): Promise<void> {
  const themeSetup = page.getByTestId('gd-theme-setup');
  await expect(themeSetup).toBeVisible();
  // AIお題生成の導線が無いこと（regression guard）。
  await expect(page.getByRole('button', { name: /AI/ })).toHaveCount(0);
  await page.getByTestId('gd-theme-title').fill(title);
  await page
    .getByTestId('gd-theme-description')
    .fill('E2E 用のお題です。チームで結論をまとめてください。');
  await page.getByTestId('gd-theme-confirm').click();
}

// 「GD部屋を作る」ウィザード（/career/gd/rooms/create）から UI 操作で public room を作成し、
// room 詳細 URL の roomId を返す。plannedCount は 4/6/8 のいずれか。
// オンラインマッチはお題を作成者が入力する方式なので、step2 でお題を入力・確定する。
// manifest に記録して cleanup 対象にする。
export async function createPublicRoom(
  page: Page,
  plannedCount: 4 | 6 | 8,
  hostName: string,
): Promise<string> {
  await page.goto('/career/gd/rooms/create');

  // step1: 募集人数・表示名（制限時間は既定のまま）。
  await page.getByRole('button', { name: `${plannedCount}人`, exact: true }).click();
  await page.fill('#gd-public-name', hostName);
  await page.getByRole('button', { name: /次へ（GDのお題を決める）/ }).click();

  // step2: お題は作成者が入力する（AI生成の導線は存在しない）。
  await confirmGdTheme(page, `E2Eお題 ${hostName}`);

  await page.getByRole('button', { name: /このお題でGD部屋を作成/ }).click();
  await page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i);
  const id = roomIdFromUrl(page.url());
  expect(id).not.toBe('');
  recordRoom(id);
  return id;
}
