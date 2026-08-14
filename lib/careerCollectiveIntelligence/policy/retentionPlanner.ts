// PASSAI CAREER — retention の期限計算 / cleanup planner / dry-run（Policy Freeze / `D-P2`）。
//
// Human 指示 §6:
//   H-L2 を versioned policy へ反映し、expiration calculation / cleanup planner /
//   dry-run / candidate enumeration / safe-delete port まで実装する。
//   ★ **実際の destructive cleanup は production provision 後**。
//
// ★ 安全設計:
//   - planner は **候補を数える / 列挙するだけ**。削除は `SafeDeletePort` に委譲する。
//   - `SafeDeletePort` は `dryRun` を **必須引数**にしてあり、
//     呼び出し側が明示的に false を渡さない限り破壊しない。
//   - policy version が未サポートなら **何も計画しない**（fail-closed）。
//   - 現在の repo には SafeDeletePort の production 実装が **存在しない**
//     （＝コードから destructive cleanup を起動できない）。
//
// pure / deterministic / never-throw。`nowMs` は注入。

import {
  RETENTION_CLASSES,
  RETENTION_POLICY,
  CURRENT_POLICY_VERSION,
  isPolicyVersionSupported,
  retentionDaysFor,
  type RetentionClass,
} from './registry';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── expiration calculation ──────────────────────────────────────────
export type ExpirationVerdict =
  | { status: 'retained'; ageDays: number; retentionDays: number }
  | { status: 'expired'; ageDays: number; retentionDays: number }
  /** 由来時刻不明 / policy 未サポート → 判定しない（削除もしない）。 */
  | { status: 'undetermined'; reason: 'unknown_class' | 'unsupported_policy' | 'invalid_timestamp' };

/**
 * 1 件の期限判定（pure）。
 *
 * ★ `undetermined` は「削除してよい」ではない。**触らない**という意味。
 */
export function classifyExpiration(input: {
  retentionClass: string;
  createdAt: string | number | null | undefined;
  nowMs: number;
  policyVersion?: number;
}): ExpirationVerdict {
  const version = input.policyVersion ?? CURRENT_POLICY_VERSION;
  if (!isPolicyVersionSupported(version)) {
    return { status: 'undetermined', reason: 'unsupported_policy' };
  }
  const days = retentionDaysFor(input.retentionClass);
  if (days === null) return { status: 'undetermined', reason: 'unknown_class' };

  let createdMs: number | null = null;
  if (typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)) {
    createdMs = input.createdAt;
  } else if (typeof input.createdAt === 'string') {
    const t = Date.parse(input.createdAt);
    createdMs = Number.isNaN(t) ? null : t;
  }
  if (createdMs === null || !Number.isFinite(input.nowMs)) {
    return { status: 'undetermined', reason: 'invalid_timestamp' };
  }
  const raw = Math.floor((input.nowMs - createdMs) / MS_PER_DAY);
  const ageDays = raw < 0 ? 0 : raw; // 未来日時（clock skew）は 0 扱い
  return ageDays > days
    ? { status: 'expired', ageDays, retentionDays: days }
    : { status: 'retained', ageDays, retentionDays: days };
}

/** その class の期限日（ISO）。policy 未サポート / 未知 class は null。 */
export function expiresAtFor(
  retentionClass: string,
  createdAtIso: string,
  policyVersion: number = CURRENT_POLICY_VERSION,
): string | null {
  if (!isPolicyVersionSupported(policyVersion)) return null;
  const days = retentionDaysFor(retentionClass);
  if (days === null) return null;
  const t = Date.parse(createdAtIso);
  if (Number.isNaN(t)) return null;
  return new Date(t + days * MS_PER_DAY).toISOString();
}

// ── cleanup planner ─────────────────────────────────────────────────
/** cleanup の対象候補 1 件（識別子は **不透明 id のみ**。本文・PII を持たない）。 */
export type CleanupCandidate = {
  retentionClass: RetentionClass;
  /** 対象行の不透明 id（uuid / client id 等）。本文は含めない。 */
  recordId: string;
  createdAt: string;
  ageDays: number;
};

export type CleanupPlan = {
  policyId: string;
  policyVersion: number;
  /** class 別の候補数（数だけ。id は candidates に持つ）。 */
  countsByClass: Readonly<Record<string, number>>;
  candidates: readonly CleanupCandidate[];
  /** 判定できなかった件数（削除対象にしない）。 */
  undeterminedCount: number;
  /** ★ この plan を実行すると破壊的操作が起きるか。 */
  destructive: boolean;
};

export type CleanupPlanInput = {
  /** enumerate 済みの行（repository が読む。planner は I/O しない）。 */
  records: readonly { retentionClass: string; recordId: string; createdAt: string }[];
  nowMs: number;
  policyVersion?: number;
  /** 1 回の plan に含める最大件数（過大な一括削除を避ける）。 */
  maxCandidates?: number;
};

export const DEFAULT_MAX_CLEANUP_CANDIDATES = 500;

/**
 * cleanup 候補を列挙する（**pure・削除しない**）。
 *
 * ★ `destructive` は常に false。plan 自体は破壊的ではない。
 *   破壊は `executeCleanup(..., { dryRun: false })` を明示的に呼んだときだけ起きる。
 */
