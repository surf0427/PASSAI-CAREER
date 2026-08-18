// PASSAI CAREER — GD route 共有: Company Data Spine A 層（公式情報）の解決（STEP-GD-31）。
//
// 面接 `app/api/career/interview/resolveCompanyOfficial.ts` / プレゼン版と同型の薄い wrapper。
// お題生成（theme）と評価（feedback / room result）が共有する。
//
// ★ 本モジュールが「しない」こと:
//   - 新しい企業検索・crawler・fetcher・enrichment を起動しない（既存 snapshot を読むだけ）。
//   - 企業指定 UI を GD に**新設しない**（要件 27: 開始 UX を大規模変更しない）。
//   - Company Data Spine に無い事実を AI に推測させない（renderer の usage note が明示する）。
//
// ★ 企業の決め方（既存材料からの安全な解決）:
//   GD には企業指定フィールドが無い。そこで
//     ① 呼び出し側が明示的に企業を渡した場合はそれを使う（将来 UI が付いたときの受け口）
//     ② 無ければ「解決しない」= 公式情報なしで一般 GD として成立させる
//   とする。②が既定であり、**現行 UX は 1 mm も変わらない**。
//   推測で企業を当てはめない（誤った企業の事実を評価に混ぜる方が有害）。

import 'server-only';

import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
import { loadCompanyOfficialContext } from '@/lib/careerCompanyOfficial/readRepository.server';

export type GdCompanyTarget = {
  companyId?: string | null;
  companyName?: string | null;
};

/**
 * この GD が企業公式情報（A 層）を使うか。
 *
 * 企業が特定できない（companyName / companyId とも空）→ false（I/O ゼロ）。
 * ＝ 一般テーマの GD には企業情報を入れない。
 */
export function gdUsesCompanyOfficial(target: GdCompanyTarget | null | undefined): boolean {
  const name = typeof target?.companyName === 'string' ? target.companyName.trim() : '';
  const id = typeof target?.companyId === 'string' ? target.companyId.trim() : '';
  return !!(name || id);
}

/**
 * 企業指定から A 層を解決する（never-throw / fail-open）。
 *
 * 返り値 null は「公式情報を prompt へ載せない」。null / unavailable / disabled は
 * いずれも renderer 側で空 block になるため、GD は常に成立する（graceful degradation）:
 *   A 層なし → 従来どおりテーマと transcript のみ → お題生成・評価は成立。
 *
 * @param loadContext DI（QA から差し替えるための seam。既定は実 read repository）
 */
export async function resolveGdCompanyOfficial(
  target: GdCompanyTarget | null | undefined,
  loadContext = loadCompanyOfficialContext,
): Promise<CompanyOfficialReadResult | null> {
  if (!gdUsesCompanyOfficial(target)) return null;

  const companyName = typeof target?.companyName === 'string' ? target.companyName.trim() : '';
  const companyId = typeof target?.companyId === 'string' ? target.companyId.trim() : '';

  try {
    return await loadContext({
      companyId: companyId || null,
      companyName: companyName || null,
      nowIso: new Date().toISOString(),
    });
  } catch {
    // read repository 自体が never-throw だが、import/初期化の失敗でも GD を止めない。
    return null;
  }
}
