// PASSAI CAREER — Central Memory Architecture 型・契約定義（P4-A）。
//
// 位置づけ:
//   「中央メモリ」は新しい永続ストアではなく、**localStorage canonical の raw log から
//   純関数 selector が purpose 別に必要な AI-consumable summary block だけを算出する論理層**。
//   本ファイルは P4-A の成果物であり **型と契約のみ**。selector 実装・localStorage 読込・
//   Supabase 読込・prompt 生成・budget/guard の挙動変更は一切含まない（それらは P4-B 以降）。
//
// no behavior change 保証:
//   - 本ファイルを import する既存コードは現時点で存在しない（＝runtime 不変）。
//   - runtime 値は「反復用の const key 配列」のみ（既存挙動に影響しない純追加）。
//
// 依存方針（意図的に self-contained）:
//   - 既存型（CareerAiContext / *HistorySnapshot / CareerEventFeature / CareerContextPurpose 等）を
//     import しない。循環参照を避け、P4-A を「設計の宣言」に留めるため。
//   - 既存 union との整合はコメントで明示する（実際の型接続は P4-C で行う）。
//   - このため本ファイルは storage 型・snapshot 型と *構造的に近いが独立* した宣言である。
//
// 3層分離（詳細は docs/qa/p4a_memory_types_map.md §B）:
//   1) Raw Log            — 既存 localStorage canonical + Supabase durable mirror（現状維持・本層は触れない）
//   2) Feature Summary    — raw log から都度生成する AI-consumable 要約（route 別に再利用可能）
//   3) Career Memory Snapshot — route 横断で使う中央 memory（long-term / latest / signals / warnings）

// ── 機能キー（CareerEventFeature と整合。GD は solo/room を区別する） ──────────────

// 中央メモリが扱う機能。types/careerEvents.ts の CareerEventFeature と整合させる
// （'gd' を gd_solo / gd_room に分けている点のみ差分。実接続は P4-C）。
export type CareerMemoryFeature =
  | 'profile'
  | 'activity'
  | 'values'
  | 'self_analysis'
  | 'es'
  | 'interview'
  | 'presentation'
  | 'company_research'
  | 'matching'
  | 'consultation'
  | 'gd_solo'
  | 'gd_room'
  | 'events';

// ── Memory Block Key ──────────────────────────────────────────────
// CareerMemorySnapshot が持ちうるブロックの識別子。selector はこの単位で出し入れする。

export type CareerMemoryBlockKey =
  | 'base' // profile + activity + values の stable base summary
  | 'selfAnalysis'
  | 'es'
  | 'interview'
  | 'presentation'
  | 'companyResearch'
  | 'matching'
  | 'gdSolo'
  | 'gdRoom'
  | 'consultation'
  | 'signals'; // career_user_events 由来の metadata signal（member-only）

// 反復・検証用の正本リスト（runtime 値。既存挙動には影響しない純追加）。
export const CAREER_MEMORY_BLOCK_KEYS = [
  'base',
  'selfAnalysis',
  'es',
  'interview',
  'presentation',
  'companyResearch',
  'matching',
  'gdSolo',
  'gdRoom',
  'consultation',
  'signals',
] as const satisfies readonly CareerMemoryBlockKey[];

// ── Purpose（CareerContextPurpose と整合。memory 視点で GD/mypage を明示） ─────────

// 中央メモリ selector の呼び出し purpose。lib/careerContext/purpose.ts の
// CareerContextPurpose と整合させる（memory 視点で gd_solo / gd_multiplayer_result /
// mypage を明示。実際の policy 接続は P4-C）。
export type CareerMemoryPurpose =
  | 'self_analysis'
  | 'self_analysis_deep_dive'
  | 'es_review'
  | 'interview'
  | 'presentation'
  | 'company_research'
  | 'matching'
  | 'consultation'
  | 'gd_solo'
  | 'gd_multiplayer_result'
  | 'mypage';

export const CAREER_MEMORY_PURPOSES = [
  'self_analysis',
  'self_analysis_deep_dive',
  'es_review',
  'interview',
  'presentation',
  'company_research',
  'matching',
  'consultation',
  'gd_solo',
  'gd_multiplayer_result',
  'mypage',
] as const satisfies readonly CareerMemoryPurpose[];

