/*
 * scripts/career-gd-rate-limit-qa.ts
 *
 * 就活版 GD rate limit ユーティリティ（lib/rateLimit）の単体テスト。
 * ネットワーク/サーバ/Supabase を使わず in-memory backend で決定的に検証する。
 *
 * 使い方:  npx tsx scripts/career-gd-rate-limit-qa.ts
 * 終了コード: 全 PASS → 0 / 1 件でも FAIL → 1
 *
 * 確認項目:
 *   1. limit 内は allowed / 超過で blocked（remaining / retryAfter）
 *   2. 別 key は影響を受けない（user 単位分離）
 *   3. namespace 分離（create/join が別枠）
 *   4. 複数 window: 短期 window で blocked / 長期 window で独立に blocked
 *   5. 無効化フラグ（CAREER_GD_RATE_LIMIT_DISABLED）で allow
 *   6. 429 response 仕様（status/headers/body・PII/secret 非混入）
 */

import {
  checkRateLimits,
  rateLimitedResponse,
  type RateLimitRule,
} from '../lib/rateLimit/index';
import { __setRateLimitStoreForTest } from '../lib/rateLimit/store';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

// テスト毎に store をリセット（null → 次回 getRateLimitStore が新しい in-memory を作る）。
function resetStore(): void {
  __setRateLimitStoreForTest(null);
}

async function main(): Promise<void> {
  delete process.env.CAREER_GD_RATE_LIMIT_DISABLED;
  const NOW = 1_000_000_000_000; // 固定 nowMs

  // 1. limit 内 allowed / 超過 blocked
  {
    resetStore();
    const rule: RateLimitRule = { namespace: 'test_create', windows: [{ limit: 3, windowSeconds: 60 }] };
    const r1 = await checkRateLimits({ key: 'userA', rule, nowMs: NOW });
    const r2 = await checkRateLimits({ key: 'userA', rule, nowMs: NOW });
    const r3 = await checkRateLimits({ key: 'userA', rule, nowMs: NOW });
    const r4 = await checkRateLimits({ key: 'userA', rule, nowMs: NOW });
    check('within limit (1..3) allowed', r1.allowed && r2.allowed && r3.allowed, `${r1.allowed}/${r2.allowed}/${r3.allowed}`);
    check('remaining decrements 2,1,0', r1.result.remaining === 2 && r2.result.remaining === 1 && r3.result.remaining === 0, `${r1.result.remaining}/${r2.result.remaining}/${r3.result.remaining}`);
    check('4th over limit blocked', !r4.allowed, `allowed=${r4.allowed}`);
    check('blocked retryAfterSeconds > 0', r4.result.retryAfterSeconds > 0, `retry=${r4.result.retryAfterSeconds}`);
    check('blocked remaining 0', r4.result.remaining === 0, `rem=${r4.result.remaining}`);

    // 2. 別 key は影響なし
    const rb = await checkRateLimits({ key: 'userB', rule, nowMs: NOW });
    check('different key not affected (user isolation)', rb.allowed && rb.result.remaining === 2, `allowed=${rb.allowed} rem=${rb.result.remaining}`);

    // 3. namespace 分離（同じ key・別 namespace は別枠）
    const joinRule: RateLimitRule = { namespace: 'test_join', windows: [{ limit: 3, windowSeconds: 60 }] };
    const rj = await checkRateLimits({ key: 'userA', rule: joinRule, nowMs: NOW });
    check('namespace separation (create vs join)', rj.allowed && rj.result.remaining === 2, `allowed=${rj.allowed} rem=${rj.result.remaining}`);
  }

  // 4a. 短期 window で blocked（短期 limit=2 < 長期 limit=5）
  {
    resetStore();
    const rule: RateLimitRule = { namespace: 'test_short', windows: [{ limit: 2, windowSeconds: 60 }, { limit: 5, windowSeconds: 3600 }] };
    await checkRateLimits({ key: 'u', rule, nowMs: NOW });
    await checkRateLimits({ key: 'u', rule, nowMs: NOW });
    const blocked = await checkRateLimits({ key: 'u', rule, nowMs: NOW });
    check('short window blocks at 3rd', !blocked.allowed && blocked.result.limit === 2, `allowed=${blocked.allowed} limit=${blocked.result.limit}`);
  }

  // 4b. 長期 window で独立に blocked（短期 generous=100・長期 strict=3）
  {
    resetStore();
    const rule: RateLimitRule = { namespace: 'test_long', windows: [{ limit: 100, windowSeconds: 60 }, { limit: 3, windowSeconds: 3600 }] };
    await checkRateLimits({ key: 'u', rule, nowMs: NOW });
    await checkRateLimits({ key: 'u', rule, nowMs: NOW });
    await checkRateLimits({ key: 'u', rule, nowMs: NOW });
    const blocked = await checkRateLimits({ key: 'u', rule, nowMs: NOW });
    check('long window blocks while short ok', !blocked.allowed && blocked.result.limit === 3, `allowed=${blocked.allowed} limit=${blocked.result.limit}`);
  }

  // 4c. window ロール（新しい 60s バケットでリセット）
  {
    resetStore();
    const rule: RateLimitRule = { namespace: 'test_roll', windows: [{ limit: 1, windowSeconds: 60 }] };
    const a = await checkRateLimits({ key: 'u', rule, nowMs: NOW });
    const b = await checkRateLimits({ key: 'u', rule, nowMs: NOW });
    const c = await checkRateLimits({ key: 'u', rule, nowMs: NOW + 61_000 });
    check('same window 2nd blocked, next window allowed', a.allowed && !b.allowed && c.allowed, `${a.allowed}/${b.allowed}/${c.allowed}`);
  }

  // 5. 無効化フラグで allow
  {
    resetStore();
    process.env.CAREER_GD_RATE_LIMIT_DISABLED = '1';
    const rule: RateLimitRule = { namespace: 'test_disabled', windows: [{ limit: 1, windowSeconds: 60 }] };
    let allAllowed = true;
    for (let i = 0; i < 10; i++) {
      const r = await checkRateLimits({ key: 'u', rule, nowMs: NOW });
      allAllowed = allAllowed && r.allowed;
    }
    check('disabled flag allows all (no silent-prod-noop by default; test only)', allAllowed);
    delete process.env.CAREER_GD_RATE_LIMIT_DISABLED;
  }

  // 6. 429 response 仕様
  {
    const res = rateLimitedResponse({ allowed: false, limit: 3, remaining: 0, resetAt: 1234567, retryAfterSeconds: 42 });
    check('429 status', res.status === 429, `status=${res.status}`);
    check('Retry-After header', res.headers.get('Retry-After') === '42');
    check('X-RateLimit-Limit header', res.headers.get('X-RateLimit-Limit') === '3');
    check('X-RateLimit-Remaining header', res.headers.get('X-RateLimit-Remaining') === '0');
    check('X-RateLimit-Reset header', res.headers.get('X-RateLimit-Reset') === '1234567');
    const body = (await res.json()) as Record<string, unknown>;
    check('body error=RATE_LIMITED', body.error === 'RATE_LIMITED', JSON.stringify(body));
    check('body has retryAfterSeconds', body.retryAfterSeconds === 42);
    const blob = JSON.stringify(body);
    check('body has no user_id / email / secret fields', !/user_id|userId|email|token|cookie|password/i.test(blob), blob);
  }

  console.log(`\n==== SUMMARY: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
