// PASSAI 就活版 — GD 結果履歴の DB hydrate 実ブラウザ E2E（STEP-GD-20-L・タグ @hydrate）。
// seed-hydrate.mjs で seed 済みの DB に対し、localStorage 無し/別デバイス状態で自分の履歴だけ復元でき、
// 他人の履歴が見えず、重複せず、DB 失敗時も端末内履歴が壊れないことを確認する。
//
// 前提: DB は seed のみ（他の result 生成 spec と混ざらないよう --grep @hydrate で単独実行）。
// HYDRATE_MANIFEST（seed の roomId）を env で受け取る。
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { memberContext } from './helpers';

test.describe.configure({ mode: 'serial' });

const VIEW = '/career/gd/view';
const RESULTS_API = '**/api/career/gd/room/results';

function manifest(): Record<string, string> {
  const p = process.env.HYDRATE_MANIFEST;
  if (!p) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

// localStorage 用の最小 CareerGdRoomLog。
function localLog(roomId: string, title: string) {
  return {
    id: roomId,
    roomId,
    participantId: 'local-p',
    createdAt: '2026-01-01T00:00:00.000Z',
    theme: { title, description: '', format: 'free' },
    format: 'free',
    participantCount: 2,
    humanCount: 1,
    durationSec: 900,
    evaluation: {
      version: 2, scored: true,
      axisScores: { logicalThinking: 60, collaboration: 60, initiative: 60, creativity: 60, persuasiveness: 60, discussionSkill: 60 },
      overallScore: 60, rank: 'B', companyCommunicationGrade: 'B',
      strengths: [], weaknesses: [], improvements: [], goodQuotes: [],
      overallComment: '', speechCount: 1, totalSpeechCount: 2,
    },
    ranking: [],
    matchingHints: { hints: [], summary: '' },
    consultationSummary: '',
  };
}

test.describe('GD result hydrate @hydrate', () => {
  // A. localStorage 無し + DB あり → 自分の履歴が復元され、他人の履歴は見えない。
  test('A. hydrate populates from DB, others not visible (member A)', async ({ browser }) => {
    const { context, page } = await memberContext(browser, 0);
    try {
      await page.goto(VIEW);
      // 自分が参加した room の履歴が DB から復元される。
      await expect(page.getByText('HydrateSolo議題')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Hydrate共有議題')).toBeVisible();
      // 別デバイス保存分バッジ。
      await expect(page.getByTestId('gd-history-synced')).toBeVisible();
      // 参加していない他人の room は出ない。
      await expect(page.getByText('HydrateB議題')).toHaveCount(0);
      await expect(page.getByText('HydrateC議題')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // B. 別 member B は自分の履歴のみ（A 専用・C 専用は見えない）。
  test('B. member B sees only own history', async ({ browser }) => {
    const { context, page } = await memberContext(browser, 1);
    try {
      await page.goto(VIEW);
      await expect(page.getByText('HydrateB議題')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Hydrate共有議題')).toBeVisible();
      await expect(page.getByText('HydrateSolo議題')).toHaveCount(0);
      await expect(page.getByText('HydrateC議題')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // C. localStorage に同じ room がある状態で hydrate → 重複表示しない。
  test('C. merge dedupes same room (no double)', async ({ browser }) => {
    const roomA = manifest().roomA;
    expect(roomA, 'HYDRATE_MANIFEST.roomA required').toBeTruthy();
    const { context, page } = await memberContext(browser, 0);
    try {
      // ページ読込前に localStorage へ roomA（同一 roomId）の log を仕込む。
      await context.addInitScript(
        ([rid]) => {
          const log = {
            id: rid, roomId: rid, participantId: 'local-p', createdAt: '2026-01-01T00:00:00.000Z',
            theme: { title: 'HydrateSolo議題', description: '', format: 'free' }, format: 'free',
            participantCount: 2, humanCount: 1, durationSec: 900,
            evaluation: { version: 2, scored: true, axisScores: { logicalThinking: 60, collaboration: 60, initiative: 60, creativity: 60, persuasiveness: 60, discussionSkill: 60 }, overallScore: 60, rank: 'B', companyCommunicationGrade: 'B', strengths: [], weaknesses: [], improvements: [], goodQuotes: [], overallComment: '', speechCount: 1, totalSpeechCount: 2 },
            ranking: [], matchingHints: { hints: [], summary: '' }, consultationSummary: '',
          };
          window.localStorage.setItem('careerGdRoomLogs', JSON.stringify([log]));
        },
        [roomA],
      );
      await page.goto(VIEW);
      await expect(page.getByText('Hydrate共有議題')).toBeVisible({ timeout: 15_000 }); // hydrate 完了の目印
      // 同一 roomId は 1 枚だけ（重複なし）。
      await expect(page.getByText('HydrateSolo議題')).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  // D. DB 取得失敗（500）でも端末内（localStorage）履歴は壊れず表示され、控えめな警告が出る。
  test('D. DB failure falls back to localStorage', async ({ browser }) => {
    const { context, page } = await memberContext(browser, 0);
    try {
      await context.addInitScript(
        ([log]) => window.localStorage.setItem('careerGdRoomLogs', JSON.stringify([log])),
        [localLog('local-only-room-0000', 'LocalOnly議題')],
      );
      // results API を 500 に固定（DB 取得失敗をシミュレート）。
      await page.route(RESULTS_API, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
      await page.goto(VIEW);
      // 端末内履歴は表示される。
      await expect(page.getByText('LocalOnly議題')).toBeVisible({ timeout: 15_000 });
      // 控えめな失敗警告。
      await expect(page.getByText(/オンライン履歴の取得に失敗/)).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