export function planCleanup(input: CleanupPlanInput): CleanupPlan {
  const version = input.policyVersion ?? CURRENT_POLICY_VERSION;
  const counts: Record<string, number> = {};
  for (const c of RETENTION_CLASSES) counts[c] = 0;
  const candidates: CleanupCandidate[] = [];
  let undetermined = 0;

  if (!isPolicyVersionSupported(version)) {
    // ★ policy が使えないなら **一切計画しない**（fail-closed）。
    return {
      policyId: 'career_collective_intelligence',
      policyVersion: version,
      countsByClass: counts,
      candidates: [],
      undeterminedCount: Array.isArray(input.records) ? input.records.length : 0,
      destructive: false,
    };
  }

  const max = Number.isInteger(input.maxCandidates) && (input.maxCandidates as number) > 0
    ? (input.maxCandidates as number)
    : DEFAULT_MAX_CLEANUP_CANDIDATES;

  for (const r of Array.isArray(input.records) ? input.records : []) {
    const verdict = classifyExpiration({
      retentionClass: r?.retentionClass, createdAt: r?.createdAt, nowMs: input.nowMs, policyVersion: version,
    });
    if (verdict.status === 'undetermined') { undetermined += 1; continue; }
    if (verdict.status === 'retained') continue;
    if (candidates.length >= max) { undetermined += 1; continue; } // 上限超過は「今回対象外」
    const cls = r.retentionClass as RetentionClass;
    counts[cls] = (counts[cls] ?? 0) + 1;
    candidates.push({
      retentionClass: cls, recordId: r.recordId, createdAt: r.createdAt, ageDays: verdict.ageDays,
    });
  }

  return {
    policyId: 'career_collective_intelligence',
    policyVersion: version,
    countsByClass: counts,
    candidates,
    undeterminedCount: undetermined,
    destructive: false,
  };
}

// ── safe-delete port ────────────────────────────────────────────────
/**
 * 破壊的削除の port。**production 実装は現在存在しない**。
 *
 * ★ `dryRun` は optional にしない（呼び出し側が必ず意思表示する）。
 * ★ 実装は service-role batch のみ。member request path から呼べる場所に置かない
 *   （`.batch.ts` 側に置く規約。QA `HDR-2` の到達性 guard が効く）。
 */
export type SafeDeletePort = {
  deleteRecords: (input: {
    retentionClass: RetentionClass;
    recordIds: readonly string[];
    dryRun: boolean;
    policyVersion: number;
  }) => Promise<{ deleted: number; skipped: number }>;
};

export type CleanupExecution = {
  dryRun: boolean;
  planned: number;
  deleted: number;
  skipped: number;
  /** 実行を拒否した理由（拒否しなかったら null）。 */
  refusedReason: 'unsupported_policy' | 'legal_not_approved' | 'no_port' | null;
};

/**
 * cleanup を実行する（**既定は dry-run**）。
 *
 * ★ 破壊するのは以下がすべて満たされたときだけ:
 *   - `dryRun === false` を明示
 *   - policy version がサポート対象
 *   - `legalApproved === true`（H-L7。retention は法務レビュー対象）
 *   - `SafeDeletePort` の実装が渡されている
 *
 * どれか 1 つでも欠ければ **何も削除せず** `refusedReason` を返す。
 */
export async function executeCleanup(
  plan: CleanupPlan,
  options: {
    dryRun: boolean;
    legalApproved: boolean;
    port?: SafeDeletePort | null;
  },
): Promise<CleanupExecution> {
  const planned = plan?.candidates?.length ?? 0;
  const base: CleanupExecution = {
    dryRun: options?.dryRun !== false,
    planned,
    deleted: 0,
    skipped: planned,
    refusedReason: null,
  };
  try {
    if (!isPolicyVersionSupported(plan?.policyVersion)) {
      return { ...base, dryRun: true, refusedReason: 'unsupported_policy' };
    }
    if (options.dryRun !== false) return base; // dry-run: 何もしない
    if (options.legalApproved !== true) {
      return { ...base, dryRun: true, refusedReason: 'legal_not_approved' };
    }
    if (!options.port || typeof options.port.deleteRecords !== 'function') {
      return { ...base, dryRun: true, refusedReason: 'no_port' };
    }
    let deleted = 0;
    let skipped = 0;
    for (const cls of RETENTION_CLASSES) {
      const ids = plan.candidates.filter((c) => c.retentionClass === cls).map((c) => c.recordId);
      if (ids.length === 0) continue;
      const r = await options.port.deleteRecords({
        retentionClass: cls, recordIds: ids, dryRun: false, policyVersion: plan.policyVersion,
      });
      deleted += Number.isFinite(r?.deleted) ? r.deleted : 0;
      skipped += Number.isFinite(r?.skipped) ? r.skipped : 0;
    }
    return { dryRun: false, planned, deleted, skipped, refusedReason: null };
  } catch {
    // never-throw: 失敗しても「削除できなかった」として返す（部分削除は port の責務）。
    return { ...base, dryRun: true, refusedReason: 'no_port' };
  }
}

/** policy の retention 表（docs / preflight が参照）。 */
export function retentionSummary(): { retentionClass: RetentionClass; days: number }[] {
  return RETENTION_POLICY.classes.map((c) => ({ retentionClass: c.retentionClass, days: c.days }));
}
