// PASSAI CAREER — Consent capture surface gate の env 読取（NEXT-7 / server-only）。
//
// env（server-only。NEXT_PUBLIC_ 禁止＝client bundle へ出さない）:
//   - CAREER_CONSENT_CAPTURE_ENABLED       : 運用側の明示有効化（未設定 = OFF）。
//   - CAREER_CONSENT_POLICY_LEGAL_APPROVED : policy manifest の法務承認済み（未設定 = 未承認）。
//   - CAREER_DATA_SPINE_READY_*            : 既存の decision register（careerDataSpinePolicy）。
//
// ★ 3 つすべてが揃わない限り surface は開かない（fail-closed）。値は log しない。

import 'server-only';

import { getServerReadinessConfig } from '@/lib/careerDataSpinePolicy/config.server';
import {
  evaluateConsentCaptureGate,
  type ConsentCaptureGateResult,
} from './captureGate';

export const CAREER_CONSENT_CAPTURE_ENABLED_ENV = 'CAREER_CONSENT_CAPTURE_ENABLED';
export const CAREER_CONSENT_POLICY_LEGAL_APPROVED_ENV = 'CAREER_CONSENT_POLICY_LEGAL_APPROVED';

/** server env + readiness register から capture gate を評価する（default closed）。 */
export function loadConsentCaptureGate(): ConsentCaptureGateResult {
  return evaluateConsentCaptureGate(
    process.env[CAREER_CONSENT_CAPTURE_ENABLED_ENV],
    process.env[CAREER_CONSENT_POLICY_LEGAL_APPROVED_ENV],
    getServerReadinessConfig(),
  );
}
