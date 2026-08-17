// PASSAI 就活版 — GD 参加人数 API バリデーション E2E（STEP-GD-20-I）。
// UI 改ざん相当（API 直叩き）でも 4/6/8 以外を 400 で拒否すること、
// 未指定は既定 4（後方互換）で受理することを、認証済み member の context.request で検証する。
import { test, expect } from '@playwright/test';
import { memberContext, E2E_GD_THEME } from './helpers';

test.describe.configure({ mode: 'serial' });

const LOBBY_CREATE = '/api/career/gd/lobby/create';
const ROOM_CREATE = '/api/career/gd/room/create';

test.describe('GD participant-count API validation', () => {
  // 4/6/8 は受理（200・ok）。同一 host の再作成は reused でも受理扱い。
  test('valid 4/6/8 -> 200 accepted', async ({ browser }) => {
    const { context } = await memberContext(browser, 0);
    try {
      for (const n of [4, 6, 8]) {
        const res = await context.request.post(LOBBY_CREATE, {
          data: { format: 'free', plannedParticipantCount: n, timeLimitSec: 900, theme: E2E_GD_THEME },
        });
        expect(res.status(), `planned=${n}`).toBe(200);
        const body = await res.json();
        expect(body.ok, `planned=${n} ok`).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  // 4/6/8 以外は 400 INVALID_COUNT（silently fallback しない）。
  test('invalid 3/5/7/9/10/string -> 400 INVALID_COUNT', async ({ browser }) => {
    const { context } = await memberContext(browser, 1);
    try {
      const invalids: unknown[] = [3, 5, 7, 9, 10, 'six'];
      for (const v of invalids) {
        const res = await context.request.post(LOBBY_CREATE, {
          data: { format: 'free', plannedParticipantCount: v, timeLimitSec: 900, theme: E2E_GD_THEME },
        });
        expect(res.status(), `planned=${JSON.stringify(v)}`).toBe(400);
        const body = await res.json();
        expect(body.error, `planned=${JSON.stringify(v)} error`).toBe('INVALID_COUNT');
      }
    } finally {
      await context.close();
    }
  });

  // 未指定 / null は既定 4 で受理（後方互換・silently fallback とは別扱い）。
  test('omitted / null -> 200 (default 4)', async ({ browser }) => {
    const { context } = await memberContext(browser, 2);
    try {
      const omitted = await context.request.post(LOBBY_CREATE, {
        data: { format: 'free', timeLimitSec: 900, theme: E2E_GD_THEME },
      });
      expect(omitted.status()).toBe(200);
      expect((await omitted.json()).ok).toBe(true);

      const nullish = await context.request.post(LOBBY_CREATE, {
        data: { format: 'free', plannedParticipantCount: null, timeLimitSec: 900, theme: E2E_GD_THEME },
      });
      expect(nullish.status()).toBe(200);
      expect((await nullish.json()).ok).toBe(true);
    } finally {
      await context.close();
    }
  });

  // 合言葉 room 作成 API も同じ検証（4 受理・5 拒否）。
  test('legacy 合言葉 create shares the 4/6/8 rule', async ({ browser }) => {
    const { context } = await memberContext(browser, 3);
    try {
      const ok = await context.request.post(ROOM_CREATE, {
        data: { format: 'free', plannedParticipantCount: 8, timeLimitSec: 900, displayName: 'ApiCode', theme: E2E_GD_THEME },
      });
      expect(ok.status()).toBe(200);
      expect(typeof (await ok.json()).roomId).toBe('string');

      const bad = await context.request.post(ROOM_CREATE, {
        data: { format: 'free', plannedParticipantCount: 5, timeLimitSec: 900, displayName: 'ApiCode', theme: E2E_GD_THEME },
      });
      expect(bad.status()).toBe(400);
      expect((await bad.json()).error).toBe('INVALID_COUNT');
    } finally {
      await context.close();
    }
  });
});
