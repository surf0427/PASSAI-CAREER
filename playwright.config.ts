import { defineConfig } from '@playwright/test';

// PASSAI 就活版 — GD 公開ロビー 実ブラウザ E2E（STEP-GD-20-H）。
//
// - システム Chrome を channel:'chrome' で駆動（Playwright browser バイナリの
//   ダウンロードが環境で不可のため）。
// - テスト member の storageState（Supabase auth cookie）は E2E_STORAGE_DIR から読む。
//   秘密は tracked files に置かない（scratchpad のみ）。
// - サーバは別途 `next start -p 3111` を起動して reuse する（build 済み前提）。
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3111';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    headless: true,
    channel: 'chrome',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: 'npx next start -p 3111',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
