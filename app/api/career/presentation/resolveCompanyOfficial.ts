// PASSAI CAREER — プレゼン route 共有: Company Data Spine A 層（公式情報）の解決。
//
// 面接の `app/api/career/interview/resolveCompanyOfficial.ts` と同型の薄い wrapper。
// theme / evaluate / qa の 3 route が共有する。
//
// ★ 本モジュールが「しない」こと:
//   - 新しい企業検索・crawler・fetcher・enrichment を起動しない（既存 snapshot を読むだけ）。
//   - Company Identity を必須にしない（companyId が無ければ企業名で解決を試み、
//     曖昧・未解決なら「公式情報なし」に倒す）。
//   - client 申告 companyId を権威として扱わない（read repository が実在を確認する）。

import 'server-only';

import type {
  CareerPresentationConfig,
  CareerPresentationType,
} from '@/types/careerPresentation';
import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
import { loadCompanyOfficialContext } from '@/lib/careerCompanyOfficial/readRepository.server';

/**
 * 「自分自身を語る」プレゼン種別（企業公式情報を要求しない）。
 *
 * ★ 面接の `interviewModeUsesCompanyOfficial`（自己分析モードを除外）と同じ思想:
 *   自己PR / ガクチカは学生自身の経験・強みを語る場であり、企業の事実は主題ではない。
 *   企業名が入力されていても A 層は渡さない。
 */
const SELF_FOCUSED_PRESENTATION_TYPES: readonly CareerPresentationType[] = [
  'self_pr',
  'gakuchika',
];

/**
 * このプレゼンが企業公式情報（A 層）を使うか。
 *
 * ★ 現行フローにおける実質的な gate は **「企業が指定されているか」**である。
 *   `presentationType` はモード選択 UI の廃止に伴い後方互換フィールドになっており、
 *   新規セッションは常に `CAREER_PRESENTATION_NEW_SESSION_TYPE`（'real'）が入る
 *   （app/career/presentation/setup/page.tsx の注記どおり）。
 *   したがって type だけで出し分けると、現行の全セッションが同じ扱いになってしまう。
 *
 *   そこで 2 段で判定する:
 *     1. 企業が特定できない（companyName / companyId とも空）→ false（I/O ゼロ）
 *        ＝ お題プレゼン・業界のみ指定のセッションには企業情報を入れない。
 *     2. 旧ログの自己PR / ガクチカ → false（企業名があっても主題ではない）
 *   これにより「企業を指定したプレゼンだけが A 層を受け取る」という product 挙動になる。
 */
export function presentationUsesCompanyOfficial(
  config: CareerPresentationConfig | null | undefined,
  presentationType?: CareerPresentationType,
): boolean {
  const companyName = typeof config?.companyName === 'string' ? config.companyName.trim() : '';
  const companyId = typeof config?.companyId === 'string' ? config.companyId.trim() : '';
  if (!companyName && !companyId) return false;
  if (presentationType && SELF_FOCUSED_PRESENTATION_TYPES.includes(presentationType)) return false;
  return true;
}

/**
 * config から A 層を解決する（never-throw / fail-open）。
 *
 * 返り値 null は「公式情報を prompt へ載せない」。null / unavailable / disabled は
 * いずれも renderer 側で空 block になるため、プレゼンは常に成立する（graceful degradation）:
 *   A 層なし → 従来どおり companyName / industry / jobType のみ → お題生成・評価は成立。
 *
 * @param loadContext DI（QA から差し替えるための seam。既定は実 read repository）。
 */
export async function resolvePresentationCompanyOfficial(
  config: CareerPresentationConfig | null | undefined,
  presentationType?: CareerPresentationType,
  loadContext = loadCompanyOfficialContext,
): Promise<CompanyOfficialReadResult | null> {
  if (!presentationUsesCompanyOfficial(config, presentationType)) return null;

  const companyName = typeof config?.companyName === 'string' ? config.companyName.trim() : '';
  const companyId = typeof config?.companyId === 'string' ? config.companyId.trim() : '';

  try {
    return await loadContext({
      companyId: companyId || null,
      companyName: companyName || null,
      nowIso: new Date().toISOString(),
    });
  } catch {
    // read repository 自体が never-throw だが、import/初期化の失敗でもプレゼンを止めない。
    return null;
  }
}
