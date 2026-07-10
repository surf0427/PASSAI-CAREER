/**
 * Consent Ledger — withdrawal / account deletion の pure impact plan（P14-C）。
 *
 * 集計 system が将来何をすべきかを **技術的アクション**と**法務確認事項**に分けて返す。
 * 法的結論を断定しない。production の集計処理・削除処理には接続しない。
 */

import type {
  AccountDeletionImpactPlan,
  ConsentScope,
  WithdrawalImpactPlan,
} from '@/types/careerConsent';

/**
 * withdrawal 発生時の impact plan（pure）。
 * 技術: 将来利用停止・以降 event 除外・open bucket 再計算候補・cache 失効。
 * 法務: closed aggregate からの寄与除去義務・過去表示・backup・匿名化済みへの撤回範囲。
 */
export function buildWithdrawalImpactPlan(input: { scope: ConsentScope }): WithdrawalImpactPlan {
  const technicalActions: WithdrawalImpactPlan['technicalActions'] = [
    'stop_future_use',
    'exclude_events_after_effective_at',
    'recompute_open_buckets',
    'invalidate_cached_aggregates',
  ];
  if (input.scope === 'ai_context_aggregated_insight') technicalActions.push('stop_ai_context_use');
  if (input.scope === 'user_facing_aggregated_insight') technicalActions.push('stop_user_facing_use');

  const legalReviewItems: string[] = [
    'contribution_removal_from_closed_aggregate',
    'previously_displayed_aggregate_handling',
    'backup_ledger_and_aggregate',
    'historical_report_retention',
    'withdrawal_scope_on_anonymized_aggregate',
  ];
  return { technicalActions, legalReviewItems };
}

/**
 * account deletion の impact plan（pure）。
 * auth account 削除 / source event 削除 / consent ledger 削除 / aggregate 再計算 /
 * cache 失効 / backup 失効 / legal evidence 保持 を **混同しない**。
 */
export function buildAccountDeletionImpactPlan(): AccountDeletionImpactPlan {
  const technicalActions: AccountDeletionImpactPlan['technicalActions'] = [
    'stop_new_consent_grant',
    'deactivate_all_aggregate_scopes',
    'stop_future_event_eligibility',
    'request_raw_event_deletion',
    'recompute_open_buckets',
    'invalidate_cached_aggregates',
    'stop_ai_context_use',
    'reregistration_is_separate_subject',
  ];
  const legalReviewItems: string[] = [
    'consent_ledger_retention_or_deletion',
    'aggregate_recompute_obligation_after_deletion',
    'consent_evidence_retention_after_deletion',
    'backup_deletion',
    'minor_user_handling',
  ];
  return { technicalActions, legalReviewItems };
}
