// PASSAI 就活版 — GD 完全ランダムマッチ 実ブラウザ E2E（STEP-GD-21）。
//
// 検証：ランダムマッチの enter/waiting/cancel（UI）／同人数の複数 member が
// 同じ room に成立して遷移／人数別 queue が混ざらない／random_match room が
// 公開ロビー一覧に出ない、を実ブラウザで確認する。
//
// 前提（重要）：
//   - career_gd_match_queue_apply.sql が対象 project に適用済みであること。
//     未適用だと enter は 503 DB_NOT_APPLIED になり、パネルはエラー表示で待機に入らない
//     （その場合は @random-match の matching 系はスキップ想定）。
//   - AI 補完前提の早期成立を E2E で速くするため、サーバ env
//     CAREER_GD_MATCH_WAIT_OVERRIDE_SEC=1 を設定して起動すること（本番では未設定）。
//   - member storageState（テスト member の auth cookie）は helpers 経由で読む。
//
// 秘密（token/cookie/email/user_id）は扱わない。
import { test, expect, type Page } from '@playwright/test';
import { memberContext, roomIdFromUrl, recordRoom } from './helpers';

test.describe.configure({ mode: 'serial' });

const panel = (page: Page) => page.locator('[data-testid="gd-random-match-panel"]');

// パネルで人数を選んで「ランダムマッチに参加」。waiting か matched(room 遷移) まで待つ。
async function enterMatch(page: Page, count: 4 | 6 | 8): Promise<void> {
  await page.goto('/career/gd/lobby');
  const p = panel(page);
  await expect(p).toBeVisible();
  await p.getByRole('button', { name: `${count}人`, exact: true }).click();
  await p.getByRole('button', { name: 'ランダムマッチに参加' }).click();
}

