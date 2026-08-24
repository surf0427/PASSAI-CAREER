/**
 * PASSAI CAREER — 発表資料ファイル（material file）の共有定数・純関数。
 *
 * 受験版 `lib/presentation/material.ts` の allowlist / 上限 / 拡張子マップの思想を
 * そのまま踏襲する（PDF / PNG / JPG・10MB）。ただし **CAREER 専用の別モジュール**とし、
 * bucket 名も CAREER 専用にする。受験版（Project A）と CAREER（Project B）の
 * Supabase 境界を 1 箇所も混ぜないため（career-supabase-project-boundary-qa が守る境界）。
 *
 * server-only にしない（setup 画面の client 側検証からも import するため）。
 * 純粋な定数・純関数のみ。I/O・env 参照・Supabase client 生成は一切しない。
 *
 * ★ CAREER の storage 契約（受験版との違い）:
 *   受験版は browser が user JWT で Storage へ直接 upload し、storage.objects の RLS
 *   （先頭フォルダ = auth.uid()）で所有権を守る。
 *   CAREER は **browser から Storage を直接触らせない**。upload / download はすべて
 *   server route が service-role client で行い、path は server が
 *   `${userId}/${sessionId}/material.${ext}` として生成する（client 申告 path は使わない）。
 *   そのため所有権は「path を server しか作れない」ことで構造的に保証され、
 *   RLS は多層防御として別途 SQL で張る（supabase/career_presentation_materials_apply.sql）。
 */

/** CAREER 専用 private bucket（受験版の 'presentation-materials' とは別物）。 */
export const CAREER_PRESENTATION_MATERIAL_BUCKET = 'career-presentation-materials';

/** 最大 10MB・1 セッション 1 ファイル（受験版と同値）。 */
export const CAREER_PRESENTATION_MATERIAL_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 許可 MIME → Storage パス拡張子（受験版と同じ 3 種）。
 * ★ PowerPoint（.ppt/.pptx）は、安全に中身を読む extract pipeline が CAREER に無いため非対応。
 *   （テキストを貼り付ける経路が既にあるので、機能としては塞がらない）
 */
export const CAREER_PRESENTATION_MATERIAL_MIME_EXT: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

/** input[accept] 用。 */
export const CAREER_PRESENTATION_MATERIAL_ACCEPT =
  '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';

/** 表示用のラベル（UI・エラーメッセージで共用）。 */
export const CAREER_PRESENTATION_MATERIAL_TYPE_LABEL = 'PDF / PNG / JPG';

/** ファイル名の保存上限（受験版と同値）。表示用途のみで path には使わない。 */
export const CAREER_PRESENTATION_MATERIAL_FILE_NAME_MAX = 255;

export function careerPresentationMaterialExt(mime: unknown): string | null {
  if (typeof mime !== 'string') return null;
  return CAREER_PRESENTATION_MATERIAL_MIME_EXT[mime] ?? null;
}

export function isAllowedCareerPresentationMaterialMime(mime: unknown): boolean {
  return careerPresentationMaterialExt(mime) !== null;
}

/**
 * session id が Storage path に埋めて安全か（純関数）。
 *
 * ★ path traversal（`..` / `/`）・絶対パス・空文字を構造的に拒否する。
 *   CAREER の session id は crypto.randomUUID() か `cprez-<ts>-<rand>` の 2 形態なので、
 *   英数字と `-` `_` だけを許可すれば十分。
 */
export function isSafeMaterialSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sessionId);
}

/**
 * Storage の canonical path を生成する（**server だけが呼ぶ**唯一の path 生成器）。
 *
 * userId は server session 由来の値のみを渡すこと（client 申告値は禁止）。
 * 不正な入力では null を返す（呼び出し側は null を「拒否」として扱う）。
 */
export function buildCareerPresentationMaterialPath(
  userId: unknown,
  sessionId: unknown,
  mimeType: unknown,
): string | null {
  const ext = careerPresentationMaterialExt(mimeType);
  if (!ext) return null;
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return null;
  if (!isSafeMaterialSessionId(sessionId)) return null;
  return `${userId}/${sessionId}/material.${ext}`;
}

/**
 * 同一セッションで生成されうる全 path（拡張子違い）。
 * 差し替え・削除で「前の拡張子のファイルが残る」ことを防ぐために使う。
 */
export function buildCareerPresentationMaterialPathCandidates(
  userId: unknown,
  sessionId: unknown,
): string[] {
  return Object.keys(CAREER_PRESENTATION_MATERIAL_MIME_EXT)
    .map((mime) => buildCareerPresentationMaterialPath(userId, sessionId, mime))
    .filter((p): p is string => p !== null);
}

/** 表示用ファイル名の正規化（改行・制御文字を落とし、長さを切る）。 */
export function normalizeMaterialFileName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // 制御文字（改行・タブ・NUL 等）を空白へ落とす。表示専用の値なので中身は保つ。
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return cleaned.length > CAREER_PRESENTATION_MATERIAL_FILE_NAME_MAX
    ? cleaned.slice(0, CAREER_PRESENTATION_MATERIAL_FILE_NAME_MAX)
    : cleaned;
}

/** バイト数の表示整形（UI 共用）。 */
export function formatMaterialBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