// ── Raw risk / budget hint / block policy ─────────────────────────

// ブロックが「raw 本文を運びうるか」のリスク階級（rawTextGuard の観点）。
//   none: 構造化 signal のみ / low: 短い要約 / medium: 自由記述の短縮 / high: 生本文になりうる
export type CareerMemoryRawRisk = 'none' | 'low' | 'medium' | 'high';

// ブロックの purpose 別扱い（宣言。P4-A では強制しない）。
export type CareerMemoryInclusion = 'required' | 'optional' | 'forbidden';

// budget 目安（文字数ベース。lib/careerContext/budget.ts と接続可能な単位）。
export type CareerMemoryBudgetHint = {
  block: CareerMemoryBlockKey;
  // このブロックが占めてよい概算文字数の目安。
  maxChars: number;
  // 件数上限（履歴系のみ。例: history=3, companyResearch=5, matching=2）。
  maxItems?: number;
};

// purpose × block の 1 セルの方針。selector が「必要 block だけ返す」ための宣言。
export type CareerMemoryBlockPolicy = {
  block: CareerMemoryBlockKey;
  inclusion: CareerMemoryInclusion;
  rawRisk: CareerMemoryRawRisk;
  budget: CareerMemoryBudgetHint;
  note?: string;
};

// 1 purpose 分の memory 契約（route 別 selector の宣言）。
// 実データは docs/qa/p4a_memory_types_map.md §D の表を正本とし、
// 実際の const registry 化・強制は P4-C 以降で行う（P4-A では型のみ）。
export type CareerMemoryPurposePolicy = {
  purpose: CareerMemoryPurpose;
  blocks: CareerMemoryBlockPolicy[];
  // base + 選択 block の合計文字数目安（超過は観測用。挙動には影響しない）。
  totalMaxChars: number;
  // 全 block が空のときの振る舞い（例: 'base のみ' / 'transcript 主体で memory 不使用'）。
  fallback: string;
  // 旧 client / v2 欠損データへの後方互換メモ。
  backwardCompat: string;
};

// ── Feature Summary 共通型 ────────────────────────────────────────
// raw log から都度生成する AI-consumable 要約の共通土台。
//   - latest: 直近スナップショット（新しい順。件数上限つき）。
//   - longTerm: 複数件から算出した累積要約（一貫項目・推移メモ等。任意）。
//   - meta: 由来メタ（件数・最新時刻・警告）。本文は持たない。

export type FeatureSummaryMeta = {
  feature: CareerMemoryFeature;
  // 要約元 raw log 件数（0 なら該当機能未利用）。
  sourceCount: number;
  // 最新 raw log の作成時刻（YYYY-MM-DD 以上の粒度。任意）。
  latestAt?: string;
  // rawTextGuard 相当の自己申告警告（例: 'truncated', 'pii_stripped'）。
  warnings?: string[];
};

// TLatest: 1 件分の latest スナップショット形状 / TLongTerm: 累積要約形状（無ければ never）。
export type FeatureSummary<TLatest, TLongTerm = never> = {
  meta: FeatureSummaryMeta;
  latest: TLatest[];
  longTerm?: TLongTerm;
};

// ── feature 別 summary（raw 本文・PII を除いた AI-consumable 形状） ────────────────

// profile: 氏名・メール等 PII を除いた stable base。
export type ProfileMemorySummary = {
  university: string;
  faculty: string;
  grade: string;
  graduationYear: string;
  targetIndustries: string[];
  targetJobs: string[];
  targetCompanies: string[];
  jobHuntingStatus: string;
  strengths: string[];
  weaknesses: string[];
  preferredLocations: string[];
  // 注: name / email 等 PII は memory に載せない（rawTextGuard DANGER_KEY_TOKENS 対応）。
};

// activity: 18 セクションの全文ではなく「入力済みカテゴリ + 主要ハイライト」の軽量版。
export type ActivityMemorySummary = {
  // 入力済み活動カテゴリのラベル（buildCoverageInventory 相当）。
  presentSections: string[];
  // ガクチカ等の主要タイトル（要約・件数上限つき。本文は載せない）。
  highlights: string[];
};

