// PASSAI 就活版 — 就活相談AI（司令塔）の次アクションを、各機能ページへ安全に導線化する層。
//
// 役割: AI が返した「対応機能キー（feature）」を、アプリが管理する href / CTA 文言へ変換する。
//   - AI に自由な URL を出させない（feature は許可リストのみ／href はここで決定）。
//   - client（page.tsx で導線ボタン描画）と server（route.ts で normalize / feature 検証）双方から使う純粋関数。
//   - DOM / localStorage / API / DB には触れない。

import type { CareerConsultationActionFeature } from '@/types/careerConsultation';

// 許可する feature キーの実体（型 CareerConsultationActionFeature と 1:1）。
// route 側の normalize で「許可リスト外の feature を落とす」ために実行時の集合として持つ。
export const CAREER_CONSULTATION_ACTION_FEATURES: readonly CareerConsultationActionFeature[] = [
  'profile',
  'activity',
  'values',
  'selfAnalysis',
  'matching',
  'es',
  'interview',
  'gd',
  'presentation',
  'companyResearch',
  'consultation',
  'home',
];

// feature → 遷移先 href（アプリ側で確定。AI の出力は使わない）。
const FEATURE_HREF: Record<CareerConsultationActionFeature, string> = {
  profile: '/career/profile',
  activity: '/career/activity',
  values: '/career/values',
  selfAnalysis: '/career/self-analysis',
  matching: '/career/matching',
  es: '/career/es',
  interview: '/career/interview',
  gd: '/career/gd',
  presentation: '/career/presentation',
  companyResearch: '/career/company-research',
  consultation: '/career/consultation',
  home: '/career/home',
};

// feature → 導線ボタンの CTA 文言（就活文脈で自然な短句）。
const FEATURE_CTA: Record<CareerConsultationActionFeature, string> = {
  profile: '基本情報を編集',
  activity: '活動整理へ',
  values: '就活軸を整理する',
  selfAnalysis: '自己分析へ',
  matching: 'マッチングを見る',
  es: 'ESへ進む',
  interview: '面接練習へ',
  gd: 'GD対策へ',
  presentation: 'プレゼン対策へ',
  companyResearch: '企業研究へ',
  consultation: '相談を続ける',
  home: 'ホームへ',
};

// unknown が許可 feature か判定する型ガード（route の normalize / page の描画双方で使う）。
export function isCareerConsultationActionFeature(
  value: unknown,
): value is CareerConsultationActionFeature {
  return (
    typeof value === 'string' &&
    (CAREER_CONSULTATION_ACTION_FEATURES as readonly string[]).includes(value)
  );
}

// feature → href。未知値は null（呼び出し側でリンク無し表示にフォールバック）。
export function actionFeatureHref(
  feature: CareerConsultationActionFeature | null | undefined,
): string | null {
  if (!feature) return null;
  return FEATURE_HREF[feature] ?? null;
}

// feature → CTA 文言。未知値は汎用文言。
export function actionFeatureCta(
  feature: CareerConsultationActionFeature | null | undefined,
): string {
  if (!feature) return '開く';
  return FEATURE_CTA[feature] ?? '開く';
}

// ── 公開ゲートを持つ feature の到達可能性（純関数）─────────────────────
//
// 企業マッチング（/career/matching）と GD（/career/gd）は公開ゲートを持ち、
// server flag が OFF のとき page 側 layout が notFound() を返す（＝ 404）。
// AI はこの gate を知らないので `feature:'matching'` を推薦しうるが、そのまま
// 導線化すると **有料ユーザーが 404 に着地する**。
//
// 既存の gate 済み導線（app/career/home/CareerHomeClient.tsx /
// app/career/gd/GdSoloResultDetail.tsx）と同じ方針で、OFF の機能は
// 「準備中」を出さず **定義ごと落とす**（＝ その推薦アクション自体を出さない）。
//
// ★ 判定材料は **server flag のみ**（呼び出し側が渡す）。本 module は env を読まない
//   （pure のまま保ち、client / server / QA から同じ実装を使えるようにする）。

/** 公開ゲートを持つ feature の有効状態（値は必ず server flag 由来）。 */
export type CareerConsultationFeatureGates = {
  /** CAREER_COMPANY_MATCHING_ENABLED */
  matching: boolean;
  /** CAREER_GD_ENABLED */
  gd: boolean;
};

/**
 * その feature の遷移先ページに実際に到達できるか。
 * gate を持たない feature（自己分析 / ES / 面接 …）は常に true。
 */
export function isCareerConsultationActionFeatureReachable(
  feature: CareerConsultationActionFeature,
  gates: CareerConsultationFeatureGates,
): boolean {
  if (feature === 'matching') return gates.matching;
  if (feature === 'gd') return gates.gd;
  return true;
}
