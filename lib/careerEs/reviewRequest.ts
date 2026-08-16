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

import type { CareerEsSelectionType } from '@/types/careerEs';

// 添削リクエストの body 形状（route の受け口と 1:1）。
export type CareerEsReviewRequestBody = {
  answer: string;
  question: string;
  charLimit: number | null;
  companyName: string;
  industry: string;
  jobType: string;
  selectionType: CareerEsSelectionType | null;
  // 保存済み企業研究（任意・[id] からのみ渡る）。未参照なら送らない。
  companyResearchContext?: unknown;
};

// draft / log の双方を受け取れる最小形（どちらも同名の optional フィールドを持つ）。
export type EsReviewRequestSource = {
  question?: string;
  charLimit?: number;
  companyName?: string;
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

export function buildEsReviewRequestBody(
  source: EsReviewRequestSource,
  answer: string,
): CareerEsReviewRequestBody {
  const body: CareerEsReviewRequestBody = {
    answer: answer.trim(),
    question: text(source.question),
    charLimit: charLimitOrNull(source.charLimit),
    companyName: text(source.companyName),
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
  return body;
}