// values: 就活軸の選択ラベル群（自由記述備考は短縮のみ）。
export type ValuesMemorySummary = {
  priorities: string[];
  avoidances: string[];
  industries: string[];
  jobTypes: string[];
  workStyles: string[];
  companyTypes: string[];
  careerGoals: string[];
  culturePreferences: string[];
};

// base ブロック（profile + activity + values）。selector が purpose に応じて minimal/include を出し分ける。
export type BaseMemorySummary = {
  profile: ProfileMemorySummary;
  activity: ActivityMemorySummary;
  values: ValuesMemorySummary;
};

// self-analysis: latest（1 回分）+ longTerm（一貫強み・推移）。
// 既存 SelfAnalysisHistorySnapshot / SelfAnalysisPastSummary の共通上位（P4-B で統合）。
export type SelfAnalysisLatest = {
  createdAt: string;
  summary: string;
  careerDirection: string;
  strengths: string[];
  weaknesses: string[];
  valueKeywords: string[];
  strengthKeywords: string[];
  recommendedIndustries: string[];
  recommendedJobs: string[];
  companySelectionCriteria: string[];
  gakuchikaIdeas: string[];
  nextActions: string[];
};
export type SelfAnalysisLongTerm = {
  // 複数回で一貫している強み。
  consistentStrengths: string[];
  // 推奨業界の変化（oldest → newest）。無ければ空。
  industryShift: string[];
};
export type SelfAnalysisMemorySummary = FeatureSummary<SelfAnalysisLatest, SelfAnalysisLongTerm>;

// ES: 本人が取り組んだ設問メタの要約。
//   ★ P17-M1（ESトレーニング再設計対応）: ES は AI 代筆を廃止し、本人が本文を書く方式に変わった。
//     Personal Memory には **本人が入力した設問メタ（企業名・設問）だけ**を載せ、
//     AI 生成文（旧 headline / gakuchika / selfPr / motivation / appealPoints）・AI 添削コメント・
//     生本文全文は載せない（req: AI 生成文は本人作成情報として扱わない / 生本文は保存しない）。
export type EsLatest = {
  createdAt: string;
  companyName: string;
  question: string;
};
export type EsLongTerm = {
  // ES を書いた企業名の集合（志望動機の企業固有性チェック用）。
  companies: string[];
};
export type EsMemorySummary = FeatureSummary<EsLatest, EsLongTerm>;

// interview: 弱み・繰り返しフィードバック要約（turn 全文は載せない）。
export type InterviewLatest = {
  createdAt: string;
  mode: string;
  overallComment: string;
  strengths: string[];
  improvements: string[];
  deepDiveTopics: string[];
  nextActions: string[];
  companyFit: string;
};
export type InterviewLongTerm = {
  // 繰り返し出ている改善点（＝優先課題）。
  recurringImprovements: string[];
  // 安定している強み。
  stableStrengths: string[];
};
export type InterviewMemorySummary = FeatureSummary<InterviewLatest, InterviewLongTerm>;

// presentation: 構成・delivery フィードバック要約（transcript 全文は載せない）。
export type PresentationLatest = {
  createdAt: string;
  presentationType: string;
  theme: string;
  // 生スコアは band 化推奨だが、履歴推移の可読性のため数値も許容（PII ではない）。
  totalScore: number | null;
  rank: string;
  overallComment: string;
  improvements: string[];
  priorityImprovements: string[];
  expectedQuestions: string[];
  nextPractice: string[];
  companyFit: string;
};
export type PresentationLongTerm = {
  // スコア推移メモ（例: '68→75点 改善傾向'）。
  scoreTrend: string;
};
export type PresentationMemorySummary = FeatureSummary<PresentationLatest, PresentationLongTerm>;

// company research: 本人が検証した企業メモの要約（verifiedResearchText 全文は載せない）。
export type CompanyResearchLatest = {
  createdAt: string;
  companyName: string;
  // verifiedResearchText の要約（生本文ではない）。
  verifiedMemoSummary: string;
  // 面接文脈用の要約（既存 interviewContextSummary 相当）。
  interviewContextSummary: string;
  fit: string;
};
export type CompanyResearchMemorySummary = FeatureSummary<CompanyResearchLatest>;

