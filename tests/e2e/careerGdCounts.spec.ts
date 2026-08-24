// PASSAI 就活版 — GD 6人 / 8人 room の実ブラウザ E2E（STEP-GD-20-I）。
// 4/6/8 の 3 択のうち 6・8 を新規検証。2 人参加状態で host start → AI 補完で planned まで満たし、
// roster / result / ranking が 8 人でも破綻しないことを確認する。
//
// 実行順（アルファベット順）は careerGdCounts が最初。各 room を finish まで進めて
// host（member0）の waiting 公開 room を残さないため、後続 spec の公開 room 作成と競合しない。
import { test, expect, type Browser } from '@playwright/test';
import {
  memberContext,
  createPublicRoom,
  lobbyCard,
  speakAs,
  expectVoiceOnlyComposer,
} from './helpers';

test.describe.configure({ mode: 'serial' });

// planned 人数の room を作り、2 人参加 → host start（AI 補完）→ 発言 → finish → 評価まで通す。
async function runCountRoom(
  browser: Browser,
  planned: 6 | 8,
  hostName: string,
  expectedAi: number,
): Promise<void> {
  const host = await memberContext(browser, 0);
  const joiner = await memberContext(browser, 1);
  try {
    const roomId = await createPublicRoom(host.page, planned, hostName);
    await expect(host.page.getByText(`参加者（1 / ${planned}）`)).toBeVisible();

    // 別memberの一覧で上限 /planned が表示され、参加できる。
    await joiner.page.goto('/career/gd/lobby');
    const jc = lobbyCard(joiner.page, roomId);
    await expect(jc).toBeVisible();
    await expect(jc).toContainText(`/ ${planned}`); // 参加人数上限の表示
    await jc.getByRole('button', { name: '参加する' }).click();
    await joiner.page.waitForURL(`**/career/gd/room/${roomId}`);
    await expect(joiner.page.getByText(`参加者（2 / ${planned}）`)).toBeVisible();

    // host start → AI 補完で planned 人（人間2 + AI expectedAi）になる。
    await host.page.goto(`/career/gd/room/${roomId}`);
    await host.page.getByRole('button', { name: 'AIメンバーを補完して開始' }).click();
    await expect(host.page.getByText('GD進行中')).toBeVisible({ timeout: 20_000 });
    await expect(host.page.getByText('（テーマ準備中）')).toHaveCount(0);
    await expect(host.page.locator('[data-testid="gd-member-row"]')).toHaveCount(planned);
    await expect(host.page.locator('[data-testid="gd-member-row"][data-ai="true"]')).toHaveCount(expectedAi);
    await expect(host.page.getByText(`参加者（2 / ${planned}）`)).toBeVisible();

    // 発言 → finish → 評価（result/ranking が planned 人でも破綻しない）。
    const msg = `E2E ${planned}人: 論点を三つに整理して進めましょう。`;
    await expectVoiceOnlyComposer(host.page);
    await speakAs(host.page, roomId, msg);
    await expect(host.page.getByText(msg)).toBeVisible({ timeout: 20_000 });

    host.page.once('dialog', (d) => d.accept());
    await host.page.getByRole('button', { name: 'GDを終了する' }).click();
    await expect(host.page.getByText('GDは終了しました')).toBeVisible({ timeout: 15_000 });

    await host.page.getByRole('button', { name: '評価を見る' }).click();
    await expect(host.page.getByRole('link', { name: 'GD履歴（結果一覧）を見る →' })).toBeVisible({ timeout: 70_000 });
  } finally {
    await host.context.close();
    await joiner.context.close();
  }
}

test.describe('GD 6/8-person rooms browser E2E', () => {
  test('B(6人). 6人room: create → lobby上限/6 → 2人start → AI補完4→計6 → result', async ({ browser }) => {
    await runCountRoom(browser, 6, 'SixHost', 4);
  });

  test('C(8人). 8人room: create → lobby上限/8 → 2人start → AI補完6→計8 → result', async ({ browser }) => {
    await runCountRoom(browser, 8, 'EightHost', 6);
  });
});
