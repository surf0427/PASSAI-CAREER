// PASSAI CAREER Context Orchestrator — purpose registry（P3-A で導入）。
//
// 「どの機能（purpose）で、どの career context をどの程度 AI に渡すか」を 1 箇所で宣言する。
// 純粋な定義のみ（I/O / env / secret / Supabase read なし）。
//
// P3-A の位置づけ:
//   - registry は「方針の宣言」。orchestrator は base system prompt を既存 buildCareerSystemPrompt に
//     委譲し、出力は現行と byte 単位で同一（＝品質・cache に影響しない骨格）。
//   - policy を実際に適用した section 削減（profile:minimal で氏名だけにする等）は P3-B 以降。
//   - 現行の各 route の cross-feature block（自己分析 / ES / 企業研究 等）は引き続き route 側の責務。
//     registry の recentLogs / companyContext はその「宣言」であり、P3-A では強制しない。

export type CareerContextPurpose =
  | 'consultation'
  | 'es_generation'
  | 'es_review'
  | 'interview_practice'
  | 'interview_complete'
  | 'gd_feedback'
  | 'presentation_feedback'
  | 'company_research_review'
  | 'matching'
  | 'mypage_summary';

export const CAREER_CONTEXT_PURPOSES: readonly CareerContextPurpose[] = [
  'consultation',
  'es_generation',
  'es_review',
  'interview_practice',
  'interview_complete',
  'gd_feedback',
  'presentation_feedback',
  'company_research_review',
  'matching',
  'mypage_summary',
];

// 各 section の扱い（宣言用）。P3-A では活動は常に P2-A formatter で compact 済み。
export type ProfileInclusion = 'include' | 'minimal' | 'exclude';
export type ActivityInclusion = 'compact' | 'exclude';
export type ValuesInclusion = 'include' | 'exclude';
export type LogsInclusion = 'include' | 'exclude';
export type CompanyInclusion = 'include' | 'optional' | 'exclude';

export type CareerContextPolicy = {
  profile: ProfileInclusion;
  activity: ActivityInclusion;
  values: ValuesInclusion;
  // route が別途渡す cross-feature ログ（自己分析 / ES / 面接 等）の宣言（P3-A では強制しない）。
  recentLogs: LogsInclusion;
  // 企業研究 context の宣言（P3-A では強制しない）。
  companyContext: CompanyInclusion;
  // base context の目安上限（P3-A は観測用。P3-B で実適用）。
  maxContextChars: number;
  notes?: string;
};

// 未知 purpose や欠損時の安全な既定（現行挙動に最も近い「全部入り」）。
export const DEFAULT_CAREER_CONTEXT_POLICY: CareerContextPolicy = {
  profile: 'include',
  activity: 'compact',
  values: 'include',
  recentLogs: 'exclude',
  companyContext: 'optional',
  maxContextChars: 3500,
};

export const CAREER_CONTEXT_REGISTRY: Record<CareerContextPurpose, CareerContextPolicy> = {
  es_generation: {
    profile: 'include',
    activity: 'compact',
    values: 'include',
    recentLogs: 'exclude', // 直近ログは使わず、profile/activity/values + 自己分析(route が別途)で生成
    companyContext: 'optional',
    maxContextChars: 3500,
    notes: 'ES 生成。企業研究は選択時のみ route 側で付与。',
  },
  es_review: {
    profile: 'minimal',
    activity: 'compact',
    values: 'include',
    recentLogs: 'exclude',
    companyContext: 'optional',
    maxContextChars: 3500,
    notes: '添削は対象ドラフトが主。base は薄めで良い（P3-B で minimal 実適用）。',
  },
  interview_practice: {
    profile: 'include',
    activity: 'compact',
    values: 'include',
    recentLogs: 'include', // 自己分析 / ES / matching / 相談気づきを route が付与
    companyContext: 'optional',
    maxContextChars: 3500,
    notes: '面接 練習。start/turn/complete が共有する base builder 経由。',
  },
  interview_complete: {
    profile: 'include',
    activity: 'compact',
    values: 'include',
    recentLogs: 'include',
    companyContext: 'optional',
    maxContextChars: 3500,
    notes: '最終評価。出力 schema が重いため base は現行維持（P3-A は非移行の宣言のみ）。',
  },
  consultation: {
    profile: 'minimal',
    activity: 'compact',
    values: 'include',
    recentLogs: 'include',
    companyContext: 'optional',
    maxContextChars: 3500,
  },
  gd_feedback: {
    profile: 'exclude',
    activity: 'exclude',
    values: 'exclude',
    recentLogs: 'exclude',
    companyContext: 'exclude',
    maxContextChars: 2000,
    notes: 'GD 評価は transcript 主体。career base context は使わない。',
  },
  presentation_feedback: {
    profile: 'include',
    activity: 'compact',
    values: 'include',
    recentLogs: 'include',
    companyContext: 'exclude',
    maxContextChars: 3500,
  },
  company_research_review: {
    profile: 'minimal',
    activity: 'compact',
    values: 'include',
    recentLogs: 'exclude',
    companyContext: 'include',
    maxContextChars: 3000,
  },
  matching: {
    profile: 'include',
    activity: 'compact',
    values: 'include',
    recentLogs: 'include',
    companyContext: 'exclude',
    maxContextChars: 3500,
  },
  mypage_summary: {
    profile: 'minimal',
    activity: 'compact',
    values: 'exclude',
    recentLogs: 'include',
    companyContext: 'exclude',
    maxContextChars: 1500,
  },
};

/** purpose に対応する policy を返す。未知 purpose は安全な既定へ fallback。 */
export function getCareerContextPolicy(purpose: CareerContextPurpose | string): CareerContextPolicy {
  return (
    (CAREER_CONTEXT_REGISTRY as Record<string, CareerContextPolicy>)[purpose] ??
    DEFAULT_CAREER_CONTEXT_POLICY
  );
}
