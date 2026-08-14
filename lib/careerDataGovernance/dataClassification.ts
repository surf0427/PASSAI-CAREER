// PASSAI CAREER — Data Spine 横断の **privacy 分類**（Collective Intelligence Closure / `D-C1`）。
//
// これは Layer 4 / Layer 5 の安全性の土台になる **単一の分類表**である。
// 「どの data が、どの層まで到達してよいか」をコードで固定し、
// docs のコメントではなく **型と実行時 guard** で強制する。
//
// ★ 分類（Human 指示 §3 の 3 分類）:
//
//   PERSONAL_ONLY
//     本人の personal optimization 専用。
//     他ユーザー / aggregate / shared KB へ **自動流入禁止**。
//     「Personal Memory だから」「Event Log にあるから」は許可理由にならない。
//
//   ANONYMOUS_AGGREGATABLE
//     匿名 aggregate に投入しうる。ただし投入可能 = 無条件許可ではない:
//     consent scope + cohort 閾値 + suppression をすべて満たしたときだけ。
//
//   EXPLICITLY_SHAREABLE
//     本人が **その目的のために明示的に共有した場合のみ** shared knowledge へ利用可能。
//     app 利用 / 保存 / AI 生成 / 一般規約同意は共有同意ではない（`D-C4`）。
//
// ★ 設計原則:
//   1. **default deny**。未知の data class は `PERSONAL_ONLY` として扱う（`classifyDataClass`）。
//   2. 分類は data class 単位で 1 箇所に集約する（散在した string literal 判定を作らない）。
//   3. 「分類が許す」ことと「gate が許す」ことは別。分類は **上限**であって許可ではない。
//   4. pure / deterministic / never-throw。I/O・env 非依存。

import type { ConsentScope } from '@/types/careerAggregate';

// ── 分類 ────────────────────────────────────────────────────────────
export type DataPrivacyClass =
  | 'PERSONAL_ONLY'
  | 'ANONYMOUS_AGGREGATABLE'
  | 'EXPLICITLY_SHAREABLE';

export const DATA_PRIVACY_CLASSES: readonly DataPrivacyClass[] = [
  'PERSONAL_ONLY',
  'ANONYMOUS_AGGREGATABLE',
  'EXPLICITLY_SHAREABLE',
];

/** 到達しうる層（分類が許す **上限**。実際の許可は gate が別途判定する）。 */
export type DataSpineLayerTarget =
  | 'personal_context' // Layer 1–3（本人の prompt / memory / event）
  | 'aggregate' // Layer 4
  | 'shared_knowledge'; // Layer 5

// ── data class 語彙 ─────────────────────────────────────────────────
// Data Spine が実際に扱う data の種類。**実在するものだけ**を列挙する。
export type CareerDataClass =
  // ── Layer 1 Source Data（端末 canonical / mirror）
  | 'source.profile'
  | 'source.activity'
  | 'source.values'
  | 'source.self_analysis'
  | 'source.es'
  | 'source.interview'
  | 'source.matching'
  | 'source.company_research'
  | 'source.presentation'
  | 'source.consultation'
  | 'source.gd_room'
  | 'source.gd_solo'
  // ── Layer 2 Personal Career Memory（本人向け projection）
  | 'memory.base'
  | 'memory.self_analysis'
  | 'memory.es'
  | 'memory.interview'
  // ── Layer 3 Career Event Log（構造化 event。本文を持たない）
  | 'event.feature_usage'
  | 'event.signal_summary'
  // ── 明示共有された寄与（Layer 5 入口）
  | 'contribution.company_knowledge'
  // ── 自由記述 / 生本文（どの層でも共有不可）
  | 'raw.free_text';

