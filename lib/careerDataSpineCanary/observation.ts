// PASSAI CAREER — Canary observability の正規化（純関数・PII フリー）。
//
// 責務: Personal Memory read / Server Context / Source-Sync の構造化結果を、
//   **enum だけの観測語彙** へ正規化する。H-4 rollout 判断の evidence 源。
//
// ★★ 絶対に載せないもの ★★
//   raw profile / ES 本文 / interview 回答 / self-analysis 本文 / consultation 本文 /
//   email / name / prompt / AI response / **UUID そのもの**。
//   本 module が扱うのは固定 enum と件数のみ（型で担保し、QA が静的に検査する）。

import type { CareerContextPurpose } from '@/lib/careerContext/purpose';

// ── Source-Sync 観測語彙 ────────────────────────────────────────────
export type CanarySyncOutcome =
  | 'verified'
  | 'unclaimed'
  | 'mismatch'
  | 'unreadable'
  | 'invalid'; // signal 自体が parse 不能 / version 不一致（wire レベルの不正）

export const CANARY_SYNC_OUTCOMES: readonly CanarySyncOutcome[] = [
  'verified', 'unclaimed', 'mismatch', 'unreadable', 'invalid',
];

// ── Personal Memory 観測語彙 ────────────────────────────────────────
export type CanaryMemoryOutcome =
  | 'persisted' // 永続 row が検証済み Source と一致して採用された
  | 'rebuilt'   // 検証済み Source から request-local に再構築して採用された
  | 'stale'     // 永続 row が Source と不一致（rebuild 無効時に不採用）
  | 'invalid'   // row が validation / schema を通らなかった
  | 'omitted';  // veto / 読取不能 / gate deny 等で Memory を使わなかった

export const CANARY_MEMORY_OUTCOMES: readonly CanaryMemoryOutcome[] = [
  'persisted', 'rebuilt', 'stale', 'invalid', 'omitted',
];

// ── Server Context 観測語彙 ─────────────────────────────────────────
export type CanaryContextOutcome =
  | 'server_context_used'
  | 'bridge_fallback'
  | 'sync_unverified'
  | 'purpose_disabled'
  | 'user_not_canary';

export const CANARY_CONTEXT_OUTCOMES: readonly CanaryContextOutcome[] = [
  'server_context_used', 'bridge_fallback', 'sync_unverified', 'purpose_disabled', 'user_not_canary',
];

// ── Batch 2: source kind 別の観測 ───────────────────────────────────
// 「purpose 全体」ではなく「どの source が server 化できたか / なぜ落ちたか」を見るための enum。
// 記録するのは **kind 名と enum の組だけ**（件数のみ。識別子・本文は持たない）。
export type CanarySourceOrigin = 'server' | 'bridge';
export const CANARY_SOURCE_ORIGINS: readonly CanarySourceOrigin[] = ['server', 'bridge'];

/** purpose 単位の server 化度合い。partial は「一部 kind だけ server」。 */
export type CanaryPurposeCoverage = 'full_server' | 'partial_server' | 'bridge_fallback' | 'gated_off';
export const CANARY_PURPOSE_COVERAGES: readonly CanaryPurposeCoverage[] = [
  'full_server', 'partial_server', 'bridge_fallback', 'gated_off',
];

/** 1 request 分の観測（enum + 件数のみ。識別子を持たない）。 */
export type CanaryObservation = {
  purpose: CareerContextPurpose;
  sync: CanarySyncOutcome | null;
  memory: CanaryMemoryOutcome | null;
  context: CanaryContextOutcome | null;
  /** prompt へ載った Personal Memory section 数（内容は含まない）。 */
  memorySectionCount: number;
  /** Batch 2: source kind → 採用元（enum のみ。省略可）。 */
  sourceOrigins?: Readonly<Record<string, CanarySourceOrigin>> | null;
  /** Batch 2: source kind → sync verdict（enum のみ。省略可）。 */
  sourceVerdicts?: Readonly<Record<string, string>> | null;
  /** Batch 2: purpose 単位の server 化度合い（省略可）。 */
  coverage?: CanaryPurposeCoverage | null;
};

// ── 正規化 ─────────────────────────────────────────────────────────

/** Personal Memory read の meta（enum のみの部分集合）。 */
export type MemoryMetaLike = {
  gate: 'disabled' | 'denied' | 'allowed';
  read: 'skipped' | 'ok' | 'empty' | 'error';
  sectionCount: number;
  sourceRead: string;
  origins: Readonly<Partial<Record<string, 'persisted' | 'rebuilt'>>>;
  vetoed: Readonly<Partial<Record<string, 'unreadable' | 'unclaimed' | 'mismatch'>>>;
};

/**
 * Personal Memory の代表 outcome を 1 つに畳む（純関数）。
 * 優先: invalid > stale > omitted > rebuilt > persisted
 *   （＝「使えなかった理由」を優先的に表面化し、成功で覆い隠さない）。
 */
export function normalizeMemoryOutcome(meta: MemoryMetaLike): CanaryMemoryOutcome {
  const vetoes = Object.values(meta.vetoed);
  // read できていない / gate 拒否 → omitted。
  if (meta.gate !== 'allowed' || meta.read === 'skipped') return 'omitted';
  if (meta.read === 'error') return 'invalid';
  if (vetoes.includes('mismatch')) return 'stale';       // Source と不一致（＝古い）
  if (vetoes.includes('unreadable')) return 'omitted';   // 読めない
  if (vetoes.includes('unclaimed')) return 'omitted';    // 証明の提示が無い
  const origins = Object.values(meta.origins);
  if (origins.includes('rebuilt')) return 'rebuilt';
  if (origins.includes('persisted')) return 'persisted';
  return 'omitted';
}

/**
 * Source-Sync の代表 outcome（memory meta の veto から導く）。
 *
 * ★ 返り値 null = 「sync を **評価していない**」。
 *   gate 拒否 / master OFF / 対象外 purpose では sync 検証自体が走らないため、
 *   veto が空でも `verified` と報告してはいけない（rollout 判断の verified 率が水増しされる）。
 *   2026-08-14 の canary 実機検証で検出した観測バグの修正。
 */
export function normalizeSyncOutcome(
  meta: MemoryMetaLike,
  signalPresent: boolean,
): CanarySyncOutcome | null {
  // sync が評価される前に打ち切られたケースは「未評価」。
  if (meta.gate !== 'allowed') return null;
  if (meta.read === 'skipped') return null;
  const vetoes = Object.values(meta.vetoed);
  if (vetoes.includes('unreadable')) return 'unreadable';
  if (vetoes.includes('mismatch')) return 'mismatch';
  if (vetoes.includes('unclaimed')) return signalPresent ? 'invalid' : 'unclaimed';
  return 'verified';
}

/** Server Context decision reason → 観測語彙。 */
export function normalizeContextOutcome(
  reason:
    | 'flag_off'
    | 'user_not_canary'
    | 'source_unavailable'
    | 'source_empty'
    | 'sync_unverified'
    | 'server_source',
): CanaryContextOutcome {
  switch (reason) {
    case 'server_source': return 'server_context_used';
    case 'flag_off': return 'purpose_disabled';
    case 'user_not_canary': return 'user_not_canary';
    case 'sync_unverified': return 'sync_unverified';
    // source_unavailable / source_empty は「server context を使わず bridge へ戻った」ケース。
    default: return 'bridge_fallback';
  }
}
