// PASSAI — rate limit のカウンタ store（STEP-GD-20-K）。
//
// 方針:
//   - production/preview: Upstash Redis REST（env 設定時）で複数インスタンス間で共有。
//   - development/test: in-memory fallback（プロセス内 Map・TTL 付き）。
//   - **本番で silent no-op にしない**: Upstash 未設定の production では in-memory に落ちるが、
//     その旨を一度だけ警告する（保守的 fallback。実効上限は「インスタンス数 × limit」になる）。
//   - store には生の user_id / IP を入れない（呼び出し側で hash 済みキーを渡す）。接続文字列/token はログに出さない。
//
// server-only（route handler からのみ使用）。

import 'server-only';

export interface RateLimitStore {
  // storeKey のカウンタを +1 し、新規作成時に TTL（秒）を設定して新しい count を返す。
  incr(storeKey: string, ttlSeconds: number, nowMs: number): Promise<number>;
  // テスト用: 全消去（in-memory のみ実効。Upstash は no-op＝本番 store をテストで消さない）。
  resetAll(): Promise<void>;
  readonly backend: 'memory' | 'upstash';
}

// ── in-memory（fallback / test） ─────────────────────────────
class InMemoryRateLimitStore implements RateLimitStore {
  readonly backend = 'memory' as const;
  private map = new Map<string, { count: number; expiresAt: number }>();

  async incr(storeKey: string, ttlSeconds: number, nowMs: number): Promise<number> {
    const e = this.map.get(storeKey);
    if (!e || e.expiresAt <= nowMs) {
      this.map.set(storeKey, { count: 1, expiresAt: nowMs + ttlSeconds * 1000 });
      this.prune(nowMs);
      return 1;
    }
    e.count += 1;
    return e.count;
  }

  private prune(nowMs: number): void {
    if (this.map.size <= 1000) return;
    for (const [k, v] of this.map) if (v.expiresAt <= nowMs) this.map.delete(k);
  }

  async resetAll(): Promise<void> {
    this.map.clear();
  }
}

// ── Upstash Redis REST（production/preview・依存追加なし・fetch のみ） ──
class UpstashRestRateLimitStore implements RateLimitStore {
  readonly backend = 'upstash' as const;
  constructor(private readonly url: string, private readonly token: string) {}

  async incr(storeKey: string, ttlSeconds: number): Promise<number> {
    // INCR → 初回のみ EXPIRE（NX）でウインドウ TTL を設定。pipeline で 1 往復。
    const res = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify([
        ['INCR', storeKey],
        ['EXPIRE', storeKey, String(ttlSeconds), 'NX'],
      ]),
    });
    if (!res.ok) throw new Error(`upstash rest status ${res.status}`);
    const data = (await res.json()) as Array<{ result?: unknown }>;
    const count = Number(data?.[0]?.result);
    if (!Number.isFinite(count)) throw new Error('upstash rest: unexpected result');
    return count;
  }

  async resetAll(): Promise<void> {
    // 本番 store はテストで消さない。テストは in-memory backend を使う。
  }
}

let cached: RateLimitStore | null = null;
let warned = false;

export function getRateLimitStore(): RateLimitStore {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    cached = new UpstashRestRateLimitStore(url, token);
    return cached;
  }
  // Upstash 未設定。production で shared store が無いことを一度だけ警告（保守的 fallback）。
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  if (isProd && !warned) {
    warned = true;
    console.warn(
      'rate limit: UPSTASH_REDIS_REST_URL/TOKEN 未設定のため in-memory fallback を使用します。' +
        '複数インスタンス間で共有されないため実効上限は「インスタンス数 × limit」になります。' +
        '本番では Upstash/KV を設定してください。',
    );
  }
  cached = new InMemoryRateLimitStore();
  return cached;
}

// テスト用: store を差し替える / reset する。
export function __setRateLimitStoreForTest(store: RateLimitStore | null): void {
  cached = store;
}
