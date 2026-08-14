// PASSAI CAREER — purpose resolver 共通の source 別観測整形（Batch 2）。
//
// `loadPurposeServerContext` の結果を canary counter が受け取れる **enum のみ**の形へ落とす。
// 純関数 / never-throw / 識別子・本文を一切含まない。

import type {
  CanaryPurposeCoverage,
  CanarySourceOrigin,
} from './observation';

type PurposeContextLike = {
  status: 'purpose_disabled' | 'user_not_canary' | 'full_server' | 'partial_server' | 'bridge_fallback';
  origin: Readonly<Record<string, CanarySourceOrigin>>;
  verdicts: Readonly<Record<string, string>> | null;
};

/** purpose 単位の server 化度合い（gate で落ちた場合は gated_off にまとめる）。 */
export function toPurposeCoverage(status: PurposeContextLike['status']): CanaryPurposeCoverage {
  if (status === 'purpose_disabled' || status === 'user_not_canary') return 'gated_off';
  return status;
}

/** 要求 kind に限定した origin map（要求していない kind を数えない）。 */
export function pickSourceOrigins(
  ctx: PurposeContextLike,
  kinds: readonly string[],
): Record<string, CanarySourceOrigin> {
  const out: Record<string, CanarySourceOrigin> = {};
  for (const k of kinds) out[k] = ctx.origin[k] ?? 'bridge';
  return out;
}

/**
 * structural bridge source（server-readable representation が存在しない）を観測に載せる。
 * `bridge`（safety fallback）と区別するため専用の値を使う（`D-S11`）。
 */
export function markStructuralBridges(
  sources: readonly string[],
): Record<string, CanarySourceOrigin> {
  const out: Record<string, CanarySourceOrigin> = {};
  for (const s of sources) out[s] = 'not_server_capable';
  return out;
}

/** 要求 kind に限定した verdict map（未評価なら空 = 何も数えない）。 */
export function pickSourceVerdicts(
  ctx: PurposeContextLike,
  kinds: readonly string[],
): Record<string, string> {
  if (!ctx.verdicts) return {};
  const out: Record<string, string> = {};
  for (const k of kinds) {
    const v = ctx.verdicts[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
