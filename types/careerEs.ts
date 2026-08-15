// PASSAI 就活版 — ES（エントリーシート）作成AIの出力・ログ型
//
// 受験版の志望理由書（statement）系の型には依存しない（新卒就活向けに新規定義）。
// DB / Supabase には接続せず localStorage のみで扱う。

import type { CompanyResearchSnapshot } from '@/types/careerCompanyResearch';

// 選考種別（応募する選考の種類）。
//   - 'main'       : 本選考（入社を前提とした選考）
//   - 'internship' : インターン応募
// 未指定（undefined）は「選考種別の指定なし」を表す。後方互換のため optional 運用。
export type CareerEsSelectionType = 'main' | 'internship';

// 就活版 ES作成AI が返す JSON 構造。
// API route（app/api/career/es/route.ts）の出力と 1:1 で対応する。
export type CareerEsResult = {
  // ガクチカ（学生時代に力を入れたこと）本文ドラフト。
  gakuchika: string;
  // 自己PR本文ドラフト。
  selfPr: string;
  // 志望動機本文ドラフト。
  motivation: string;
  // キャッチコピー（自分を一言で表す見出し）。
  headline: string;
  // 企業へのアピールポイント。
  appealPoints: string[];
  // 面接で深掘りされそうな想定質問。
  interviewQuestions: string[];
  // 改善点（さらに良くするための指摘）。
  improvements: string[];

  // ── 設問モード（任意設問が指定されたとき）の追加フィールド ──────────
  // 後方互換: 既存の「おまかせ生成モード」（7フィールド一括）ログには存在しない。
  // 消費側は常に「未定義なら設問モードでない」と防御的に扱うこと。
  //
  // 設問に対する回答本文ドラフト。設問モードのときのみ生成される。
  answer?: string;
  // 生成時に与えられた ES 設問文（結果を自己完結させるため echo する）。
  question?: string;
  // 生成時に与えられた文字数指定。
  charLimit?: number;
  // 生成時に与えられた企業名（任意）。
  companyName?: string;
  // 生成時に与えられた選考種別（本選考 / インターン）。任意。
  selectionType?: CareerEsSelectionType;
  // 生成時に与えられた志望業界（このESに限った指定。任意）。
  industry?: string;
  // 生成時に与えられた志望職種（このESに限った指定。任意）。
  jobType?: string;
};

// ── AI添削（es-review）の型 ──────────────────────────────────────────
// 既存の生成系（CareerEsResult / CareerEsLog）とは独立した追加型。
// 既存型を一切変更しないため、後方互換は自明（新規 type の追加のみ）。
// 今回は localStorage に保存せず画面 state のみで扱う（将来 Supabase 保存も可能な形）。

// ランク（スコアから決定論で導出する。AI には決めさせない）。
export type CareerEsRank = 'S' | 'A' | 'B' | 'C' | 'D';

// 6 軸スコア（各 0〜100 の整数）。
export type CareerEsReviewBreakdown = {
  // 論理性。
  logic: number;
  // 具体性。
  specificity: number;
  // オリジナリティ。
  originality: number;
  // 読みやすさ。
  readability: number;
  // 説得力。
  persuasion: number;
  // 企業適合性。
  companyFit: number;
};

// ES添削AI の出力（API route app/api/career/es-review/route.ts の出力と 1:1）。
//
// 設計方針（ESトレーニングシステム化）:
//   AI は本文の代筆・完成例を返さない（ai_policy 厳守）。添削は評価とアドバイスのみ。
//   旧 rewriteExample（AI が書いた完成本文）は廃止した。代わりに「不足している要素」と
//   「採用担当視点コメント」を返し、ユーザー自身が書き直せるようにする。
export type CareerEsReview = {
  // 総合スコア（0〜100。breakdown 6 軸の平均から決定論で導出）。
  overallScore: number;
  // ランク（overallScore から決定論で導出）。
  rank: CareerEsRank;
  // 総評（全体所感）。
  overallComment: string;
  // 6 軸スコア。
  breakdown: CareerEsReviewBreakdown;
  // 良かった点。
  strengths: string[];
  // 改善点（行動レベル）。
  improvements: string[];
  // 不足している要素（回答に足りていない観点・エピソード要素）。
  missingElements: string[];
  // 採用担当視点コメント（採用担当がこの回答をどう受け取るか）。
  recruiterComments: string[];
  // 優先的に直すべきアクション（重要な順）。
  priorityActions: string[];
};

