// PASSAI CAREER — purpose 単位の server context 解決（Batch 2 / `D-S6`）。
//
// Batch 1 までは purpose ごとに `loadServerBaseContext` を呼び、base（profile/activity/values）だけを
// server 化していた。Batch 2 では **cross-feature source（self_analysis / es / matching /
// company_research / consultation / presentation / interview）も同じ 1 回の read で解決**する。
//
// なぜ 1 回にまとめるか:
//   - Layer 1 read を purpose あたり 2 回打たない（latency / DB 負荷）。
//   - base と cross-feature で **同じ mirror snapshot** を見る（read skew を作らない）。
//   - observability を purpose あたり 1 件に保つ（counters の二重計上を防ぐ）。
//
// base の判定意味論は `loadServerBaseContext` と **同一**（`decideBaseContextSource`）:
//   3 base kind が全部 verified、かつ実データがある場合のみ server base を使う。
//   cross-feature は **kind 単位**で独立に判定する（`D-S1` の section isolation）。
//
// 厳守:
//   - server-only / service role なし / owner-scoped RLS のみ。
//   - never-throw / fail-open（何が起きても bridge へ倒す）。
//   - PII・本文・UUID を log しない。

import 'server-only';

import type { CareerContextPurpose } from '@/lib/careerContext/purpose';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import {
  EMPTY_CAREER_SOURCE_BUNDLE,
  type CareerSourceBundle,
  type CareerSourceKind,
} from '@/lib/careerSourceData/types';
import {
  BASE_CONTEXT_SOURCE_KINDS,
  decideBaseContextSource,
  type BaseContextDecisionReason,
} from './baseContextPolicy';
import {
  loadVerifiedCrossFeatureSources,
  serverOnlyBundle,
  type CrossFeatureSourceResult,
  type SourceOrigin,
} from './crossFeatureSources.server';

export type PurposeServerContext = {
  /** null なら base は従来どおり request body を使う。 */
  base: {
    profile: CareerProfileInput | null;
    activity: CareerActivityInput | null;
    values: CareerValuesInput | null;
  } | null;
  /** base の判定理由（観測用・既存 enum と互換）。 */
  baseReason: BaseContextDecisionReason;
  /** verified な kind だけ実データが入った bundle（selector へ渡す安全形）。 */
  sources: CareerSourceBundle;
  /** kind → 'server' | 'bridge'。route はこれを見て per-field に採用元を決める。 */
  origin: Readonly<Record<CareerSourceKind, SourceOrigin>>;
  /** purpose 全体の状態（観測用）。 */
  status: CrossFeatureSourceResult['status'];
  /** kind → sync verdict（観測用。null なら評価に至っていない）。 */
  verdicts: CrossFeatureSourceResult['verdicts'];
};

function hasAnyBaseData(b: CareerSourceBundle): boolean {
  if (b.profile && Object.keys(b.profile).length > 0) return true;
  if (b.activity && Object.keys(b.activity).length > 0) return true;
  if (b.values) return true;
  return false;
}

/**
 * purpose が必要とする kind を 1 回で解決する（never-throw・fail-open）。
 *
 * `kinds` には base 3 kind を **含めて**渡すこと（base も同じ read で解決するため）。
 */
export async function loadPurposeServerContext(
  purpose: CareerContextPurpose,
  kinds: readonly CareerSourceKind[],
  req?: Request,
  loader = loadVerifiedCrossFeatureSources,
): Promise<PurposeServerContext> {
  try {
    const result = await loader(purpose, kinds, req);
    const sources = serverOnlyBundle(result);

    // base は「3 kind すべて server」かつ「実データあり」のときだけ採用（既存意味論と同一）。
    const wantsBase = BASE_CONTEXT_SOURCE_KINDS.every((k) => kinds.includes(k));
    const baseAllServer =
      wantsBase && BASE_CONTEXT_SOURCE_KINDS.every((k) => result.origin[k] === 'server');
    const decision = decideBaseContextSource(
      result.status !== 'purpose_disabled' && result.status !== 'user_not_canary',
      result.statuses,
      wantsBase && hasAnyBaseData(sources),
      baseAllServer,
    );

    const baseReason: BaseContextDecisionReason =
      result.status === 'purpose_disabled'
        ? 'flag_off'
        : result.status === 'user_not_canary'
          ? 'user_not_canary'
          : decision.reason;

    return {
      base: decision.useServerSource
        ? {
            profile: (sources.profile as CareerProfileInput | null) ?? null,
            activity: (sources.activity as CareerActivityInput | null) ?? null,
            values: (sources.values as CareerValuesInput | null) ?? null,
          }
        : null,
      baseReason,
      sources,
      origin: result.origin,
      status: result.status,
      verdicts: result.verdicts,
    };
  } catch {
    const origin = {} as Record<CareerSourceKind, SourceOrigin>;
    for (const k of kinds) origin[k] = 'bridge';
    return {
      base: null,
      baseReason: 'source_unavailable',
      sources: EMPTY_CAREER_SOURCE_BUNDLE,
      origin,
      status: 'bridge_fallback',
      verdicts: null,
    };
  }
}
