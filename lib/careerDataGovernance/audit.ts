/**
 * Data Spine governance — audit event / monitoring signal builders（P17-B §12）。
 *
 * user identity / raw content / exact sensitive count を **含めない** pure builder。
 * 実 monitoring service へは送らない（型と生成のみ）。
 *
 * pure・決定論（Date.now 非使用。timestamp は呼び出し側が注入）。
 */

import type {
  AuditEventType,
  DataSpineAuditEvent,
  DataSpineComponent,
  MonitoringSeverity,
  MonitoringSignal,
  MonitoringSignalKind,
} from '@/types/careerDataGovernance';

/** exact count を出さず安全 bucket 文字列へ（monitoring 用）。 */
export function toCountBucket(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n === 0) return '0';
  if (n < 10) return '1–9';
  if (n < 50) return '10–49';
  if (n < 100) return '50–99';
  if (n < 500) return '100–499';
  return '500+';
}

/** audit event を作る（identity / raw を持ち込ませない・pure）。 */
export function buildAuditEvent(input: {
  eventType: AuditEventType;
  component: DataSpineComponent;
  subjectKey: string;
  correlationKey: string;
  occurredAt: string;
  reasonCode?: string | null;
  calculationVersion?: string | null;
  policyVersion?: number | null;
}): DataSpineAuditEvent {
  return {
    eventType: input.eventType,
    component: input.component,
    subjectKey: input.subjectKey,
    correlationKey: input.correlationKey,
    occurredAt: input.occurredAt,
    reasonCode: input.reasonCode ?? null,
    calculationVersion: input.calculationVersion ?? null,
    policyVersion: input.policyVersion ?? null,
  };
}

/** subjectKey / correlationKey に identity / raw が混じっていないか（防御的検査）。 */
const IDENTITY_MARKERS = ['@', 'user_id', 'email', 'name=', 'univ'];
export function isAuditPayloadSafe(e: DataSpineAuditEvent): boolean {
  const blob = `${e.subjectKey} ${e.correlationKey} ${e.reasonCode ?? ''}`.toLowerCase();
  return !IDENTITY_MARKERS.some((m) => blob.includes(m));
}

/** rate 系 monitoring signal（0..1）。 */
export function buildRateSignal(input: {
  kind: MonitoringSignalKind;
  component: DataSpineComponent;
  rate: number;
  observedAt: string;
  severity?: MonitoringSeverity;
  policyVersion?: number | null;
}): MonitoringSignal {
  const rate = Number.isFinite(input.rate) ? Math.min(1, Math.max(0, input.rate)) : 0;
  const severity: MonitoringSeverity =
    input.severity ?? (rate >= 0.5 ? 'critical' : rate >= 0.2 ? 'warning' : 'info');
  return {
    kind: input.kind,
    severity,
    component: input.component,
    rate,
    countBucket: null,
    observedAt: input.observedAt,
    policyVersion: input.policyVersion ?? null,
  };
}

/** count 系 monitoring signal（生 count を出さず bucket）。 */
export function buildCountSignal(input: {
  kind: MonitoringSignalKind;
  component: DataSpineComponent;
  count: number;
  observedAt: string;
  severity?: MonitoringSeverity;
  policyVersion?: number | null;
}): MonitoringSignal {
  return {
    kind: input.kind,
    severity: input.severity ?? 'info',
    component: input.component,
    rate: null,
    countBucket: toCountBucket(input.count),
    observedAt: input.observedAt,
    policyVersion: input.policyVersion ?? null,
  };
}

/** monitoring signal に exact count / identity が載っていないか（防御的検査）。 */
export function isMonitoringSignalSafe(s: MonitoringSignal): boolean {
  // rate は 0..1、count は bucket 文字列のみ。raw number の count field を持たない構造。
  const bucketOk = s.countBucket === null || /^(0|1–9|10–49|50–99|100–499|500\+)$/.test(s.countBucket);
  const rateOk = s.rate === null || (s.rate >= 0 && s.rate <= 1);
  return bucketOk && rateOk;
}
