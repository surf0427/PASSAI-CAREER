// PASSAI CAREER — matching purpose 専用の ES latest summary（P7-B: matching-only pilot）。
//
// 設計固定: docs/qa/p7b_matching_es_summary.md（field/cap/drop 方針・横展開しない理由・before/after）。
//
// 背景（P7-A 設計監査の結論）:
//   matching / interview / presentation は従来 `esLogs[0].result` として full CareerEsResult を
//   carry していたが、matching の prompt render で実際に使うのは headline / selfPr / motivation の
//   3 field のみ（gakuchika は matching では render されない）。full result を carry すると body も
//   prompt も肥大するため、matching **だけ** を strict summary 化する。
//
// スコープ厳守:
//   - 本モジュールは matching-local。interview / presentation / consultation は一切参照しない・
//     影響しない（それぞれの snapshot builder / render は不変）。
//   - 純関数のみ（I/O / env / secret / DOM / Supabase なし）。
//   - PII policy は P6-F のまま（本 summary は氏名等 PII を構造上含まない ES draft 由来のみ）。
//
// 型設計:
//   - 共通 EsLatest / EsMemorySummary（gakuchika や appealPoints を持つ）を雑に carry すると
//     不要 field が復活するため、matching では専用の lightweight 型 MatchingEsSummary を使う。

import type { CareerEsResult } from '@/types/careerEs';
import { truncate } from './summaryUtils';

// truncate cap（文字数）。selfPr / motivation は 200 字で丸める（P7-A の 160〜200 目安の上限側）。
// headline は短文想定だが、異常に長い入力への安全弁として cap を設ける。
export const MATCHING_ES_SELFPR_CAP = 200;
export const MATCHING_ES_MOTIVATION_CAP = 200;
export const MATCHING_ES_HEADLINE_CAP = 80;

// matching が prompt render で使う field のみを持つ厳格 summary。
//   - gakuchika: matching では render されないため **持たない**。
//   - appealPoints / interviewQuestions / improvements / answer / question / charLimit /
//     companyName / selectionType / industry / jobType 等の未使用 field も **持たない**。
export type MatchingEsSummary = {
  headline: string;
  selfPr: string;
  motivation: string;
};

// full CareerEsResult → matching 用 strict summary。
//   - result が無ければ null（従来の「esLogs[0] 不在 → null」と同じ null 安全）。
//   - 各 field は str 正規化 + cap 済み（selfPr / motivation は truncate、headline は安全 cap）。
export function buildMatchingEsSummary(
  result: CareerEsResult | null | undefined,
): MatchingEsSummary | null {
  if (!result) return null;
  return {
    headline: truncate(result.headline, MATCHING_ES_HEADLINE_CAP),
    selfPr: truncate(result.selfPr, MATCHING_ES_SELFPR_CAP),
    motivation: truncate(result.motivation, MATCHING_ES_MOTIVATION_CAP),
  };
}

// matching の ES prompt block を可読テキストへ整形（未提供なら空文字）。
//   ラベル・順序は従来の matching renderEs（P7-A 監査時点）と一致させる（キャッチコピー / 自己PR /
//   志望動機）。本文は既に cap 済みだが、full result が wire で届いた場合にも備えて防御的に再 cap する。
export function renderMatchingEsSummary(
  es: MatchingEsSummary | CareerEsResult | null | undefined,
): string {
  if (!es) return '';
  const headline = truncate(es.headline, MATCHING_ES_HEADLINE_CAP);
  const selfPr = truncate(es.selfPr, MATCHING_ES_SELFPR_CAP);
  const motivation = truncate(es.motivation, MATCHING_ES_MOTIVATION_CAP);
  const lines: string[] = [];
  if (headline) lines.push(`- キャッチコピー: ${headline}`);
  if (selfPr) lines.push(`- 自己PR: ${selfPr}`);
  if (motivation) lines.push(`- 志望動機: ${motivation}`);
  return lines.join('\n');
}