export const CAREER_DATA_CLASSES = [
  'source.profile',
  'source.activity',
  'source.values',
  'source.self_analysis',
  'source.es',
  'source.interview',
  'source.matching',
  'source.company_research',
  'source.presentation',
  'source.consultation',
  'source.gd_room',
  'source.gd_solo',
  'memory.base',
  'memory.self_analysis',
  'memory.es',
  'memory.interview',
  'event.feature_usage',
  'event.signal_summary',
  'contribution.company_knowledge',
  'raw.free_text',
] as const satisfies readonly CareerDataClass[];

export type DataClassificationEntry = {
  dataClass: CareerDataClass;
  privacyClass: DataPrivacyClass;
  /** 分類が許す到達層の **上限**（gate による許可とは別）。 */
  allowedTargets: readonly DataSpineLayerTarget[];
  /** aggregate / shared へ出すために必要な consent scope（personal only は null）。 */
  requiredConsentScope: ConsentScope | null;
  /** なぜこの分類なのか（監査で読む根拠。推測ではなく実装事実を書く）。 */
  rationale: string;
};

// ── 分類表（唯一の source of truth）────────────────────────────────
//
// ★ 現時点で `ANONYMOUS_AGGREGATABLE` なのは **Layer 3 の feature 利用 event だけ**。
//   これは「いつどの機能を使ったか」という構造化 signal であり、本文・スコア・
//   企業名・属性を持たない（`lib/careerAggregate/policy.ts` の allowlist / prohibited が強制）。
//
// ★ Layer 1 / Layer 2 は **すべて PERSONAL_ONLY**。
//   「Personal Memory だから aggregate してよい」という論法を構造的に禁止する（Human 指示 §4）。
//
// ★ `source.company_research` も **PERSONAL_ONLY**。
//   自分のために保存した企業研究が自動的に shared KB へ行くことは無い。
//   共有できるのは、本人が明示的に作った `contribution.company_knowledge` だけ。
const ENTRIES: readonly DataClassificationEntry[] = [
  // Layer 1 Source Data — すべて本人専用。
  ...(
    [
      'source.profile',
      'source.activity',
      'source.values',
      'source.self_analysis',
      'source.es',
      'source.interview',
      'source.matching',
      'source.presentation',
      'source.consultation',
      'source.gd_room',
      'source.gd_solo',
    ] as const
  ).map(
    (dataClass): DataClassificationEntry => ({
      dataClass,
      privacyClass: 'PERSONAL_ONLY',
      allowedTargets: ['personal_context'],
      requiredConsentScope: null,
      rationale:
        'Layer 1 の本人 source。本文・自由記述・企業名・スコアを含みうるため aggregate / shared へ流さない。',
    }),
  ),
  {
    dataClass: 'source.company_research',
    privacyClass: 'PERSONAL_ONLY',
    allowedTargets: ['personal_context'],
    requiredConsentScope: null,
    rationale:
      '本人が自分のために保存した企業研究。**共有禁止が default**（Human 指示 §14 PRIVATE_PERSONAL_RESEARCH）。' +
      ' shared KB へ入れられるのは、本人が別途明示的に作成した contribution だけ。',
  },
  // Layer 2 Personal Career Memory — 本人向け projection。
  ...(['memory.base', 'memory.self_analysis', 'memory.es', 'memory.interview'] as const).map(
    (dataClass): DataClassificationEntry => ({
      dataClass,
      privacyClass: 'PERSONAL_ONLY',
      allowedTargets: ['personal_context'],
      requiredConsentScope: null,
      rationale:
        'Layer 2 は本人の prompt 用 projection。compact でも本人の内容そのものであり、' +
        '「Personal Memory だから」を理由に Layer 4 / 5 へ流すことは禁止（Human 指示 §4）。',
    }),
  ),
  // Layer 3 Event Log。
  {
    dataClass: 'event.feature_usage',
    privacyClass: 'ANONYMOUS_AGGREGATABLE',
    allowedTargets: ['personal_context', 'aggregate'],
    requiredConsentScope: 'internal_aggregated_analytics',
    rationale:
      '機能の開始/完了という構造化 event。本文・スコア・企業・属性を持たない（projection allowlist が強制）。' +
      ' aggregate 可能だが、consent scope + cohort 閾値 + suppression をすべて満たしたときのみ。',
  },
  {
    dataClass: 'event.signal_summary',
    privacyClass: 'PERSONAL_ONLY',
    allowedTargets: ['personal_context'],
    requiredConsentScope: null,
    rationale:
      'Event Signal は本人向けの補助 summary（Layer 3 の独立 subsystem）。' +
      ' ability / aptitude / matching / aggregate へ流入させない（`D-L3` / `D-L4` / Human 指示 §4）。',
  },
  // Layer 5 入口。
  {
    dataClass: 'contribution.company_knowledge',
    privacyClass: 'EXPLICITLY_SHAREABLE',
    allowedTargets: ['shared_knowledge'],
    requiredConsentScope: 'company_knowledge_contribution',
    rationale:
      '本人が「共有する」目的で明示的に作成した寄与のみ。' +
      ' 明示 consent + PII scrub + provenance + moderation をすべて通って初めて published になる。',
  },
  // 生本文。
  {
    dataClass: 'raw.free_text',
    privacyClass: 'PERSONAL_ONLY',
    allowedTargets: ['personal_context'],
    requiredConsentScope: null,
    rationale:
      '面接回答 / 相談本文 / 自己分析本文などの生テキスト。' +
      ' aggregate にも shared KB にも直接入れない（Human 指示 §4 / §19）。',
  },
];

