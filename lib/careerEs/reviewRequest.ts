// PASSAI 就活版 — ES 添削（/api/career/es-review）へ送るリクエストボディの組み立て（純関数）。
//
// 目的:
//   ES 設定（設問 / 文字数 / 企業名 / 志望業界 / 志望職種 / 選考種別）が
//   **どのルート（draft の初回添削 / [id] の再添削・改善版）からでも欠落せずに**
//   添削 API へ届くことを 1 箇所で保証する。
//   呼び出し側（draft ページ / [id] ページ）が個別に body を組むと項目落ちが起きるため集約する。
//
// 後方互換:
//   旧ログ（companyName / industry / jobType / selectionType / charLimit 欠損）でも
//   キー自体は常に送る（欠損は '' / null）。route 側は '' / null を「未指定」として扱う。
//
// Company Data Spine（A 層）:
//   `companyId` は draft / log には保存されているのに、ここで落ちていたため
//   Company Official Facts へ到達できなかった（cross-feature audit の P0）。
//   ★ companyId は **権威情報ではなく解決の hint**。route 側は既存 loader の
//     trust boundary（server が canonical company を決める）に従うので、
//     ここでは「保存済みの値をそのまま運ぶ」だけにする。
//
// User Data Spine:
//   profile / activity / values / selfAnalysis は **bridge**（request body）として運ぶ。
//   server context canary が有効な環境では route 側が server 読み出しを優先し、
//   無効なら本 bridge が使われる（既存 fail-open contract と同型）。

import type { CareerEsSelectionType } from '@/types/careerEs';
import type { CareerEsReviewContextPayload } from './reviewContext';

// 添削リクエストの body 形状（route の受け口と 1:1）。
export type CareerEsReviewRequestBody = {
  answer: string;
  question: string;
  charLimit: number | null;
  companyName: string;
  // Company Data Spine 解決の hint（未紐付け・旧ログでは null）。
  companyId: string | null;
  industry: string;
  jobType: string;
  selectionType: CareerEsSelectionType | null;
  // 保存済み企業研究（任意・[id] からのみ渡る）。未参照なら送らない。
  companyResearchContext?: unknown;
  // User Data Spine bridge（任意）。未指定なら route は従来どおり ES 設定のみで添削する。
  profile?: CareerEsReviewContextPayload['profile'];
  activity?: CareerEsReviewContextPayload['activity'];
  values?: CareerEsReviewContextPayload['values'];
  selfAnalysis?: CareerEsReviewContextPayload['selfAnalysis'];
};

// draft / log の双方を受け取れる最小形（どちらも同名の optional フィールドを持つ）。
export type EsReviewRequestSource = {
  question?: string;
  charLimit?: number;
  companyName?: string;
  companyId?: string;
  industry?: string;
  jobType?: string;
  selectionType?: CareerEsSelectionType;
  companyResearchContext?: unknown;
};

function text(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 正の整数だけを採用する（保存側 esStorage / route 側と同一ポリシー）。
function charLimitOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * 添削 API の body を組む。
 *
 * @param context User Data Spine bridge（任意）。未指定なら該当キーを送らない
 *   ＝ 既存呼び出し・既存 QA と body 形状互換（route 側も未指定を空として扱う）。
 */
export function buildEsReviewRequestBody(
  source: EsReviewRequestSource,
  answer: string,
  context?: CareerEsReviewContextPayload | null,
): CareerEsReviewRequestBody {
  const body: CareerEsReviewRequestBody = {
    answer: answer.trim(),
    question: text(source.question),
    charLimit: charLimitOrNull(source.charLimit),
    companyName: text(source.companyName),
    // 旧ログ / free-text 企業（companyId 未紐付け）は null。'' は送らない（route の未指定判定と揃える）。
    companyId: text(source.companyId) || null,
    industry: text(source.industry),
    jobType: text(source.jobType),
    selectionType:
      source.selectionType === 'main' || source.selectionType === 'internship'
        ? source.selectionType
        : null,
  };
  if (source.companyResearchContext !== undefined && source.companyResearchContext !== null) {
    body.companyResearchContext = source.companyResearchContext;
  }
  if (context) {
    body.profile = context.profile;
    body.activity = context.activity;
    body.values = context.values;
    body.selfAnalysis = context.selfAnalysis;
  }
  return body;
}
