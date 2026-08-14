// PASSAI CAREER — production readiness preflight checker（Policy Freeze / `D-P5`）。
//
// Human 指示 §19:
//   production へ触れずに「有効化に何が足りないか」を返す checker。
//   秘密情報を表示しない。
//
// ★ 返すのは **boolean と enum だけ**。env の値・UUID・接続文字列は一切含めない。
// ★ 「module が存在するから ready」にはしない（Human 指示 §29 / §12）。
//    legal approval / moderator provider / infra adapter は
//    **明示的に注入された事実**のみを根拠にする。
//
// pure / deterministic / never-throw。I/O は呼び出し側が集めて注入する。

import {
  COHORT_POLICY,
  MODERATION_POLICY,
  RETENTION_POLICY,
  currentPolicySnapshot,
  isPolicyFrozen,
  isPolicyVersionSupported,
} from './policy/registry';

export type PreflightCheckKey =
  | 'policy_frozen'
  | 'policy_version_supported'
  | 'cohort_configured'
  | 'retention_configured'
  | 'legal_approved'
  | 'moderator_configured'
  | 'infra_adapter_configured'
  | 'migration_applied'
  | 'rls_expected'
  | 'feature_flags_off';

export const PREFLIGHT_CHECKS: readonly PreflightCheckKey[] = [
  'policy_frozen',
  'policy_version_supported',
  'cohort_configured',
  'retention_configured',
  'legal_approved',
  'moderator_configured',
  'infra_adapter_configured',
  'migration_applied',
  'rls_expected',
  'feature_flags_off',
];

/**
 * preflight の入力。
 *
 * ★ すべて **呼び出し側が確認した事実**を渡す。本 module は env を読まない。
 * ★ 未指定は「未達」として扱う（`=== true` 判定）。
 */
export type PreflightInput = {
  /** H-L7: 法務承認。★ 承認の source を明示できるときだけ true にする。 */
  legalApproved?: boolean;
  /** legal approval の出所（監査用。空なら未承認扱い）。 */
  legalApprovalSource?: string | null;
  /** H-L6: moderator provider が設定されているか（module 存在ではなく adapter 実体）。 */
  moderatorProviderConfigured?: boolean;
  /** H-L8: batch provider adapter が設定されているか。 */
  infraAdapterConfigured?: boolean;
  /** production migration が適用済みか（適用前は false）。 */
  migrationApplied?: boolean;
  /** 対象 table すべてで RLS が有効と確認できたか。 */
  rlsVerified?: boolean;
  /** Layer 4 / Layer 5 の feature flag がすべて OFF か（有効化前の期待状態）。 */
  featureFlagsOff?: boolean;
};

export type PreflightItem = {
  key: PreflightCheckKey;
  ok: boolean;
  /** 何をすれば ok になるか（値・秘密は含めない）。 */
  requirement: string;
  /** 対応する Human decision（無ければ null）。 */
  humanDecision: string | null;
};

export type PreflightReport = {
  /** すべて ok か。 */
  ready: boolean;
  items: readonly PreflightItem[];
  /** 未達の key（決定論順）。 */
  blocking: readonly PreflightCheckKey[];
  /** policy の凍結状態（値は含めない）。 */
  policy: ReturnType<typeof currentPolicySnapshot>;
};

/**
 * production readiness を評価する（**fail-closed**・秘密を出さない）。
 *
 * ★ `ready: true` になっても **自動で有効化はされない**。
 *   実際の有効化は `evaluateActivation()` の別判定 + operator の env 設定が必要。
 */
export function runPreflight(input: PreflightInput | null | undefined): PreflightReport {
  const snapshot = currentPolicySnapshot();

  const legalOk =
    input?.legalApproved === true &&
    typeof input?.legalApprovalSource === 'string' &&
    input.legalApprovalSource.trim() !== '';

  const items: PreflightItem[] = [
    {
      key: 'policy_frozen',
      ok: isPolicyFrozen(),
      requirement: 'Human 承認済み policy が registry に凍結されていること（PENDING が無い）。',
      humanDecision: null,
    },
    {
      key: 'policy_version_supported',
      ok: isPolicyVersionSupported(snapshot.version),
      requirement: 'policy version が SUPPORTED_POLICY_VERSIONS に含まれること。',
      humanDecision: null,
    },
    {
      key: 'cohort_configured',
      ok: COHORT_POLICY.approval === 'APPROVED',
      requirement: 'cohort threshold が APPROVED であること（H-L1）。',
      humanDecision: 'H-L1',
    },
    {
      key: 'retention_configured',
      // ★ PROVISIONAL でも「設定されている」ことは満たす。法務は別 check。
      ok: RETENTION_POLICY.approval !== 'PENDING' && RETENTION_POLICY.classes.length > 0,
      requirement: 'retention class ごとの日数が policy に定義されていること（H-L2）。',
      humanDecision: 'H-L2',
    },
    {
      key: 'legal_approved',
      ok: legalOk,
      requirement:
        '法務レビュー完了の **明示的な source**（承認文書 ID 等）と共に legalApproved=true が渡されること（H-L7）。' +
        ' module の存在や env の未設定を承認と見なさない。',
      humanDecision: 'H-L7',
    },
    {
      key: 'moderator_configured',
      ok: input?.moderatorProviderConfigured === true,
      requirement:
        'moderator 解決 adapter（role table / allowlist / IdP）が実装・設定されていること（H-L6）。' +
        ' moderation module が存在するだけでは満たさない。',
      humanDecision: 'H-L6',
    },
    {
      key: 'infra_adapter_configured',
      ok: input?.infraAdapterConfigured === true,
      requirement: 'batch provider adapter（scheduler / lock / monitoring）が設定されていること（H-L8）。',
      humanDecision: 'H-L8',
    },
    {
      key: 'migration_applied',
      ok: input?.migrationApplied === true,
      requirement: 'production candidate migration が適用済みであること（H-L8）。',
      humanDecision: 'H-L8',
    },
    {
      key: 'rls_expected',
      ok: input?.rlsVerified === true,
      requirement: '対象 table すべてで RLS 有効と policy 適用が確認できていること。',
      humanDecision: 'H-L8',
    },
    {
      key: 'feature_flags_off',
      // ★ 有効化 **前** の期待状態。ここが false なら「既に何か ON になっている」＝要調査。
      ok: input?.featureFlagsOff === true,
      requirement: '有効化前は Layer 4 / Layer 5 の feature flag がすべて OFF であること。',
      humanDecision: null,
    },
  ];

  const blocking = items.filter((i) => !i.ok).map((i) => i.key).sort();
  return { ready: blocking.length === 0, items, blocking, policy: snapshot };
}

/**
 * legal approval の **唯一の判定関数**（Human 指示 §12）。
 *
 * ★ 「module があるから approved」「env 未設定だから approved」を **構造的に不可能**にする。
 *   承認は「明示的な true」と「出所文字列」の両方が揃ったときだけ。
 */
export function isLegalApproved(input: {
  approved?: unknown;
  source?: unknown;
}): boolean {
  return (
    input?.approved === true &&
    typeof input?.source === 'string' &&
    input.source.trim() !== ''
  );
}

/** moderation が「人手承認あり」で構成されているか（自動公開でないこと）。 */
export function isModerationModeSafe(): boolean {
  return (
    MODERATION_POLICY.mode === 'automated_prescreen_then_human' &&
    MODERATION_POLICY.allowAutomatedPublication === false
  );
}
