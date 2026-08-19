/**
 * 受験版（PASSAI / Supabase **Project A**）identity を必要とするルートの唯一の定義。
 *
 * 背景（本 module が生まれた理由）:
 *   本 repository には受験版（app/home, app/input, app/diagnosis, …）と
 *   就活版 PASSAI CAREER（app/career 配下, および CAREER 専用 LP = app/page.tsx）が同居する。
 *   ルート layout（app/layout.tsx）は **全ルート共通** で受験版の AuthProvider を mount するため、
 *   放置すると CAREER のページを開いただけで Project A の identity 解決（profiles）と
 *   受験版 feature の backfill / restore（basic_info_logs / diagnosis_logs / activity_logs /
 *   self_analysis_logs）が起動する。
 *
 *   CAREER 本番は公開 env（NEXT_PUBLIC_SUPABASE_*）も CAREER の Supabase（Project B）を指すため、
 *   @supabase/ssr の cookie storage key は project ref 単位＝ CAREER ログインの session を
 *   受験版 client も member として読んでしまい、Project B に存在しない受験版 table へ
 *   REST request が飛んで 404 になっていた（しかも失敗時は backfill flag が立たないため毎回再発）。
 *
 * 方針: **default-deny**。
 *   ここに列挙した受験版ルートでだけ Project A identity を起動し、それ以外
 *   （CAREER LP / /career 配下 / 共通の法務・情報ページ）では AuthProvider を完全に不活性にする。
 *   新しい受験版ページを足して Project A identity が要るなら、この配列に追加すること。
 *
 * 静的 guard: scripts/career-legacy-bootstrap-boundary-qa.ts が
 *   「AuthProvider を consume するファイルは必ずここで許可された prefix 配下にある」ことを検査する。
 */

/** 受験版 identity（Project A）が必要なルート prefix。ここに無いルートは identity 不活性。 */
export const EXAM_IDENTITY_PREFIXES = [
  '/account',
  '/admission-matching',
  '/analyze',
  '/auth',
  '/billing',
  '/diagnosis',
  '/essay',
  '/essay-practice',
  '/home',
  '/input',
  '/interview',
  '/login',
  '/matching',
  '/mypage',
  '/presentation',
  '/pricing',
  '/self-analysis',
  '/self-pr',
  '/statement',
  '/tutor',
] as const;

/**
 * 受験版 identity を起動してよいパスか。
 * - `null`（pathname 未確定）は安全側＝ false（起動しない）。
 * - 完全一致 or `prefix + '/'` の前方一致のみ。`/self-pr` が `/self-p` に誤反応しない。
 */
export function isExamIdentityPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return EXAM_IDENTITY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
  );
}

/** CAREER surface（CAREER LP / /career 配下）か。receipt 用の明示 helper。 */
export function isCareerSurfacePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === '/' || pathname === '/career' || pathname.startsWith('/career/');
}