const BY_CLASS: ReadonlyMap<CareerDataClass, DataClassificationEntry> = new Map(
  ENTRIES.map((e) => [e.dataClass, e]),
);

export const DATA_CLASSIFICATION_TABLE: readonly DataClassificationEntry[] = ENTRIES;

// ── 判定 API（すべて pure / never-throw / default deny）──────────────

/**
 * data class の分類を返す。**未知の class は `PERSONAL_ONLY`**（default deny）。
 * これにより「新しい data を足したが分類し忘れた」場合でも aggregate / shared へ漏れない。
 */
export function classifyDataClass(dataClass: string): DataPrivacyClass {
  return BY_CLASS.get(dataClass as CareerDataClass)?.privacyClass ?? 'PERSONAL_ONLY';
}

/** 分類表の entry（未知なら null）。 */
export function dataClassificationEntry(dataClass: string): DataClassificationEntry | null {
  return BY_CLASS.get(dataClass as CareerDataClass) ?? null;
}

/**
 * その data class が指定した層へ **到達しうるか**（分類上の上限判定）。
 *
 * ★ true は「許可」ではない。gate（consent / flag / cohort / moderation）が別途必要。
 * ★ 未知の class は常に false（personal_context を除く）。
 */
export function mayReachLayer(dataClass: string, target: DataSpineLayerTarget): boolean {
  const entry = BY_CLASS.get(dataClass as CareerDataClass);
  if (!entry) return target === 'personal_context';
  return entry.allowedTargets.includes(target);
}

/** aggregate（Layer 4）へ投入しうる data class か（分類上の上限）。 */
export function mayBeAggregated(dataClass: string): boolean {
  return mayReachLayer(dataClass, 'aggregate');
}

/** shared knowledge（Layer 5）へ出しうる data class か（分類上の上限）。 */
export function mayBeShared(dataClass: string): boolean {
  return mayReachLayer(dataClass, 'shared_knowledge');
}

/** その data class を層へ出すために必要な consent scope（不要 / 不可なら null）。 */
export function requiredConsentScopeFor(dataClass: string): ConsentScope | null {
  return BY_CLASS.get(dataClass as CareerDataClass)?.requiredConsentScope ?? null;
}

/** 指定分類の data class 一覧（監査 / docs 生成用・決定論順）。 */
export function dataClassesWithPrivacyClass(
  privacyClass: DataPrivacyClass,
): CareerDataClass[] {
  return ENTRIES.filter((e) => e.privacyClass === privacyClass)
    .map((e) => e.dataClass)
    .sort();
}
