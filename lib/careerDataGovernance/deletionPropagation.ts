// PASSAI CAREER — 削除 / consent 撤回の伝播マトリクス（Collective Intelligence Closure / `D-C6`）。
//
// Human 指示 §11 / §33:
//   source 削除・consent 撤回・アカウント削除が、
//   pending contribution / approved contribution / aggregate input / aggregate output /
//   shared knowledge に対して **それぞれ何を起こすか**を分類する。
//   不可逆・derived data の問題を隠さない。
//
// ★ 本 module は **判定表**であり executor ではない。
//   実際の削除 job / cron / RPC は production infrastructure（H-L8）であり、
//   ここでは「何が保証されていて、何が Human/legal decision 待ちか」を型で固定する。
//
// pure / deterministic / never-throw。

export type DeletionTrigger =
  /** 由来 source（Layer 1 の行）をユーザーが削除した。 */
  | 'source_deleted'
  /** その scope の consent を撤回した。 */
  | 'consent_revoked'
  /** アカウント自体を削除した。 */
  | 'account_deleted';

export const DELETION_TRIGGERS: readonly DeletionTrigger[] = [
  'source_deleted',
  'consent_revoked',
  'account_deleted',
];

export type DeletionTargetKind =
  | 'pending_contribution' // Layer 5: 未 publish の寄与
  | 'published_contribution' // Layer 5: 既に published の shared knowledge
  | 'aggregate_input' // Layer 4: batch へ投入された contribution row
  | 'aggregate_output' // Layer 4: 生成済み artifact
  | 'personal_memory'; // Layer 2: 本人向け projection

export const DELETION_TARGETS: readonly DeletionTargetKind[] = [
  'pending_contribution',
  'published_contribution',
  'aggregate_input',
  'aggregate_output',
  'personal_memory',
];

/**
 * 伝播の結果分類。
 *
 * - `automatically_deleted`   : 構造的に自動削除される（実装済み経路がある）。
 * - `invalidated_and_rebuilt` : 無効化して再生成する（再生成完了まで serve しない）。
 * - `future_use_only_blocked` : 既存物には触れず、**以後の利用/寄与だけ**が止まる。
 * - `human_policy_required`   : 既 publish / derived data の扱いは Human/legal decision（コードで確定しない）。
 */
export type PropagationEffect =
  | 'automatically_deleted'
  | 'invalidated_and_rebuilt'
  | 'future_use_only_blocked'
  | 'human_policy_required';

export type PropagationRule = {
  trigger: DeletionTrigger;
  target: DeletionTargetKind;
  effect: PropagationEffect;
  /** 現在コードで **構造的に保証されている**か（true なら QA で固定できる）。 */
  guaranteedByCode: boolean;
  /** Human decision key（`human_policy_required` のときのみ）。 */
  humanDecision: string | null;
  rationale: string;
};

