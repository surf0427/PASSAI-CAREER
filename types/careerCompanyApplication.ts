/**
 * Company Data Spine — Application Context（X 層 / user × company）。Phase A / R6。
 *
 * これは **企業の事実（Official）でも、本人が得た企業情報（Private Evidence）でもない**。
 * 「その人がその企業をどう受けるか」の応募文脈であり、両者と混ぜてはいけない。
 *
 * 目的は 1 つだけ: ES / 面接 / プレゼンで **同じ職種・選考種別を何度も入力させない**。
 *
 * ★ 既存フィールドの置換ではなく **初期値の供給元**。
 *   各機能のログ（CareerEsDraft / CareerInterviewTarget / CareerPresentationTarget）は
 *   これまでどおり自分の field に保存する。だから既存ログ構造も後方互換も壊れない。
 *
 * ★ Application Tracking 機能にしない。以下は **意図的に持たない**:
 *   締切 / 面接日程 / 合否 / ステータス履歴 / TODO / リマインダ /
 *   companyMemo（= Private Evidence の領分）/ 企業事実 / AI 分析。
 *
 * 語彙はすべて既存型を再利用する（似た enum を増やさない）。
 */

import type { CareerCompanyInterestLevel } from '@/types/careerCompanyResearch';
import type {
  CareerInterviewPhase,
  CareerInterviewSelectionType,
} from '@/types/careerInterview';

/**
 * user × company の応募文脈（MVP 最小形）。
 * companyId 以外はすべて optional（入力を強制しない）。
 */
export type CareerCompanyApplication = {
  /** ★ 必須。companyId が無い（未登録企業）ときは Application Context を作らない。 */
  companyId: string;
  /** 志望度。既存 CareerCompanyInterestLevel を再利用（'high'|'mid'|'low'|'watch'）。 */
  interestLevel?: CareerCompanyInterestLevel;
  /** 応募職種（free-text。既存 jobType と同じ粒度）。 */
  jobType?: string;
  /** 選考種別。既存 ES / 面接 / プレゼンと同じ 'main' | 'internship'。 */
  selectionType?: CareerInterviewSelectionType;
  /** 選考段階。既存 CareerInterviewPhase を canonical 語彙として採用。 */
  selectionPhase?: CareerInterviewPhase;
  /** 選考年度（'2027' 等の粗い粒度）。既存のどこにも無かった唯一の新規項目。 */
  selectionYear?: string;
  updatedAt: string;
};

/** 各機能へ渡す初期値（Application Context の部分ビュー）。 */
export type CareerCompanyApplicationDefaults = {
  interestLevel?: CareerCompanyInterestLevel;
  jobType?: string;
  selectionType?: CareerInterviewSelectionType;
  selectionPhase?: CareerInterviewPhase;
  selectionYear?: string;
};
