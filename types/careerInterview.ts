// PASSAI 就活版 — 面接AIの型
//
// 受験版（lib/interviewAi / types/interview.ts）の DB セッション・InterviewFeedback には依存しない。
// 就活版は「ステートレスAPI + localStorage セッション」で動かすため、専用の軽量な型を持つ。
// 受験版の AO・推薦・大学受験・大学評価軸の文脈は持ち込まない（新卒就活専用）。

import type { CompanyResearchSnapshot } from '@/types/careerCompanyResearch';

// 会話 1 発話。質問（面接官）/ 回答（学生）の交互列で会話履歴を表す。
export type CareerInterviewTurn = {
  role: 'question' | 'answer';
  content: string;
};

// 入力モード（テキスト入力 / 音声入力）。音声は Web Speech API（ブラウザ内）で扱う。
export type CareerInterviewMode = 'text' | 'voice';

// 面接の種類（新卒就活）。受験版の interviewType（self_analysis/statement/essay/free/pressure）に
// 相当するが、概念を就活へ全面的に置き換える。
//   - self_analysis : 自己分析深掘り（価値観・強み・原体験）
//   - gakuchika     : ガクチカ深掘り（学生時代に力を入れたこと）
//   - self_pr       : 自己PR深掘り（強み・再現性）
//   - motivation    : 志望動機（業界・企業理解・キャリア軸との接続）
//   - real          : 本番想定面接（総合・横断）
//   - pressure      : 圧迫面接（少し厳しめ。人格否定はしない）
export type CareerInterviewType =
  | 'self_analysis'
  | 'gakuchika'
  | 'self_pr'
  | 'motivation'
  | 'real'
  | 'pressure';

// 1 ターン（回答→次質問）のAI出力。
// reaction = 直前の回答への一言リアクション、question = 次の深掘り質問。
export type CareerInterviewTurnResult = {
  reaction: string;
  question: string;
};

// ── 受験先・選考の想定（面接の前段で入力する任意の応募コンテキスト） ─────────
// 面接AIが「どの企業・選考を受けるか」を前提に、志望動機・企業理解・職種理解の
// 深掘りやフィードバックを最適化するために使う。すべて localStorage 保持で、
// Supabase / DB には接続しない（欠損しても面接は成立する後方互換設計）。

// 選考種別。ES 側（CareerEsSelectionType）と同じ語彙に揃える（'main' | 'internship'）。
// 未指定（undefined）は「指定なし」を表す。
export type CareerInterviewSelectionType = 'main' | 'internship';

// 選考フェーズ。未指定（undefined）は「指定なし」を表す。
//   - 'first'      : 一次面接
//   - 'second'     : 二次面接
//   - 'final'      : 最終面接
//   - 'internship' : インターン面接
//   - 'casual'     : カジュアル面談
export type CareerInterviewPhase =
  | 'first'
  | 'second'
  | 'final'
  | 'internship'
  | 'casual';

// 面接の前段で入力する受験先・選考情報。companyName のみ必須、他は任意。
export type CareerInterviewTarget = {
  // 志望企業名（必須）。★ Company Identity 導入後も **required のまま維持する**。
  companyName: string;
  // Company Data Spine の canonical key（Phase A / R5・optional・後方互換）。
  //   - 登録済み企業を選んだときだけ入る。欠損（未登録・free-text・旧 target）が正常。
  //   - ★ 不変条件: companyId があるなら companyName も必ず非空
  //     （normalizeInterviewTarget が companyName 空を null に倒すため構造的に担保される）。
  companyId?: string;
  // 志望業界（任意）。
  industry?: string;
  // 志望職種（任意）。
  jobType?: string;
  // 選考種別（任意）。未指定は「指定なし」。
  selectionType?: CareerInterviewSelectionType;
  // 選考フェーズ（任意）。未指定は「指定なし」。
  interviewPhase?: CareerInterviewPhase;
  // 企業について分かっていること・メモ（任意。AIの企業情報は本メモを最優先根拠にする）。
  companyMemo?: string;
  // 特に対策したいこと（任意）。
  focusPoint?: string;
};

