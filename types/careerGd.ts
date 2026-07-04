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

// ── Phase2 マルチGD（合言葉参加型・server 正本）用の型 ─────────────────
// Phase1 の型は一切変更しない。以下は Supabase career_gd_room_* 行のクライアント表現。
// DB との変換は API route 側で行う（クライアントは room 系テーブルを直接叩かない）。

export type GdRoomStatus = 'waiting' | 'active' | 'finished' | 'cancelled';

// career_gd_rooms のクライアント表現（join_code_hash / room_salt はクライアントに渡さない）。
export type CareerGdRoom = {
  id: string;
  hostUserId: string;
  status: GdRoomStatus;
  format: GdFormat;
  theme: GdTheme | null; // start 時に確定（waiting 中は未確定）
  timeLimitSec: number;
  plannedParticipantCount: number;
  codeExpiresAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

// career_gd_room_members のクライアント表現（AI は userId 未設定 / isAi=true）。
export type CareerGdRoomMember = {
  id: string;
  roomId: string;
  userId?: string | null; // AI は null
  isAi: boolean;
  isHost: boolean;
  participantId: string;
  displayName: string;
  role: GdRole;
  // AI のみ。STEP-GD-13 以降は 10 タイプの persona 情報を保持する（既存 assertiveness/style は後方互換）。
  // 秘匿情報は含まない（persona は元々 UI 表示・プロンプト用の公開情報）。
  persona?: {
    assertiveness: 1 | 2 | 3;
    style: string;
    personaKey?: string; // 例: leader / logical / critical …（スネークケース）
    personaRole?: string; // 議論上の役回り（例: 進行・整理）。member.role(GdRole) とは別。
    personaSummary?: string;
    speakingStyle?: string;
    strengths?: string[];
    weaknesses?: string[];
  };
  joinedAt: string;
  leftAt?: string | null;
};

// career_gd_room_messages のクライアント表現（STEP-GD-14 まで空配列でよい）。
export type CareerGdRoomMessage = {
  id: string;
  roomId: string;
  participantId: string;
  senderUserId?: string | null; // AI は null
  seq: number;
  content: string;
  kind: 'speech' | 'system';
  createdAt: string;
};

// create API のレスポンス（平文 joinCode はここでのみ受け取る）。
export type CareerGdRoomCreateResponse = {
  roomId: string;
  joinCode: string;
  codeExpiresAt: string;
  status: GdRoomStatus;
  format: GdFormat;
  plannedParticipantCount: number;
  timeLimitSec: number;
};

// join API のレスポンス。
export type CareerGdRoomJoinResponse = {
  roomId: string;
  status: GdRoomStatus;
  joinedMember: CareerGdRoomMember;
  members: CareerGdRoomMember[];
  codeExpiresAt: string;
};

// GET room API のレスポンス（ロビー / 進行のポーリングで使う）。
export type CareerGdRoomDetailResponse = {
  room: CareerGdRoom;
  members: CareerGdRoomMember[];
  messages: CareerGdRoomMessage[];
  isHost: boolean;
  currentUserMember: CareerGdRoomMember | null;
  status: GdRoomStatus;
};

// ── STEP-GD-14: 発言 / 進行 / 結果 API のレスポンス型 ──────────────────

// GET messages（afterSeq でポーリング差分取得）。
export type CareerGdRoomMessagesResponse = {
  messages: CareerGdRoomMessage[];
  latestSeq: number; // 取得できた中の最大 seq（0 = まだ発言なし）
};

// POST messages（人間の発言投稿）。同一 client_msg_id は冪等に同じ message を返す。
export type CareerGdRoomMessagePostResponse = {
  message: CareerGdRoomMessage;
  idempotent: boolean; // 既存 client_msg_id と一致して再投稿された場合 true
};

// POST ai-turn（AI 1 名の発言を生成・保存）。
export type CareerGdRoomAiTurnResponse = {
  message: CareerGdRoomMessage;
  speakerParticipantId: string;
};

// ── STEP-GD-15: 本格 feedback 採点（messages 本文を根拠にした AI 評価） ──────
// 就活支援サービスとして、GD能力評価 + 強み弱み + 企業コミュ適性 + マッチング連携に
// 再利用できる構造で持つ。合計・ランク・企業グレードは AI に決めさせず server が決定論算出する。

// 6 評価軸（各 0〜100）。
export type CareerGdAxisKey =
  | 'logicalThinking' // 論理性: 筋・根拠・因果
  | 'collaboration' // 協調性: 他者反応・傾聴・議論促進
  | 'initiative' // 主体性: 議論を動かす・リード
  | 'creativity' // 発想力: 新視点・アイデア量
  | 'persuasiveness' // 説得力: 納得感・具体性
  | 'discussionSkill'; // GD適応力: 全体把握・整理・時間意識

export type CareerGdAxisScores = Record<CareerGdAxisKey, number>;

// 1 参加者（人間のみ採点）の本格評価。
//   - axisScores は AI（0〜100・発言本文が根拠）。
//   - overallScore / rank / companyCommunicationGrade は server が決定論で算出（AI に決めさせない）。
//   - scored=false は「採点不能」（空議論・本人発言0件など）。
export type CareerGdEvaluation = {
  version: 2; // 評価スキーマ版（1=STEP-GD-14 の発言量ベース暫定）。
  scored: boolean;
  unscoredReason?: string; // scored=false のときの理由（採点不能）
  axisScores: CareerGdAxisScores;
  overallScore: number; // 0〜100（server 算出）
  rank: GdCompanyGrade; // S/A/B/C/D（server 算出・overallScore から決定論写像）
  companyCommunicationGrade: GdCompanyGrade; // 就活: 会議/顧客折衝/チーム業務との相性（server 算出）
  strengths: string[]; // 実発言が根拠
  weaknesses: string[]; // 実発言が根拠
  improvements: string[]; // 建設的な改善提案
  goodQuotes: string[]; // 実際の発言抜粋（短文）
  overallComment: string; // 総合講評（就活向け・建設的）
  speechCount: number; // 補助指標（評価の主根拠にはしない）
  totalSpeechCount: number;
};

// ランキング（人間参加者のみ・全員に共有）。overallScore 降順。
export type CareerGdRankingEntry = {
  participantId: string;
  displayName: string;
  rank: number;
  overallScore: number;
  grade: GdCompanyGrade;
};

// マッチング連携ヒント（断定禁止・「傾向として」レベル）。
export type CareerGdMatchingHints = {
  hints: string[]; // 例: 「傾向として営業職と相性が良い可能性」
  summary: string; // 相談AI/他機能へ渡す 1〜2 文
};

// 各ユーザーの結果（career_gd_room_results 1 行のクライアント表現）。
export type CareerGdRoomResultView = {
  roomId: string;
  participantId: string;
  displayName: string;
  evaluation: CareerGdEvaluation; // 本人ぶん（詳細は本人のみ表示）
  ranking: CareerGdRankingEntry[]; // 全体（共有）
  matchingHints: CareerGdMatchingHints; // 本人ぶん
  consultationSummary: string; // generateCareerGdSummary の出力（相談AI 連携用の圧縮サマリー）
  createdAt: string;
};

export type CareerGdRoomResultResponse = {
  result: CareerGdRoomResultView;
};

// ── STEP-GD-16: マルチGD 結果の学習履歴（localStorage canonical / Supabase durable mirror） ──
// 各デバイスの「自分のマルチGD結果」履歴。career_gd_room_results（Supabase）が durable mirror、
// この log が閲覧用 canonical（既存 CAREER の run→result→view 設計に合わせる）。
// 重複保存を避けるため roomId を id とし、append 時に upsert（同 roomId は置換）。
export type CareerGdRoomLog = {
  id: string; // = roomId（重複排除キー）
  roomId: string;
  participantId: string; // 本人の participant_id（ranking で自分を強調するため）
  createdAt: string; // 結果を履歴に登録した時刻（= 表示上の実施日時）
  theme: GdTheme;
  format: GdFormat;
  participantCount: number; // 総参加者（人間＋AI）
  humanCount: number;
  durationSec: number; // 所要時間（finishedAt - startedAt、無ければ制限時間）
  evaluation: CareerGdEvaluation; // 本人の 6 軸評価（overallScore/rank/companyCommunicationGrade 等）
  ranking: CareerGdRankingEntry[]; // 参加者内スコア順（共有）
  matchingHints: CareerGdMatchingHints; // 本人ぶん
  consultationSummary: string; // 相談AI 連携用の圧縮サマリー（overall_summary 由来）
};

// GD 結果履歴 hydrate（GET /api/career/gd/room/results）の 1 件。
// 本人が参加した room の「自分ぶん」の結果のみ。PII（user_id/email/join_code_hash）は含めない。
export type CareerGdRoomResultHistoryItem = {
  roomId: string;
  resultId: string;
  roomType: 'public_lobby' | 'invite' | 'random_match' | 'unknown';
  theme: string | null;
  format: GdFormat;
  participantCount: number; // 人間＋AI
  humanParticipantCount: number;
  aiParticipantCount: number;
  createdAt: string;
  durationSec: number;
  participantId: string; // 本人の participant_id（ranking 強調用）
  evaluation: CareerGdEvaluation; // 本人の 6 軸評価
  ranking: CareerGdRankingEntry[]; // 参加者内スコア順（共有）
  matchingHints: CareerGdMatchingHints; // 本人ぶん
  consultationSummary: string; // overall_summary 由来
};

export type CareerGdRoomResultsResponse = { results: CareerGdRoomResultHistoryItem[] };

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
