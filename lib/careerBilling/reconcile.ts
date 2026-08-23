/**
 * PASSAI CAREER — career_subscriptions の self-healing（Stripe → DB の一方通行）。
 *
 * STEP-CAREER-SUBSCRIPTION-SYNC-HARDENING。
 *
 * ── なぜ必要か ────────────────────────────────────────────────────────
 *   webhook は「届けば」正しく同期する。しかし
 *     - endpoint 障害が Stripe の retry 期間（数日）を超えた
 *     - DB の一時障害で transient-error のまま retry も尽きた
 *     - Stripe Dashboard から直接 subscription を操作した
 *     - webhook endpoint の設定漏れ / secret 差し替え中の取りこぼし
 *   といった経路で `Stripe truth != career_subscriptions` が残りうる。
 *   その状態は **自然回復しない**（次の event が来るまで誰も気付かない）ので、
 *   定期的に Stripe を読み直して DB を寄せる経路を用意する。
 *
 * ── 方向は一方通行 ────────────────────────────────────────────────────
 *   Stripe（billing truth） → career_subscriptions
 *   DB の内容を Stripe へ push することは **絶対にしない**（解約の巻き戻し等を防ぐ）。
 *
 * ── 権利判定には触れない ──────────────────────────────────────────────
 *   本 module が直すのは entitlement の**入力**（subscription state）だけ。
 *   grace / cancel の意味論（lib/careerBilling/entitlementPolicy.ts）は一切変更しない。
 *
 * ── 境界 ──────────────────────────────────────────────────────────────
 *   - Project B のみ（career_subscriptions / career service_role）。
 *     受験版の subscriptions / profiles / Project A client には触れない。
 *   - 保存の形（Stripe Subscription → 行）は webhook と同じ
 *     `syncCareerSubscriptionById` に委譲する。mapping を 2 度書かない。
 *   - 破壊的処理を持たない。DELETE も、Stripe に無い行の削除もしない。
 *   - I/O はすべて deps 経由。QA が実 Stripe / 実 DB 無しで全分岐を検証できる。
 */

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { CAREER_SUBSCRIPTIONS_TABLE, syncCareerSubscriptionById } from './subscription';
import { retrieveCareerSubscription, type CareerSubscriptionFetch } from './stripe';

/**
 * reconcile 対象にする status（＝ **今後 Stripe 側で変わりうる** 状態）。
 *
 * entitlementPolicy の分類に対応させている:
 *   - 権利あり側（active / trialing / past_due）… 解約・失効へ動きうる
 *   - 権利なしだが復帰しうる側（incomplete / unpaid / paused）… 支払い成功で active へ動きうる
 *     ★ 「DB=incomplete / Stripe=active」という本 STEP の主眼のケースがここ。
 *
 * 除外するもの（Stripe 側でもう動かない終端。読むだけ無駄で API 予算を食う）:
 *   - incomplete_expired … Stripe は二度と active にしない
 *   - canceled           … 再開は新しい subscription id になり別行として webhook が作る
 *     ただし **current_period_end が未来の canceled 行は grace で権利を与えている**ため、
 *     取りこぼさないよう別枠で候補に入れる（下の selectCareerReconcileCandidates 参照）。
 */
export const CAREER_RECONCILE_ACTIVE_STATUSES: readonly string[] = [
  'trialing',
  'active',
  'past_due',
  'incomplete',
  'unpaid',
  'paused',
];

/** 1 回の実行で Stripe に問い合わせる上限（無限 scan を作らないための天井）。 */
export const CAREER_RECONCILE_DEFAULT_LIMIT = 200;
/** 1 回の実行で許す最大 limit（運用が誤って巨大な値を渡しても青天井にしない）。 */
export const CAREER_RECONCILE_MAX_LIMIT = 500;

