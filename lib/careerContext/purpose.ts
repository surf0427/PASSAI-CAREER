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
  | 'self_analysis'
  | 'self_analysis_deep_dive'
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
  'self_analysis',
  'self_analysis_deep_dive',
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

// Orchestrator 移行状況（P3-E 時点）:
//   移行済み: es_generation(P3-A) / interview_practice(P3-A, start·turn·complete 共有) /
//             matching(P3-B) / presentation_feedback(P3-C, evaluate·qa) /
//             company_research_review(P3-C) / consultation(P3-C, base のみ) /
//             self_analysis(P3-D, route.ts) / self_analysis_deep_dive(P3-E, question の base builder)
//   未移行  : es_review(静的 SYSTEM_PROMPT・base 不使用) / gd_feedback(transcript 主体・base 不使用) /
//             interview_complete(purpose 自体は未使用) / mypage_summary(route 未実装)
//   → career の全 AI route/builder が base context を Orchestrator 経由に統一（base 不使用 route を除く）。
// policy は宣言（観測用）。purpose 別の実削減は P3-F 以降。route 挙動は policy に依存しない。
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
    notes: '未移行。es-review は静的 SYSTEM_PROMPT で base(buildCareerSystemPrompt) を使わない。',
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
    notes: '面接最終評価。base は interview_practice の共有 builder 経由で移行済み。interview_complete purpose 自体は現状未使用（将来 complete 専用 policy 用に予約）。',
  },
  consultation: {
    profile: 'include',
    activity: 'compact', // route 側で compressCareerActivityForConsultation 済みを渡す
    values: 'include',
    recentLogs: 'include', // 司令塔: 自己分析/ES/面接/プレゼン/GD/マッチング等を route が手組みで付与
    companyContext: 'include', // 保存済み企業研究スナップショット（最大5件）
    maxContextChars: 3500,
    notes: '司令塔。手組みアグリゲートは route の責務（P3-C は base のみ Orchestrator 経由）。',
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
    notes: 'P3-C で Orchestrator 移行済み（evaluate/qa が共有する base builder 経由）。',
  },
  company_research_review: {
    profile: 'include',
    activity: 'compact',
    values: 'include',
    recentLogs: 'include', // 自己分析 / マッチング結果を route が付与
    companyContext: 'include', // 添削対象の企業研究テキストが主題（user メッセージ側）
    maxContextChars: 3500,
    notes: 'P3-C で Orchestrator 移行済み。AI 生成ではなく本人一次メモの添削・本人整合。',
  },
  matching: {
    // P6-C: PII 除外 pilot。profile を minimal に通電し、orchestrator が氏名(構造化PII)を prompt から落とす。
    //   request body は不変（生 profile は route まで届く）。prompt byte のみ matching で意図的に変更。
    profile: 'minimal',
    activity: 'compact',
    values: 'include',
    recentLogs: 'include',
    companyContext: 'exclude',
    maxContextChars: 3500,
    notes: 'P3-B で Orchestrator 移行済み。P6-C で profile:minimal を通電し氏名を prompt から除外（PII pilot）。総合スコア・順位は決定的エンジンが別計算。',
  },
  self_analysis: {
    profile: 'include',
    activity: 'compact',
    values: 'include',
    recentLogs: 'exclude', // 横断ログは読まない。過去の自己分析ログ(自分)+coverage は route が付与
    companyContext: 'exclude',
    maxContextChars: 3500,
    notes: 'P3-D で本体(route.ts)を Orchestrator 移行済み。',
  },
  self_analysis_deep_dive: {
    profile: 'include',
    activity: 'compact',
    values: 'include',
    recentLogs: 'exclude', // 横断ログは読まない。coverage 棚卸し・過去自己分析ログは builder が付与
    companyContext: 'exclude',
    maxContextChars: 3500,
    notes: 'P3-E で deepDive(質問生成)の base builder を Orchestrator 移行済み。coverage/pastLog/topics/幅優先ローテは builder 側で不変。',
  },
  mypage_summary: {
    profile: 'minimal',
    activity: 'compact',
    values: 'exclude',
    recentLogs: 'include',
    companyContext: 'exclude',
    maxContextChars: 1500,
    notes: '未使用（route 未実装・将来のマイページ要約用に予約）。',
  },
};

/** purpose に対応する policy を返す。未知 purpose は安全な既定へ fallback。 */
export function getCareerContextPolicy(purpose: CareerContextPurpose | string): CareerContextPolicy {
  return (
    (CAREER_CONTEXT_REGISTRY as Record<string, CareerContextPolicy>)[purpose] ??
    DEFAULT_CAREER_CONTEXT_POLICY
  );
}
