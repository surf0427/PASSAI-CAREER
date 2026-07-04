// PASSAI 就活版 — GD 完全ランダムマッチ 実ブラウザ E2E（STEP-GD-21）。
//
// UI フロー（enter→waiting→cancel／2人成立→room遷移→host start→AI補完→active／
// queue 分離／random_match room が公開ロビーに出ない）を実ブラウザで検証する。
//
// 前提：career_gd_match_queue_apply.sql（reconciled）適用済み。サーバは
//   CAREER_GD_MATCH_WAIT_OVERRIDE_SEC=0（人間2人で即成立＝テスト決定性）で起動する。
//   4/6/8 満員成立・同時 enter 競合・queue 分離の網羅は RPC/HTTP live QA 側で担保済み。
// 秘密（token/cookie/email/user_id）は扱わない。storageState 経由でログイン。
import { test, expect, type Page } from '@playwright/test';
import { memberContext, roomIdFromUrl, recordRoom } from './helpers';

test.describe.configure({ mode: 'serial' });

const panel = (page: Page) => page.locator('[data-testid="gd-random-match-panel"]');

async function enterMatch(page: Page, count: 4 | 6 | 8): Promise<void> {
  await page.goto('/career/gd/lobby');
  const p = panel(page);
  await expect(p).toBeVisible();
  await p.getByRole('button', { name: `${count}人`, exact: true }).click();
  await p.getByRole('button', { name: 'ランダムマッチに参加' }).click();
}

let matchedRoomId = '';

test.describe('GD random matching E2E @random-match', () => {
  // ── A. enter → waiting → cancel → re-enter（1人は成立しない＝ソロ化防止） ──
  test('A. enter で waiting 表示・waitingCount・cancel・再enter', async ({ browser }) => {
    const { context, page } = await memberContext(browser, 0);
    try {
      await enterMatch(page, 8); // 1人だけなので waiting のまま（min2）
      const p = panel(page);
      await expect(p).toHaveAttribute('data-phase', 'waiting');
      await expect(page.getByText(/マッチング待機中です（8人）/)).toBeVisible();
      await expect(page.getByText(/同じ条件で待機中の参加者/)).toBeVisible();
      await page.getByRole('button', { name: 'マッチングをキャンセル' }).click();
      await expect(p).toHaveAttribute('data-phase', 'idle');
      // 再enter できる
      await p.getByRole('button', { name: '8人', exact: true }).click();
      await p.getByRole('button', { name: 'ランダムマッチに参加' }).click();
      await expect(p).toHaveAttribute('data-phase', 'waiting');
      await page.getByRole('button', { name: 'マッチングをキャンセル' }).click();
      await expect(p).toHaveAttribute('data-phase', 'idle');
    } finally {
      await context.close();
    }
  });

  // ── B. 2人成立 → 同じ room へ遷移 → host start → AI補完 → active ──
  test('B. 2 member 成立→room遷移→host start→AI補完2→active', async ({ browser }) => {
    const a = await memberContext(browser, 0); // 先に enter＝host（最古）
    const b = await memberContext(browser, 1);
    try {
      await enterMatch(a.page, 4);
      await expect(panel(a.page)).toHaveAttribute('data-phase', 'waiting');
      // b が入ると（override=0 で）即成立し、両者 room へ遷移。
      await enterMatch(b.page, 4);
      await b.page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i, { timeout: 20_000 });
      matchedRoomId = roomIdFromUrl(b.page.url());
      recordRoom(matchedRoomId);
      // a も 5 秒 polling で matched → 同じ room へ。
      await a.page.waitForURL(`**/career/gd/room/${matchedRoomId}`, { timeout: 20_000 });
      expect(roomIdFromUrl(a.page.url())).toBe(matchedRoomId);
      // room 詳細：参加者 2/4。
      await expect(a.page.getByText(/参加者（2 \/ 4）/)).toBeVisible();
      // 非host(b)は待機・host(a)は開始 CTA。
      await expect(b.page.getByText('ホストの開始を待っています')).toBeVisible();
      await a.page.getByRole('button', { name: 'AIメンバーを補完して開始' }).click();
      await expect(a.page.getByText('GD進行中')).toBeVisible({ timeout: 20_000 });
      // AI補完: planned4 - humans2 = AI2、総勢4。
      await expect(a.page.locator('[data-testid="gd-member-row"]')).toHaveCount(4);
      await expect(a.page.locator('[data-testid="gd-member-row"][data-ai="true"]')).toHaveCount(2);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  // ── C. random_match room は公開ロビー一覧に出ない ──
  test('C. 成立した random_match room が公開ロビー一覧に現れない', async ({ browser }) => {
    const { context, page } = await memberContext(browser, 4);
    try {
      expect(matchedRoomId).not.toBe('');
      await page.goto('/career/gd/lobby');
      await page.waitForTimeout(1_000);
      await expect(page.locator(`[data-room-id="${matchedRoomId}"]`)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // ── D. queue 分離（4希望と6希望は互いにマッチしない） ──
  test('D. 4希望と6希望は別 queue（相互にマッチしない）', async ({ browser }) => {
    const c = await memberContext(browser, 2); // 4希望・1人
    const d = await memberContext(browser, 3); // 6希望・1人
    try {
      await enterMatch(c.page, 4);
      await enterMatch(d.page, 6);
      // どちらも相手が居ない別 queue のため waiting のまま（cross-match しない）。
      await c.page.waitForTimeout(3_000);
      await expect(panel(c.page)).toHaveAttribute('data-phase', 'waiting');
      await expect(panel(d.page)).toHaveAttribute('data-phase', 'waiting');
      await expect(c.page.getByText(/マッチング待機中です（4人）/)).toBeVisible();
      await expect(d.page.getByText(/マッチング待機中です（6人）/)).toBeVisible();
      await c.page.getByRole('button', { name: 'マッチングをキャンセル' }).click();
      await d.page.getByRole('button', { name: 'マッチングをキャンセル' }).click();
    } finally {
      await c.context.close();
      await d.context.close();
    }
  });
});
