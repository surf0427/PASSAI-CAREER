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
  | 'es_review'
  | 'es_deep_dive'
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
  'es_review',
  'es_deep_dive',
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
// compact = P2-A 既定上限 / minimal = purpose 別 tighter 上限（P8-B: matching のみ通電）/ exclude = 非搭載。
export type ActivityInclusion = 'compact' | 'minimal' | 'exclude';
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

// Orchestrator 移行状況（Data Spine connection 時点で再監査）:
//   live（orchestrator 経由）: interview_practice(start·turn·complete 共有) / matching /
//             presentation_feedback(theme·evaluate·qa) / company_research_review /
//             consultation / self_analysis(route.ts) / self_analysis_deep_dive(question) /
//             es_review(es-review route)
//   base fallback のみ（材料未選択時に es_review policy を借りる）: es/deep / es/organize
//   DORMANT（registry のみ・live callsite 0）: interview_complete / mypage_summary
//
// ★ STEP-GD-31: gd_feedback を DORMANT から **live** へ昇格。
//   GD（マルチ評価 / ソロ評価 / お題生成）が app/api/career/gd/resolveContextInputs.ts 経由で
//   User Data Spine を、resolveCompanyOfficial.ts 経由で Company Data Spine を受け取る。
//   「GD は INTENTIONALLY_CONTEXT_FREE」という旧方針はここで終了する（GD だけが Spine から
//   孤立している状態を解消するため）。ただし採点根拠は transcript のみという原則は不変。
//
// ★ `es_generation` は Closure Batch で **retire**（`D-S12`）。
//   ES 再設計（AI 代筆廃止）で live route が消滅し、orchestrator branch も renderer も
//   到達不能になっていた。enum / registry / renderer / mapping をまとめて削除した。
// policy は宣言（観測用）。purpose 別の実削減は P3-F 以降。route 挙動は policy に依存しない。
export const CAREER_CONTEXT_REGISTRY: Record<CareerContextPurpose, CareerContextPolicy> = {
  es_review: {
    // 氏名(構造化 PII)は prompt から落とす（matching / presentation / interview / consultation と同じ pilot）。
    profile: 'minimal',
    activity: 'compact',
    values: 'include',
    // 直近の自己分析だけは route が別 block で付与する（横断ログ全部は読まない）。
    recentLogs: 'include',
    companyContext: 'optional',
    maxContextChars: 3500,
    notes: 'ES 添削。Data Spine connection で Orchestrator へ移行済み。静的 ES_REVIEW_SYSTEM_PROMPT（添削者ペルソナ・出力 schema）は維持し、base(buildCareerSystemPrompt) と Company 公式情報を **別ブロック**として route が結合する。自己分析は route が canonical renderer で付与。',
  },
  es_deep_dive: {
    // ES 深掘り質問生成。es_review と同じ policy（氏名除外 / activity compact / values 込み）。
    //   ★ es_review と **別 purpose** にしている理由: Company Official の使い道が違う。
    //     添削は「本人の記述と企業の実像の照合」、深掘りは「どの経験・動機を確認すべきかの判断材料」。
    //     renderer の usage note を purpose 単位で出し分けるため、purpose を分ける必要がある。
    profile: 'minimal',
    activity: 'compact',
    values: 'include',
    recentLogs: 'include', // 直近の自己分析を route が背景 block として付与
    companyContext: 'optional',
    maxContextChars: 3500,
    notes: 'ES 深掘り質問生成（seed / follow-up）。選択材料が主要材料、base + 自己分析は背景。企業依存設問（志望動機 / 企業研究）でのみ Company Official を背景に載せる。',
  },
  interview_practice: {
    // P6-E: PII 除外 pilot 横展開。matching(P6-C)/presentation(P6-D) と同じく profile を minimal に通電し氏名を prompt から落とす。
    //   request body は不変。prompt byte のみ変更（start/turn/complete が共有する base builder 経由）。
    profile: 'minimal',
    activity: 'compact',
    values: 'include',
    recentLogs: 'include', // 自己分析 / ES / matching / 相談気づきを route が付与
    companyContext: 'optional',
    maxContextChars: 3500,
    notes: '面接 練習。start/turn/complete が共有する base builder 経由。P6-E で profile:minimal を通電し氏名を prompt から除外（PII pilot 横展開）。',
  },
  interview_complete: {
    // P6-E: interview_practice と揃えて minimal 通電（base builder 共有。purpose 自体は現状未使用だが policy を整合させる）。
    profile: 'minimal',
    activity: 'compact',
    values: 'include',
    recentLogs: 'include',
    companyContext: 'optional',
    maxContextChars: 3500,
    notes: '面接最終評価。base は interview_practice の共有 builder 経由で移行済み。interview_complete purpose 自体は現状未使用（将来 complete 専用 policy 用に予約）。P6-E で profile:minimal に整合。',
  },
  consultation: {
    // P6-F: PII 除外 pilot 最終横展開。matching/presentation/interview と揃えて profile を minimal に通電し氏名を prompt から落とす。
    //   request body は不変。activity 圧縮（compressCareerActivityForConsultation）は route 側の別処理で影響なし。prompt byte のみ変更。
    profile: 'minimal',
    activity: 'compact', // route 側で compressCareerActivityForConsultation 済みを渡す
    values: 'include',
    recentLogs: 'include', // 司令塔: 自己分析/ES/面接/プレゼン/GD/マッチング等を route が手組みで付与
    companyContext: 'include', // 保存済み企業研究スナップショット（最大5件）
    maxContextChars: 3500,
    notes: '司令塔。手組みアグリゲートは route の責務（P3-C は base のみ Orchestrator 経由）。P6-F で profile:minimal を通電し氏名を prompt から除外（PII pilot 完了）。',
  },
  gd_feedback: {
    // STEP-GD-31: Data Spine 接続。GD だけが Spine から孤立している状態を解消する。
    //
    // ★ ただし「transcript 主体」という評価原則は変えない（要件 25）。
    //   base context は **評価軸を歪めるためではなく、フィードバックの宛先を合わせるため**に使う:
    //     - 志望業界 / 職種 / 選考種別を踏まえた「次に何を伸ばすべきか」の助言
    //     - 本人の強み・価値観と GD 中の振る舞いのギャップの指摘
    //   スコアそのものは **server が axisScores から決定論算出**するため、
    //   base context が総合点・ランクを動かすことは構造的に起こらない（要件 29）。
    //
    // profile:minimal … 氏名(構造化 PII)は prompt から落とす（matching / interview と同じ pilot）。
    //   GD 評価に本名は不要（表示名は transcript 側に既に出ている）。
    profile: 'minimal',
    activity: 'compact',
    values: 'include',
    // 直近の自己分析 / 過去 GD を route が別 block で付与する（横断ログ全部は読まない）。
    recentLogs: 'include',
    // 企業指定 GD（＝志望企業が解決できたとき）だけ Company Official を載せる。
    companyContext: 'optional',
    // transcript が主役なので base は絞る（既存 2000 を維持。肥大させない）。
    maxContextChars: 2000,
    notes:
      'GD 評価は transcript 主体（この原則は不変）。STEP-GD-31 で User Data Spine を接続し、志望業界・職種・価値観・自己分析を「助言の宛先合わせ」に使う。総合点/ランク/企業コミュ適性は server の決定論算出のままで、AI には axisScores と根拠しか作らせない。',
  },
  presentation_feedback: {
    // P6-D: PII 除外 pilot 横展開。matching(P6-C) と同じく profile を minimal に通電し、氏名を prompt から落とす。
    //   request body は不変。prompt byte のみ presentation で意図的に変更（evaluate/qa 共有 base builder 経由）。
    profile: 'minimal',
    activity: 'compact',
    values: 'include',
    recentLogs: 'include',
    companyContext: 'exclude',
    maxContextChars: 3500,
    notes: 'P3-C で Orchestrator 移行済み（evaluate/qa が共有する base builder 経由）。P6-D で profile:minimal を通電し氏名を prompt から除外（PII pilot 横展開）。',
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
    // P8-B: activity を minimal に通電。orchestrator が MATCHING_ACTIVITY_LIMITS（field/全体を絞る tighter 上限）で
    //   activity render を縮める。section/card 上限は既定と同一で見出し・title・役割・資格/IT/語学は残す。
    //   request body の raw activity は不変（決定的エンジンは raw を読む＝スコア/順位は不変）。prompt narrative のみ縮む。
    activity: 'minimal',
    values: 'include',
    recentLogs: 'include',
    companyContext: 'exclude',
    maxContextChars: 3500,
    notes: 'P3-B で Orchestrator 移行済み。P6-C で profile:minimal（氏名除外）。P8-B で activity:minimal（tighter limits で narrative 圧縮・スコアは raw activity の決定的エンジンで別計算のため不変）。総合スコア・順位は決定的エンジンが別計算。',
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
