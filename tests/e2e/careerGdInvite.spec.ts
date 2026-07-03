// PASSAI 就活版 — 合言葉(invite) room 回帰 実ブラウザ E2E（STEP-GD-20-H）。
// 既存の合言葉フロー（作成/誤コード拒否/参加/開始/発言/終了/評価）が壊れていないこと、
// および public_lobby ↔ invite の分離が保たれていることをブラウザで確認する。
// 参加コードは DOM から読むが、値は一切ログ出力しない。
import { test, expect } from '@playwright/test';
import { memberContext, recordRoom, roomIdFromUrl } from './helpers';

test.describe.configure({ mode: 'serial' });

let inviteRoomId = '';

test.describe('GD invite (合言葉) room regression', () => {
  test('H. 合言葉 create → 誤コード拒否 → 参加 → 分離 → start/message/finish/result', async ({ browser }) => {
    const host = await memberContext(browser, 0);
    const joiner = await memberContext(browser, 1);
    const looker = await memberContext(browser, 2);
    try {
      // 1) 合言葉 room 作成（デフォルト free / 4人）。
      await host.page.goto('/career/gd/room/create');
      await host.page.getByRole('button', { name: 'ルームを作成 →' }).click();
      await expect(host.page.getByText('参加コード（合言葉）')).toBeVisible();
      // 6桁コードを DOM から取得（値は出力しない）。
      const code = (await host.page.locator('p.select-all').innerText()).trim();
      expect(code).toMatch(/^[0-9]{6}$/);
      const wrongCode = String((Number(code) + 1) % 1_000_000).padStart(6, '0');

      // 2) 誤コードでは参加できない。
      await joiner.page.goto('/career/gd/room/join');
      await joiner.page.fill('input[placeholder="000000"]', wrongCode);
      await joiner.page.getByRole('button', { name: '参加する →' }).click();
      await expect(joiner.page.getByText(/参加できるルームが見つかりません|参加に失敗/)).toBeVisible();
      expect(joiner.page.url()).toContain('/career/gd/room/join');

      // 3) 正しいコードで参加 → room 詳細へ遷移。roomId を取得。
      await joiner.page.fill('input[placeholder="000000"]', code);
      await joiner.page.getByRole('button', { name: '参加する →' }).click();
      await joiner.page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i);
      inviteRoomId = roomIdFromUrl(joiner.page.url());
      expect(inviteRoomId).not.toBe('');
      recordRoom(inviteRoomId);
      await expect(joiner.page.getByText(/参加者（2 \/ 4）/)).toBeVisible();

      // 4) 分離: invite room は public lobby に出ない。
      await looker.page.goto('/career/gd/lobby');
      // lobby が読み込まれるまで待つ（作成フォーム表示で確認）。
      await expect(looker.page.getByRole('button', { name: '公開ルームを作成', exact: true })).toBeVisible();
      await expect(looker.page.locator(`[data-room-id="${inviteRoomId}"]`)).toHaveCount(0);

      // 5) host start（2 humans → AI 補完 → active・theme）。
      await host.page.goto(`/career/gd/room/${inviteRoomId}`);
      await host.page.getByRole('button', { name: 'AIメンバーを補完して開始' }).click();
      await expect(host.page.getByText('GD進行中')).toBeVisible({ timeout: 20_000 });
      await expect(host.page.getByText('（テーマ準備中）')).toHaveCount(0);
      await expect(host.page.locator('[data-testid="gd-member-row"]')).toHaveCount(4);
      await expect(host.page.locator('[data-testid="gd-member-row"][data-ai="true"]')).toHaveCount(2);

      // 6) message。
      const msg = 'E2E合言葉: まず前提を揃えて論点を整理しましょう。';
      await host.page.fill('textarea[placeholder="あなたの発言を入力（600文字まで）"]', msg);
      await host.page.getByRole('button', { name: '発言する' }).click();
      await expect(host.page.getByText(msg)).toBeVisible();

      // 7) finish。
      host.page.once('dialog', (d) => d.accept());
      await host.page.getByRole('button', { name: 'GDを終了する' }).click();
      await expect(host.page.getByText('GDは終了しました')).toBeVisible({ timeout: 15_000 });

      // 8) result 生成。
      await host.page.getByRole('button', { name: '評価を見る' }).click();
      await expect(host.page.getByRole('link', { name: 'GD履歴（結果一覧）を見る →' })).toBeVisible({ timeout: 70_000 });
    } finally {
      await host.context.close();
      await joiner.context.close();
      await looker.context.close();
    }
  });
});
