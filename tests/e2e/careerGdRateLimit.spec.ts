// PASSAI 就活版 — GD lobby create/join の rate limit UI E2E（STEP-GD-20-K）。
// タグ @ratelimit。rate limit を ENABLED にしたサーバ（CAREER_GD_RATE_LIMIT_DISABLED 未設定）で実行する。
// 回帰 run（bypass サーバ）では --grep-invert @ratelimit で除外すること。
//
// create/join を上限まで消費した状態で UI 操作すると 429 の文言が role="alert" に出て、
// ボタンが永久 disabled にならないこと、満員(ROOM_FULL)と混同しないことを確認する。
import { test, expect } from '@playwright/test';
import { memberContext, lobbyCard, roomIdFromUrl, E2E_GD_THEME, confirmGdTheme } from './helpers';

test.describe.configure({ mode: 'serial' });

const CREATE = '/api/career/gd/lobby/create';
const JOIN = '/api/career/gd/lobby/join';
const RL_MESSAGE = '短時間に操作が集中しています';

test.describe('GD rate limit UI @ratelimit', () => {
  // A. create を上限(3/60s)まで消費 → UI create で 429 → alert 表示・ボタン再有効。
  // fixed-window の境界に依存しないよう「API で 429 を観測するまで消費 → 直後に UI 操作」する。
  test('A. create 429 shows rate-limit alert, button not permanently disabled', async ({ browser }) => {
    const { context, page } = await memberContext(browser, 0);
    try {
      // context.request は同一 context の cookie を共有（= member0 として認証）。API で上限に到達させる。
      let hit429 = false;
      for (let i = 0; i < 8 && !hit429; i++) {
        const r = await context.request.post(CREATE, { data: { format: 'free', plannedParticipantCount: 4, theme: E2E_GD_THEME } });
        if (r.status() === 429) hit429 = true;
        else expect(r.status(), `pre-create ${i}`).toBe(200);
      }
      expect(hit429, 'create rate limit should trigger via API').toBeTruthy();
      // 直後に UI から create → 429（作成ウィザードでお題を入力して作成を押す）。
      await page.goto('/career/gd/rooms/create');
      await page.getByRole('button', { name: '4人', exact: true }).click();
      await page.getByRole('button', { name: /次へ（GDのお題を決める）/ }).click();
      await confirmGdTheme(page, 'E2Eお題（rate limit）');
      const createBtn = page.getByRole('button', { name: /このお題でGD部屋を作成/ });
      await expect(createBtn).toBeVisible();
      await createBtn.click();
      // 429 の文言が role="alert" に出る。
      await expect(page.getByRole('alert').filter({ hasText: RL_MESSAGE })).toBeVisible();
      // 遷移していない（作成画面のまま）。
      expect(page.url()).toContain('/career/gd/rooms/create');
      // ボタンは永久 disabled にならない（再度押せる状態に戻る）。
      await expect(createBtn).toBeEnabled();
    } finally {
      await context.close();
    }
  });

  // B. join を上限(10/60s)まで消費 → UI join で 429 → alert 表示・満員と区別。
  test('B. join 429 shows rate-limit alert, distinct from ROOM_FULL', async ({ browser }) => {
    const creatorJ = await memberContext(browser, 1); // exhaust 用 room
    const creatorK = await memberContext(browser, 3); // UI join 対象 room
    const spammer = await memberContext(browser, 2);
    try {
      // 2 つの 8 人 room を別々の host で作成（満員にならない）。
      const rj = await creatorJ.context.request.post(CREATE, { data: { format: 'free', plannedParticipantCount: 8, theme: E2E_GD_THEME } });
      const roomJ = (await rj.json()).roomId as string;
      const rk = await creatorK.context.request.post(CREATE, { data: { format: 'free', plannedParticipantCount: 8, theme: E2E_GD_THEME } });
      const roomK = (await rk.json()).roomId as string;
      expect(roomJ && roomK).toBeTruthy();

      // spammer(member2) が roomJ へ join を繰り返し、API で 429 を観測するまで上限を使い切る。
      let hit429 = false;
      for (let i = 0; i < 20 && !hit429; i++) {
        const j = await spammer.context.request.post(JOIN, { data: { roomId: roomJ } });
        if (j.status() === 429) hit429 = true;
        else expect(j.status(), `pre-join ${i}`).toBe(200);
      }
      expect(hit429, 'join rate limit should trigger via API').toBeTruthy();

      // 直後に UI から roomK へ join → 429（user 単位なので別 room でも 429）。
      await spammer.page.goto('/career/gd/lobby');
      const card = lobbyCard(spammer.page, roomK);
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute('data-full', 'false'); // 満員ではない
      const joinBtn = card.getByRole('button', { name: '参加する' });
      await expect(joinBtn).toBeVisible();
      await joinBtn.click();
      // rate limit の文言（満員ではない）。
      await expect(spammer.page.getByRole('alert').filter({ hasText: RL_MESSAGE })).toBeVisible();
      await expect(spammer.page.getByText('このルームは満員です。')).toHaveCount(0);
      // 永久 disabled にならない。
      await expect(spammer.page.locator('body')).toContainText(RL_MESSAGE);
      void roomIdFromUrl(spammer.page.url());
    } finally {
      await creatorJ.context.close();
      await creatorK.context.close();
      await spammer.context.close();
    }
  });
});
