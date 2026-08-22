// PASSAI 就活版 — GD マルチ ルームテーマ入力の検証・正規化（server / client 共用）。
//
// 修正1（テーマ設定ステップ）で、ユーザーが確定した GD テーマを部屋作成時に
// career_gd_rooms.theme（jsonb）へ保存するための共通ロジック。
//   - 手動入力 / AI 生成いずれのテーマも同じ形（GdTheme）に正規化する。
//   - create route（invite / public lobby）と ThemeSetupStep（UI ガード）で共用する。
//
// 純粋ロジック（DOM / localStorage / Supabase / AI 非依存）。

import type { GdFormat, GdTheme } from '@/types/careerGd';

export const GD_THEME_TITLE_MAX = 120;
export const GD_THEME_DESCRIPTION_MAX = 2000;
export const GD_THEME_CONSTRAINT_MAX = 300;
export const GD_THEME_CONSTRAINTS_MAX_COUNT = 8;
// 企業ターゲット（任意）の長さ上限。Company Data Spine の解決 hint として運ぶだけなので短くてよい。
export const GD_THEME_COMPANY_NAME_MAX = 120;
export const GD_THEME_COMPANY_ID_MAX = 64;

// マルチGD（公開GD部屋 / 合言葉）では GD形式をユーザーに選ばせない（お題の文面で表現する）。
// 既存の format 列・prompt・役割割当を壊さないため、値としてはこの既定値を使い続ける。
export const GD_DEFAULT_FORMAT: GdFormat = 'free';

function normalizeFormat(v: unknown): GdFormat {
  return v === 'case' || v === 'abstract' ? v : GD_DEFAULT_FORMAT;
}

// 確定条件: タイトルと説明の両方が非空。UI の「決定」ボタン活性判定・start 時の
// 「確定テーマかどうか」判定に使う（buildRoomTheme fallback の分岐にも使用）。
export function isThemeConfirmed(theme: GdTheme | null | undefined): theme is GdTheme {
  if (!theme) return false;
  return theme.title.trim().length > 0 && theme.description.trim().length > 0;
}

export type ParseRoomThemeResult =
  | { ok: true; theme: GdTheme }
  | { ok: false; reason: string };

// 任意の入力値（API body / UI state）を GdTheme に正規化・検証する。
// title / description は必須。constraints は string[]（空・欠落可）。
export function parseRoomThemeInput(value: unknown): ParseRoomThemeResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, reason: 'テーマが指定されていません。' };
  }
  const v = value as {
    title?: unknown;
    description?: unknown;
    format?: unknown;
    constraints?: unknown;
    companyName?: unknown;
    companyId?: unknown;
  };

  const title = typeof v.title === 'string' ? v.title.trim() : '';
  const description = typeof v.description === 'string' ? v.description.trim() : '';
  if (!title) return { ok: false, reason: 'テーマ（タイトル）を入力してください。' };
  if (!description) return { ok: false, reason: 'テーマの説明を入力してください。' };
  if (title.length > GD_THEME_TITLE_MAX) {
    return { ok: false, reason: `テーマは${GD_THEME_TITLE_MAX}文字以内で入力してください。` };
  }
  if (description.length > GD_THEME_DESCRIPTION_MAX) {
    return { ok: false, reason: `説明は${GD_THEME_DESCRIPTION_MAX}文字以内で入力してください。` };
  }

  const constraints = Array.isArray(v.constraints)
    ? v.constraints
        .filter((c): c is string => typeof c === 'string')
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
        .slice(0, GD_THEME_CONSTRAINTS_MAX_COUNT)
        .map((c) => c.slice(0, GD_THEME_CONSTRAINT_MAX))
    : [];

  // 企業ターゲット（任意）。GD は既定で企業未指定の一般練習なので、
  //   欠損・空文字はそのまま「企業指定なし」として通す（必須化しない）。
  //   ★ ここで拾わないと room.theme（jsonb）へ保存されず、room result 側の
  //     gdCompanyTarget() が永久に null になる（Company Data Spine が到達不能になる）。
  const companyName =
    typeof v.companyName === 'string'
      ? v.companyName.trim().slice(0, GD_THEME_COMPANY_NAME_MAX)
      : '';
  const companyId =
    typeof v.companyId === 'string' ? v.companyId.trim().slice(0, GD_THEME_COMPANY_ID_MAX) : '';

  const theme: GdTheme = {
    title,
    description,
    format: normalizeFormat(v.format),
    ...(constraints.length > 0 ? { constraints } : {}),
    // ★ companyId 単独は持たせない（企業名が無い ID は表示・照合に使えないため）。
    //   interview の normalizeInterviewTarget と同じ不変条件に揃える。
    ...(companyName ? { companyName } : {}),
    ...(companyName && companyId ? { companyId } : {}),
  };
  return { ok: true, theme };
}
