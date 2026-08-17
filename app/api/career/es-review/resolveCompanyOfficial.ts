// PASSAI CAREER — ES 添削 route: Company Data Spine A 層（公式情報）の解決。
//
// 面接の `app/api/career/interview/resolveCompanyOfficial.ts` と同型の薄い wrapper。
//
// ★ 本モジュールが「しない」こと（Scope の中核）:
//   - 新しい企業検索・crawler・fetcher・enrichment を起動しない。
//     ここは **既に Data Spine に存在する readable snapshot を読むだけ**。
//     取得（prefetch / refresh / TTL）は lib/careerCompanyPrefetch の別 pipeline の責務。
//   - Company Identity を必須にしない。companyId が無ければ企業名で解決を試み、
//     曖昧・未解決なら「公式情報なし」に倒す（誤った企業の公式情報を prompt へ載せない）。
//   - client 申告の companyId を権威として扱わない。read repository 側が
//     `findCompanyById` で実在を確かめ、見つからなければ null になる（trust boundary は既存のまま）。
//
// A 層（公式情報 / 外部・一次情報）と B 層（ユーザー本人の企業研究メモ）は別経路・別 block。
// B 層は従来どおり route の `companyResearchContext` が扱う。ここでは触らない。

import 'server-only';

import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
import { loadCompanyOfficialContext } from '@/lib/careerCompanyOfficial/readRepository.server';

/**
 * ES 設定（企業名 / companyId）から A 層を解決する（never-throw / fail-open）。
 *
 * 返り値 null は「公式情報を prompt へ載せない」を意味する。null / unavailable / disabled は
 * いずれも renderer 側で空 block になるため、添削は常に成立する（graceful degradation）:
 *   A 層なし → B 層（企業研究メモ）があればそれ → どちらも無ければ ES 設定のみ → 添削は成立。
 *
 * @param loadContext DI（QA から差し替えるための seam。既定は実 read repository）。
 */
export async function resolveEsReviewCompanyOfficial(
  companyName: string,
  companyId: string | null,
  loadContext = loadCompanyOfficialContext,
): Promise<CompanyOfficialReadResult | null> {
  const name = typeof companyName === 'string' ? companyName.trim() : '';
  const id = typeof companyId === 'string' ? companyId.trim() : '';
  // 企業が特定できない ES（旧ログ・企業名未入力）では読みに行かない（I/O ゼロ）。
  if (!name && !id) return null;

  try {
    return await loadContext({
      companyId: id || null,
      companyName: name || null,
      nowIso: new Date().toISOString(),
    });
  } catch {
    // read repository 自体が never-throw だが、import/初期化の失敗でも添削を止めない。
    return null;
  }
}
