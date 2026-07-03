// PASSAI 就活版 — GD host start 促し UI の実ブラウザ E2E（STEP-GD-20-J）。
// waiting room で host には開始 CTA＋人数状況、非host には開始待ち＋AI補完説明を出し、
// 満員時は「全員そろいました」表示に切り替わることを検証する。
//
// 各テストは最後に room を start（→active）して member0 の waiting 公開 room を残さないため、
// 後続 spec（careerGdLobby 等）の公開 room 作成と競合しない。
import { test, expect } from '@playwright/test';
import { memberContext, createPublicRoom, lobbyCard } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('GD host start prompt (waiting UI)', () => {
  // A. host waiting UI（4人・2〜3人相当）: あなたがホスト / 人数 / AI補完予定 / start CTA。
  test('A. host waiting UI: prompt + count + AI-fill + start CTA works', async ({ browser }) => {
    const host = await memberContext(browser, 0);
    try {
      const roomId = await createPublicRoom(host.page, 4, 'PromptHostA');
      // 人数状況（1 / 4・AI補完予定3）。
      const status = host.page.locator('[data-testid="gd-waiting-status"]');
      await expect(status).toHaveAttribute('data-human', '1');
      await expect(status).toHaveAttribute('data-planned', '4');
      await expect(status).toHaveAttribute('data-ai-fill', '3');
      await expect(status).toContainText('参加状況: 1 / 4 人');
      await expect(status).toContainText('AIメンバー補完予定: 3 人');
      // host 促し文言。
      await expect(host.page.getByText('あなたがホストです')).toBeVisible();
      // start CTA（不足あり → 補完ラベル）を押せる → active。
      const cta = host.page.getByRole('button', { name: 'AIメンバーを補完して開始' });
      await expect(cta).toBeVisible();
      await expect(cta).toBeEnabled();
      await cta.click();
      await expect(host.page.getByText('GD進行中')).toBeVisible({ timeout: 20_000 });
      void roomId;
    } finally {
      await host.context.close();
    }
  });

  // B. 非host waiting UI: ホスト開始待ち / start CTA なし / 人数 / AI補完で開始可能な説明。
  test('B. non-host waiting UI: waiting message, no start CTA, count shown', async ({ browser }) => {
    const host = await memberContext(browser, 0);
    const guest = await memberContext(browser, 1);
    try {
      const roomId = await createPublicRoom(host.page, 4, 'PromptHostB');
      // guest 参加。
      await guest.page.goto('/career/gd/lobby');
      await lobbyCard(guest.page, roomId).getByRole('button', { name: '参加する' }).click();
      await guest.page.waitForURL(`**/career/gd/room/${roomId}`);

      // 非host 視点。
      await expect(guest.page.getByText('ホストの開始を待っています')).toBeVisible();
      await expect(guest.page.getByText(/AIメンバーが自動で参加します/)).toBeVisible();
      const gStatus = guest.page.locator('[data-testid="gd-waiting-status"]');
      await expect(gStatus).toHaveAttribute('data-human', '2');
      await expect(gStatus).toContainText('参加状況: 2 / 4 人');
      // 非host には start CTA が出ない。
      await expect(guest.page.getByRole('button', { name: 'AIメンバーを補完して開始' })).toHaveCount(0);
      await expect(guest.page.getByRole('button', { name: 'GDを開始する' })).toHaveCount(0);

      // 後片付け: host が開始して waiting を解消。
      await host.page.goto(`/career/gd/room/${roomId}`);
      await host.page.getByRole('button', { name: 'AIメンバーを補完して開始' }).click();
      await expect(host.page.getByText('GD進行中')).toBeVisible({ timeout: 20_000 });
    } finally {
      await host.context.close();
      await guest.context.close();
    }
  });

  // C. 満員時 host UI（planned=4・4人）: 全員そろいました / AI補完予定0 / 「GDを開始する」。
  test('C. full host UI: all-present message, 0 AI-fill, GDを開始する CTA', async ({ browser }) => {
    const host = await memberContext(browser, 0);
    const j1 = await memberContext(browser, 1);
    const j2 = await memberContext(browser, 2);
    const j3 = await memberContext(browser, 3);
    try {
      const roomId = await createPublicRoom(host.page, 4, 'PromptHostC');
      for (const j of [j1, j2, j3]) {
        await j.page.goto('/career/gd/lobby');
        await lobbyCard(j.page, roomId).getByRole('button', { name: '参加する' }).click();
        await j.page.waitForURL(`**/career/gd/room/${roomId}`);
      }
      // host 再読込 → 満員 UI。
      await host.page.goto(`/career/gd/room/${roomId}`);
      const status = host.page.locator('[data-testid="gd-waiting-status"]');
      await expect(status).toHaveAttribute('data-human', '4');
      await expect(status).toHaveAttribute('data-ai-fill', '0');
      await expect(status).toContainText('全員そろっています');
      await expect(host.page.getByText('参加者が全員そろいました')).toBeVisible();
      // 満員では「AIメンバー補完予定」を出さない。
      await expect(host.page.getByText(/AIメンバー補完予定/)).toHaveCount(0);
      // full 用 CTA。
      const cta = host.page.getByRole('button', { name: 'GDを開始する' });
      await expect(cta).toBeVisible();
      await expect(cta).toBeEnabled();
      await cta.click();
      await expect(host.page.getByText('GD進行中')).toBeVisible({ timeout: 20_000 });
    } finally {
      await host.context.close();
      await j1.context.close();
      await j2.context.close();
      await j3.context.close();
    }
  });

  // D. 6人/8人での AI 補完予定表示（2人参加時）。
  test('D. AI-fill count for 6-person (4) and 8-person (6) rooms', async ({ browser }) => {
    for (const [planned, expectFill] of [[6, 4], [8, 6]] as const) {
      const host = await memberContext(browser, 0);
      const guest = await memberContext(browser, 1);
      try {
        const roomId = await createPublicRoom(host.page, planned, `PromptHost${planned}`);
        await guest.page.goto('/career/gd/lobby');
        await lobbyCard(guest.page, roomId).getByRole('button', { name: '参加する' }).click();
        await guest.page.waitForURL(`**/career/gd/room/${roomId}`);

        await host.page.goto(`/career/gd/room/${roomId}`);
        const status = host.page.locator('[data-testid="gd-waiting-status"]');
        await expect(status).toHaveAttribute('data-human', '2');
        await expect(status).toHaveAttribute('data-planned', String(planned));
        await expect(status).toHaveAttribute('data-ai-fill', String(expectFill));
        await expect(status).toContainText(`AIメンバー補完予定: ${expectFill} 人`);

        // 後片付け: 開始して waiting を解消。
        await host.page.getByRole('button', { name: 'AIメンバーを補完して開始' }).click();
        await expect(host.page.getByText('GD進行中')).toBeVisible({ timeout: 20_000 });
      } finally {
        await host.context.close();
        await guest.context.close();
      }
    }
  });
});
