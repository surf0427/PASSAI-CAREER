// PASSAI CAREER — ES 深掘り route: Company Data Spine A 層（公式情報）の解決 + render。
//
// 背景（AI call 単位監査の指摘 P1-3）:
//   ES draft は `companyName` / `companyId` を保持し UI にも出しているのに、
//   `/api/career/es/deep` の body にそれが無く、深掘り質問 AI は企業を一切知らなかった。
//   志望動機・企業研究系の設問では「この経験のどこをこの企業向けに掘るか」を
//   決められないため、質問の質が落ちていた。
//
// ★ 本 module が返すのは **render 済みの block 文字列**である（read 結果ではない）。
//   理由: `app/` 配下から `lib/careerContextRenderers/*` を直接 import することは
//   既存 architecture invariant で禁止されている（Orchestrator が唯一の注入口。
//   career-collective-intelligence-production-prep-qa が app/ の import 0 を固定）。
//   したがって render も **Orchestrator 経由**で行い、route には文字列だけを渡す。
//
// ★ しないこと:
//   - 新しい企業検索・crawler・fetcher・enrichment を起動しない（既存 snapshot の read のみ）。
//   - client 申告 companyId を権威として扱わない（read repository が実在を確認する）。
//   - 企業依存でない設問（ガクチカ / 自己PR 等）へは投入しない。

import 'server-only';

import type { EsQuestionType } from '@/lib/careerEs/deepDivePrompt';
import { loadCompanyOfficialContext } from '@/lib/careerCompanyOfficial/readRepository.server';
import { buildCareerAiContext } from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';

/**
 * 企業公式情報を背景に載せる設問種別。
 *
 * ★ `EsQuestionType` の実 enum（gakuchika / motivation / selfPr / research / other）に対応。
 *   - motivation : 志望動機。「なぜこの企業か」を掘るには企業の実像が要る。
 *   - research   : 企業研究系。主題が企業そのもの。
 *   それ以外（gakuchika / selfPr / other）は **学生自身の経験**が主題なので投入しない
 *   （面接の self_analysis モードを除外しているのと同じ思想）。
 */
const COMPANY_DEPENDENT_QUESTION_TYPES: readonly EsQuestionType[] = ['motivation', 'research'];

export function esDeepUsesCompanyOfficial(questionType: EsQuestionType): boolean {
  return COMPANY_DEPENDENT_QUESTION_TYPES.includes(questionType);
}

/**
 * ES 深掘り用の企業公式情報 block を返す（never-throw / fail-open）。
 *
 * 返り値 '' は「公式情報を prompt へ載せない」。
 * 企業未指定 / 非企業依存設問 / flag OFF / DDL 未適用 / 未ログイン / 企業未解決 / fact 0 件は
 * いずれも '' になり、深掘りは従来どおり成立する（graceful degradation）。
 *
 * @param loadContext DI（QA から差し替えるための seam。既定は実 read repository）。
 */
export async function resolveEsDeepCompanyOfficialBlock(
  questionType: EsQuestionType,
  companyName: string | null | undefined,
  companyId: string | null | undefined,
  loadContext = loadCompanyOfficialContext,
): Promise<string> {
  if (!esDeepUsesCompanyOfficial(questionType)) return '';

  const name = typeof companyName === 'string' ? companyName.trim() : '';
  const id = typeof companyId === 'string' ? companyId.trim() : '';
  // 企業が特定できない ES（旧 draft・企業名未入力）では読みに行かない（I/O ゼロ）。
  if (!name && !id) return '';

  try {
    const result = await loadContext({
      companyId: id || null,
      companyName: name || null,
      nowIso: new Date().toISOString(),
    });
    // Orchestrator（純関数）経由で render する。purpose allowlist / budget /
    //   es_deep_dive 専用 usage note の強制は renderer 側の責務。
    return buildCareerContextForPurpose(
      'es_deep_dive',
      buildCareerAiContext({ featureKey: 'career-es', userInput: '' }),
      { company: result },
    ).companyOfficialContext;
  } catch {
    // read / render の失敗で深掘りを止めない。
    return '';
  }
}
