// PASSAI CAREER — Collective Intelligence **承認済み policy の単一 source**
// （Policy Freeze Batch / `D-P1`）。
//
// Human が 2026-08-14 に承認した H-L1 / H-L3 / H-L4 / H-L6（APPROVED）と
// H-L2 / H-L5（PROVISIONALLY APPROVED — SUBJECT TO LEGAL REVIEW）を
// **1 箇所の typed / versioned policy** へ凍結する。
//
// ★ 原則（Human 指示 §3 / §4）:
//   1. 同じ値を複数 module へ hardcode しない。**ここが唯一の権威**。
//      既存 module（`careerAggregate/policy.ts` 等）の PROVISIONAL 定数は
//      本 registry と **一致していることを QA が固定**する（二重管理の検出）。
//   2. policy は version を持ち、consent record / aggregate provenance /
//      shared knowledge provenance から「どの version に基づくか」を追跡できる。
//   3. **未知 version / 無効 policy は fail-closed**（serve しない）。
//   4. legal 承認は policy に含めない（`legalApproved` は別 gate。
//      policy が frozen でも legal 未承認なら activation は false）。
//
// pure / deterministic / never-throw。I/O・env 非依存。

// ── policy identity ─────────────────────────────────────────────────
export type PolicyId = 'career_collective_intelligence';
export const POLICY_ID: PolicyId = 'career_collective_intelligence';

/**
 * 現在の policy version。
 *
 * ★ 値を変えるときの規約:
 *   - threshold / retention / purpose / sharing / withdrawal / moderation の
 *     **意味が変わる**変更 → version を上げる（既存 consent は再同意が必要になりうる）
 *   - コメント修正・型の整理のみ → version 据え置き
 */
export const CURRENT_POLICY_VERSION = 1 as const;

/** サポートする version（ここに無い version は **fail-closed**）。 */
export const SUPPORTED_POLICY_VERSIONS: readonly number[] = [1];

/**
 * policy の承認状態。
 *   APPROVED                        : Human 承認済み。production candidate として確定。
 *   PROVISIONALLY_APPROVED_PENDING_LEGAL: Human は承認したが法務レビューで変更されうる。
 *   PENDING                         : 未承認。
 */
export type PolicyApprovalState =
  | 'APPROVED'
  | 'PROVISIONALLY_APPROVED_PENDING_LEGAL'
  | 'PENDING';

// ── H-L1: cohort thresholds（APPROVED）─────────────────────────────
export type CohortThresholdPolicyFrozen = {
  /** これ未満は audience に関わらず常に suppress。 */
  absoluteLowerBound: number;
  internal: number;
  userFacing: number;
  aiContext: number;
  /** rare category（分割 cohort 値の最小 distinct-user support）。 */
  rareCategoryMinSupport: number;
  approval: PolicyApprovalState;
};

export const COHORT_POLICY: CohortThresholdPolicyFrozen = {
  absoluteLowerBound: 10,
  internal: 20,
  userFacing: 50,
  aiContext: 100,
  rareCategoryMinSupport: 20,
  approval: 'APPROVED',
};

// ── H-L2: retention（PROVISIONALLY APPROVED — PENDING LEGAL）────────
/** retention の対象クラス。**一律にしない**（Human 指示 §5）。 */
export type RetentionClass =
  | 'aggregate_raw_input'
  | 'pending_moderation_contribution'
  | 'approved_shared_knowledge'
  | 'aggregate_artifact'
  | 'operational_log';

export const RETENTION_CLASSES: readonly RetentionClass[] = [
  'aggregate_raw_input',
  'pending_moderation_contribution',
  'approved_shared_knowledge',
  'aggregate_artifact',
  'operational_log',
];

export type RetentionClassPolicy = {
  retentionClass: RetentionClass;
  days: number;
  rationale: string;
};

export const RETENTION_POLICY: {
  approval: PolicyApprovalState;
  classes: readonly RetentionClassPolicy[];
} = {
  approval: 'PROVISIONALLY_APPROVED_PENDING_LEGAL',
  classes: [
    {
      retentionClass: 'aggregate_raw_input',
      days: 90,
      rationale: '再集計に必要な window を確保しつつ最短。既に本文を持たない構造化 event。',
    },
    {
      retentionClass: 'pending_moderation_contribution',
      days: 30,
      rationale: '審査待ちのまま個人由来テキストを滞留させない。超過は expire 遷移で自動 reject。',
    },
    {
      retentionClass: 'approved_shared_knowledge',
      days: 730,
      rationale: '選考情報は 1〜2 年で陳腐化。FRESHNESS_POLICY の stale 境界（30 ヶ月）と整合。',
    },
    {
      retentionClass: 'aggregate_artifact',
      days: 400,
      rationale: '前年同月比を 1 回見られる長さ。serve 期限（TTL）とは別概念。',
    },
    {
      retentionClass: 'operational_log',
      days: 180,
      rationale: '障害調査に十分。識別子を含まないため長期保持の必要が薄い。',
    },
  ],
};

