// PASSAI 就活版 — GD（グループディスカッション）機能の型
//
// 受験版（大学受験・AO/推薦）とは一切無関係。新卒就活専用。
// Phase1 は「ソロGD（ユーザー1人 + AI参加者）」で完結するが、型は将来のマルチプレイ
// （Phase2 招待リンク型 / Phase3 ランダムマッチング）に対応できるよう最初から設計する。
//
// 保存は localStorage が canonical:
//   - 'careerGdSessions' : 進行中/完了セッション（会話状態）
//   - 'careerGdResults'  : 完了結果（評価・企業評価・個別FB・順位・matchingHints）
// DB / Supabase / usage には接続しない（Phase1）。

// GD 形式。MVP は 自由/ケース/抽象。将来 'industry' | 'company' を追加できる。
export type GdFormat = 'free' | 'case' | 'abstract';

// 参加形式。Phase1 は 'solo' 固定。Phase2 以降で 'multi'。
export type GdParticipationMode = 'solo' | 'multi';

// 役割。人数・形式によって使う役割数は調整する（gdRoles.ts）。
export type GdRole =
  | 'facilitator' // 司会
  | 'scribe' // 書記
  | 'timekeeper' // タイムキーパー
  | 'presenter' // 発表者
  | 'member'; // 一般参加者

// 参加者の種別。solo では自分以外はすべて 'ai'。
export type GdParticipantType = 'user' | 'ai';

// 企業選考目線の評価ランク（順位とは別軸で必ず表示する）。
//   S: かなり通過レベル / A: 通過可能性が高い / B: 平均的 / C: 改善が必要 / D: かなり改善が必要
export type GdCompanyGrade = 'S' | 'A' | 'B' | 'C' | 'D';

// careerMatching など他機能へ渡すための行動特性（列挙で制約する）。
export type GdBehaviorTrait =
  | 'leader' // リーダー型
  | 'coordinator' // 調整型
  | 'analytical' // 分析型
  | 'ideator' // アイデア型
  | 'listener' // 傾聴型
  | 'driver'; // 推進型

// GD 参加者（自分 + AI を混在で保持）。
export type GdParticipant = {
  id: string;
  type: GdParticipantType;
  displayName: string;
  role: GdRole;
  // 自分自身か（solo/multi 共通で 1 人だけ true）。
  isSelf?: boolean;
  // Phase2: 招待参加したユーザーの ID（solo では未設定）。
  userId?: string;
  // AI 参加者のみ。強すぎず、ユーザーの発言機会を奪わない上限として使う。
  persona?: {
    assertiveness: 1 | 2 | 3;
    style: string; // 論理型 / 共感型 / 発散型 / 慎重型 / 推進型 等
  };
};

// 1 発言。system は進行アナウンス（役割割当・タイマー等）。
export type GdUtterance = {
  id: string;
  participantId: string;
  content: string;
  createdAt: string;
  kind?: 'speech' | 'system';
};

// GD テーマ。
export type GdTheme = {
  title: string;
  description: string;
  format: GdFormat;
  constraints?: string[]; // ケース型の与件など
};

// 個別フィードバックの評価軸（AI は各 0〜100 の小スコア + 根拠を返す。合計はサーバ計算）。
export type GdAxisScores = {
  logic: number; // 論理性
  cooperation: number; // 協調性
  volume: number; // 発言量（過多/過少も評価）
  roleExecution: number; // 役割遂行度
  drive: number; // 議論推進力
  listening: number; // 傾聴力
};

// 参加者ごとの個別フィードバック。
export type GdParticipantFeedback = {
  participantId: string;
  axisScores: GdAxisScores;
  totalScore: number; // ← サーバが axisScores から決定的に算出
  companyGrade: GdCompanyGrade; // ← サーバが totalScore から決定的に写像
  companyImpression: string; // 企業選考での評価（説明文・断定回避）
  behaviorTraits: GdBehaviorTrait[]; // この参加者の行動特性（1〜2個）
  improvements: string[]; // 改善点
  nextPracticeTasks: string[]; // 次回の練習課題
  crossFeatureHints: {
    matching?: string;
    interview?: string;
    es?: string;
    selfAnalysis?: string;
  };
};

// マルチ時の順位（Phase2〜。solo では付けない）。
export type GdRankingEntry = {
  participantId: string;
  rank: number;
  totalScore: number;
  companyGrade: GdCompanyGrade;
  reason: string; // 順位の根拠（煽らず成長支援トーン）
};

// careerMatching / 相談AI / 面接 / ES / 自己分析へ渡す集約ヒント（自分自身の分）。
export type GdMatchingHints = {
  behaviorTraits: GdBehaviorTrait[];
  strengthKeywords: string[]; // GD で顕在化した強み
  suggestedEnvironments: string[]; // 向いてそうな環境
  companyGrade: GdCompanyGrade;
  summary: string; // 1〜2 文の要約（他機能のプロンプトへ注入しやすい形）
};

// 進行中 / 完了セッション（localStorage: 'careerGdSessions'）。
export type CareerGdSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'in_progress' | 'completed';
  participationMode: GdParticipationMode; // Phase1 は 'solo'
  format: GdFormat;
  theme: GdTheme;
  timeLimitSec: number;
  plannedParticipantCount: number;
  participants: GdParticipant[]; // user + ai 混在
  transcript: GdUtterance[];
  // Phase2: 招待ルーム連携（solo では未設定）。
  roomId?: string;
  // 他機能連携（任意・後方互換）。
  companyResearchLogId?: string;
  selfAnalysisLogId?: string;
};

// 完了結果 1 件（localStorage: 'careerGdResults'）。
export type CareerGdResult = {
  id: string; // = session.id
  createdAt: string;
  participationMode: GdParticipationMode;
  format: GdFormat;
  theme: GdTheme;
  timeLimitSec: number;
  participants: GdParticipant[];
  transcript: GdUtterance[];
  selfRole: GdRole; // 自分の役割
  feedbacks: GdParticipantFeedback[]; // 全参加者分（solo は 自分 + AI）
  ranking?: GdRankingEntry[]; // multi のみ。solo は未設定
  selfCompanyGrade: GdCompanyGrade; // 自分の企業評価（一覧表示用に冗長保持）
  overallSummary: string; // 総合講評（solo は AI 比較を含む）
  matchingHints: GdMatchingHints; // 他機能が参照する集約（自分の分）
  roomId?: string;
  companyResearchLogId?: string;
  selfAnalysisLogId?: string;
  favorite?: boolean;
};
