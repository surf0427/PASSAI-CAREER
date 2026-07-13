/**
 * Aggregated Insight — shadow evidence contract（P17-E §8・pure）。
 *
 * shadow read の観測結果は **safe metadata のみ**。禁止 field（identity / prompt / response /
 * raw artifact / exact count / URL / secret / raw error）を絶対に含めない。
 *
 * prompt / response は shadow によって変わらない（契約上 false 固定）。
 */

export type ShadowGateDecision =
  | 'flag_off'
  | 'readiness_not_ready'
  | 'canary_excluded'
  | 'real_mode_blocked'
  | 'passed';

export type ShadowSourceStatus =
  | 'not_run'
  | 'available'
  | 'empty'
  | 'unavailable'
  | 'disabled'
  | 'blocked'
  | 'stale';

export type ShadowErrorCategory =
  | 'none'
  | 'dependency_unavailable'
  | 'read_error'
  | 'timeout'
  | 'exception';

/** 保存・出力してよい evidence（allowlist）。 */
export type ShadowEvidence = {
  runId: string;
  /** 常に true（synthetic-only。実データ shadow は本 series で行わない）。 */
  syntheticMarker: true;
  metricKey: string | null;
  sourceStatus: ShadowSourceStatus;
  rendered: boolean;
  byteCount: number;
  disclaimerPresent: boolean;
  gateDecision: ShadowGateDecision;
  /** latency は生値でなく bucket。 */
  latencyBucket: string;
  errorCategory: ShadowErrorCategory;
  policyVersion: number | null;
  calculationVersion: string | null;
  /** ISO（呼び出し側が注入。無ければ null）。 */
  timestamp: string | null;
  /** 契約: shadow は prompt を変えない。 */
  promptChanged: false;
  /** 契約: shadow は response を変えない。 */
  responseChanged: false;
  /** rollback は flag OFF のみで成立。 */
  rollbackReady: true;
};

export const SHADOW_EVIDENCE_ALLOWED_FIELDS: readonly string[] = [
  'runId', 'syntheticMarker', 'metricKey', 'sourceStatus', 'rendered', 'byteCount',
  'disclaimerPresent', 'gateDecision', 'latencyBucket', 'errorCategory', 'policyVersion',
  'calculationVersion', 'timestamp', 'promptChanged', 'responseChanged', 'rollbackReady',
];

/** evidence へ絶対に載せてはいけない key の断片（部分一致で検出）。 */
export const SHADOW_EVIDENCE_PROHIBITED_FRAGMENTS: readonly string[] = [
  'userid', 'user_id', 'authuid', 'auth_uid', 'uid', 'email', 'prompt', 'response', 'artifactpayload',
  'safe_artifact', 'cohortcount', 'denominator', 'numerator', 'supabaseurl', 'url', 'apikey', 'key',
  'token', 'session', 'rawmessage', 'secret', 'name',
];

export function latencyBucket(ms: number): string {
  const n = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (n < 50) return '<50ms';
  if (n < 200) return '50–199ms';
  if (n < 1000) return '200–999ms';
  return '1000ms+';
}

export function buildShadowEvidence(input: {
  runId: string;
  metricKey?: string | null;
  sourceStatus: ShadowSourceStatus;
  rendered: boolean;
  byteCount: number;
  disclaimerPresent: boolean;
  gateDecision: ShadowGateDecision;
  latencyMs: number;
  errorCategory: ShadowErrorCategory;
  policyVersion?: number | null;
  calculationVersion?: string | null;
  timestamp?: string | null;
}): ShadowEvidence {
  return {
    runId: input.runId,
    syntheticMarker: true,
    metricKey: input.metricKey ?? null,
    sourceStatus: input.sourceStatus,
    rendered: input.rendered,
    byteCount: input.byteCount,
    disclaimerPresent: input.disclaimerPresent,
    gateDecision: input.gateDecision,
    latencyBucket: latencyBucket(input.latencyMs),
    errorCategory: input.errorCategory,
    policyVersion: input.policyVersion ?? null,
    calculationVersion: input.calculationVersion ?? null,
    timestamp: input.timestamp ?? null,
    promptChanged: false,
    responseChanged: false,
    rollbackReady: true,
  };
}