/** reconcile が読む最小の行形状。 */
export type CareerReconcileRow = {
  stripe_subscription_id: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

/** 1 件ごとの結果。log / 応答の集計キーと 1:1。 */
export type CareerReconcileOutcome =
  | 'repaired'        // Stripe と違ったので DB を寄せた
  | 'unchanged'       // 既に一致していた（意味的な変更なし）
  | 'stripe_missing'  // Stripe に存在しない（**行は消さない**）
  | 'stripe_error'    // Stripe API の一時障害（この 1 件だけ skip）
  | 'db_error';       // 書き込み失敗（この 1 件だけ skip）

export type CareerReconcileSummary = {
  /** 候補として読み込んだ件数（= Stripe へ問い合わせた件数）。 */
  processed: number;
  repaired: number;
  unchanged: number;
  stripe_missing: number;
  stripe_error: number;
  db_error: number;
  /** limit に達して候補を全部見られなかったか（silent truncation を作らない）。 */
  truncated: boolean;
  dryRun: boolean;
};

const EMPTY_SUMMARY: Omit<CareerReconcileSummary, 'dryRun'> = {
  processed: 0,
  repaired: 0,
  unchanged: 0,
  stripe_missing: 0,
  stripe_error: 0,
  db_error: 0,
  truncated: false,
};

/**
 * 候補行を読む（bounded）。
 *
 * ★ 「全件 SELECT → 全件 Stripe API」にしない。status で絞り、limit で天井を作る。
 * ★ 並び順は updated_at 昇順（＝最後に触ってから最も時間が経った行から見る）。
 *   件数が limit を超える規模になっても、古い行から順に回るので特定の行だけが
 *   永久に検査されない、という偏りが起きにくい。
 */
export async function selectCareerReconcileCandidates(input: {
  admin: SupabaseClient;
  limit: number;
  nowIso: string;
}): Promise<{ rows: CareerReconcileRow[]; error: string | null }> {
  // entitlement に効く 3 列だけ読む（差分判定に必要な最小集合）。
  const columns =
    'stripe_subscription_id, status, current_period_end, cancel_at_period_end';

  // ① まだ動きうる status。
  const active = await input.admin
    .from(CAREER_SUBSCRIPTIONS_TABLE)
    .select(columns)
    .in('status', CAREER_RECONCILE_ACTIVE_STATUSES as string[])
    .order('updated_at', { ascending: true })
    .limit(input.limit);
  if (active.error) return { rows: [], error: active.error.message ?? 'select failed' };

  // ② grace 期間中の canceled（現在も権利を与えているので Stripe と一致している必要がある）。
  const grace = await input.admin
    .from(CAREER_SUBSCRIPTIONS_TABLE)
    .select(columns)
    .eq('status', 'canceled')
    .gt('current_period_end', input.nowIso)
    .order('updated_at', { ascending: true })
    .limit(input.limit);
  if (grace.error) return { rows: [], error: grace.error.message ?? 'select failed' };

  // 同一 subscription が両方に出ることは無い（status が排他）が、念のため一意化する。
  const seen = new Set<string>();
  const rows: CareerReconcileRow[] = [];
  for (const r of [...(active.data ?? []), ...(grace.data ?? [])] as CareerReconcileRow[]) {
    if (!r?.stripe_subscription_id || seen.has(r.stripe_subscription_id)) continue;
    seen.add(r.stripe_subscription_id);
    rows.push(r);
  }
  return { rows, error: null };
}

/**
 * DB 行と Stripe の現在値が **意味的に**一致しているか。
 *
 * ここで見るのは entitlement に効く 3 つだけ（status / cancel_at_period_end /
 * current_period_end）。updated_at のような運用列の差分で「repaired」とは数えない
 * ＝ 一致している行に無駄な書き込みを発生させない。
 */
export type CareerStripeSubscriptionView = {
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
};

export function isCareerSubscriptionInSync(
  row: CareerReconcileRow,
  view: CareerStripeSubscriptionView,
): boolean {
  return (
    row.status === view.status &&
    row.cancel_at_period_end === view.cancelAtPeriodEnd &&
    sameInstant(row.current_period_end, view.currentPeriodEnd)
  );
}

/** Stripe Subscription から比較用の view を作る（純関数）。 */
export function toCareerStripeSubscriptionView(sub: {
  status: unknown;
  cancel_at_period_end?: unknown;
  items?: { data?: { current_period_end?: number | null }[] };
}): CareerStripeSubscriptionView {
  const item = sub.items?.data?.[0];
  return {
    status: String(sub.status),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    currentPeriodEnd:
      item?.current_period_end != null
        ? new Date(item.current_period_end * 1000).toISOString()
        : null,
  };
}

/** timestamptz の表記揺れ（+00:00 と Z など）を吸収して同時刻か判定する。 */
export function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
}

