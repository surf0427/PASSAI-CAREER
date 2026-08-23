/*
 * scripts/career-subscription-sync-qa.ts
 *
 * PASSAI CAREER — subscription 同期の堅牢性 QA（dev-only / 実 Stripe・実 DB 非接続）。
 *
 * 対象は Release Candidate Audit の P2-3:
 *   「webhook の配送順序が保証されないため古い event が新しい state を巻き戻す」
 *   「取りこぼした場合に self-heal する経路が無い」
 *
 * 検証:
 *   [A] Ordering — 古い event が新しい state を巻き戻さない（§26 Case 1-4）
 *   [B] Reconciliation — Stripe を正として drift を修復する（§27）
 *   [C] Bounded work / 候補選択 / 冪等
 *   [D] 静的契約（境界・非破壊・cron 認証・env）
 *
 * ★ 実 Stripe / 実 Supabase へ接続しない。secret も実値も読まない・表示しない。
 *   Stripe 取得と DB 書き込みはすべて注入した fake を通る。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-subscription-sync-qa.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ★ 実 Stripe Price env が無い環境でも plan 解決が通るように、import 前に固定する。
//   実値ではなくテスト専用のダミー（この値は Stripe へ送られない）。
const TEST_PRICE_ID = 'price_test_career_qa';
process.env.STRIPE_CAREER_PRICE_ID = TEST_PRICE_ID;

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** コメント行を除いた実コードだけを検査対象にする。 */
const codeOf = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

// ───────────────────────────────────────────────────────────────
// Fakes
// ───────────────────────────────────────────────────────────────

type Row = {
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  plan: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
};

/** career_subscriptions / career_billing_customers の最小 in-memory 代替。 */
class FakeDb {
  subscriptions = new Map<string, Row>();
  customers = new Map<string, string>(); // stripe_customer_id -> user_id
  upsertCount = 0;
  failUpserts = false;

  from(table: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;
    if (table === 'career_subscriptions') {
      return {
        upsert(values: Record<string, unknown>) {
          db.upsertCount += 1;
          if (db.failUpserts) {
            return Promise.resolve({ error: { message: 'fake db failure' } });
          }
          const id = String(values.stripe_subscription_id);
          const prev = db.subscriptions.get(id);
          db.subscriptions.set(id, {
            ...(prev ?? {}),
            ...(values as unknown as Row),
            updated_at: new Date().toISOString(),
          });
          return Promise.resolve({ error: null });
        },
        select() {
          return {
            eq() {
              return {
                limit() {
                  return {
                    maybeSingle: () => Promise.resolve({ data: null, error: null }),
                  };
                },
              };
            },
          };
        },
      };
    }
    if (table === 'career_billing_customers') {
      return {
        select() {
          return {
            eq(_col: string, value: string) {
              return {
                maybeSingle: () =>
                  Promise.resolve({
                    data: db.customers.has(value) ? { user_id: db.customers.get(value) } : null,
                    error: null,
                  }),
              };
            },
          };
        },
        insert(values: Record<string, unknown>) {
          const cid = String(values.stripe_customer_id);
          if (db.customers.has(cid)) {
            // 既に mapping 済み（UNIQUE 違反）。実装は 23505 を冪等に無視する。
            return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } });
          }
          db.customers.set(cid, String(values.user_id));
          return Promise.resolve({ error: null });
        },
        upsert() {
          return Promise.resolve({ error: null });
        },
      };
    }
    throw new Error(`FakeDb: unexpected table ${table}`);
  }
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = 'cus_qa';
const SUB_ID = 'sub_qa';

/** Stripe Subscription の最小 shape（sync が読む field だけ）。 */
function stripeSub(input: {
  status: string;
  cancelAtPeriodEnd?: boolean;
  periodEndSec?: number;
  priceId?: string;
}) {
  return {
    id: SUB_ID,
    customer: CUSTOMER_ID,
    status: input.status,
    cancel_at_period_end: input.cancelAtPeriodEnd === true,
    metadata: { app_user_id: USER_ID },
    items: {
      data: [
        {
          price: { id: input.priceId ?? TEST_PRICE_ID },
          current_period_start: 1_760_000_000,
          current_period_end: input.periodEndSec ?? 1_762_000_000,
        },
      ],
    },
  } as unknown as import('stripe').Stripe.Subscription;
}

