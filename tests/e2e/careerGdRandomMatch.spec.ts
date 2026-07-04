// PASSAI 就活版 — GD 完全ランダムマッチ 実ブラウザ E2E（STEP-GD-21 → UX STEP-GD-23）。
//
// UI フロー（説明表示／4/6/8選択／enter→waiting詳細→cancel→再enter／2人成立→room遷移＋
// random_match 由来表示＋host/non-host 説明→host start→AI補完→active／queue 分離／
// random_match room が公開ロビーに出ない）を実ブラウザで検証する。
//
// 前提：career_gd_match_queue_apply.sql（reconciled）適用済み。サーバは
//   CAREER_GD_MATCH_WAIT_OVERRIDE_SEC=0（人間2人で即成立＝テスト決定性）で起動する。
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
  // ── A. 説明・4/6/8選択・waiting詳細・cancel(cancelled)→再enter ──
  test('A. 説明表示・人数選択・waiting詳細・cancel→再enter', async ({ browser }) => {
    const { context, page } = await memberContext(browser, 0);
    try {
      await page.goto('/career/gd/lobby');
      const p = panel(page);
      await expect(p).toBeVisible();
      // 機能説明 + 混同防止の注記が見える。
      await expect(page.getByText(/同じ人数を希望する/)).toBeVisible();
      await expect(page.getByText(/公開ロビー（自分でルームを選ぶ）や合言葉参加とは別の機能/)).toBeVisible();
      // 4/6/8 が選べる。
      for (const c of [4, 6, 8]) await expect(p.getByRole('button', { name: `${c}人`, exact: true })).toBeVisible();

      // 8人で参加 → waiting 詳細。
      await p.getByRole('button', { name: '8人', exact: true }).click();
      await p.getByRole('button', { name: 'ランダムマッチに参加' }).click();
      await expect(p).toHaveAttribute('data-phase', 'waiting');
      await expect(p).toHaveAttribute('data-planned-count', '8');
      await expect(page.getByText(/自動マッチング中（8人）/)).toBeVisible();
      await expect(page.getByText(/同じ条件で待機中/)).toBeVisible();
      await expect(page.getByText(/待機時間/)).toBeVisible();
      // waitingCount は自分を含め 1 以上。
      await expect(p).toHaveAttribute('data-waiting-count', /[1-9]/);

      // cancel → cancelled 状態（選択UIに戻り、再参加できる旨を表示）。
      await page.getByRole('button', { name: 'マッチングをキャンセル' }).click();
      await expect(p).toHaveAttribute('data-phase', 'cancelled');
      await expect(page.getByText(/マッチングをキャンセルしました/)).toBeVisible();

      // 再enter（reload せず cancelled 状態の選択UIから）→ waiting。
      await p.getByRole('button', { name: '8人', exact: true }).click();
      await p.getByRole('button', { name: 'ランダムマッチに参加' }).click();
      await expect(p).toHaveAttribute('data-phase', 'waiting');
      await page.getByRole('button', { name: 'マッチングをキャンセル' }).click();
      await expect(p).toHaveAttribute('data-phase', 'cancelled');
    } finally {
      await context.close();
    }
  });

  // ── B. 2人成立 → room遷移 + random_match 由来表示 + host/non-host → host start → AI補完 → active ──
  test('B. 2 member 成立→room遷移(random_match表示)→host start→AI補完2→active', async ({ browser }) => {
    const a = await memberContext(browser, 0); // 先に enter＝host（最古）
    const b = await memberContext(browser, 1);
    try {
      await enterMatch(a.page, 4);
      await expect(panel(a.page)).toHaveAttribute('data-phase', 'waiting');
      await enterMatch(b.page, 4);
      await b.page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i, { timeout: 20_000 });
      matchedRoomId = roomIdFromUrl(b.page.url());
      recordRoom(matchedRoomId);
      await a.page.waitForURL(`**/career/gd/room/${matchedRoomId}`, { timeout: 20_000 });
      expect(roomIdFromUrl(a.page.url())).toBe(matchedRoomId);

      // random_match 由来の表示（公開ロビー/合言葉との混同防止）。
      await expect(a.page.locator('[data-testid="gd-random-origin"]')).toBeVisible();
      await expect(a.page.getByText('ランダムマッチで成立したルームです')).toBeVisible();
      // 6桁コード共有の案内は出ない（random_match はコード無し）。
      await expect(a.page.getByText(/6桁コードを参加者に共有/)).toHaveCount(0);
      // 参加者 2/4。
      await expect(a.page.getByText(/参加者（2 \/ 4）/)).toBeVisible();

      // host/non-host の説明が分かれる。
      await expect(b.page.getByText('ホストの開始を待っています')).toBeVisible();
      await expect(a.page.getByText('あなたがホストです')).toBeVisible();
      await a.page.getByRole('button', { name: 'AIメンバーを補完して開始' }).click();
      await expect(a.page.getByText('GD進行中')).toBeVisible({ timeout: 20_000 });
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
    const c = await memberContext(browser, 2);
    const d = await memberContext(browser, 3);
    try {
      await enterMatch(c.page, 4);
      await enterMatch(d.page, 6);
      await c.page.waitForTimeout(3_000);
      await expect(panel(c.page)).toHaveAttribute('data-phase', 'waiting');
      await expect(panel(d.page)).toHaveAttribute('data-phase', 'waiting');
      await expect(c.page.getByText(/自動マッチング中（4人）/)).toBeVisible();
      await expect(d.page.getByText(/自動マッチング中（6人）/)).toBeVisible();
      await c.page.getByRole('button', { name: 'マッチングをキャンセル' }).click();
      await d.page.getByRole('button', { name: 'マッチングをキャンセル' }).click();
    } finally {
      await c.context.close();
      await d.context.close();
    }
  });
});