// matching: キャリア方向性・fit signals（決定的スコアの生値詳細は載せない）。
export type MatchingLatest = {
  createdAt: string;
  // 志向・方向性の要約。
  careerDirection: string;
  // 相性の高い観点（強み/価値観/働き方/志向）。
  fitSignals: string[];
  // 上位候補企業名（band/順位のみ。生スコア詳細は載せない）。
  topCandidates: string[];
};
export type MatchingMemorySummary = FeatureSummary<MatchingLatest>;

// GD: 振る舞い・チームワーク signal（発言本文・raw message は載せない）。solo/room 共通形。
export type GdLatest = {
  createdAt: string;
  // 'solo' | 'room'（発生源。room は multiplayer）。
  mode: 'solo' | 'room';
  role: string;
  // 振る舞い signal（例: '結論提示が早い', '傾聴が強い'）。生の発言ではない。
  behaviorSignals: string[];
  // チームへの貢献 signal。
  teamworkSignals: string[];
};
export type GdMemorySummary = FeatureSummary<GdLatest>;

// consultation: 司令塔レベルの「現在地」signal（会話 thread 本文は載せない）。
export type ConsultationMemorySummary = {
  meta: FeatureSummaryMeta;
  // 現在の相談フォーカス（短い要約）。
  currentFocus: string;
  // 未解決の懸念・迷い（短いラベル群）。
  openConcerns: string[];
  // 直近で提案された次アクション（本文ではなくラベル）。
  recentActions: string[];
};

// career_user_events 由来の L2 Personal Event Signal（P10-B で安全な v1 schema へ置換）。
// 実体・builder は lib/careerMemory/eventSignals.ts（本文なし・bucket/band のみ）。snapshot の
// `signals?` 用に型を import（local 束縛）+ re-export する。type-only のため runtime 不変・循環なし。
import type { CareerEventSignalSummary } from './eventSignals';
export type { CareerEventSignalSummary };

// ── Career Memory Snapshot（route 横断の中央メモリ。全 block optional） ─────────────
// selector は purpose に応じて「必要 block のみ」を埋める。空 block は undefined のまま。

export type CareerMemorySnapshotMeta = {
  purpose: CareerMemoryPurpose;
  // 常に client 側で生成される（案A: client-side selector）。
  generatedForClient: true;
  // 実際に埋めた block（観測・test 用）。
  includedBlocks: CareerMemoryBlockKey[];
  // budget / guard 上の警告（例: 'over_budget', 'raw_text_suspected'）。挙動には影響しない。
  warnings: string[];
};

export type CareerMemorySnapshot = {
  meta: CareerMemorySnapshotMeta;
  base?: BaseMemorySummary;
  selfAnalysis?: SelfAnalysisMemorySummary;
  es?: EsMemorySummary;
  interview?: InterviewMemorySummary;
  presentation?: PresentationMemorySummary;
  companyResearch?: CompanyResearchMemorySummary;
  matching?: MatchingMemorySummary;
  gdSolo?: GdMemorySummary;
  gdRoom?: GdMemorySummary;
  consultation?: ConsultationMemorySummary;
  signals?: CareerEventSignalSummary;
};

// ── Selector 契約（型のみ。実装は P4-C） ──────────────────────────────
// client 側が load* で読んだ raw logs を渡すと、purpose 別 memory snapshot を返す純関数。
// P4-A では storage 型への依存を作らないため loaded を unknown 受けで宣言する（実型は P4-C）。

export type CareerMemorySelectorLoadedLogs = {
  profile?: unknown;
  activity?: unknown;
  values?: unknown;
  selfAnalysisLogs?: unknown;
  esLogs?: unknown;
  interviewResults?: unknown;
  presentationResults?: unknown;
  companyResearchLogs?: unknown;
  matchingLogs?: unknown;
  consultationThreads?: unknown;
  gdResults?: unknown;
  gdRoomLogs?: unknown;
  eventSignals?: unknown;
};

export type CareerMemorySelectorInput = {
  purpose: CareerMemoryPurpose;
  loaded: CareerMemorySelectorLoadedLogs;
};

// 純関数シグネチャ（副作用なし・I/O なし）。P4-C で実装する。
export type CareerMemorySelectorContract = (
  input: CareerMemorySelectorInput,
) => CareerMemorySnapshot;
