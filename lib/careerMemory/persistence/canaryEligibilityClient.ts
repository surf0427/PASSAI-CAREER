'use client';

// PASSAI CAREER — Personal Memory canary eligibility client resolver（P16-G）。
//
// 責務: 現在の CAREER member session の access token を取得し、section を eligibility endpoint へ送って
//   eligible boolean を得る。**全失敗（timeout / network / auth / malformed / 5xx）を false へ変換**。
//   never-throw・console 非出力・token/userId を storage へ保存しない。
//
// ★ 境界:
//   - client 申告 userId は送らない（server が token/cookie から user を確定する）。送るのは section のみ。
//     token は Authorization ヘッダにのみ載せ、body / query / storage / log には出さない。
//   - fire-and-forget の write 経路から呼ばれるため、画面保存を妨げない（短い timeout・例外を潰す）。

import { getCareerBrowserSupabaseClient } from '@/lib/careerSupabase/browserClient';
import type { CareerPersonalMemorySectionKey } from './schema';

// 軽量な内部 auth/config 判定用の短い timeout（AI call の 60s とは別。素早い server 判定なので短くする）。
export const CAREER_CANARY_ELIGIBILITY_TIMEOUT_MS = 3_000;
export const CAREER_CANARY_ELIGIBILITY_ENDPOINT = '/api/career/personal-memory/canary-eligibility';

// DI 可能な依存（QA で fake を注入）。
export type EligibilityClientDeps = {
  // 現在 session の access token を返す（無ければ null）。token は保存・log しない。
  getAccessToken: () => Promise<string | null>;
  // fetch 実装（timeout signal を受ける）。
  fetchFn: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs: number;
};

function createTimeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return controller.signal;
}

// 実依存（browser session の access token + global fetch）。
const realDeps: EligibilityClientDeps = {
  getAccessToken: async (): Promise<string | null> => {
    try {
      const client = getCareerBrowserSupabaseClient();
      if (!client) return null;
      const { data } = await client.auth.getSession();
      return data.session?.access_token ?? null;
    } catch {
      return null;
    }
  },
  fetchFn: (input, init) => fetch(input, init),
  timeoutMs: CAREER_CANARY_ELIGIBILITY_TIMEOUT_MS,
};

// section の eligible を解決する（never-throw・全失敗 false）。
export async function resolveCanaryEligibility(
  section: CareerPersonalMemorySectionKey,
  deps: EligibilityClientDeps = realDeps,
): Promise<boolean> {
  try {
    const token = await deps.getAccessToken();
    if (!token) return false; // guest / no-session → deny（endpoint を叩かない）

    let res: Response;
    try {
      res = await deps.fetchFn(CAREER_CANARY_ELIGIBILITY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ section }),
        signal: createTimeoutSignal(deps.timeoutMs),
      });
    } catch {
      return false; // timeout(abort) / network error → deny
    }
    if (!res.ok) return false; // 401 / 403 / 500 等 → deny

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return false; // malformed JSON → deny
    }
    return !!json && typeof json === 'object' && (json as { eligible?: unknown }).eligible === true;
  } catch {
    return false; // 予期せぬ失敗 → deny
  }
}
