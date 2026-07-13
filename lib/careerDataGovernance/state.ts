/**
 * Data Spine governance — 状態評価 & ContextSourceResult 変換規則（P17-B §C）。
 *
 * governance 状態（generation/validation/privacy/publish/freshness/invalidation/rollback）を
 * 「serve してよいか」へ写像する pure logic。fail-closed。
 *
 * 優先順位（安全側から）:
 *   1. rollback 中 → blocked
 *   2. invalidation（consent_revoked / user_deleted 等）→ blocked
 *   3. generation failed / validation invalid / privacyReview failed → blocked
 *   4. privacyReview not_reviewed（未実施）→ blocked（fail-closed）
 *   5. generation 未完 / unvalidated / unpublished / withdrawn / lineage 欠落 → unavailable or blocked
 *   6. freshness stale/expired/unknown → stale
 *   7. それ以外 → serve
 *
 * pure。DB / Date.now 非依存。
 */

import type {
  GovernanceReadDisposition,
  GovernanceState,
} from '@/types/careerDataGovernance';

/** lineage が read に足るか（source window / calculation version / watermark 必須）。 */
function lineageSufficient(state: GovernanceState): boolean {
  const l = state.lineage;
  return (
    typeof l.sourceWindow === 'string' && l.sourceWindow !== '' &&
    typeof l.calculationVersion === 'string' && l.calculationVersion !== '' &&
    typeof l.inputWatermark === 'string' && l.inputWatermark !== ''
  );
}

export function evaluateGovernanceDisposition(
  state: GovernanceState,
): GovernanceReadDisposition {
  // 1. rollback。
  if (state.rollback !== null) {
    return { serve: false, status: 'blocked', reason: 'legal' };
  }
  // 2. invalidation（revoke / delete / legal 由来）。
  if (state.invalidation !== null) {
    const reason = state.invalidation === 'legal_hold' ? 'legal' : 'consent';
    return { serve: false, status: 'blocked', reason };
  }
  // 3. 明確な失敗。
  if (state.generation === 'failed') return { serve: false, status: 'blocked', reason: 'moderation' };
  if (state.validation === 'invalid') return { serve: false, status: 'blocked', reason: 'moderation' };
  if (state.privacyReview === 'failed') return { serve: false, status: 'blocked', reason: 'privacy' };
  // 4. privacy 未レビューは fail-closed（serve しない）。
  if (state.privacyReview === 'not_reviewed') return { serve: false, status: 'blocked', reason: 'privacy' };
  // 5. まだ生成/検証/公開が整っていない → unavailable（unknown と混同しない: not_checked）。
  if (state.generation === 'pending' || state.generation === 'generating') {
    return { serve: false, status: 'unavailable', reason: 'not_checked' };
  }
  if (state.validation === 'unvalidated') return { serve: false, status: 'unavailable', reason: 'not_checked' };
  if (state.publish === 'withdrawn') return { serve: false, status: 'blocked', reason: 'moderation' };
  if (state.publish === 'unpublished') return { serve: false, status: 'unavailable', reason: 'not_checked' };
  if (!lineageSufficient(state)) return { serve: false, status: 'unavailable', reason: 'lookup_error' };
  // 6. freshness。
  if (state.freshness === 'stale' || state.freshness === 'expired') {
    return { serve: false, status: 'stale', reason: 'freshness_expired' };
  }
  if (state.freshness === 'unknown') {
    return { serve: false, status: 'stale', reason: 'incomplete_batch' };
  }
  // 7. serve。
  return { serve: true };
}

/** serve 可能な「健全」default state を作る（fixture / test 用の起点）。 */
export function healthyGovernanceState(
  lineage: GovernanceState['lineage'],
  freshness: GovernanceState['freshness'] = 'fresh',
): GovernanceState {
  return {
    generation: 'generated',
    publish: 'published',
    validation: 'valid',
    privacyReview: 'passed',
    freshness,
    lineage,
    invalidation: null,
    rollback: null,
  };
}