// ── 伝播表（唯一の source of truth）─────────────────────────────────
//
// ★ 正直さの原則: 「できていないこと」を `automatically_deleted` と書かない。
//   実装済みの構造的保証だけを guaranteedByCode=true にする。
export const PROPAGATION_MATRIX: readonly PropagationRule[] = [
  // ── consent 撤回 ──────────────────────────────────────────────
  {
    trigger: 'consent_revoked',
    target: 'pending_contribution',
    effect: 'invalidated_and_rebuilt',
    guaranteedByCode: true,
    humanDecision: null,
    rationale:
      'lifecycle の withdraw 遷移で revoked へ落ちる。publish 前なので shared KB へ出ない（`lifecycle.ts`）。',
  },
  {
    trigger: 'consent_revoked',
    target: 'published_contribution',
    effect: 'human_policy_required',
    guaranteedByCode: false,
    humanDecision: 'H-L5',
    rationale:
      '既に published となった shared knowledge の扱い（削除 / 匿名維持 / 凍結）は法務判断。' +
      ' コードでは revoke 遷移と takedown request の受け皿だけを用意し、方針は確定しない。',
  },
  {
    trigger: 'consent_revoked',
    target: 'aggregate_input',
    effect: 'future_use_only_blocked',
    guaranteedByCode: true,
    humanDecision: null,
    rationale:
      '以後の batch では consent ineligible として projection が reject する（`projection.ts` / `consent.ts`）。',
  },
  {
    trigger: 'consent_revoked',
    target: 'aggregate_output',
    effect: 'invalidated_and_rebuilt',
    guaranteedByCode: true,
    humanDecision: null,
    rationale:
      '影響 batch を metric × window で特定し invalidate → regeneration。' +
      ' 再生成完了まで fail-closed で serve しない（`invalidation.ts`）。' +
      ' ★ 個人単位の逆引きはしない（逆引き可能にすること自体が privacy リスク）。',
  },
  {
    trigger: 'consent_revoked',
    target: 'personal_memory',
    effect: 'future_use_only_blocked',
    guaranteedByCode: true,
    humanDecision: null,
    rationale:
      'Personal Memory は personal_service_processing であり aggregate/shared consent とは別 purpose。' +
      ' aggregate consent の撤回は Personal Memory の利用を止めない（purpose limitation）。',
  },

  // ── source 削除 ──────────────────────────────────────────────
  {
    trigger: 'source_deleted',
    target: 'pending_contribution',
    effect: 'human_policy_required',
    guaranteedByCode: false,
    humanDecision: 'H-L5',
    rationale:
      '寄与は source の複製ではなく **本人が別途作成した独立オブジェクト**。' +
      ' source を消したら寄与も消すかは product decision（自動連動させない）。',
  },
  {
    trigger: 'source_deleted',
    target: 'published_contribution',
    effect: 'human_policy_required',
    guaranteedByCode: false,
    humanDecision: 'H-L5',
    rationale: '同上。published 済みの扱いは法務判断。',
  },
  {
    trigger: 'source_deleted',
    target: 'aggregate_input',
    effect: 'future_use_only_blocked',
    guaranteedByCode: true,
    humanDecision: null,
    rationale:
      '削除された source は以後の ETL 入力に現れない。過去 batch からの個人単位の除去は行わない' +
      '（行うには user-level 逆引きが必要で privacy 上不可）。',
  },
  {
    trigger: 'source_deleted',
    target: 'aggregate_output',
    effect: 'invalidated_and_rebuilt',
    guaranteedByCode: true,
    humanDecision: null,
    rationale: '該当 window の batch を invalidate → regeneration（`invalidation.ts`）。',
  },
  {
    trigger: 'source_deleted',
    target: 'personal_memory',
    effect: 'automatically_deleted',
    guaranteedByCode: true,
    humanDecision: null,
    rationale:
      'Personal Memory は由来 source から再構築される derived data。source 削除で invalidate される' +
      '（`invalidatePersonalMemoryForSourceReset` / server safety net）。',
  },

  // ── アカウント削除 ────────────────────────────────────────────
  {
    trigger: 'account_deleted',
    target: 'pending_contribution',
    effect: 'automatically_deleted',
    guaranteedByCode: false,
    humanDecision: 'H-L8',
    rationale:
      'contribution 行は contributor に紐づくため、アカウント削除で cascade 可能' +
      '（DDL の外部キー方針に依存。production 適用は H-L8）。',
  },
  {
    trigger: 'account_deleted',
    target: 'published_contribution',
    effect: 'human_policy_required',
    guaranteedByCode: false,
    humanDecision: 'H-L5',
    rationale:
      '既に匿名化・moderation 済みで公開されている knowledge を消すかは法務判断。' +
      ' contributor identity は internal provenance にのみ存在し public payload には無い。',
  },
  {
    trigger: 'account_deleted',
    target: 'aggregate_input',
    effect: 'future_use_only_blocked',
    guaranteedByCode: true,
    humanDecision: null,
    rationale: '以後の ETL に現れない。過去 batch からの個人単位除去は不可（同上）。',
  },
  {
    trigger: 'account_deleted',
    target: 'aggregate_output',
    effect: 'invalidated_and_rebuilt',
    guaranteedByCode: true,
    humanDecision: null,
    rationale:
      '該当 window を invalidate → regeneration。' +
      ' ★ **完全な historical aggregate から特定個人だけを引くことは構造的に不可能**。' +
      ' これは欠陥ではなく、user-level 逆引きを持たない設計の帰結（隠さず記録する）。',
  },
  {
    trigger: 'account_deleted',
    target: 'personal_memory',
    effect: 'automatically_deleted',
    guaranteedByCode: false,
    humanDecision: 'H-L8',
    rationale: 'owner-scoped 行のため cascade 削除可能（production 適用は H-L8）。',
  },
];

/** trigger × target の効果を引く（未定義の組は fail-closed で human_policy_required）。 */
export function propagationEffect(
  trigger: DeletionTrigger,
  target: DeletionTargetKind,
): PropagationRule {
  const found = PROPAGATION_MATRIX.find((r) => r.trigger === trigger && r.target === target);
  if (found) return found;
  return {
    trigger,
    target,
    effect: 'human_policy_required',
    guaranteedByCode: false,
    humanDecision: 'H-L5',
    rationale: '未定義の組み合わせ。安全側（Human decision 必要）へ倒す。',
  };
}

/** コードで構造的に保証している rule だけ（QA が固定する対象）。 */
export function codeGuaranteedRules(): PropagationRule[] {
  return PROPAGATION_MATRIX.filter((r) => r.guaranteedByCode);
}

/** Human/legal decision 待ちの rule（decision packet 生成に使う）。 */
export function humanDecisionRules(): PropagationRule[] {
  return PROPAGATION_MATRIX.filter((r) => r.effect === 'human_policy_required');
}

/**
 * ★ 明示的に記録する「不可逆な事実」。
 * docs だけでなくコードから読めるようにする（監査で見落とさないため）。
 */
export const IRREVERSIBLE_FACTS: readonly string[] = [
  'published_aggregate_artifact_cannot_be_diffed_per_user: ' +
    'aggregate は user-level 逆引きを保持しないため、生成済み artifact から特定個人の寄与だけを差し引くことはできない。' +
    ' 対応は window 単位の invalidate + regeneration のみ。',
  'published_shared_knowledge_removal_is_policy_not_code: ' +
    '既に published となった shared knowledge の削除可否は法務判断（H-L5）であり、コードでは確定しない。',
];
