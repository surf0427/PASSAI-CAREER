/**
 * Production server loader — Company Knowledge (Layer 5)（P17-C §11）。
 *
 * P17-A の disabled loader 契約は破壊しない（別 module）。repository を DI で受け取り、
 * 多重 gate 通過後に read repository の projection を返す。route / Orchestrator から import しない。
 *
 * 状態写像:
 *   flag OFF → disabled(flag_off) / readiness false → blocked(legal) / canary 外 → disabled(not_connected)
 *   それ以外は read repository の ContextSourceResult をそのまま返す
 *   （available は projection builder が privacy=shared_company_knowledge / usage=user_evidence_not_fact を保証）。
 *
 * pure DI・never-throw。
 */

import type { CanaryDecision } from '@/lib/careerDataSpineGate/canary';
import type {
  CompanyKnowledgeProjection,
  ContextSourceResult,
} from '@/types/careerContextSource';

export type CompanyKnowledgeServerDeps = {
  readRepository: {
    readProjection(query: {
      purpose: string;
      companyId: string;
      displayName: string;
      nowIso: string;
    }): Promise<ContextSourceResult<CompanyKnowledgeProjection>>;
  };
  isReadEnabled: boolean;
  isConsumerEnabled: boolean;
  readinessReady: boolean;
  canary: CanaryDecision;
  query: { purpose: string; companyId: string; displayName: string; nowIso: string };
};

export async function loadCompanyKnowledgeContextServer(
  deps: CompanyKnowledgeServerDeps,
): Promise<ContextSourceResult<CompanyKnowledgeProjection>> {
  try {
    if (!deps.isReadEnabled || !deps.isConsumerEnabled) return { status: 'disabled', reason: 'flag_off' };
    if (!deps.readinessReady) return { status: 'blocked', reason: 'legal' };
    if (!deps.canary.eligible) return { status: 'disabled', reason: 'not_connected' };

    const res = await deps.readRepository.readProjection(deps.query);
    // available 以外はそのまま（empty/unavailable/stale/blocked）。available は projection builder が
    // privacy/usage/provenance/confidence/freshness を保証済み。防御的に usage を確認する。
    if (res.status === 'available' && res.usage !== 'user_evidence_not_fact') {
      return { status: 'unavailable', reason: 'unknown' };
    }
    return res;
  } catch {
    return { status: 'unavailable', reason: 'unknown' };
  }
}
