// PASSAI CAREER — presentation purpose 専用の ES latest summary（P7-F: presentation-only pilot）。
//
// 設計固定: docs/qa/p7f_presentation_es_summary.md（field/cap/drop・matching との違い・before/after）。
//
// 背景（P7-D 監査 → P7-E golden → P7-F 実装）:
//   presentation は ES を full CareerEsResult で carry し、`useCareerContext === true` のときだけ
//   `headline / gakuchika / selfPr / motivation` の 4 field を **cap なし**で render していた。
//   ES は presentation では「発表の主役ではない参考情報」（評価対象は transcript / お題）なので、
//   保守的に summary 化して prompt/token を削る。
//
// matching（P7-B）との意図的な差分:
//   - matching は gakuchika を render しない → 3 field / 200 字。
//   - presentation は gakuchika も render する（theme personalization 等に効き得る）→ 4 field。
//     参考情報ゆえ削るが、matching より保守的に **300 字**（typical はほぼ無損失・heavy の裾だけ削る）。
//   → 共通型を流用せず presentation-local な PresentationEsSummary を用いる。
//
// スコープ厳守（P7-F）:
//   - 本モジュールは presentation-local。interview / matching / consultation は一切参照しない・
//     影響しない（それぞれの snapshot builder / render は不変）。特に interview には横展開しない
//     （interview の gakuchika は面接深掘りの一次材料。P7-D 判定 = C）。
//   - 純関数のみ（I/O / env / secret / DOM / Supabase なし）。
//   - PII policy は P6-F のまま（本 summary は ES draft 由来で氏名等 PII を構造上含まない）。

import type { CareerEsResult } from '@/types/careerEs';
import { truncate } from './summaryUtils';
import { classifyEsQuestionType } from '@/lib/careerEs/deepDivePrompt';

// truncate cap（文字数）。conservative cap 300（matching の 200 より保守的）。
// headline は短文想定だが、異常に長い入力への安全弁として cap を設ける。
export const PRESENTATION_ES_HEADLINE_CAP = 80;
export const PRESENTATION_ES_GAKUCHIKA_CAP = 300;
export const PRESENTATION_ES_SELFPR_CAP = 300;
export const PRESENTATION_ES_MOTIVATION_CAP = 300;

// presentation が prompt render で使う field のみを持つ厳格 summary。
//   - gakuchika: matching と違い presentation では render する **ため残す**。
//   - appealPoints / interviewQuestions / improvements / answer / question / charLimit /
//     companyName / selectionType / industry / jobType 等の未使用 field は **持たない**。
export type PresentationEsSummary = {
  headline: string;
  gakuchika: string;
  selfPr: string;
  motivation: string;
};

// full CareerEsResult → presentation 用 strict summary。
//   - result が無ければ null（従来の「esLogs[0] 不在 → null」と同じ null 安全）。
//   - 各 field は str 正規化 + cap 済み（headline 80 / gakuchika・selfPr・motivation 300）。
//
// ESトレーニングシステム対応（後方互換）:
//   opts.body（ユーザーが書いた本文）があれば優先し、設問種別（opts.question から推定）に応じて
//   既存フィールドへ投影する（presentation は gakuchika を持つため 3 種にきれいに割り当てられる）:
//     - 自己PR系 → selfPr / 志望動機系 → motivation / それ以外（ガクチカ・研究等）→ gakuchika
//   opts が無い / body が空白のときは従来どおり result フィールドから作る（byte 不変）。
//   contract（4 フィールド）は拡張しない。review の有無は一切参照しない。
export function buildPresentationEsSummary(
  result: CareerEsResult | null | undefined,
  opts?: { body?: string | null; question?: string | null },
): PresentationEsSummary | null {
  if (!result) return null;
  const body = opts?.body?.trim() ?? '';
  if (body) {
    const type = classifyEsQuestionType(opts?.question?.trim() ?? '');
    return {
      headline: truncate(result.headline, PRESENTATION_ES_HEADLINE_CAP),
      gakuchika:
        type === 'selfPr' || type === 'motivation'
          ? truncate(result.gakuchika, PRESENTATION_ES_GAKUCHIKA_CAP)
          : truncate(body, PRESENTATION_ES_GAKUCHIKA_CAP),
      selfPr:
        type === 'selfPr'
          ? truncate(body, PRESENTATION_ES_SELFPR_CAP)
          : truncate(result.selfPr, PRESENTATION_ES_SELFPR_CAP),
      motivation:
        type === 'motivation'
          ? truncate(body, PRESENTATION_ES_MOTIVATION_CAP)
          : truncate(result.motivation, PRESENTATION_ES_MOTIVATION_CAP),
    };
  }
  return {
    headline: truncate(result.headline, PRESENTATION_ES_HEADLINE_CAP),
    gakuchika: truncate(result.gakuchika, PRESENTATION_ES_GAKUCHIKA_CAP),
    selfPr: truncate(result.selfPr, PRESENTATION_ES_SELFPR_CAP),
    motivation: truncate(result.motivation, PRESENTATION_ES_MOTIVATION_CAP),
  };
}

// presentation の ES prompt block を可読テキストへ整形（未提供なら空文字）。
//   ラベル・順序・文脈は P7-E 監査時点の presentation renderEs と一致させる（キャッチコピー /
//   ガクチカ / 自己PR / 志望動機）。本文は既に cap 済みだが、full result が wire で届いた場合にも
//   備えて防御的に再 cap する。呼び出し側（buildPresentationBaseSystem）の useCareerContext gate は
//   本関数の外にある（gate off 時は本関数を呼ばず esBlock='' のまま）。
export function renderPresentationEsSummary(
  es: PresentationEsSummary | CareerEsResult | null | undefined,
): string {
  if (!es) return '';
  const headline = truncate(es.headline, PRESENTATION_ES_HEADLINE_CAP);
  const gakuchika = truncate(es.gakuchika, PRESENTATION_ES_GAKUCHIKA_CAP);
  const selfPr = truncate(es.selfPr, PRESENTATION_ES_SELFPR_CAP);
  const motivation = truncate(es.motivation, PRESENTATION_ES_MOTIVATION_CAP);
  const lines: string[] = [];
  if (headline) lines.push(`- キャッチコピー: ${headline}`);
  if (gakuchika) lines.push(`- ガクチカ: ${gakuchika}`);
  if (selfPr) lines.push(`- 自己PR: ${selfPr}`);
  if (motivation) lines.push(`- 志望動機: ${motivation}`);
  return lines.join('\n');
}
