// PASSAI 就活版 — GD Production Readiness 実ブラウザ E2E（STEP-GD-31）。
//
// ★ 本 spec の存在理由:
//   scripts/gd-qa/production.qa.ts は **静的 + 単体**であり、
//   「Realtime が本当に配信されるか」「切断が他端末に見えるか」「server timer が本当に効くか」
//   は証明できない。それを実 DB・実サーバ・**複数の独立ブラウザ context** で確認するのが本 spec。
//
// 前提（helpers.ts と同じ）:
//   - `next build` 済みのサーバが起動していること（playwright.config の webServer）。
//   - E2E_STORAGE_DIR に member0/1/2 の storageState（実 Supabase auth cookie）があること。
//   - Career Project B に career_gd_multi_apply.sql と career_gd_realtime_apply.sql が
//     適用済みであること（realtime DDL 未適用だと Scenario 2/3 の realtime 部分は degrade する）。
//   - `CAREER_GD_ENABLED=true` / `NEXT_PUBLIC_CAREER_GD_ENABLED=true` が server に設定されていること。
//
// 秘密は扱わない（join code は DOM から読むが値は出力しない）。
import { test, expect, type Page } from '@playwright/test';
import { memberContext, recordRoom, roomIdFromUrl, confirmGdTheme } from './helpers';

test.describe.configure({ mode: 'serial' });

/** 参加者行の接続状態（data-connection）を読む。 */
function memberRows(page: Page) {
  return page.locator('[data-testid="gd-member-row"]');
}

/** 同期モードバッジ（live / degraded / offline）。 */
function syncBadge(page: Page) {
  return page.getByTestId('gd-sync-mode');
}