// ── ES 深掘りの「材料候補」（既存 Career Data の参照） ───────────────────
// V1 の位置づけ:
//   深掘り開始前に「今回の設問に使えそうな既存 Career Data」をユーザーが選ぶ。
//   選択結果は **ES ローカル**（careerEsDrafts → CareerEsLog.deepDive）にのみ保存する。
//   Career Data（careerActivityData / careerSelfAnalysisLogs / careerValues 等）へは
//   一切書き戻さない（Data Spine への自動昇格なし）。
//
// スナップショット方針:
//   選択時点の label / facts / factKinds を **そのまま保持**する。候補元（活動整理の
//   エントリ等）が後から編集・削除されても、作成中の ES が壊れない・会話の前提が
//   途中で変わらないようにするため（id は traceability 用に持つが、再解決には依存しない）。

// 候補の出所。Layer 1（localStorage canonical）の種別と 1:1。
export type CareerEsMaterialSourceKind = 'activity' | 'values' | 'profile' | 'selfAnalysis';

// 設問との関連判定の結果（コード側が決定論で導出する。AI には決めさせない）。
//   full    … 選択候補で必要観点の大半が埋まる
//   partial … 関連はあるが不足観点が多い
//   none    … 関連する既存情報が無い（候補リストを表示しない＝1 から深掘り）
export type CareerEsMaterialCoverage = 'full' | 'partial' | 'none';

// ユーザーが選択した 1 材料（選択時点のスナップショット）。
export type CareerEsSelectedMaterial = {
  // 安定 ID（例: 'activity:focusedActivities:<entryId>' / 'values:priorities'）。
  id: string;
  sourceKind: CareerEsMaterialSourceKind;
  // 1 行ラベル（選択時点のスナップショット）。
  label: string;
  // 既知事実の行（'ラベル: 値'）。深掘りの「すでに分かっていること」に使う。
  facts: string[];
  // 充足した観点の種別（軸カバレッジ算出に使う。lib/careerEs の EsMaterialFactKind）。
  factKinds: string[];
};

// 材料選択フェーズの結果（draft に保存する）。
export type CareerEsDraftMaterials = {
  // フェーズを通過したか（none で通過した場合も true。再開時に選択画面へ戻さないため）。
  decided: boolean;
  coverage: CareerEsMaterialCoverage;
  selected: CareerEsSelectedMaterial[];
};

// ── ES 作成中ドラフト（careerEsLogs とは別ストア） ─────────────────────
// 深掘りQ&Aの途中離脱・リロードで進捗が失われないよう、未完成の作成状態を保存する。
// 正式ログ（careerEsLogs）とは意図的に分離する:
//   - 未完成draftを matching / presentation / mypage / consultation / ES履歴 に露出させない。
//   - 正式ログ化（careerEsLogs 追記）は「執筆ページで AI添削＝保存を確定した時点」以降。
// 保存キーは 'careerEsDrafts'（app/career/es/esDraftStorage.ts）。owner 単位で分離する。
export const ES_DRAFT_SCHEMA_VERSION = 1;

export type CareerEsDraft = {
  // draft の安定 ID（URL・保存キー・削除に使う）。
  id: string;
  // スキーマ版。読み込み時に不一致なら安全に破棄する（fail-safe migration）。
  schemaVersion: number;
  // 所有者境界。member は userId、guest は null。読み込み時に現在の owner で絞り込む。
  ownerId: string | null;
  // 作成モード。'deep'=深掘りしながら書く / 'write'=自力で書く。
  mode: 'deep' | 'write';
  createdAt: string;
  updatedAt: string;

  // ── 設問メタ（Step1 入力） ──
  question: string;
  charLimit?: number;
  companyName?: string;
  industry?: string;
  jobType?: string;
  selectionType?: CareerEsSelectionType;
  // 設問種別（深掘りの質問数レンジ選定に使う。設問文から推定した値の記録）。
  questionType?: string;

  // ── 深掘り進捗（mode='deep'） ──
  // 材料選択フェーズの結果（V1 で追加・optional）。
  //   欠損 = 材料選択フェーズを実施していない旧 draft。読み込み側は「未実施」として扱う
  //   （ただし深掘りが既に始まっている旧 draft を選択画面へ戻さないこと）。
  materials?: CareerEsDraftMaterials;
  // Q&A 履歴（末尾が question なら未回答の保留質問）。
  deepTurns?: { role: 'question' | 'answer'; content: string }[];
  // 材料整理メモ（organize 完了後）。
  memo?: string[];
  // organize（材料整理）を終えたか。true で本文執筆フェーズへ。
  organized?: boolean;

  // ── 執筆中の本文 ──
  body?: string;
};

