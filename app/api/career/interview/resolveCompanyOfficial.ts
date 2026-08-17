// PASSAI CAREER — 面接 route 共有: Company Data Spine A 層（公式情報）の解決。
//
// 役割:
//   start / turn / complete の 3 route が、前段で入力した受験先（target）に対応する
//   **Company Official Facts**（A 層）を既存 read 経路から取得するための薄い wrapper。
//
// ★ 本モジュールが「しない」こと（Scope の中核）:
//   - 新しい企業検索・crawler・fetcher・enrichment を起動しない。
//     ここは **既に Data Spine に存在する readable snapshot を読むだけ**。
//     取得（prefetch / refresh / TTL）は lib/careerCompanyPrefetch の別 pipeline の責務で、
//     面接 runtime からは一切トリガしない。
//   - Company Identity を必須にしない。companyId が無ければ企業名で解決を試み、
//     曖昧・未解決なら「公式情報なし」に倒す（誤った企業の公式情報を prompt へ載せない）。
//
// A 層（公式情報 / 外部・一次情報）と B 層（ユーザー本人の企業研究メモ）は別経路・別 block。
// B 層は従来どおり resolveContextInputs.ts（companyResearch）が扱う。ここでは触らない。

import 'server-only';

import type { CareerInterviewTarget, CareerInterviewType } from '@/types/careerInterview';
import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
import { loadCompanyOfficialContext } from '@/lib/careerCompanyOfficial/readRepository.server';

/**
 * 面接モードが企業公式情報（A 層）を使うか。
 *
 * ★ 自己分析モードは「自分自身を説明する力」を鍛える場なので A 層を **要求しない**。
 *   （新しい context architecture を作るのではなく、既存 orchestrator へ extras を渡さないだけ。
 *     prompt policy 側でも buildTargetBlock が企業情報を背景扱いに落とす＝二重の担保。）
 *   企業理解 / 本番 / 圧迫は同一の data source を使う（圧迫専用経路は作らない）。
 */
export function interviewModeUsesCompanyOfficial(
  interviewType: CareerInterviewType | undefined,
): boolean {
  return interviewType !== 'self_analysis';
}

/**
 * target から A 層を解決する（never-throw / fail-open）。
 *
 * 返り値 null は「公式情報を prompt へ載せない」を意味する。null / unavailable / disabled は
 * いずれも renderer 側で空 block になるため、面接は常に成立する（graceful degradation）:
 *   A 層なし → B 層（企業研究メモ）があればそれ → どちらも無ければ target のみ → 面接は成立。
 *
 * @param loadContext DI（QA から差し替えるための seam。既定は実 read repository）。
 */
export async function resolveInterviewCompanyOfficial(
  target: CareerInterviewTarget | null,
  interviewType: CareerInterviewType | undefined,
  loadContext = loadCompanyOfficialContext,
): Promise<CompanyOfficialReadResult | null> {
  if (!interviewModeUsesCompanyOfficial(interviewType)) return null;
  // companyName は必須入力だが、旧セッションの再開など欠損しうる経路を防御的に扱う。
  const companyName = typeof target?.companyName === 'string' ? target.companyName.trim() : '';
  const companyId = typeof target?.companyId === 'string' ? target.companyId.trim() : '';
  if (!companyName && !companyId) return null;

  try {
    return await loadContext({
      companyId: companyId || null,
      companyName: companyName || null,
      nowIso: new Date().toISOString(),
    });
  } catch {
    // read repository 自体が never-throw だが、import/初期化の失敗でも面接を止めない。
    return null;
  }
}
