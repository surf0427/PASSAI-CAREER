// PASSAI CAREER — プレゼン 発表資料ファイルの upload / delete route。
//
// 役割: setup 画面（お題プレゼンの準備）で選ばれた発表資料（PDF / PNG / JPG）を
//   CAREER 専用 private bucket へ保存し、session に持たせる参照 metadata を返す。
//   評価そのものは行わない（AI を 1 度も呼ばない）。
//
// ★ 受験版（/api/presentation/material）との違い:
//   受験版は「browser が Storage へ直接 upload → route は DB に material_* を記録するだけ」。
//   CAREER は localStorage canonical で material 行を持つ DB が無く、また browser に
//   Storage 権限を渡したくないため、**ファイル本体もこの route が受けて service-role で書く**。
//   その結果:
//     - client は bucket 名も path も storage 資格情報も一切持たない
//     - path は server が identity から生成する（client 申告 path は存在しない）
//     - 他人の path を指すことが構造的に不可能（CASE H）
//
// ★ Supabase 境界: CAREER（Project B）の client だけを使う。受験版（Project A）の
//   lib/supabase/* には触れない（career-supabase-project-boundary-qa が守る）。
//
// 順序（他の CAREER AI route と同一）: request guard → 有料ゲート → 検証 → Storage。
//   ★ quota は消費しない（消費は evaluate の 1 回だけ。資料添付は非課金）。

import 'server-only';

import { devWarn } from '@/lib/devLog';
import { guardCareerAiUpload } from '@/lib/careerApi/requestGuard';
import { CAREER_AI_RATE_LIMITS } from '@/lib/rateLimit';
import { requireCareerAiAccess } from '@/lib/careerBilling/aiAccess';
import { getCareerServiceRoleSupabaseClient } from '@/lib/careerSupabase/serviceRoleClient';
import {
  CAREER_PRESENTATION_MATERIAL_BUCKET,
  CAREER_PRESENTATION_MATERIAL_MAX_BYTES,
  CAREER_PRESENTATION_MATERIAL_TYPE_LABEL,
  buildCareerPresentationMaterialPath,
  buildCareerPresentationMaterialPathCandidates,
  isAllowedCareerPresentationMaterialMime,
  isSafeMaterialSessionId,
  normalizeMaterialFileName,
} from '@/lib/careerPresentation/material';
import type { CareerPresentationMaterialFile } from '@/types/careerPresentation';

// Storage SDK / Buffer を使うため Node ランタイム（Edge では動かさない）。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RULES = {
  member: CAREER_AI_RATE_LIMITS.presentationMaterialMember,
  guest: CAREER_AI_RATE_LIMITS.presentationMaterialGuest,
} as const;

/**
 * 発表資料ファイルをアップロードする（multipart/form-data）。
 *
 * 受信: file=<File>, sessionId=<string>
 * 返却: 200 { materialFile } / 400 / 413 / 415 / 503
 */