// 完了済み ES作成 1 件分の localStorage スナップショット。
// 保存キーは 'careerEsLogs'（app/career/es/esStorage.ts）。
export type CareerEsLog = {
  // 安定 ID（UI の選択キー / 重複排除に使う）。
  id: string;
  // 生成時刻（ISO 文字列）。
  createdAt: string;
  // 任意: 実行時にユーザーが添えた補足・志望企業メモなど。
  userInput: string;
  // AI 出力本体。
  result: CareerEsResult;

  // ── 企業別 ES 管理の土台（すべて optional・後方互換） ────────────────
  // 既存ログには存在しないため、read / normalize 側で defensive に扱うこと。
  //
  // 対象企業名（企業別の一覧・絞り込みに使う）。
  companyName?: string;
  // 生成に使った ES 設問文（設問モードのときに保存）。
  question?: string;
  // 生成に使った文字数指定。
  charLimit?: number;
  // 生成に使った選考種別（本選考 / インターン）。
  selectionType?: CareerEsSelectionType;
  // 生成に使った志望業界（このESに限った指定）。
  industry?: string;
  // 生成に使った志望職種（このESに限った指定）。
  jobType?: string;
  // お気に入りフラグ（結果画面でトグル）。
  favorite?: boolean;
  // 提出済みフラグ（結果画面でトグル）。
  submitted?: boolean;
  // 将来の編集保存用（今回は型のみ用意し、UI からは未書き込み）。
  editedResult?: CareerEsResult;

  // ── ESトレーニングシステム（本文・添削・バージョン管理） ──────────────
  // すべて optional・後方互換。既存の生成ログには存在しないため defensive に扱う。
  //
  // ユーザーが自分で書いた ES 本文（今後の canonical。AI は本文を書かない）。
  body?: string;
  // 永続化した添削結果（従来は画面 state のみだった。結果閲覧・版比較のため保存する）。
  review?: CareerEsReview;
  // バージョン管理のグループ ID（同一設問＋企業の版をまとめる）。欠損は単独版扱い。
  groupId?: string;
  // グループ内の版番号（1 始まり）。欠損は 1 版扱い。
  version?: number;
  // この版の作成モード。'deep'=深掘りしながら書く / 'write'=自力で書く。
  mode?: 'deep' | 'write';
  // 深掘りモードの材料（Q&A と AI 整理メモ）。面接機能との連携も見据えた一貫データ。
  deepDive?: {
    turns: { role: 'question' | 'answer'; content: string }[];
    memo?: string[];
    // 深掘り開始前にユーザーが選んだ既存 Career Data（V1 で追加・optional）。
    // 「この版がどの既存材料を前提に書かれたか」の traceability。欠損は「材料選択なし」。
    materials?: CareerEsSelectedMaterial[];
  };

  // ── ログの出自（添削からの改善版保存など） ──────────────────────────
  // 既存ログには存在しないため、欠損を前提に防御的に扱うこと。
  //
  // このログの生成元ログの ID（改善版保存のとき元ログを指す）。
  sourceLogId?: string;
  // ログの種別。未指定（欠損）は従来の生成ログ（'generated' 相当）として扱う。
  //   - 'generated'      : ES生成（おまかせ / 設問モード）由来
  //   - 'review_rewrite' : AI添削の rewriteExample を改善版として保存したもの
  sourceType?: 'generated' | 'review_rewrite';

  // ── 企業研究ログ連携（すべて optional・後方互換） ──────────────────────
  // 生成/添削時に参照した「ユーザー本人の企業研究ログ」を記録する。
  // 後から企業研究ログが更新されても、当時何を参照したか分かるよう snapshot を保存する。
  //
  // 参照した企業研究ログの ID（view へのリンク等に使う）。
  companyResearchLogId?: string;
  // 参照時点の軽量スナップショット（traceability・添削時の再利用に使う）。
  companyResearchSnapshot?: CompanyResearchSnapshot;
};
