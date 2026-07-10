/**
 * L2 Personal Event Signals — career_user_events から「本文なし・小さな傾向 signal」を作る純関数（P10-B）。
 *
 * 位置づけ（P10-A 設計監査で確定）:
 *   Event Log（L3）の生 row を AI へ直接渡さず、**直近 30 日の利用傾向**を短い Signal へ集約する。
 *   本モジュールは **その中核 pure builder のみ**。P10-B では以下へ一切接続しない:
 *     Supabase reader / CareerMemorySnapshot.signals populate / selector / orchestrator /
 *     renderer / prompt / consultation / matching。（＝body byte 不変・AI context 非接続を維持）
 *
 * 安全方針（本文・PII を Signal に入れない）:
 *   - 入力は feature / event_type / score_band / occurred_at のみ。**metadata は入力にも出力にも無い**。
 *   - 出力の string は「event feature enum / usage bucket / recency bucket / score band」の固定語彙のみ。
 *   - exact count / exact timestamp / id / company_id / client_event_id / user_id を持たない。
 *   - 弱み・次アクション・未利用領域など「推奨判断」は builder の責務外（上位 selector へ分離）。
 *
 * 決定論:
 *   - `now` を注入し、入力順に依存しない（集約 + canonical tie-break）。入力配列を mutation しない。
 *   - 30 日より古い / future / invalid / unknown feature・event_type は無視。有効 event ゼロなら null。
 */

import {
  CAREER_EVENT_FEATURES,
  CAREER_EVENT_TYPES,
  CAREER_SCORE_BANDS,
  type CareerEventFeature,
  type CareerScoreBand,
} from '@/types/careerEvents';

// ── v1 Schema ─────────────────────────────────────────────────────
export type CareerEventUsageBucket = '1' | '2-3' | '4+';
export type CareerEventRecencyBucket = '24h' | '7d' | '30d';
// band を保存している機能のみ（生スコアは扱わない）。
export type CareerEventBandFeature = 'matching' | 'presentation' | 'gd';
export type CareerEventBandRecency = '7d' | '30d';
export type CareerEventBandSignal = {
  band: CareerScoreBand;
  recency: CareerEventBandRecency;
};

/**
 * career_user_events 由来の L2 Personal Event Signal（v1）。
 * summary が無い（有効 event ゼロ）状態は builder が `null` を返して表す（`none` 表現は持たない）。
 */
export type CareerEventSignalSummary = {
  version: 1;
  windowDays: 30;
  /** 直近利用順・重複なし・最大 5 件（timestamp は持たない）。 */
  recentFeatures: CareerEventFeature[];
  /** key があれば利用あり（none は key なしで表す）。exact count は持たない。 */
  featureUsage: Partial<Record<CareerEventFeature, CareerEventUsageBucket>>;
  /** band を保存する matching / presentation / gd のみ。band が無い機能は key なし。 */
  latestBands?: Partial<Record<CareerEventBandFeature, CareerEventBandSignal>>;
  /** window 内で利用された異なる feature 数（小整数）。 */
  activeAreaCount: number;
  /** 最も新しい有効 event の経過時間 bucket。 */
  lastActivityRecency: CareerEventRecencyBucket;
};

/**
 * builder への最小入力 row（DB client 非依存）。metadata / id / user_id /
 * client_event_id / company_id / created_at は **入力に含めない**（本文混入経路を作らない）。
 */
export type CareerEventSignalSourceRow = {
  feature: unknown;
  event_type: unknown;
  score_band?: unknown;
  occurred_at: unknown;
};

// ── 定数 ─────────────────────────────────────────────────────────
const WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;
// reader が limit 100 を使う前提に合わせ builder も bounded にする（最新 100 件のみ集約）。
const MAX_SIGNAL_SOURCE_EVENTS = 100;
const MAX_RECENT_FEATURES = 5;
// band を持つ機能（canonical 出力順の source）。
const BAND_FEATURES: readonly CareerEventBandFeature[] = ['matching', 'presentation', 'gd'];

// canonical index（入力順非依存の tie-break 用。unknown は末尾へ）。
function featureIndex(feature: CareerEventFeature): number {
  const i = (CAREER_EVENT_FEATURES as readonly string[]).indexOf(feature);
  return i < 0 ? CAREER_EVENT_FEATURES.length : i;
}
function eventTypeIndex(eventType: string): number {
  const i = (CAREER_EVENT_TYPES as readonly string[]).indexOf(eventType);
  return i < 0 ? CAREER_EVENT_TYPES.length : i;
}
function bandIndex(band: CareerScoreBand | null): number {
  return band === null ? -1 : (CAREER_SCORE_BANDS as readonly string[]).indexOf(band);
}

// occurred_at を epoch ms へ正規化（string=Date.parse / number=そのまま）。無効は null。
function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function asFeatureOrNull(value: unknown): CareerEventFeature | null {
  return typeof value === 'string' && (CAREER_EVENT_FEATURES as readonly string[]).includes(value)
    ? (value as CareerEventFeature)
    : null;
}
function asEventTypeOrNull(value: unknown): string | null {
  return typeof value === 'string' && (CAREER_EVENT_TYPES as readonly string[]).includes(value)
    ? value
    : null;
}
function asBandOrNull(value: unknown): CareerScoreBand | null {
  return typeof value === 'string' && (CAREER_SCORE_BANDS as readonly string[]).includes(value)
    ? (value as CareerScoreBand)
    : null;
}

