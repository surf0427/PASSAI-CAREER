// PASSAI CAREER — Consent capture surface gate（NEXT-7 / Data Spine）。
//
// 責務: 「ユーザー向けの同意取得 UI / API を通電してよいか」を決める **純粋判定**。env 読取は
//   captureGate.server.ts の責務。
//
// ★ fail-closed の設計理由:
//   同意取得は Layer 4 / Layer 5 の前提条件だが、**同意文言そのものは法務判断**（H-7 / BLOCKED_BY_LEGAL）。
//   コードが legal wording を勝手に確定しないよう、通電には次の 3 つが **すべて** 必要:
//     1. 明示の有効化 flag（運用判断）
//     2. policy manifest の legal review が承認済みであることを示す flag（法務判断）
//     3. Layer 別 readiness（既存 careerDataSpinePolicy の decision register）が満たされていること
//   どれか 1 つでも欠ければ surface は「利用不可」を返す（UI も出さない・event も書かない）。
//
// ★ ここで確定しないもの（意図的）:
//   - 同意文言 / notice 本文 / retention 期間 / minors policy / commercial scope
//     （すべて policy manifest 側の値であり、legal が確定して初めて active になる）。

import type { ConsentScope } from '@/types/careerConsent';
import {
  evaluateLayerReadiness,
  LAYER4_REQUIRED_DECISIONS,
  LAYER5_REQUIRED_DECISIONS,
  type ReadinessConfig,
} from '@/lib/careerDataSpinePolicy/readiness';

// capture surface が扱う scope（personal_service_processing は通常サービス処理なので capture 対象外）。
//   ★ 集合的知能 / 共有に関わる scope のみを明示 opt-in の対象にする。
export const CONSENT_CAPTURE_SCOPES: readonly ConsentScope[] = [
  'internal_aggregated_analytics',
  'user_facing_aggregated_insight',
  'ai_context_aggregated_insight',
  'externally_shared_insight',
  'company_knowledge_contribution',
];

// scope → 依存する Layer（readiness の必要 decision 集合を選ぶ）。
export function requiredDecisionsForScope(scope: ConsentScope): readonly string[] {
  return scope === 'externally_shared_insight' || scope === 'company_knowledge_contribution'
    ? LAYER5_REQUIRED_DECISIONS
    : LAYER4_REQUIRED_DECISIONS;
}

export type ConsentCaptureBlockReason =
  | 'flag_off'
  | 'legal_not_approved'
  | 'readiness_incomplete'
  | 'scope_not_capturable';

export type ConsentCaptureGateResult =
  | { enabled: true; scopes: readonly ConsentScope[] }
  | { enabled: false; reason: ConsentCaptureBlockReason; blockedScopes: readonly ConsentScope[] };

const TRUE_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes']);
function isTrue(raw: unknown): boolean {
  return typeof raw === 'string' && TRUE_VALUES.has(raw.trim().toLowerCase());
}

export function evalConsentCaptureFlag(raw: unknown): boolean {
  return isTrue(raw);
}

/** policy manifest の法務承認 flag（未設定 / false は「未承認」）。 */
export function evalConsentLegalApproved(raw: unknown): boolean {
  return isTrue(raw);
}

/**
 * capture surface を通電してよいか（純粋・fail-closed）。
 * 有効な scope が 1 つも無ければ enabled=false（部分的に開ける場合は開いた scope のみ返す）。
 */
export function evaluateConsentCaptureGate(
  enabledRaw: unknown,
  legalApprovedRaw: unknown,
  readiness: ReadinessConfig | null | undefined,
): ConsentCaptureGateResult {
  if (!evalConsentCaptureFlag(enabledRaw)) {
    return { enabled: false, reason: 'flag_off', blockedScopes: CONSENT_CAPTURE_SCOPES };
  }
  if (!evalConsentLegalApproved(legalApprovedRaw)) {
    return { enabled: false, reason: 'legal_not_approved', blockedScopes: CONSENT_CAPTURE_SCOPES };
  }
  const scopes = CONSENT_CAPTURE_SCOPES.filter((scope) => {
    const required = requiredDecisionsForScope(scope) as readonly never[];
    return evaluateLayerReadiness(readiness, required).ready;
  });
  if (scopes.length === 0) {
    return { enabled: false, reason: 'readiness_incomplete', blockedScopes: CONSENT_CAPTURE_SCOPES };
  }
  return { enabled: true, scopes };
}

/** gate 結果に対して、その scope の capture が許可されているか（default deny）。 */
export function isScopeCapturable(
  gate: ConsentCaptureGateResult,
  scope: unknown,
): scope is ConsentScope {
  if (!gate.enabled) return false;
  return typeof scope === 'string' && (gate.scopes as readonly string[]).includes(scope);
}