test.describe('GD random matching E2E @random-match', () => {
  // ─────────────── A. enter → waiting → cancel（UI 単体） ───────────────
  test('A. enter で waiting 表示・waitingCount・cancel できる', async ({ browser }) => {
    const { context, page } = await memberContext(browser, 0);
    try {
      await enterMatch(page, 8); // 8 は 1 人では成立しない（min2＋待機）ので waiting に入る
      const p = panel(page);
      // waiting に入る（DB 未適用なら matched にならず、代わりに 503 エラー表示 → その場合 skip）。
      const phase = await p.getAttribute('data-phase');
      test.skip(phase !== 'waiting', 'random-match DB (career_gd_match_queue) 未適用のため matching をスキップ');
      await expect(p).toHaveAttribute('data-phase', 'waiting');
      await expect(page.getByText(/マッチング待機中です（8人）/)).toBeVisible();
      await expect(page.getByText(/同じ条件で待機中の参加者/)).toBeVisible();
      // cancel → idle。
      await page.getByRole('button', { name: 'マッチングをキャンセル' }).click();
      await expect(p).toHaveAttribute('data-phase', 'idle');
      await expect(page.getByRole('button', { name: 'ランダムマッチに参加' })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  // ─────────────── B. 2 人で成立（AI 補完前提・wait override 前提） ───────────────
  test('B. 同人数の 2 member が同じ room に成立して遷移', async ({ browser }) => {
    const a = await memberContext(browser, 0);
    const b = await memberContext(browser, 1);
    try {
      await enterMatch(a.page, 4);
      const pa = panel(a.page);
      const phase = await pa.getAttribute('data-phase');
      test.skip(phase !== 'waiting', 'random-match DB 未適用のためスキップ');

      // 2 人目が入ると（wait override 前提で）成立し、双方 room へ遷移する。
      await enterMatch(b.page, 4);
      await b.page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i, { timeout: 20_000 });
      const roomB = roomIdFromUrl(b.page.url());
      recordRoom(roomB);
      // A は 5 秒 polling で matched → 同じ room へ遷移。
      await a.page.waitForURL(`**/career/gd/room/${roomB}`, { timeout: 20_000 });
      expect(roomIdFromUrl(a.page.url())).toBe(roomB);
      // room 詳細：参加者 2/4（不足分は host start で AI 補完）。
      await expect(a.page.getByText(/参加者（2 \/ 4）/)).toBeVisible();
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  // ─────────────── C. 4 人満員成立（1 room・members 4） ───────────────
  test('C. 4 人が enter → 1 room に成立・全員同じ room', async ({ browser }) => {
    const ctxs = await Promise.all([0, 1, 2, 3].map((i) => memberContext(browser, i)));
    try {
      // 既定 wait でも 4 人揃えば満員成立する。
      for (const c of ctxs) await enterMatch(c.page, 4);
      const phase = await panel(ctxs[0].page).getAttribute('data-phase');
      const url0 = ctxs[0].page.url();
      test.skip(phase !== 'waiting' && !/\/room\//.test(url0), 'random-match DB 未適用のためスキップ');

      const rooms: string[] = [];
      for (const c of ctxs) {
        await c.page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i, { timeout: 25_000 });
        rooms.push(roomIdFromUrl(c.page.url()));
      }
      recordRoom(rooms[0]);
      // 全員同じ room。
      expect(new Set(rooms).size).toBe(1);
      await expect(ctxs[0].page.getByText(/参加者（4 \/ 4）/)).toBeVisible();
    } finally {
      for (const c of ctxs) await c.context.close();
    }
  });

  // ─────────────── D. queue 分離（4 と 6 は混ざらない） ───────────────
  test('D. 4 希望と 6 希望は別 room に成立', async ({ browser }) => {
    const four = await Promise.all([0, 1].map((i) => memberContext(browser, i)));
    const six = await Promise.all([2, 3].map((i) => memberContext(browser, i)));
    try {
      for (const c of four) await enterMatch(c.page, 4);
      const phase = await panel(four[0].page).getAttribute('data-phase');
      test.skip(phase !== 'waiting' && !/\/room\//.test(four[0].page.url()), 'random-match DB 未適用のためスキップ');
      for (const c of six) await enterMatch(c.page, 6);

      for (const c of [...four, ...six]) {
        await c.page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i, { timeout: 25_000 });
      }
      const roomFour = roomIdFromUrl(four[0].page.url());
      const roomSix = roomIdFromUrl(six[0].page.url());
      recordRoom(roomFour);
      recordRoom(roomSix);
      expect(roomIdFromUrl(four[1].page.url())).toBe(roomFour);
      expect(roomIdFromUrl(six[1].page.url())).toBe(roomSix);
      expect(roomFour).not.toBe(roomSix);
      await expect(four[0].page.getByText(/参加者（2 \/ 4）/)).toBeVisible();
      await expect(six[0].page.getByText(/参加者（2 \/ 6）/)).toBeVisible();
    } finally {
      for (const c of [...four, ...six]) await c.context.close();
    }
  });

  // ─────────────── E. random_match room は公開ロビー一覧に出ない ───────────────
  test('E. 成立した random_match room が公開ロビー一覧に現れない', async ({ browser }) => {
    const a = await memberContext(browser, 0);
    const b = await memberContext(browser, 1);
    const observer = await memberContext(browser, 4);
    try {
      await enterMatch(a.page, 4);
      const phase = await panel(a.page).getAttribute('data-phase');
      test.skip(phase !== 'waiting', 'random-match DB 未適用のためスキップ');
      await enterMatch(b.page, 4);
      await b.page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i, { timeout: 20_000 });
      const roomId = roomIdFromUrl(b.page.url());
      recordRoom(roomId);

      // 別 member が公開ロビー一覧を見ても、この random room のカードは出ない。
      await observer.page.goto('/career/gd/lobby');
      await observer.page.waitForTimeout(1_000);
      await expect(observer.page.locator(`[data-room-id="${roomId}"]`)).toHaveCount(0);
    } finally {
      await a.context.close();
      await b.context.close();
      await observer.context.close();
    }
  });
});