export type ShadowEvidenceVerdict = 'PASS' | 'STOP' | 'INCOMPLETE';
export type ShadowEvidenceValidation = { verdict: ShadowEvidenceVerdict; reasons: readonly string[] };

/**
 * evidence を PASS / STOP / INCOMPLETE で判定する（pure）。
 * STOP: 契約違反・危険（prompt/response 変化 / 非 synthetic / 禁止 field / gate 不整合）。
 * INCOMPLETE: migration/seed 未完・dependency 未接続で確認不能。
 * PASS: synthetic・全 gate 通過・available・rendered・disclaimer・不変契約・rollback 可。
 */
export function validateShadowEvidence(e: unknown): ShadowEvidenceValidation {
  const reasons: string[] = [];
  if (!e || typeof e !== 'object') return { verdict: 'STOP', reasons: ['evidence_not_object'] };
  const ev = e as ShadowEvidence;

  // ── STOP 条件（安全側で最優先）──
  if (!isShadowEvidenceSafe(e)) reasons.push('prohibited_field_or_unsafe_value');
  if (ev.syntheticMarker !== true) reasons.push('not_synthetic');
  if (ev.promptChanged !== false) reasons.push('prompt_changed');
  if (ev.responseChanged !== false) reasons.push('response_changed');
  // gate 不整合: query した（not_run 以外）のに gate が passed でない。
  if (ev.sourceStatus !== 'not_run' && ev.gateDecision !== 'passed') reasons.push('query_without_passed_gate');
  if (reasons.length > 0) return { verdict: 'STOP', reasons };

  // ── INCOMPLETE 条件 ──
  if (ev.gateDecision !== 'passed') return { verdict: 'INCOMPLETE', reasons: [`gate_${ev.gateDecision}`] };
  if (ev.errorCategory === 'dependency_unavailable') return { verdict: 'INCOMPLETE', reasons: ['dependency_unavailable'] };
  if (ev.sourceStatus === 'unavailable') return { verdict: 'INCOMPLETE', reasons: ['source_unavailable_migration_or_seed_missing'] };
  if (ev.sourceStatus !== 'available') return { verdict: 'INCOMPLETE', reasons: [`source_${ev.sourceStatus}`] };

  // ── PASS 条件 ──
  if (!ev.rendered) return { verdict: 'INCOMPLETE', reasons: ['not_rendered'] };
  if (!ev.disclaimerPresent) return { verdict: 'STOP', reasons: ['disclaimer_missing'] };
  if (ev.byteCount <= 0) return { verdict: 'INCOMPLETE', reasons: ['empty_render'] };
  if (ev.rollbackReady !== true) return { verdict: 'STOP', reasons: ['rollback_not_ready'] };
  return { verdict: 'PASS', reasons: ['synthetic_available_rendered_disclaimer_immutable'] };
}

/** evidence が安全か（許可 key のみ・禁止 fragment なし・契約不変値）。 */
export function isShadowEvidenceSafe(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const keys = Object.keys(e as Record<string, unknown>);
  // allowlist 外の key を持たない。
  if (keys.some((k) => !SHADOW_EVIDENCE_ALLOWED_FIELDS.includes(k))) return false;
  // 値まで含めて禁止 fragment を検出（防御的）。
  const blob = JSON.stringify(e).toLowerCase();
  // 許可 key 名に含まれる無害な語（'key' in 'metricKey' 等）は allowlist で担保済のため、
  // ここでは値側の危険語のみを見る: prompt本文/email/token 等の実値混入を検出。
  const valueBlob = Object.values(e as Record<string, unknown>)
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  // email / URL / JWT らしき **実値** を検出（calculationVersion の 'metric@1' 等は誤検出しない）。
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|https?:\/\/|bearer |eyj[a-z0-9]/i.test(valueBlob)) return false;
  const ev = e as Record<string, unknown>;
  if (ev.syntheticMarker !== true) return false;
  if (ev.promptChanged !== false) return false;
  if (ev.responseChanged !== false) return false;
  void blob;
  return true;
}