/** retention class の日数（未知 class は null＝fail-closed）。 */
export function retentionDaysFor(retentionClass: string): number | null {
  const e = RETENTION_POLICY.classes.find((c) => c.retentionClass === retentionClass);
  return e ? e.days : null;
}

// ── H-L3: aggregation purpose（APPROVED）───────────────────────────
export type AllowedAggregatePurpose =
  | 'internal_product_analytics'
  | 'user_facing_aggregate_trend';

export const ALLOWED_AGGREGATE_PURPOSES: readonly AllowedAggregatePurpose[] = [
  'internal_product_analytics',
  'user_facing_aggregate_trend',
];

/**
 * ★ 恒久禁止 purpose。**将来の誰かが接続しようとしたら QA が落ちる**ように
 *   名前を明示列挙する（`PF-3` が静的 guard で固定）。
 */
export type ForbiddenAggregatePurpose =
  | 'ability_inference'
  | 'aptitude_inference'
  | 'matching_decision'
  | 'hiring_probability'
  | 'individual_ranking'
  | 'personal_ai_decision_context';

export const FORBIDDEN_AGGREGATE_PURPOSES: readonly ForbiddenAggregatePurpose[] = [
  'ability_inference',
  'aptitude_inference',
  'matching_decision',
  'hiring_probability',
  'individual_ranking',
  'personal_ai_decision_context',
];

export const AGGREGATE_PURPOSE_POLICY = {
  approval: 'APPROVED' as PolicyApprovalState,
  allowed: ALLOWED_AGGREGATE_PURPOSES,
  forbidden: FORBIDDEN_AGGREGATE_PURPOSES,
  /**
   * ★ Layer 4 を Personal Optimization の AI context へ接続しない（H-L3 明示）。
   *   `true` になるのは Human が改めて承認したときのみ。
   */
  allowPersonalOptimizationAiContext: false,
} as const;

/** purpose が許可されているか（**未知は false**＝default deny）。 */
export function isAggregatePurposeAllowed(purpose: string): boolean {
  return (ALLOWED_AGGREGATE_PURPOSES as readonly string[]).includes(purpose);
}

/** purpose が明示禁止されているか。 */
export function isAggregatePurposeForbidden(purpose: string): boolean {
  return (FORBIDDEN_AGGREGATE_PURPOSES as readonly string[]).includes(purpose);
}

// ── H-L4: sharing rule（APPROVED）──────────────────────────────────
/**
 * 共有は **二段 gate**。どちらか一方だけでは寄与にならない。
 *   1. master opt-in       : `company_knowledge_contribution` scope への明示同意
 *   2. per-item confirmation: contribution ごとの `share_granted`
 */
export const SHARING_POLICY = {
  approval: 'APPROVED' as PolicyApprovalState,
  requireMasterOptIn: true,
  requirePerContributionConfirmation: true,
  /** ★ 以下はいずれも共有同意として **扱わない**（H-L4 の禁止事項）。 */
  rejectedImpliedConsentSources: [
    'global_consent_auto_sharing',
    'private_company_research_auto_sharing',
    'saving_research_implied_sharing',
    'personal_memory_consent',
  ] as readonly string[],
  /** consent family は Personal Optimization と共有しない。 */
  sharingConsentFamily: 'company_knowledge_sharing' as const,
} as const;

// ── H-L5: withdrawal rule（PROVISIONALLY APPROVED — PENDING LEGAL）──
/** 撤回時の contribution 状態区分。 */
export type WithdrawalSubjectState =
  | 'pending'
  | 'rejected'
  | 'approved_unpublished'
  | 'published_single_source'
  | 'derived_multi_source';

/**
 * 撤回時の挙動。
 *   delete            : 削除してよい（誰にも届いていない / 本人の記述そのもの）
 *   unpublish         : 公開を止める（削除はしない＝可逆）
 *   legal_policy_gate : 法務判断が必要。**自動 retain も自動 delete もしない**
 */
export type WithdrawalDisposition = 'delete' | 'unpublish' | 'legal_policy_gate';

