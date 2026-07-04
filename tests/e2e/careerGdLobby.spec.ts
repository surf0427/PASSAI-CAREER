// PASSAI 就活版 — GD 公開ロビー 実ブラウザ E2E（STEP-GD-20-H）。
// 実際のクリック/遷移/polling/満員/開始/発言/終了/評価/履歴までブラウザで検証する。
// 秘密（token/cookie/email）は扱わず、storageState 経由でログイン済み context を使う。
import { test, expect } from '@playwright/test';
import { memberContext, roomIdFromUrl, createPublicRoom, lobbyCard as card } from './helpers';

test.describe.configure({ mode: 'serial' });

// serial 間で共有する状態。
let hostRoomId = '';
let pollRoomId = '';
let fullRoomId = '';

test.describe('GD public lobby browser E2E', () => {
  // ─────────────── A. ページ render ───────────────
  test('A. member session で主要ページが 200 render / error page なし', async ({ browser }) => {
    const { context, page } = await memberContext(browser, 0);
    try {
      const top = await page.goto('/career/gd');
      expect(top?.status()).toBe(200);
      await expect(page.getByText('他の就活生とGD練習する')).toBeVisible();

      const lobby = await page.goto('/career/gd/lobby');
      expect(lobby?.status()).toBe(200);
      await expect(page.getByRole('button', { name: '公開ルームを作成', exact: true })).toBeVisible();

      const view = await page.goto('/career/gd/view');
      expect(view?.status()).toBe(200);
      await expect(page.getByText('ルームGD（マルチ）の履歴')).toBeVisible();

      // error page でないこと。
      const body = await page.locator('body').innerText();
      expect(body).not.toMatch(/Application error|Internal Server Error/);
    } finally {
      await context.close();
    }
  });

  // ─────────────── B. host が公開room作成 → room詳細へ遷移 ───────────────
  test('B. host が UI で公開room作成し room詳細へ遷移', async ({ browser }) => {
    const { context, page } = await memberContext(browser, 0);
    try {
      hostRoomId = await createPublicRoom(page, 4, 'HostMain');
      // 遷移先で room 情報（参加者カード・ホスト）が見える。
      await expect(page.getByText(/参加者（1 \/ 4）/)).toBeVisible();
      await expect(page.getByText('ホスト', { exact: true })).toBeVisible();
      await expect(page.getByText('参加受付中')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('B2. 同一hostの再作成は既存room再利用（同一room詳細へ）', async ({ browser }) => {
    const { context, page } = await memberContext(browser, 0);
    try {
      await page.goto('/career/gd/lobby');
      await page.getByRole('button', { name: '公開ルームを作成', exact: true }).click();
      await page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i);
      expect(roomIdFromUrl(page.url())).toBe(hostRoomId);
    } finally {
      await context.close();
    }
  });

  // ─────────────── C. 別member が一覧で見て参加 ───────────────
  test('C. 別memberが lobby一覧で room を見て参加 → room詳細へ', async ({ browser }) => {
    const { context, page } = await memberContext(browser, 1);
    try {
      await page.goto('/career/gd/lobby');
      const c = card(page, hostRoomId);
      await expect(c).toBeVisible();
      await expect(c).toHaveAttribute('data-mine', 'false');
      await expect(c).toHaveAttribute('data-joined', 'false');
      await c.getByRole('button', { name: '参加する' }).click();
      await page.waitForURL(`**/career/gd/room/${hostRoomId}`);
      await expect(page.getByText(/参加者（2 \/ 4）/)).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('C2. isJoined / isMine のボタン状態が破綻しない', async ({ browser }) => {
    const j = await memberContext(browser, 1);
    const h = await memberContext(browser, 0);
    try {
      await j.page.goto('/career/gd/lobby');
      const jc = card(j.page, hostRoomId);
      await expect(jc).toHaveAttribute('data-joined', 'true');
      await expect(jc.getByRole('link', { name: 'ルームへ戻る →' })).toBeVisible();

      await h.page.goto('/career/gd/lobby');
      const hc = card(h.page, hostRoomId);
      await expect(hc).toHaveAttribute('data-mine', 'true');
      await expect(hc.getByRole('link', { name: '自分のルームへ戻る →' })).toBeVisible();
    } finally {
      await j.context.close();
      await h.context.close();
    }
  });

  // ─────────────── D. polling 反映 ───────────────
  // lobby 一覧は 10 秒 auto-poll（リロード無しで人数更新）。room 詳細の waiting は手動「更新」
  // で反映（auto-poll は active セッションのみ・test G で検証）。
  test('D. lobby 10秒auto-poll で人数更新 / waiting詳細は更新ボタンで反映', async ({ browser }) => {
    const host2 = await memberContext(browser, 2); // PollRoom host
    const observer = await memberContext(browser, 0); // lobby を開いたまま観測
    const joiner = await memberContext(browser, 3); // 後から参加
    try {
      // m2 が PollRoom 作成 → detail(waiting) に留まる。
      pollRoomId = await createPublicRoom(host2.page, 4, 'PollHost');
      await expect(host2.page.getByText(/参加者（1 \/ 4）/)).toBeVisible();

      // m0 が lobby を開いて PollRoom を観測（count=1）。以降リロードしない。
      await observer.page.goto('/career/gd/lobby');
      const oc = card(observer.page, pollRoomId);
      await expect(oc).toHaveAttribute('data-count', '1');

      // m3 が lobby から PollRoom に参加。
      await joiner.page.goto('/career/gd/lobby');
      await card(joiner.page, pollRoomId).getByRole('button', { name: '参加する' }).click();
      await joiner.page.waitForURL(`**/career/gd/room/${pollRoomId}`);

      // lobby auto-poll（10秒）で m0 の card が count=2 に更新される（リロードなし）。
      await expect(oc).toHaveAttribute('data-count', '2', { timeout: 15_000 });

      // waiting 詳細（m2）は「更新」ボタン押下で最新（2/4）を反映する。
      await host2.page.getByRole('button', { name: '更新' }).click();
      await expect(host2.page.getByText(/参加者（2 \/ 4）/)).toBeVisible({ timeout: 10_000 });
    } finally {
      await host2.context.close();
      await observer.context.close();
      await joiner.context.close();
    }
  });

  // ─────────────── E. 満員 disabled（planned=4・最小人数） ───────────────
  // 最小人数が 4 になったため、満員(4/4)を作るには 4 人参加＋観測者 1 人が必要。
  test('E. 満員room(4人) は参加ボタンが disabled で満員表示', async ({ browser }) => {
    const host = await memberContext(browser, 1); // FullRoom host (planned=4) => 1 human
    const j2 = await memberContext(browser, 2);
    const j3 = await memberContext(browser, 3);
    const j4 = await memberContext(browser, 4);
    const late = await memberContext(browser, 5); // 満員後に一覧を見る未参加観測者
    try {
      fullRoomId = await createPublicRoom(host.page, 4, 'FullHost');

      // host 含め 4 人になるよう 3 人参加させて満員(4/4)にする。
      for (const j of [j2, j3, j4]) {
        await j.page.goto('/career/gd/lobby');
        const c = card(j.page, fullRoomId);
        await expect(c).toBeVisible();
        await c.getByRole('button', { name: '参加する' }).click();
        await j.page.waitForURL(`**/career/gd/room/${fullRoomId}`);
      }

      // 満員後、未参加memberの一覧では満員表示＆disabled。
      await late.page.goto('/career/gd/lobby');
      const lc = card(late.page, fullRoomId);
      await expect(lc).toHaveAttribute('data-full', 'true');
      await expect(lc).toHaveAttribute('data-count', '4');
      const fullBtn = lc.getByRole('button', { name: '満員' });
      await expect(fullBtn).toBeVisible();
      await expect(fullBtn).toBeDisabled();
    } finally {
      await host.context.close();
      await j2.context.close();
      await j3.context.close();
      await j4.context.close();
      await late.context.close();
      await late.context.close();
    }
  });

  // ─────────────── F. host start（AI補完・theme） ───────────────
  test('F. 非hostにstartなし / host start で active・theme・AI補完', async ({ browser }) => {
    const nonHost = await memberContext(browser, 1);
    const host = await memberContext(browser, 0);
    try {
      // 非host（m1）: 開始ボタンなし・待機メッセージ。
      await nonHost.page.goto(`/career/gd/room/${hostRoomId}`);
      await expect(nonHost.page.getByText('ホストの開始を待っています')).toBeVisible();
      await expect(nonHost.page.getByRole('button', { name: 'AIメンバーを補完して開始' })).toHaveCount(0);

      // host（m0）: 開始。
      await host.page.goto(`/career/gd/room/${hostRoomId}`);
      await host.page.getByRole('button', { name: 'AIメンバーを補完して開始' }).click();
      await expect(host.page.getByText('GD進行中')).toBeVisible({ timeout: 20_000 });
      // theme 確定（プレースホルダでない）。
      await expect(host.page.getByText('（テーマ準備中）')).toHaveCount(0);
      // AI補完: planned4 - humans2 = AI2、総勢4。
      await expect(host.page.locator('[data-testid="gd-member-row"]')).toHaveCount(4);
      await expect(host.page.locator('[data-testid="gd-member-row"][data-ai="true"]')).toHaveCount(2);
    } finally {
      await nonHost.context.close();
      await host.context.close();
    }
  });

  // ─────────────── G. message / finish / result / history ───────────────
  test('G. 発言→表示、複数人反映、finish、評価生成、履歴表示', async ({ browser }) => {
    const host = await memberContext(browser, 0);
    const other = await memberContext(browser, 1);
    try {
      const m0msg = 'E2E: 結論から言うと論点を三つに整理しましょう。';
      const m1msg = 'E2E: 賛成です。評価軸を先に決めましょう。';

      // m0 発言。
      await host.page.goto(`/career/gd/room/${hostRoomId}`);
      await host.page.fill('textarea[placeholder="あなたの発言を入力（600文字まで）"]', m0msg);
      await host.page.getByRole('button', { name: '発言する' }).click();
      await expect(host.page.getByText(m0msg)).toBeVisible();

      // m1 発言。
      await other.page.goto(`/career/gd/room/${hostRoomId}`);
      await other.page.fill('textarea[placeholder="あなたの発言を入力（600文字まで）"]', m1msg);
      await other.page.getByRole('button', { name: '発言する' }).click();
      await expect(other.page.getByText(m1msg)).toBeVisible();

      // m0 の画面に m1 の発言が polling(3秒)で反映。
      await expect(host.page.getByText(m1msg)).toBeVisible({ timeout: 10_000 });

      // finish（confirm を accept）。
      host.page.once('dialog', (d) => d.accept());
      await host.page.getByRole('button', { name: 'GDを終了する' }).click();
      await expect(host.page.getByText('GDは終了しました')).toBeVisible({ timeout: 15_000 });

      // 評価生成（AI・10〜30秒）。
      await host.page.getByRole('button', { name: '評価を見る' }).click();
      await expect(host.page.getByRole('link', { name: 'GD履歴（結果一覧）を見る →' })).toBeVisible({ timeout: 70_000 });

      // 履歴表示（localStorage canonical・同一 context）。
      await host.page.goto('/career/gd/view');
      await expect(host.page.getByText('ルームGD（マルチ）の履歴')).toBeVisible();
      await expect(host.page.getByText('まだGD履歴がありません。')).toHaveCount(0);
    } finally {
      await host.context.close();
      await other.context.close();
    }
  });
});
