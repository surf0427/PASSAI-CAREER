/**
 * Data Spine — canary allowlist gate（P17-C §10・pure）。
 *
 * fail-closed。空 allowlist は非対象。malformed UUID / ID は拒否。全 user wildcard 禁止。
 * client からの自己申告 canary は受け付けない（userId は server session 由来である前提。
 *   本関数は入力 userId を検証するのみで、client body を信用しない設計を支える）。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CanaryParseResult =
  | { ok: true; ids: ReadonlySet<string> }
  | { ok: false; reason: 'empty' | 'wildcard_rejected' | 'malformed' };

/** 生 allowlist（comma 区切り）を parse する（wildcard 禁止・UUID 検証）。 */
export function parseCanaryAllowlist(raw: string | null | undefined): CanaryParseResult {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'empty' };
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 0) return { ok: false, reason: 'empty' };
  if (parts.some((p) => p === '*' || p.toLowerCase() === 'all')) return { ok: false, reason: 'wildcard_rejected' };
  if (parts.some((p) => !UUID_RE.test(p))) return { ok: false, reason: 'malformed' };
  return { ok: true, ids: new Set(parts.map((p) => p.toLowerCase())) };
}

export type CanaryDecision = {
  eligible: boolean;
  reason: 'allowlisted' | 'not_in_allowlist' | 'empty_allowlist' | 'wildcard_rejected' | 'malformed_config' | 'invalid_user';
};

/** userId が canary 対象か（fail-closed）。 */
export function evaluateCanary(rawAllowlist: string | null | undefined, userId: string | null | undefined): CanaryDecision {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) return { eligible: false, reason: 'invalid_user' };
  const parsed = parseCanaryAllowlist(rawAllowlist);
  if (!parsed.ok) {
    const reason = parsed.reason === 'empty' ? 'empty_allowlist' : parsed.reason === 'wildcard_rejected' ? 'wildcard_rejected' : 'malformed_config';
    return { eligible: false, reason };
  }
  return parsed.ids.has(userId.toLowerCase())
    ? { eligible: true, reason: 'allowlisted' }
    : { eligible: false, reason: 'not_in_allowlist' };
}

/** 多重 gate: master read flag + consumer flag + readiness + canary すべて true のときのみ eligible。 */
export function isConsumerEligible(input: {
  masterReadEnabled: boolean;
  consumerEnabled: boolean;
  readinessReady: boolean;
  canary: CanaryDecision;
}): boolean {
  return (
    input.masterReadEnabled === true &&
    input.consumerEnabled === true &&
    input.readinessReady === true &&
    input.canary.eligible === true
  );
}