export async function POST(req: Request): Promise<Response> {
  // 1) identity 確定 + rate limit。★ formData() より前（10MB を parse する前に 429 を返す）。
  const guard = await guardCareerAiUpload(req, {
    rules: RULES,
    label: 'presentation-material',
  });
  if (!guard.ok) return guard.response;

  // 2) 有料ゲート（単一プラン）。guest / 未契約はここで終了。
  const accessDenied = await requireCareerAiAccess(guard.identity);
  if (accessDenied) return accessDenied;
  // requireCareerAiAccess を通った時点で member 確定だが、userId を使うため型でも絞る。
  if (guard.identity.kind !== 'member') {
    return Response.json({ error: 'ログインが必要です。' }, { status: 401 });
  }
  const userId = guard.identity.userId;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: 'リクエストが不正です。' }, { status: 400 });
  }

  const sessionId = form.get('sessionId');
  if (!isSafeMaterialSessionId(sessionId)) {
    return Response.json({ error: 'セッションが不正です。' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'ファイルが見つかりません。' }, { status: 400 });
  }

  // 3) MIME / サイズを server 側でも検証する（client 検証は UX 用で、正本はここ）。
  const mimeType = file.type || '';
  if (!isAllowedCareerPresentationMaterialMime(mimeType)) {
    return Response.json(
      { error: `対応形式は ${CAREER_PRESENTATION_MATERIAL_TYPE_LABEL} です。` },
      { status: 415 },
    );
  }
  if (file.size <= 0) {
    return Response.json({ error: 'ファイルが空です。' }, { status: 400 });
  }
  if (file.size > CAREER_PRESENTATION_MATERIAL_MAX_BYTES) {
    return Response.json({ error: 'ファイルサイズは最大 10MB までです。' }, { status: 413 });
  }

  // 4) path は **server が生成する**（client 申告 path は受け取らない）。
  const path = buildCareerPresentationMaterialPath(userId, sessionId, mimeType);
  if (!path) {
    return Response.json({ error: 'ファイルを保存できませんでした。' }, { status: 400 });
  }

  let supabase: ReturnType<typeof getCareerServiceRoleSupabaseClient>;
  try {
    supabase = getCareerServiceRoleSupabaseClient();
  } catch (err) {
    devWarn('[career/presentation/material] service role client unavailable', err);
    return storageUnavailable();
  }

  try {
    // 差し替え時に「前の拡張子のファイル」が残らないよう、同一セッションの他候補を消す。
    const stale = buildCareerPresentationMaterialPathCandidates(userId, sessionId).filter(
      (p) => p !== path,
    );
    if (stale.length > 0) {
      await supabase.storage.from(CAREER_PRESENTATION_MATERIAL_BUCKET).remove(stale);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    // 実バイト数でもう一度検証する（申告 size と実体の乖離を許さない）。
    if (bytes.byteLength > CAREER_PRESENTATION_MATERIAL_MAX_BYTES) {
      return Response.json({ error: 'ファイルサイズは最大 10MB までです。' }, { status: 413 });
    }

    const { error } = await supabase.storage
      .from(CAREER_PRESENTATION_MATERIAL_BUCKET)
      .upload(path, bytes, { contentType: mimeType, upsert: true });
    if (error) {
      devWarn('[career/presentation/material] upload failed', { message: error.message });
      return storageUnavailable();
    }

    const materialFile: CareerPresentationMaterialFile = {
      path,
      mimeType,
      fileName: normalizeMaterialFileName(file.name) || 'material',
      sizeBytes: bytes.byteLength,
      uploadedAt: new Date().toISOString(),
    };
    return Response.json({ materialFile }, { status: 200 });
  } catch (err) {
    devWarn('[career/presentation/material] upload threw', err);
    return storageUnavailable();
  }
}

/**
 * 発表資料ファイルを削除する（JSON: { sessionId }）。
 *
 * ★ client から path は受け取らない。identity + sessionId から生成できる全候補を消す
 *   ので、他人のファイルを消すことは構造的にできない。
 */
export async function DELETE(req: Request): Promise<Response> {
  const guard = await guardCareerAiUpload(req, {
    rules: RULES,
    label: 'presentation-material',
  });
  if (!guard.ok) return guard.response;

  const accessDenied = await requireCareerAiAccess(guard.identity);
  if (accessDenied) return accessDenied;
  if (guard.identity.kind !== 'member') {
    return Response.json({ error: 'ログインが必要です。' }, { status: 401 });
  }
  const userId = guard.identity.userId;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'リクエストが不正です。' }, { status: 400 });
  }
  const sessionId = (body as { sessionId?: unknown } | null)?.sessionId;
  if (!isSafeMaterialSessionId(sessionId)) {
    return Response.json({ error: 'セッションが不正です。' }, { status: 400 });
  }

  try {
    const supabase = getCareerServiceRoleSupabaseClient();
    const paths = buildCareerPresentationMaterialPathCandidates(userId, sessionId);
    const { error } = await supabase.storage
      .from(CAREER_PRESENTATION_MATERIAL_BUCKET)
      .remove(paths);
    if (error) {
      devWarn('[career/presentation/material] delete failed', { message: error.message });
      // 消せなくても client 側の参照は外させる（UI をブロックしない）。
    }
  } catch (err) {
    devWarn('[career/presentation/material] delete threw', err);
  }
  return Response.json({ ok: true }, { status: 200 });
}

// storage 未プロビジョニング / 障害。ユーザーには「貼り付けで代替できる」ことを伝える。
function storageUnavailable(): Response {
  return Response.json(
    {
      error:
        'ファイルの保存に失敗しました。時間をおくか、資料の内容をテキストで貼り付けてください。',
    },
    { status: 503 },
  );
}