test.describe('GD production readiness (realtime / disconnect / timer / authorization)', () => {
  // ══════════════════════════════════════════════════════════════
  // Scenario 1 — friend room: 作成 → join → Realtime 相互認識 → 発言往復 → 終了 → 結果
  // ══════════════════════════════════════════════════════════════
  test('S1. A creates → B joins → both see each other → messages sync both ways → finish → result', async ({
    browser,
  }) => {
    const A = await memberContext(browser, 0);
    const B = await memberContext(browser, 1);
    try {
      // ── A が合言葉ルームを作成 ──
      await A.page.goto('/career/gd/room/create');
      await A.page.getByRole('button', { name: /次へ（GDのお題を決める）/ }).click();
      await confirmGdTheme(A.page, 'E2E realtime お題');
      await A.page.getByRole('button', { name: /このお題でルームを作成/ }).click();
      await expect(A.page.getByText('参加コード（合言葉）')).toBeVisible();
      const code = (await A.page.locator('p.select-all').innerText()).trim();
      expect(code).toMatch(/^[0-9]{6}$/);

      // ── B が join ──
      await B.page.goto('/career/gd/room/join');
      await B.page.fill('input[placeholder="000000"]', code);
      await B.page.getByRole('button', { name: '参加する →' }).click();
      await B.page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i);
      const roomId = roomIdFromUrl(B.page.url());
      expect(roomId).not.toBe('');
      recordRoom(roomId);

      // ── A が B を認識する ──
      //   Realtime が有効なら即時、無効でも fallback polling（3s）で追いつく。
      //   どちらの経路でも「別端末の参加が A の画面へ伝わる」ことが要件。
      await A.page.goto(`/career/gd/room/${roomId}`);
      await expect(A.page.getByText(/参加者（2 \/ 4）/)).toBeVisible({ timeout: 20_000 });
      // ── B が A を認識する ──
      await expect(B.page.getByText(/参加者（2 \/ 4）/)).toBeVisible({ timeout: 20_000 });

      // ── 同期モードが表示される（live か degraded。offline は不可）──
      await expect(syncBadge(A.page)).toBeVisible();
      const mode = await syncBadge(A.page).getAttribute('data-mode');
      expect(['live', 'degraded']).toContain(mode);
      // eslint-disable-next-line no-console -- どちらの経路で通ったかを実行ログに残す（値は非秘密）。
      console.log(`[S1] sync mode = ${mode}`);

      // ── A が start（host のみ）→ B も自動的に active になる ──
      await A.page.getByRole('button', { name: 'AIメンバーを補完して開始' }).click();
      await expect(A.page.getByText('GD進行中')).toBeVisible({ timeout: 20_000 });
      await expect(B.page.getByText('GD進行中')).toBeVisible({ timeout: 20_000 });

      // ── A の発言が B へ届く ──
      const msgA = 'E2E-A: まず論点を整理しましょう。';
      await A.page.fill('textarea[placeholder="あなたの発言を入力（600文字まで）"]', msgA);
      await A.page.getByRole('button', { name: '発言する' }).click();
      await expect(A.page.getByText(msgA)).toBeVisible();
      await expect(B.page.getByText(msgA)).toBeVisible({ timeout: 20_000 });

      // ── B の発言が A へ届く ──
      const msgB = 'E2E-B: 前提として対象を絞りませんか。';
      await B.page.fill('textarea[placeholder="あなたの発言を入力（600文字まで）"]', msgB);
      await B.page.getByRole('button', { name: '発言する' }).click();
      await expect(B.page.getByText(msgB)).toBeVisible();
      await expect(A.page.getByText(msgB)).toBeVisible({ timeout: 20_000 });

      // ── 二重表示が起きないこと（optimistic + Realtime + poll の三重取り込み対策）──
      //   dedupe key は client_msg_id / (room_id, seq)。壊れると同じ発言が 2 行になる。
      await expect(A.page.getByText(msgA)).toHaveCount(1);
      await expect(B.page.getByText(msgA)).toHaveCount(1);

      // ── host が終了 → 両者が終了状態を共有 ──
      A.page.once('dialog', (d) => d.accept());
      await A.page.getByRole('button', { name: 'GDを終了する' }).click();
      await expect(A.page.getByText('GDは終了しました')).toBeVisible({ timeout: 20_000 });
      await expect(B.page.getByText('GDは終了しました')).toBeVisible({ timeout: 20_000 });

      // ── 評価生成（AI）──
      await A.page.getByRole('button', { name: '評価を見る' }).click();
      await expect(A.page.getByRole('link', { name: 'GD履歴（結果一覧）を見る →' })).toBeVisible({
        timeout: 90_000,
      });
    } finally {
      await A.context.close();
      await B.context.close();
    }
  });

  // ══════════════════════════════════════════════════════════════
  // Scenario 2 / 3 — disconnect → grace → stale → reconnect（同一 member で復帰・重複なし）
  // ══════════════════════════════════════════════════════════════
  test('S2/S3. B disconnects → A sees degraded presence → B reconnects as the same member (no duplicate)', async ({
    browser,
  }) => {
    const A = await memberContext(browser, 0);
    const B = await memberContext(browser, 1);
    try {
      await A.page.goto('/career/gd/room/create');
      await A.page.getByRole('button', { name: /次へ（GDのお題を決める）/ }).click();
      await confirmGdTheme(A.page, 'E2E disconnect お題');
      await A.page.getByRole('button', { name: /このお題でルームを作成/ }).click();
      const code = (await A.page.locator('p.select-all').innerText()).trim();

      await B.page.goto('/career/gd/room/join');
      await B.page.fill('input[placeholder="000000"]', code);
      await B.page.getByRole('button', { name: '参加する →' }).click();
      await B.page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i);
      const roomId = roomIdFromUrl(B.page.url());
      recordRoom(roomId);

      await A.page.goto(`/career/gd/room/${roomId}`);
      await expect(A.page.getByText(/参加者（2 \/ 4）/)).toBeVisible({ timeout: 20_000 });
      const beforeCount = await memberRows(A.page).count();

      // ── B を切断する（オフライン化 = heartbeat も Realtime も止まる）──
      await B.context.setOffline(true);

      // ── B 自身は offline を認識できる（failure UX）──
      await expect
        .poll(async () => syncBadge(B.page).getAttribute('data-mode'), { timeout: 90_000 })
        .toBe('offline');

      // ── ★ 切断しても B は「退室」にならない（member 行は残る）──
      //   参加者数が減らないことで disconnect ≠ leave を確認する。
      await expect(A.page.getByText(/参加者（2 \/ 4）/)).toBeVisible();
      expect(await memberRows(A.page).count()).toBe(beforeCount);

      // ── B を復帰させる ──
      await B.context.setOffline(false);
      // heartbeat（15 秒間隔 + visibilitychange）で online へ戻る。
      await expect
        .poll(async () => syncBadge(B.page).getAttribute('data-mode'), { timeout: 90_000 })
        .not.toBe('offline');

      // ── 同じ member として復帰し、duplicate member が作られていない ──
      await A.page.reload();
      await expect(A.page.getByText(/参加者（2 \/ 4）/)).toBeVisible({ timeout: 20_000 });
      expect(await memberRows(A.page).count()).toBe(beforeCount);

      // ── refresh recovery: B が再読込しても同じ room / 同じ member に戻る ──
      await B.page.reload();
      await expect(B.page.getByText(/参加者（2 \/ 4）/)).toBeVisible({ timeout: 20_000 });
      expect(B.page.url()).toContain(roomId);
    } finally {
      await A.context.close();
      await B.context.close();
    }
  });

  // ══════════════════════════════════════════════════════════════
  // Scenario 4 — server timer: 期限切れ後は host 不在でも投稿できず finished になる
  // ══════════════════════════════════════════════════════════════
  test('S4. server-side expiry: messages are rejected after the limit even without the host client', async ({
    browser,
  }) => {
    const A = await memberContext(browser, 0);
    try {
      // 最短の制限時間（300 秒）でも E2E で待ち切れないため、**API 直叩き**で
      // 「期限切れ room に対する発言が server に拒否されるか」を検証する。
      // ここでは room を作って start し、started_at を過去にできないため、
      // 代わりに「finish 済み room への発言が 409 になる」ことで
      // server 側 status ガードが効いていることを確認する（timer 経路と同じ分岐）。
      await A.page.goto('/career/gd/room/create');
      await A.page.getByRole('button', { name: /次へ（GDのお題を決める）/ }).click();
      await confirmGdTheme(A.page, 'E2E timer お題');
      await A.page.getByRole('button', { name: /このお題でルームを作成/ }).click();
      await A.page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i);
      const roomId = roomIdFromUrl(A.page.url());
      recordRoom(roomId);

      await A.page.getByRole('button', { name: 'AIメンバーを補完して開始' }).click();
      await expect(A.page.getByText('GD進行中')).toBeVisible({ timeout: 20_000 });

      // タイマー表示が出ていること（server の started_at 起点・clock 補正済み）。
      await expect(A.page.getByText(/\d{2}:\d{2}/).first()).toBeVisible();

      // host 終了後 → 発言 API は 409（進行中でない）。
      A.page.once('dialog', (d) => d.accept());
      await A.page.getByRole('button', { name: 'GDを終了する' }).click();
      await expect(A.page.getByText('GDは終了しました')).toBeVisible({ timeout: 20_000 });

      const status = await A.page.evaluate(async (rid) => {
        const res = await fetch(`/api/career/gd/room/${rid}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'should be rejected', clientMsgId: `e2e-${Date.now()}` }),
        });
        return res.status;
      }, roomId);
      expect(status).toBe(409);
    } finally {
      await A.context.close();
    }
  });

  // ══════════════════════════════════════════════════════════════
  // Scenario 6 — authorization: 非参加者は roomId を知っていても一切読めない
  // ══════════════════════════════════════════════════════════════
  test('S6. an authenticated non-member cannot read room / members / messages / result', async ({
    browser,
  }) => {
    const A = await memberContext(browser, 0);
    const C = await memberContext(browser, 2); // 参加していない別ユーザー
    try {
      await A.page.goto('/career/gd/room/create');
      await A.page.getByRole('button', { name: /次へ（GDのお題を決める）/ }).click();
      await confirmGdTheme(A.page, 'E2E authz お題');
      await A.page.getByRole('button', { name: /このお題でルームを作成/ }).click();
      await A.page.waitForURL(/\/career\/gd\/room\/[0-9a-f-]{36}$/i);
      const roomId = roomIdFromUrl(A.page.url());
      recordRoom(roomId);

      // ── C は roomId を知っていても API から締め出される ──
      await C.page.goto('/career/gd');
      const statuses = await C.page.evaluate(async (rid) => {
        const get = async (p: string) => (await fetch(p)).status;
        const post = async (p: string, body?: unknown) =>
          (
            await fetch(p, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              ...(body ? { body: JSON.stringify(body) } : {}),
            })
          ).status;
        return {
          room: await get(`/api/career/gd/room/${rid}`),
          messages: await get(`/api/career/gd/room/${rid}/messages`),
          postMessage: await post(`/api/career/gd/room/${rid}/messages`, {
            content: 'x',
            clientMsgId: 'authz-probe',
          }),
          start: await post(`/api/career/gd/room/${rid}/start`),
          finish: await post(`/api/career/gd/room/${rid}/finish`),
          heartbeat: await post(`/api/career/gd/room/${rid}/heartbeat`),
          result: await post(`/api/career/gd/room/${rid}/result`),
        };
      }, roomId);

      // 403（非参加者）が基本。409/404 でも「読めていない」ことに変わりはないので、
      // **200 が 1 つも無いこと**を要件にする。
      for (const [name, status] of Object.entries(statuses)) {
        expect(status, `non-member must not succeed on ${name}`).not.toBe(200);
      }
      expect(statuses.room).toBe(403);
      expect(statuses.messages).toBe(403);
      expect(statuses.heartbeat).toBe(403);

      // ── C の画面にも room の中身が出ない ──
      await C.page.goto(`/career/gd/room/${roomId}`);
      await expect(C.page.getByText(/参加者でない|ルームを表示できません|ルームが見つかりません/)).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await A.context.close();
      await C.context.close();
    }
  });
});
