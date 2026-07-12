// 就活版（CAREER）ログインの遷移先解決ヘルパー（純関数・テスト可能に切り出し）。
//
// 受験版 `app/login/page.tsx` の `sanitizeNext` と同型の open-redirect ガード。
// 受験版との差分は既定遷移先のみ（受験版 /home ↔ CAREER /career/home）。
//   - identity は auth.users.id。display_user_id は遷移先の判定に **使わない**。
//   - 表示ID未設定を理由に /career/onboarding/profile へ強制遷移しない（受験版と整合）。

/** redirect 未指定 / 不正時の CAREER 既定遷移先。未ログインは各画面側の導線に委ねる。 */
export const DEFAULT_CAREER_REDIRECT = '/career/home';

/**
 * open-redirect 防止: redirect は **同一オリジンの相対パス** のみ許可する。
 * - 先頭が "/" で始まり、"//" や "/\" のような protocol-relative を弾く。
 * - 不正なら DEFAULT_CAREER_REDIRECT にフォールバック。
 * 受験版 sanitizeNext と同一ルール（既定先だけ CAREER 用）。
 */
export function sanitizeCareerRedirect(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_CAREER_REDIRECT;
  if (!raw.startsWith('/')) return DEFAULT_CAREER_REDIRECT;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return DEFAULT_CAREER_REDIRECT;
  return raw;
}