export type CareerReconcileDeps = {
  /** 候補行の読み出し。 */
  listCandidates: (limit: number, nowIso: string) => Promise<{ rows: CareerReconcileRow[]; error: string | null }>;
  /** Stripe の現在 snapshot。 */
  fetchSubscription: (subscriptionId: string) => Promise<CareerSubscriptionFetch>;
  /** DB への反映（webhook と同じ writer に委譲する）。 */
  syncOne: (subscriptionId: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 観測ログ（PII / secret を出さない）。 */
  log?: (line: string) => void;
};

/**
 * reconcile 本体。
 *
 * ★ 1 件の失敗で全体を止めない（§19）。Stripe API error / DB error はその 1 件だけ
 *   skip して集計に残し、次の候補へ進む。systemic failure（候補が 1 件も読めない等）は
 *   呼び出し側へ error として返す。
 * ★ 冪等。同じ状態で 2 回走らせても 2 回目は全件 unchanged になり、行も権利も動かない。
 */
export async function reconcileCareerSubscriptions(input: {
  deps: CareerReconcileDeps;
  limit?: number;
  dryRun?: boolean;
  nowMs?: number;
}): Promise<{ summary: CareerReconcileSummary; error: string | null }> {
  const dryRun = input.dryRun === true;
  const limit = clampLimit(input.limit);
  const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
  const log = input.deps.log ?? (() => {});

  const listed = await input.deps.listCandidates(limit, nowIso);
  if (listed.error) {
    return {
      summary: { ...EMPTY_SUMMARY, dryRun },
      error: `candidate select failed: ${listed.error}`,
    };
  }

  const rows = listed.rows;
  const summary: CareerReconcileSummary = {
    ...EMPTY_SUMMARY,
    truncated: rows.length >= limit,
    dryRun,
  };

  for (const row of rows) {
    summary.processed += 1;
    const outcome = await reconcileOne({ row, deps: input.deps, dryRun });
    summary[outcome] += 1;
  }

  // 実値（subscription id / user_id）は出さない。件数だけ。
  log(
    `[career/reconcile] processed=${summary.processed} repaired=${summary.repaired} ` +
      `unchanged=${summary.unchanged} stripe_missing=${summary.stripe_missing} ` +
      `stripe_error=${summary.stripe_error} db_error=${summary.db_error} ` +
      `truncated=${summary.truncated} dryRun=${dryRun}`,
  );
  if (summary.truncated) {
    log(
      `[career/reconcile] candidate limit (${limit}) reached — 一部の subscription は今回検査していない`,
    );
  }

  return { summary, error: null };
}

async function reconcileOne(input: {
  row: CareerReconcileRow;
  deps: CareerReconcileDeps;
  dryRun: boolean;
}): Promise<CareerReconcileOutcome> {
  const { row, deps, dryRun } = input;

  let fetched: CareerSubscriptionFetch;
  try {
    fetched = await deps.fetchSubscription(row.stripe_subscription_id);
  } catch {
    // deps が想定外に throw しても cron 全体は止めない。
    return 'stripe_error';
  }

  // ★ Stripe に無い行を DELETE しない。観測できる状態にして人間に判断を委ねる。
  if (fetched.kind === 'missing') return 'stripe_missing';
  if (fetched.kind === 'error') return 'stripe_error';

  const view = toCareerStripeSubscriptionView(fetched.sub);

  // ★ 一致していれば **一切書かない**。updated_at すら動かさないので、
  //   何度走らせても行も権利も揺れない（冪等 / §27 unnecessary semantic change なし）。
  if (isCareerSubscriptionInSync(row, view)) return 'unchanged';

  // drift あり。dryRun では「直すはずだった」件数だけ数えて書かない。
  if (dryRun) return 'repaired';

  const written = await safeSync(deps, row.stripe_subscription_id);
  return written.ok ? 'repaired' : 'db_error';
}

async function safeSync(
  deps: CareerReconcileDeps,
  subscriptionId: string,
): Promise<{ ok: boolean }> {
  try {
    const r = await deps.syncOne(subscriptionId);
    return { ok: r.ok };
  } catch {
    return { ok: false };
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return CAREER_RECONCILE_DEFAULT_LIMIT;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  return Math.min(n, CAREER_RECONCILE_MAX_LIMIT);
}

/** 実 Stripe / 実 Project B に接続する既定の deps。 */
export function buildCareerReconcileDeps(admin: SupabaseClient): CareerReconcileDeps {
  return {
    listCandidates: (limit, nowIso) =>
      selectCareerReconcileCandidates({ admin, limit, nowIso }),
    // Stripe 読み取りは stripe.ts の唯一の入口を使う。
    fetchSubscription: (id) => retrieveCareerSubscription(id),
    // 書き込みは webhook と同じ writer（mapping を二重実装しない）。
    syncOne: async (id) => {
      const result = await syncCareerSubscriptionById({ admin, subscriptionId: id });
      return result.kind === 'ok'
        ? { ok: true }
        : { ok: false, reason: result.kind };
    },
    log: (line) => console.info(line),
  };
}
