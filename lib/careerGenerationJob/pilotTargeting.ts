/**
 * career generation job — pilot targeting evaluator（pure / fail-closed）。
 *
 * server env の読取は flag.server.ts の責務。本 module は env / I/O を持たない
 * 純粋判定のみ（tsx QA から直接 import して全組合せを決定論検証する）。
 *
 * ★ 方針（fail-closed / 兄弟 lib/careerDataSpineGate/canary.ts と同形）:
 *   - flag OFF → 誰も job 経路に入れない。
 *   - flag ON かつ allowlist 未設定 / 空 / malformed / wildcard → 誰も job 経路に入れない。
 *   - flag ON かつ valid allowlist → 掲載 UUID に **exact 一致**した member のみ対象。
 *   - userId が UUID でない（guest 由来の空文字・不正値含む）→ 対象外。
 *   - production は明示設定が無い限り OFF（呼び出し側が env 未設定＝flagEnabled=false）。
 *   - 値（UUID）は戻り値・log へ露出しない（boolean のみ返す・substring 一致しない）。
 */

// Supabase auth.users.id は UUID。case は許容するが破壊せず lowercase で照合する。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PilotAllowlistParse =
  | { ok: true; ids: ReadonlySet<string> }
  | { ok: false; reason: 'empty' | 'wildcard_rejected' | 'malformed' };

/** 生 allowlist（comma 区切り UUID）を parse（wildcard 禁止・UUID 検証・fail-closed）。 */
export function parsePilotAllowlist(raw: string | null | undefined): PilotAllowlistParse {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'empty' };
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 0) return { ok: false, reason: 'empty' };
  if (parts.some((p) => p === '*' || p.toLowerCase() === 'all')) {
    return { ok: false, reason: 'wildcard_rejected' };
  }
  if (parts.some((p) => !UUID_RE.test(p))) return { ok: false, reason: 'malformed' };
  return { ok: true, ids: new Set(parts.map((p) => p.toLowerCase())) };
}

export interface PilotTargetingInput {
  /** pilot flag が deployment 全体で ON か。 */
  flagEnabled: boolean;
  /** 生 allowlist env（値は保持せず判定にのみ使う）。 */
  rawAllowlist: string | null | undefined;
  /** server session 由来の認証済み userId（client 自己申告は渡さない）。 */
  userId: string | null | undefined;
}

/**
 * fail-closed 判定。全条件（flag ON・valid non-empty allowlist・userId が掲載 UUID）
 * を満たす member のみ true。ひとつでも欠ければ false。
 */
export function isPilotEnabledForUser(input: PilotTargetingInput): boolean {
  if (input.flagEnabled !== true) return false;
  if (typeof input.userId !== 'string' || !UUID_RE.test(input.userId)) return false;
  const parsed = parsePilotAllowlist(input.rawAllowlist);
  if (!parsed.ok) return false;
  return parsed.ids.has(input.userId.toLowerCase());
}
