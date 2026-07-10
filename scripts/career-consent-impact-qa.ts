/*
 * scripts/career-consent-impact-qa.ts
 *
 * PASSAI CAREER — withdrawal / account deletion impact plan QA（P14-C・H. Impact）。
 *
 * 何を守るか（P14-C §16 / §17 / §22-H）:
 *   - withdrawal: future 停止 / 以降 event 除外 / open bucket 再計算 / cache 失効。
 *   - AI scope withdrawal は AI 停止 / UF scope withdrawal は UF 停止。
 *   - closed aggregate からの寄与除去は LEGAL REVIEW。
 *   - deletion: new grant 停止 / raw deletion 要求 / re-registration は別 subject。
 *   - raw deletion（技術）と aggregate recompute（法務）を混同しない。
 *
 * 使い方: npx tsx scripts/career-consent-impact-qa.ts
 */

import { buildWithdrawalImpactPlan, buildAccountDeletionImpactPlan } from '@/lib/careerConsent/impact';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('[1] withdrawal impact');
{
  const uf = buildWithdrawalImpactPlan({ scope: 'user_facing_aggregated_insight' });
  check('stop_future_use', uf.technicalActions.includes('stop_future_use'));
  check('exclude_events_after_effective_at', uf.technicalActions.includes('exclude_events_after_effective_at'));
  check('recompute_open_buckets', uf.technicalActions.includes('recompute_open_buckets'));
  check('invalidate_cached_aggregates', uf.technicalActions.includes('invalidate_cached_aggregates'));
  check('user-facing withdrawal → stop_user_facing_use', uf.technicalActions.includes('stop_user_facing_use'));
  check('closed aggregate は legal review', uf.legalReviewItems.includes('contribution_removal_from_closed_aggregate'));

  const ai = buildWithdrawalImpactPlan({ scope: 'ai_context_aggregated_insight' });
  check('AI withdrawal → stop_ai_context_use', ai.technicalActions.includes('stop_ai_context_use'));
  check('AI withdrawal は UF 停止を含めない', !ai.technicalActions.includes('stop_user_facing_use'));
}

console.log('[2] account deletion impact');
{
  const d = buildAccountDeletionImpactPlan();
  check('stop_new_consent_grant', d.technicalActions.includes('stop_new_consent_grant'));
  check('deactivate_all_aggregate_scopes', d.technicalActions.includes('deactivate_all_aggregate_scopes'));
  check('request_raw_event_deletion（技術）', d.technicalActions.includes('request_raw_event_deletion'));
  check('reregistration_is_separate_subject', d.technicalActions.includes('reregistration_is_separate_subject'));
  check('aggregate recompute 義務は legal review', d.legalReviewItems.includes('aggregate_recompute_obligation_after_deletion'));
  check('consent ledger retention は legal review', d.legalReviewItems.includes('consent_ledger_retention_or_deletion'));
  // raw deletion（技術）と aggregate recompute（法務）が別項目で分離されている。
  check('raw deletion と aggregate recompute を混同しない', d.technicalActions.includes('request_raw_event_deletion') && !d.technicalActions.some((a) => a.includes('recompute_after_deletion')) && d.legalReviewItems.some((l) => l.includes('aggregate_recompute')));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