export const WITHDRAWAL_POLICY: {
  approval: PolicyApprovalState;
  rules: Readonly<Record<WithdrawalSubjectState, WithdrawalDisposition>>;
  /**
   * ★ legal 未承認の間の derived knowledge の扱い。
   *   `retain` を production behavior に **しない**（Human 指示 §9）。
   *   したがって legal 未承認中は `unpublish`（最も保守的で可逆）へ倒す。
   */
  derivedFallbackUntilLegalApproval: Extract<WithdrawalDisposition, 'unpublish'>;
} = {
  approval: 'PROVISIONALLY_APPROVED_PENDING_LEGAL',
  rules: {
    pending: 'delete',
    rejected: 'delete',
    approved_unpublished: 'delete',
    published_single_source: 'unpublish',
    derived_multi_source: 'legal_policy_gate',
  },
  derivedFallbackUntilLegalApproval: 'unpublish',
};

/**
 * 撤回時の実際の挙動を返す（**legal 未承認なら保守側へ倒す**）。
 * 未知 state は `legal_policy_gate` → legal 未承認中は `unpublish`（fail-closed）。
 */
export function withdrawalDispositionFor(
  state: string,
  legalApproved: boolean,
): WithdrawalDisposition {
  const rule = (WITHDRAWAL_POLICY.rules as Record<string, WithdrawalDisposition>)[state]
    ?? 'legal_policy_gate';
  if (rule === 'legal_policy_gate' && legalApproved !== true) {
    // ★ 自動 retain にしない。可逆な unpublish へ倒す。
    return WITHDRAWAL_POLICY.derivedFallbackUntilLegalApproval;
  }
  return rule;
}

// ── H-L6: moderation mode（APPROVED）──────────────────────────────
export type ModerationMode =
  | 'human_only'
  | 'automated_prescreen_then_human'
  | 'automated_approval';

export const MODERATION_POLICY = {
  approval: 'APPROVED' as PolicyApprovalState,
  mode: 'automated_prescreen_then_human' as ModerationMode,
  /** ★ 自動 pre-screen から直接 publish することを **禁止**（H-L6）。 */
  allowAutomatedPublication: false,
  /** 一次判断の SLA（時間）。超過は expire 遷移で自動 reject。 */
  humanReviewSlaHours: 72,
  /** 単一 moderator でも運用できること（provider-neutral）。 */
  minimumModerators: 1,
} as const;

// ── policy snapshot（provenance へ埋め込む形）────────────────────────
export type PolicySnapshot = {
  policyId: PolicyId;
  version: number;
  /** この snapshot が有効か（未サポート version なら false）。 */
  effective: boolean;
  cohortApproval: PolicyApprovalState;
  retentionApproval: PolicyApprovalState;
  aggregatePurposeApproval: PolicyApprovalState;
  sharingApproval: PolicyApprovalState;
  withdrawalApproval: PolicyApprovalState;
  moderationApproval: PolicyApprovalState;
};

/** 現在の policy snapshot（consent / provenance が参照する）。 */
export function currentPolicySnapshot(): PolicySnapshot {
  return {
    policyId: POLICY_ID,
    version: CURRENT_POLICY_VERSION,
    effective: SUPPORTED_POLICY_VERSIONS.includes(CURRENT_POLICY_VERSION),
    cohortApproval: COHORT_POLICY.approval,
    retentionApproval: RETENTION_POLICY.approval,
    aggregatePurposeApproval: AGGREGATE_PURPOSE_POLICY.approval,
    sharingApproval: SHARING_POLICY.approval,
    withdrawalApproval: WITHDRAWAL_POLICY.approval,
    moderationApproval: MODERATION_POLICY.approval,
  };
}

/**
 * policy version が使用可能か（**未知 version は fail-closed**）。
 *
 * consent record や artifact provenance に記録された version を検証するのに使う。
 * 「古い version で同意した」「未来 version が記録されている」いずれも false。
 */
export function isPolicyVersionSupported(version: unknown): boolean {
  return (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version > 0 &&
    SUPPORTED_POLICY_VERSIONS.includes(version)
  );
}

/** policy 全体が frozen（= production candidate として使える）か。 */
export function isPolicyFrozen(): boolean {
  const s = currentPolicySnapshot();
  if (!s.effective) return false;
  // PENDING が 1 つでもあれば frozen ではない。
  return [
    s.cohortApproval,
    s.retentionApproval,
    s.aggregatePurposeApproval,
    s.sharingApproval,
    s.withdrawalApproval,
    s.moderationApproval,
  ].every((a) => a !== 'PENDING');
}