async function main() {
  const { syncCareerSubscriptionById } = await import('../lib/careerBilling/subscription');
  const {
    reconcileCareerSubscriptions,
    selectCareerReconcileCandidates,
    isCareerSubscriptionInSync,
    toCareerStripeSubscriptionView,
    sameInstant,
    CAREER_RECONCILE_ACTIVE_STATUSES,
    CAREER_RECONCILE_DEFAULT_LIMIT,
    CAREER_RECONCILE_MAX_LIMIT,
  } = await import('../lib/careerBilling/reconcile');
  const { deriveCareerPaidAccess } = await import('../lib/careerBilling/entitlementPolicy');

  /** webhook が 1 件の subscription event を処理したことにする。 */
  async function deliverEvent(
    db: FakeDb,
    stripeCurrent: () => ReturnType<typeof stripeSub>,
  ) {
    return syncCareerSubscriptionById({
      admin: db as never,
      subscriptionId: SUB_ID,
      // ★ event payload ではなく **その時点の Stripe の現在値**を返す。
      fetchSubscription: async () => ({ kind: 'ok', sub: stripeCurrent() }),
    });
  }

  const paidOf = (db: FakeDb): boolean => {
    const row = db.subscriptions.get(SUB_ID);
    if (!row) return false;
    return deriveCareerPaidAccess([
      {
        plan: row.plan,
        status: row.status,
        current_period_end: row.current_period_end,
        cancel_at_period_end: row.cancel_at_period_end,
      },
    ]);
  };

  // ═══════════════════════════════════════════════════════════
  console.log('[A] Ordering — 古い event が新しい state を巻き戻さない');
  // ═══════════════════════════════════════════════════════════
  {
    // --- Case 1: 正順 created(incomplete) → updated(active) ---
    {
      const db = new FakeDb();
      let current = stripeSub({ status: 'incomplete' });
      await deliverEvent(db, () => current); // created 到着（Stripe は incomplete）
      check(db.subscriptions.get(SUB_ID)?.status === 'incomplete', 'Case1: created 後は incomplete');
      current = stripeSub({ status: 'active' }); // Stripe 側が active へ
      await deliverEvent(db, () => current); // updated 到着
      check(db.subscriptions.get(SUB_ID)?.status === 'active', 'Case1: updated 後は active');
      check(paidOf(db), 'Case1: paid access = true');
    }

    // --- Case 2: 逆順配送 updated(active) が先、古い created(incomplete) が後 ---
    {
      const db = new FakeDb();
      // Stripe の現在値はもう active（created event はまだ届いていない）。
      const current = stripeSub({ status: 'active' });
      await deliverEvent(db, () => current); // updated(active) 先着
      check(db.subscriptions.get(SUB_ID)?.status === 'active', 'Case2: updated 先着で active');

      // ここで **古い** created(incomplete) event が遅れて到着する。
      // 旧実装は event payload（incomplete）を保存して巻き戻っていた。
      // 新実装は id だけ使って現在値を取り直すので active のまま。
      await deliverEvent(db, () => current);
      check(
        db.subscriptions.get(SUB_ID)?.status === 'active',
        'Case2: 遅れて届いた created(incomplete) で巻き戻らない',
        `status=${db.subscriptions.get(SUB_ID)?.status}`,
      );
      check(paidOf(db), 'Case2: 課金済みユーザーの権利が消えない');
    }

    // --- Case 3: updated(active) → deleted → 古い updated(active) ---
    {
      const db = new FakeDb();
      let current = stripeSub({ status: 'active' });
      await deliverEvent(db, () => current);
      check(paidOf(db), 'Case3: 初期状態は paid');

      // 解約。Stripe は subscription を hard delete せず canceled として保持する。
      // 期限も過去にして grace を残さない。
      current = stripeSub({ status: 'canceled', periodEndSec: 1_600_000_000 });
      await deliverEvent(db, () => current); // deleted 到着
      check(db.subscriptions.get(SUB_ID)?.status === 'canceled', 'Case3: deleted 後は canceled');
      check(!paidOf(db), 'Case3: deleted 後は paid access = false');

      // 古い updated(active) が遅れて到着 → 現在値は canceled のままなので復活しない。
      await deliverEvent(db, () => current);
      check(
        db.subscriptions.get(SUB_ID)?.status === 'canceled',
        'Case3: 古い active event で解約が復活しない',
        `status=${db.subscriptions.get(SUB_ID)?.status}`,
      );
      check(!paidOf(db), 'Case3: 解約済みに永久 access が残らない');
    }

    // --- Case 3b: deleted を誤って無視しない（§13 の逆方向バグ）---
    {
      const db = new FakeDb();
      let current = stripeSub({ status: 'active' });
      await deliverEvent(db, () => current);
      current = stripeSub({ status: 'canceled', periodEndSec: 1_600_000_000 });
      const r = await deliverEvent(db, () => current);
      check(r.kind === 'ok', 'Case3b: deleted event は skip されず必ず適用される');
      check(db.subscriptions.get(SUB_ID)?.status === 'canceled', 'Case3b: canceled が保存される');
    }

    // --- Case 4: 同一 event の重複配送 → 冪等 ---
    {
      const db = new FakeDb();
      const current = stripeSub({ status: 'active' });
      await deliverEvent(db, () => current);
      const afterFirst = { ...db.subscriptions.get(SUB_ID)! };
      await deliverEvent(db, () => current); // 同じ event がもう一度
      const afterSecond = db.subscriptions.get(SUB_ID)!;
      check(db.subscriptions.size === 1, 'Case4: 行が増えない（upsert 冪等）');
      check(
        afterFirst.status === afterSecond.status &&
          afterFirst.current_period_end === afterSecond.current_period_end &&
          afterFirst.cancel_at_period_end === afterSecond.cancel_at_period_end,
        'Case4: 意味のある値が変化しない',
      );
      check(paidOf(db), 'Case4: entitlement が揺れない');
    }

    // --- Stripe 取得失敗時は DB を変更しない ---
    {
      const db = new FakeDb();
      await deliverEvent(db, () => stripeSub({ status: 'active' }));
      const before = { ...db.subscriptions.get(SUB_ID)! };

      const errored = await syncCareerSubscriptionById({
        admin: db as never,
        subscriptionId: SUB_ID,
        fetchSubscription: async () => ({ kind: 'error' }),
      });
      check(errored.kind === 'stripe-error', 'stripe error は stripe-error を返す');
      check(
        db.subscriptions.get(SUB_ID)!.status === before.status,
        'stripe error 時に DB を書き換えない（retry 前提）',
      );

      const missing = await syncCareerSubscriptionById({
        admin: db as never,
        subscriptionId: SUB_ID,
        fetchSubscription: async () => ({ kind: 'missing' }),
      });
      check(missing.kind === 'stripe-missing', 'stripe missing は stripe-missing を返す');
      check(db.subscriptions.has(SUB_ID), 'stripe missing でも行を削除しない（非破壊）');
    }

    // --- 受験版 Price の subscription は DB を一切変更しない ---
    {
      const db = new FakeDb();
      const r = await syncCareerSubscriptionById({
        admin: db as never,
        subscriptionId: SUB_ID,
        fetchSubscription: async () => ({
          kind: 'ok',
          sub: stripeSub({ status: 'active', priceId: 'price_exam_other' }),
        }),
      });
      check(r.kind === 'unknown-plan', '別 Product の Price は unknown-plan');
      check(db.subscriptions.size === 0, 'unknown-plan では DB 書き込み 0');
    }
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════
  console.log('[B] Reconciliation — Stripe を正として drift を修復する');
  // ═══════════════════════════════════════════════════════════
  {
    const PERIOD_END_SEC = 1_762_000_000;
    const PERIOD_END_ISO = new Date(PERIOD_END_SEC * 1000).toISOString();

    const makeDeps = (opts: {
      rows: {
        stripe_subscription_id: string;
        status: string;
        current_period_end: string | null;
        cancel_at_period_end: boolean;
      }[];
      stripe: Record<string, { kind: 'ok'; sub: unknown } | { kind: 'missing' } | { kind: 'error' }>;
      onSync?: (id: string) => void;
      syncFails?: boolean;
      listError?: string | null;
    }) => {
      const synced: string[] = [];
      return {
        synced,
        deps: {
          listCandidates: async () => ({
            rows: opts.rows,
            error: opts.listError ?? null,
          }),
          fetchSubscription: async (id: string) =>
            (opts.stripe[id] ?? { kind: 'missing' }) as never,
          syncOne: async (id: string) => {
            synced.push(id);
            opts.onSync?.(id);
            return { ok: !opts.syncFails };
          },
          log: () => {},
        },
      };
    };

    // --- Drift repair: DB=incomplete / Stripe=active → active ---
    {
      const { deps, synced } = makeDeps({
        rows: [
          {
            stripe_subscription_id: SUB_ID,
            status: 'incomplete',
            current_period_end: PERIOD_END_ISO,
            cancel_at_period_end: false,
          },
        ],
        stripe: {
          [SUB_ID]: {
            kind: 'ok',
            sub: stripeSub({ status: 'active', periodEndSec: PERIOD_END_SEC }),
          },
        },
      });
      const { summary, error } = await reconcileCareerSubscriptions({ deps: deps as never });
      check(error === null, 'drift: systemic error 無し');
      check(summary.repaired === 1 && summary.unchanged === 0, 'drift: repaired=1');
      check(synced.length === 1, 'drift: Stripe truth を DB へ書き戻す（sync 1 回）');
      // 実際に書き戻した結果 paid access が回復することを writer 側で確認する。
      const db = new FakeDb();
      await deliverEvent(db, () => stripeSub({ status: 'active', periodEndSec: PERIOD_END_SEC }));
      check(paidOf(db), 'drift: 修復後の行は paid access = true');
    }

    // --- Cancel repair: DB=active / Stripe=canceled(期限切れ) → canceled ---
    {
      const { deps, synced } = makeDeps({
        rows: [
          {
            stripe_subscription_id: SUB_ID,
            status: 'active',
            current_period_end: PERIOD_END_ISO,
            cancel_at_period_end: false,
          },
        ],
        stripe: {
          [SUB_ID]: {
            kind: 'ok',
            sub: stripeSub({ status: 'canceled', periodEndSec: 1_600_000_000 }),
          },
        },
      });
      const { summary } = await reconcileCareerSubscriptions({ deps: deps as never });
      check(summary.repaired === 1, 'cancel: repaired=1');
      check(synced.length === 1, 'cancel: DB を canceled へ寄せる');
      const db = new FakeDb();
      await deliverEvent(db, () => stripeSub({ status: 'canceled', periodEndSec: 1_600_000_000 }));
      check(!paidOf(db), 'cancel: 修復後の行は paid access = false');
    }

    // --- 既存 grace 仕様は変えない: canceled + 未来 period_end は権利を維持 ---
    {
      const futureSec = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 10;
      const db = new FakeDb();
      await deliverEvent(db, () => stripeSub({ status: 'canceled', periodEndSec: futureSec }));
      check(paidOf(db), 'grace: canceled + 未来 period_end は既存どおり権利を維持する');
    }

    // --- Already correct: 一致していれば書き込み 0 ---
    {
      const { deps, synced } = makeDeps({
        rows: [
          {
            stripe_subscription_id: SUB_ID,
            status: 'active',
            current_period_end: PERIOD_END_ISO,
            cancel_at_period_end: false,
          },
        ],
        stripe: {
          [SUB_ID]: {
            kind: 'ok',
            sub: stripeSub({ status: 'active', periodEndSec: PERIOD_END_SEC }),
          },
        },
      });
      const { summary } = await reconcileCareerSubscriptions({ deps: deps as never });
      check(summary.unchanged === 1 && summary.repaired === 0, 'already-correct: unchanged=1');
      check(synced.length === 0, 'already-correct: 不要な書き込みをしない（updated_at を動かさない）');
    }

    // --- 冪等: 同じ状態で 2 回走らせても結果が同じ ---
    {
      const mk = () =>
        makeDeps({
          rows: [
            {
              stripe_subscription_id: SUB_ID,
              status: 'active',
              current_period_end: PERIOD_END_ISO,
              cancel_at_period_end: false,
            },
          ],
          stripe: {
            [SUB_ID]: {
              kind: 'ok',
              sub: stripeSub({ status: 'active', periodEndSec: PERIOD_END_SEC }),
            },
          },
        });
      const a = await reconcileCareerSubscriptions({ deps: mk().deps as never });
      const b = await reconcileCareerSubscriptions({ deps: mk().deps as never });
      check(
        JSON.stringify(a.summary) === JSON.stringify(b.summary),
        'idempotent: 2 回目も同じ summary',
      );
    }

    // --- Stripe failure isolation: 1 件失敗しても他は継続 ---
    {
      const rows = ['sub_a', 'sub_b', 'sub_c'].map((id) => ({
        stripe_subscription_id: id,
        status: 'incomplete',
        current_period_end: PERIOD_END_ISO,
        cancel_at_period_end: false,
      }));
      const { deps, synced } = makeDeps({
        rows,
        stripe: {
          sub_a: { kind: 'ok', sub: stripeSub({ status: 'active', periodEndSec: PERIOD_END_SEC }) },
          sub_b: { kind: 'error' },
          sub_c: { kind: 'ok', sub: stripeSub({ status: 'active', periodEndSec: PERIOD_END_SEC }) },
        },
      });
      const { summary, error } = await reconcileCareerSubscriptions({ deps: deps as never });
      check(error === null, 'isolation: 1 件の Stripe error で全体を fail させない');
      check(summary.processed === 3, 'isolation: 3 件すべて処理を試みる');
      check(summary.stripe_error === 1, 'isolation: stripe_error=1');
      check(summary.repaired === 2, 'isolation: 残り 2 件は修復される');
      check(synced.length === 2, 'isolation: 失敗した 1 件だけ skip される');
    }

    // --- stripe_missing は行を消さない ---
    {
      const { deps, synced } = makeDeps({
        rows: [
          {
            stripe_subscription_id: SUB_ID,
            status: 'active',
            current_period_end: PERIOD_END_ISO,
            cancel_at_period_end: false,
          },
        ],
        stripe: { [SUB_ID]: { kind: 'missing' } },
      });
      const { summary } = await reconcileCareerSubscriptions({ deps: deps as never });
      check(summary.stripe_missing === 1, 'missing: stripe_missing=1');
      check(synced.length === 0, 'missing: 書き込み・削除を一切しない（非破壊）');
    }

    // --- DB 書き込み失敗は db_error として 1 件だけ計上 ---
    {
      const { deps } = makeDeps({
        rows: [
          {
            stripe_subscription_id: SUB_ID,
            status: 'incomplete',
            current_period_end: PERIOD_END_ISO,
            cancel_at_period_end: false,
          },
        ],
        stripe: {
          [SUB_ID]: {
            kind: 'ok',
            sub: stripeSub({ status: 'active', periodEndSec: PERIOD_END_SEC }),
          },
        },
        syncFails: true,
      });
      const { summary, error } = await reconcileCareerSubscriptions({ deps: deps as never });
      check(error === null, 'db_error: cron 全体は落ちない');
      check(summary.db_error === 1 && summary.repaired === 0, 'db_error: db_error=1');
    }

    // --- dryRun は書き込まない ---
    {
      const { deps, synced } = makeDeps({
        rows: [
          {
            stripe_subscription_id: SUB_ID,
            status: 'incomplete',
            current_period_end: PERIOD_END_ISO,
            cancel_at_period_end: false,
          },
        ],
        stripe: {
          [SUB_ID]: {
            kind: 'ok',
            sub: stripeSub({ status: 'active', periodEndSec: PERIOD_END_SEC }),
          },
        },
      });
      const { summary } = await reconcileCareerSubscriptions({ deps: deps as never, dryRun: true });
      check(summary.dryRun === true && summary.repaired === 1, 'dryRun: 検知はする');
      check(synced.length === 0, 'dryRun: 書き込みは 0');
    }

    // --- 候補が読めない = systemic failure ---
    {
      const { deps } = makeDeps({ rows: [], stripe: {}, listError: 'boom' });
      const { error } = await reconcileCareerSubscriptions({ deps: deps as never });
      check(error !== null, 'systemic: 候補 select 失敗は error として返す');
    }
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════
  console.log('[C] Bounded work / 候補選択 / 比較ロジック');
  // ═══════════════════════════════════════════════════════════
  {
    // status 集合が entitlement policy と整合している。
    for (const s of ['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused']) {
      check(CAREER_RECONCILE_ACTIVE_STATUSES.includes(s), `候補 status に ${s} を含む`);
    }
    check(
      !CAREER_RECONCILE_ACTIVE_STATUSES.includes('incomplete_expired'),
      '終端 status（incomplete_expired）は候補にしない',
    );
    check(
      !CAREER_RECONCILE_ACTIVE_STATUSES.includes('canceled'),
      'canceled は status 一括では候補にしない（grace 中のみ別枠）',
    );

    // truncated は limit 到達で立つ。
    {
      const rows = Array.from({ length: 5 }, (_, i) => ({
        stripe_subscription_id: `sub_${i}`,
        status: 'active',
        current_period_end: null,
        cancel_at_period_end: false,
      }));
      const { summary } = await reconcileCareerSubscriptions({
        deps: {
          listCandidates: async (limit: number) => ({ rows: rows.slice(0, limit), error: null }),
          fetchSubscription: async () => ({ kind: 'error' }) as never,
          syncOne: async () => ({ ok: true }),
          log: () => {},
        } as never,
        limit: 5,
      });
      check(summary.truncated === true, 'limit 到達時は truncated=true（silent truncation なし）');
      check(summary.processed === 5, 'limit を超えて処理しない');
    }
    {
      const { summary } = await reconcileCareerSubscriptions({
        deps: {
          listCandidates: async () => ({ rows: [], error: null }),
          fetchSubscription: async () => ({ kind: 'error' }) as never,
          syncOne: async () => ({ ok: true }),
          log: () => {},
        } as never,
      });
      check(summary.truncated === false, '候補が少なければ truncated=false');
      check(summary.processed === 0, '候補 0 件でも安全に完了する');
    }

    check(CAREER_RECONCILE_DEFAULT_LIMIT > 0, '既定 limit が正の有限値');
    check(
      CAREER_RECONCILE_MAX_LIMIT >= CAREER_RECONCILE_DEFAULT_LIMIT,
      'max limit >= default limit',
    );

    // 比較ロジック（表記揺れ吸収 / 3 field 比較）。
    check(sameInstant('2026-09-22T14:04:33+00:00', '2026-09-22T14:04:33.000Z'), 'sameInstant: 表記揺れを吸収');
    check(!sameInstant('2026-09-22T14:04:33Z', '2026-09-23T14:04:33Z'), 'sameInstant: 異なる時刻は不一致');
    check(sameInstant(null, null), 'sameInstant: null 同士は一致');
    check(!sameInstant(null, '2026-09-22T14:04:33Z'), 'sameInstant: null と値は不一致');

    const baseRow = {
      stripe_subscription_id: SUB_ID,
      status: 'active',
      current_period_end: '2026-09-22T14:04:33Z',
      cancel_at_period_end: false,
    };
    const view = toCareerStripeSubscriptionView(
      stripeSub({ status: 'active', periodEndSec: Math.floor(Date.parse('2026-09-22T14:04:33Z') / 1000) }),
    );
    check(isCareerSubscriptionInSync(baseRow, view), 'inSync: 3 field 一致なら true');
    check(
      !isCareerSubscriptionInSync({ ...baseRow, cancel_at_period_end: true }, view),
      'inSync: cancel_at_period_end の差分を検出する',
    );
    check(
      !isCareerSubscriptionInSync({ ...baseRow, status: 'past_due' }, view),
      'inSync: status の差分を検出する',
    );

    // 候補 SELECT が bounded であること（実 DB には接続しない・呼び出し形だけ検証）。
    const calls: string[] = [];
    const fakeAdmin = {
      from(table: string) {
        calls.push(`from:${table}`);
        const q: Record<string, unknown> = {};
        const chain = {
          select: (cols: string) => {
            calls.push(`select:${cols}`);
            return chain;
          },
          in: (...a: unknown[]) => {
            calls.push(`in:${String(a[0])}`);
            return chain;
          },
          eq: (...a: unknown[]) => {
            calls.push(`eq:${String(a[0])}`);
            return chain;
          },
          gt: (...a: unknown[]) => {
            calls.push(`gt:${String(a[0])}`);
            return chain;
          },
          order: (col: string) => {
            calls.push(`order:${col}`);
            return chain;
          },
          limit: (n: number) => {
            calls.push(`limit:${n}`);
            return Promise.resolve({ data: [], error: null });
          },
        };
        void q;
        return chain;
      },
    };
    await selectCareerReconcileCandidates({
      admin: fakeAdmin as never,
      limit: 7,
      nowIso: new Date().toISOString(),
    });
    check(calls.filter((c) => c === 'limit:7').length === 2, '候補 SELECT は必ず limit を付ける');
    check(calls.includes('order:updated_at'), '候補は updated_at 昇順で回す（偏り防止）');
    check(calls.includes('in:status'), 'status で候補を絞る（全件 scan をしない）');
    check(calls.includes('gt:current_period_end'), 'grace 中 canceled を別枠で拾う');
    check(
      calls.every((c) => c !== 'from:subscriptions' && c !== 'from:profiles'),
      'Project A の table を読まない',
    );
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════
  console.log('[D] 静的契約（境界 / 非破壊 / cron 認証 / env）');
  // ═══════════════════════════════════════════════════════════
  {
    const RECONCILE_LIB = 'lib/careerBilling/reconcile.ts';
    const CRON = 'app/api/cron/career-reconcile-subscriptions/route.ts';
    const WEBHOOK = 'app/api/career/billing/webhook/route.ts';
    const SUBSCRIPTION = 'lib/careerBilling/subscription.ts';

    for (const f of [RECONCILE_LIB, CRON, WEBHOOK, SUBSCRIPTION]) {
      check(existsSync(join(ROOT, f)), `${f} が存在する`);
    }

    const reconcileSrc = codeOf(read(RECONCILE_LIB));
    const cronSrc = codeOf(read(CRON));
    const webhookSrc = codeOf(read(WEBHOOK));
    const subSrc = codeOf(read(SUBSCRIPTION));

    // --- webhook が現在 snapshot を取り直す（ordering 修正の本体）---
    check(
      /syncCareerSubscriptionById\(/.test(webhookSrc),
      'webhook は by-id 同期（現在 snapshot 取り直し）を使う',
    );
    check(
      /subscriptionId:\s*sub\.id/.test(webhookSrc),
      'webhook は event から subscription id だけを取る',
    );
    check(
      !/syncCareerSubscriptionFromStripe\(\s*\{\s*admin[^)]*sub\s*\}/.test(webhookSrc),
      'webhook は event payload の snapshot をそのまま保存しない',
    );
    check(
      /subscriptions\.retrieve\(/.test(codeOf(read('lib/careerBilling/stripe.ts'))),
      'Stripe の現在 snapshot を retrieve で取る',
    );

    // --- mapping は 1 箇所（§24）---
    check(
      /syncCareerSubscriptionFromStripe\(/.test(subSrc),
      'by-id 版は既存 writer へ委譲する（mapping を二重実装しない）',
    );
    check(
      !/\.upsert\(/.test(reconcileSrc),
      'reconcile は自前で upsert しない（writer へ委譲）',
    );

    // --- 非破壊 ---
    for (const [label, src] of [
      ['reconcile', reconcileSrc],
      ['cron', cronSrc],
    ] as const) {
      check(!/\.delete\(/.test(src), `${label} は DELETE を持たない`);
      check(!/\bTRUNCATE\b/i.test(src), `${label} は TRUNCATE を持たない`);
    }
    check(
      /stripe_missing/.test(reconcileSrc) && !/delete/i.test(reconcileSrc),
      'Stripe に無い subscription でも行を消さない',
    );

    // --- 方向は一方通行（DB → Stripe の書き込みをしない）---
    for (const forbidden of [
      'subscriptions.update(',
      'subscriptions.cancel(',
      'subscriptions.create(',
      'subscriptions.del(',
    ]) {
      check(
        !reconcileSrc.includes(forbidden) && !cronSrc.includes(forbidden),
        `Stripe へ書き戻さない（${forbidden} を呼ばない）`,
      );
    }

    // --- Project 境界（Project A を流用しない）---
    for (const [label, src] of [
      ['reconcile', reconcileSrc],
      ['cron', cronSrc],
    ] as const) {
      for (const ident of [
        'getServerSupabaseClient',
        'getServiceRoleSupabaseClient',
        'getBrowserSupabaseClient',
      ]) {
        check(
          !new RegExp(`(?<![A-Za-z0-9_])${ident}(?![A-Za-z0-9_])`).test(src),
          `${label} が Project A factory（${ident}）を使わない`,
        );
      }
      for (const t of ["from('subscriptions')", "from('profiles')", "from('stripe_events')"]) {
        check(!src.includes(t), `${label} が Project A の table（${t}）に触れない`);
      }
      check(!/lib\/billing\//.test(src), `${label} が受験版 billing module を import しない`);
    }
    check(
      /getCareerServiceRoleSupabaseClient/.test(cronSrc),
      'cron は CAREER service_role client（Project B）を使う',
    );
    check(
      /career_subscriptions|CAREER_SUBSCRIPTIONS_TABLE/.test(reconcileSrc),
      'reconcile の対象は career_subscriptions',
    );

    // --- cron 認証（fail-closed）---
    check(/CRON_SECRET/.test(cronSrc), 'cron は CRON_SECRET を要求する');
    check(
      /if\s*\(!secret\)\s*return false/.test(cronSrc),
      'CRON_SECRET 未設定は fail-closed（誰も叩けない）',
    );
    check(/status:\s*401/.test(cronSrc), '未認証は 401');
    check(
      /authorization/i.test(cronSrc) && /Bearer/.test(cronSrc),
      'Authorization: Bearer 方式（既存 cron と同一）',
    );
    // ★ import 行ではなく **呼び出し位置**で比較する（import は必ず先頭にあるため）。
    const authAt = cronSrc.indexOf('isAuthorized(req)');
    const clientAt = cronSrc.indexOf('getCareerServiceRoleSupabaseClient(');
    const reconcileAt = cronSrc.indexOf('reconcileCareerSubscriptions(');
    check(
      authAt >= 0 && clientAt > authAt && reconcileAt > authAt,
      '認証が DB / Stripe アクセスより前にある',
      `auth=${authAt} client=${clientAt} reconcile=${reconcileAt}`,
    );

    // --- entitlement 判定に触れていない（今回直すのは入力だけ）---
    for (const [label, src] of [
      ['reconcile', reconcileSrc],
      ['cron', cronSrc],
    ] as const) {
      check(
        !/deriveCareerPaidAccess|entitlementPolicy/.test(src),
        `${label} は entitlement 判定ロジックを再実装しない`,
      );
    }

    // --- 観測性（件数のみ・PII / secret を出さない）---
    for (const key of ['processed', 'unchanged', 'repaired', 'stripe_missing', 'stripe_error', 'db_error']) {
      check(reconcileSrc.includes(key), `観測カウンタ ${key} を持つ`);
    }
    check(
      !/console\.(log|info|warn|error)\([^)]*(SECRET|user_id|userId)/i.test(reconcileSrc + cronSrc),
      'secret / user_id をログに出さない',
    );

    // --- 新 env を増やしていない（既存 env の再利用）---
    const cronEnvs = [...cronSrc.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    const allowedEnvs = new Set(['CRON_SECRET']);
    check(
      cronEnvs.every((e) => allowedEnvs.has(e)),
      'cron が読む env は既存の CRON_SECRET のみ',
      cronEnvs.join(','),
    );

    // --- vercel.json に daily cron が登録されている ---
    const vercel = JSON.parse(read('vercel.json')) as {
      crons?: { path: string; schedule: string }[];
    };
    const entry = (vercel.crons ?? []).find(
      (c) => c.path === '/api/cron/career-reconcile-subscriptions',
    );
    check(!!entry, 'vercel.json に CAREER reconcile cron が登録されている');
    check(
      !!entry && /^\d+\s+\d+\s+\*\s+\*\s+\*$/.test(entry.schedule),
      'schedule は 1 日 1 回（過剰な頻度にしない）',
      entry?.schedule,
    );
    // 既存 cron と実行時刻が衝突していない。
    const schedules = (vercel.crons ?? []).map((c) => c.schedule);
    check(
      new Set(schedules).size === schedules.length,
      '既存 cron と同一スケジュールに重ねていない',
    );

    // --- 公開面（P1-3 allowlist）から到達できる path であること ---
    const surface = read('lib/careerDeploymentSurface.ts');
    check(
      surface.includes("'/api/cron'"),
      'cron path は deployment allowlist に含まれる（404 にならない）',
    );
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-subscription-sync-qa: ALL PASS — ordering / reconciliation contracts hold.'
      : `career-subscription-sync-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