// 経過時間 → recency bucket（<=24h / <=7d / それ以外は 30d。window 内前提）。
function recencyBucket(elapsedMs: number): CareerEventRecencyBucket {
  if (elapsedMs <= DAY_MS) return '24h';
  if (elapsedMs <= 7 * DAY_MS) return '7d';
  return '30d';
}
// band 用 recency（7d / 30d のみ）。
function bandRecencyBucket(elapsedMs: number): CareerEventBandRecency {
  return elapsedMs <= 7 * DAY_MS ? '7d' : '30d';
}

// 件数 → usage bucket（1 / 2-3 / 4+）。0 件は呼ばない（key を作らない）。
function usageBucket(count: number): CareerEventUsageBucket {
  if (count <= 1) return '1';
  if (count <= 3) return '2-3';
  return '4+';
}

type NormalizedEvent = {
  feature: CareerEventFeature;
  eventType: string;
  band: CareerScoreBand | null;
  at: number; // occurred_at epoch ms（windowStart <= at <= now）
};

/**
 * Event rows → CareerEventSignalSummary（有効 event ゼロなら null）。純関数・deterministic。
 *
 * 手順（P10-A 設計）: 正規化/検証 → window 内のみ採用 → recency desc + canonical tie-break で
 * ソート → 最新 100 件へ cap → 集約。入力配列は mutation しない。
 *
 * 冪等性の注記: 本 builder は **意味的な重複除去をしない**。同じ内容の row が複数渡されると
 * 複数 event として集計され、usage bucket 境界を跨ぐことがある。重複防止の source of truth は
 * L3 DB の (user_id, client_event_id) partial unique index であり、builder の責務ではない。
 */
export function buildCareerEventSignalSummary(input: {
  events: readonly CareerEventSignalSourceRow[];
  now: number;
}): CareerEventSignalSummary | null {
  const { events, now } = input;
  if (!Number.isFinite(now)) return null;
  if (!Array.isArray(events) || events.length === 0) return null;

  const windowStart = now - WINDOW_MS;

  // 1. 正規化 + 検証（入力を mutation せず新配列へ）。window 外 / future / invalid / unknown は除外。
  const normalized: NormalizedEvent[] = [];
  for (const row of events) {
    if (!row || typeof row !== 'object') continue;
    const feature = asFeatureOrNull(row.feature);
    if (!feature) continue;
    const eventType = asEventTypeOrNull(row.event_type);
    if (!eventType) continue;
    const at = toEpochMs(row.occurred_at);
    if (at === null) continue;
    if (at < windowStart || at > now) continue; // 開始 inclusive / now inclusive
    // band は event 採用条件にしない（不正 band でも usage には数える）。
    normalized.push({ feature, eventType, band: asBandOrNull(row.score_band), at });
  }
  if (normalized.length === 0) return null;

  // 2. recency desc + canonical tie-break でソート（入力順非依存）→ 最新 100 件へ cap。
  normalized.sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    const fi = featureIndex(a.feature) - featureIndex(b.feature);
    if (fi !== 0) return fi;
    const ei = eventTypeIndex(a.eventType) - eventTypeIndex(b.eventType);
    if (ei !== 0) return ei;
    return bandIndex(a.band) - bandIndex(b.band);
  });
  const capped = normalized.slice(0, MAX_SIGNAL_SOURCE_EVENTS);

  // 3a. featureUsage / activeAreaCount（canonical key 順で挿入し JSON を安定化）。
  const counts = new Map<CareerEventFeature, number>();
  for (const e of capped) counts.set(e.feature, (counts.get(e.feature) ?? 0) + 1);
  const featureUsage: Partial<Record<CareerEventFeature, CareerEventUsageBucket>> = {};
  for (const feature of CAREER_EVENT_FEATURES) {
    const c = counts.get(feature);
    if (c && c > 0) featureUsage[feature] = usageBucket(c);
  }
  const activeAreaCount = counts.size;

  // 3b. recentFeatures（capped は recency desc なので first-seen で recency 順・canonical tie-break）。
  const recentFeatures: CareerEventFeature[] = [];
  const seen = new Set<CareerEventFeature>();
  for (const e of capped) {
    if (seen.has(e.feature)) continue;
    seen.add(e.feature);
    recentFeatures.push(e.feature);
    if (recentFeatures.length >= MAX_RECENT_FEATURES) break;
  }

  // 3c. lastActivityRecency（最も新しい有効 event = capped[0]）。
  const lastActivityRecency = recencyBucket(now - capped[0].at);

  // 3d. latestBands（matching / presentation / gd のみ・canonical 順・曖昧は省略）。
  const latestBands: Partial<Record<CareerEventBandFeature, CareerEventBandSignal>> = {};
  for (const bf of BAND_FEATURES) {
    const withBand = capped.filter((e) => e.feature === bf && e.band !== null);
    if (withBand.length === 0) continue;
    const maxAt = withBand.reduce((m, e) => (e.at > m ? e.at : m), withBand[0].at);
    const atMax = withBand.filter((e) => e.at === maxAt);
    const distinctBands = new Set(atMax.map((e) => e.band));
    // 同一 feature・同一 timestamp に異なる有効 band → 曖昧として省略（任意選択しない）。
    if (distinctBands.size !== 1) continue;
    const band = atMax[0].band as CareerScoreBand;
    latestBands[bf] = { band, recency: bandRecencyBucket(now - maxAt) };
  }

  const summary: CareerEventSignalSummary = {
    version: 1,
    windowDays: 30,
    recentFeatures,
    featureUsage,
    activeAreaCount,
    lastActivityRecency,
  };
  if (Object.keys(latestBands).length > 0) summary.latestBands = latestBands;
  return summary;
}