// 受験先・選考の想定（target）に紐づく最終評価の追加フィードバック。
// すべて optional。target 入力があった面接でのみ AI が返す（旧ログ・target無しでは未設定）。
export type CareerInterviewTargetFeedback = {
  // この企業向けに見たときの説得力・不足点（志望動機/企業理解/職種理解）。企業事実は断定しない。
  companyFitComment?: string;
  // 選考フェーズ（一次/二次/最終/インターン/カジュアル）別の評価。
  phaseSpecificComment?: string;
  // 職種適性・職種理解に関する評価（その職種で活きる再現性・行動特性が伝わるか）。
  jobFitComment?: string;
  // 選考種別（本選考/インターン）別の評価。
  selectionTypeComment?: string;
  // この企業・選考で落ちやすい弱点。
  weakPointsForThisTarget?: string[];
  // 次に練習すべき想定質問（この企業・選考・フェーズ向け）。
  nextPracticeQuestions?: string[];
  // 逆質問案（特にカジュアル面談・最終面接・インターンで有効。企業メモ/職種に紐づける）。
  suggestedReverseQuestions?: string[];
};

// 面接全体の最終評価。
// companyFit は STEP（就活版面接強化）で追加。旧ログには無いため読み取り側は欠損許容する。
export type CareerInterviewFinalResult = {
  overallComment: string;
  strengths: string[];
  improvements: string[];
  sampleAnswers: string[];
  deepDiveTopics: string[];
  nextActions: string[];
  // 志望業界・職種・就活軸（あれば志望企業）との相性・接続についての所見。
  companyFit: string;
  // 企業研究ログを使った面接のときの「企業研究との接続評価」（任意・後方互換）。
  //   企業理解の活用度 / 志望理由との接続 / 自己分析との接続 / 入社後ビジョンの具体性 を所見にする。
  //   企業研究ログ未選択の面接では未設定（空文字）。
  companyResearchFit?: string;
  // 受験先・選考の想定（target）に紐づく追加フィードバック（任意・後方互換）。
  //   target 入力があった面接でのみ設定。旧ログ・target無しでは未設定。
  targetFeedback?: CareerInterviewTargetFeedback;
};

// 進行中 / 完了済みの面接セッション（localStorage: careerInterviewSessions）。
// 会話状態（turns）はクライアントが保持し、各ターンの生成はステートレスAPIに委ねる。
export type CareerInterviewSession = {
  // 安定 ID（結果ログと突き合わせる）。
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'in_progress' | 'completed';
  mode: CareerInterviewMode;
  // 面接の種類（未指定の旧セッションは 'real' として扱う）。
  interviewType?: CareerInterviewType;
  // 質問・回答の交互列（末尾が question なら回答待ち）。
  turns: CareerInterviewTurn[];
  // 回答ターン上限（これに達したら面接終了）。
  maxTurns: number;

  // 受験先・選考の想定（前段で入力・任意）。旧セッションには無いため欠損許容。
  target?: CareerInterviewTarget;

  // ── 企業研究ログ連携（すべて optional・後方互換） ──────────────────────
  // 面接開始時に選んだ「ユーザー本人の企業研究ログ」。turn / complete でも文脈として使う。
  companyResearchLogId?: string;
  // 参照時点の軽量スナップショット（traceability・表示用）。
  companyResearchSnapshot?: CompanyResearchSnapshot;
};

// 完了済み面接 1 件分の最終結果（localStorage: careerInterviewResults）。
export type CareerInterviewResult = {
  // 対応するセッション ID。
  id: string;
  createdAt: string;
  mode: CareerInterviewMode;
  // 面接の種類（未指定の旧結果は 'real' として扱う）。
  interviewType?: CareerInterviewType;
  // 評価対象になった会話のスナップショット。
  turns: CareerInterviewTurn[];
  result: CareerInterviewFinalResult;

  // 受験先・選考の想定（前段で入力・任意）。旧結果には無いため欠損許容。
  target?: CareerInterviewTarget;

  // 企業研究ログ連携（optional・後方互換）。結果一覧から参照元へリンクするのに使う。
  companyResearchLogId?: string;
  companyResearchSnapshot?: CompanyResearchSnapshot;
};
