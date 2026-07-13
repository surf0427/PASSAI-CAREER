/**
 * Company Knowledge (Layer 5) — explicit-share consent snapshot（P17-B §5）。
 *
 * 既存 consent 方針（append-only・現在値は導出）を踏襲した offline snapshot。
 * consent text / commercial 可否は **仮決定しない**（permitted/prohibited uses は PROVISIONAL 入力）。
 *
 * pure・決定論。DB / private research へ接続しない。
 */

import type {
  CompanyKnowledgeConsentSnapshot,
  ConsentActorClass,
  ConsentEffectiveState,
} from '@/types/careerCompanyKnowledge';

export const COMPANY_KNOWLEDGE_CONSENT_POLICY_VERSION = 1;

/** grant snapshot を作る（pure）。commercial 可否は確定しないため既定 prohibited へ含めない。 */
export function buildGrantSnapshot(input: {
  contributionId: string;
  grantedAt: string;
  consentSource?: CompanyKnowledgeConsentSnapshot['consentSource'];
  actorClass?: ConsentActorClass;
  permittedUses?: readonly string[];
  prohibitedUses?: readonly string[];
  snapshotVersion?: number;
}): CompanyKnowledgeConsentSnapshot {
  return {
    contributionId: input.contributionId,
    scope: 'company_knowledge_contribution',
    policyVersion: COMPANY_KNOWLEDGE_CONSENT_POLICY_VERSION,
    grantedAt: input.grantedAt,
    revokedAt: null,
    consentSource: input.consentSource ?? 'explicit_ui',
    actorClass: input.actorClass ?? 'contributor',
    // commercial_utilization は確定していないため permitted に **含めない**（default deny）。
    permittedUses: input.permittedUses ?? ['aggregated_display', 'ai_context_reference'],
    prohibitedUses: input.prohibitedUses ?? ['commercial_resale', 'contributor_identification'],
    snapshotVersion: input.snapshotVersion ?? 1,
  };
}

/** revoke を適用した新 snapshot を返す（version を進める・append-only 志向）。 */
export function applyRevoke(
  snapshot: CompanyKnowledgeConsentSnapshot,
  revokedAt: string,
): CompanyKnowledgeConsentSnapshot {
  return { ...snapshot, revokedAt, snapshotVersion: snapshot.snapshotVersion + 1 };
}

/** 現在の consent 有効状態を導出する（pure）。 */
export function deriveConsentEffectiveState(
  snapshot: CompanyKnowledgeConsentSnapshot | null | undefined,
): ConsentEffectiveState {
  if (!snapshot || snapshot.grantedAt === null) return 'never_granted';
  if (snapshot.revokedAt !== null) return 'revoked';
  return 'granted';
}

/** read/publish に足る consent か（granted のみ）。 */
export function isConsentEffectiveForShare(
  snapshot: CompanyKnowledgeConsentSnapshot | null | undefined,
): boolean {
  return deriveConsentEffectiveState(snapshot) === 'granted';
}

/** ある用途が許可されているか（default deny・prohibited が優先）。 */
export function isUsePermitted(
  snapshot: CompanyKnowledgeConsentSnapshot | null | undefined,
  use: string,
): boolean {
  if (!isConsentEffectiveForShare(snapshot)) return false;
  const s = snapshot as CompanyKnowledgeConsentSnapshot;
  if (s.prohibitedUses.includes(use)) return false;
  return s.permittedUses.includes(use);
}
