/**
 * PASSAI 就活版 — GD 文字起こし route（STEP-GD-VOICE）。
 *
 * POST /api/career/gd/voice/stt   multipart/form-data
 *   audio      (必須 / Blob)  … MediaRecorder が出した 1 発言ぶんのクリップ
 *   mimeType   (任意 / string) … Blob.type が空になる環境（一部 Safari）用の申告値
 *
 * 役割は **文字起こしだけ**。発言の保存はしない:
 *   - ソロ GD … client が transcript を既存の localStorage transcript へ積む
 *   - マルチ GD … client が transcript を既存の POST /room/[roomId]/messages へ送る
 *   こうすることで「発言の正本経路」（seq 採番・冪等・timer 検証・rate limit）を
 *   音声化で一切変えない。音声はテキストの**取得手段**にすぎない、という境界を守る。
 *
 * 保存しないもの: 音声バイナリ（DB / Storage に一切書かない。メモリ上で transcribe して破棄）。
 *
 * 課金:
 *   - recordUsage は呼ばない / Daily Quota も消費しない。
 *     GD の quota 消費点は従来どおり **評価（feedback / result）のみ**であり、
 *     音声化で「1 回の GD の消費量」が変わってはいけない。
 *   - ただし有料ゲートは通す（未契約者に Whisper コストを発生させない）。
 *
 * レスポンス:
 *   200 { transcript, usable }   … usable=false は「無音・雑音で発言として採用できない」
 *   400 { error: 'INVALID_FORM' | 'MISSING_AUDIO' | 'INVALID_AUDIO_TYPE' | 'AUDIO_TOO_LARGE' }
 *   401/403 … 未ログイン / 未契約（lib/careerBilling が返す共通 body）
 *   404 … GD kill switch OFF
 *   429 … rate limit
 *   502 { error: 'STT_UNAVAILABLE' | 'STT_FAILED' }
 *   500 { error: 'STT_ERROR' }
 */

import 'server-only';

import { devWarn } from '@/lib/devLog';
import { captureRouteException } from '@/lib/sentry/capture';
import { requireCareerGdEnabled } from '@/lib/careerGdGate/flags.server';
import { resolveCareerRequestIdentity } from '@/lib/careerApi/requestGuard';
import { requireCareerAiAccess } from '@/lib/careerBilling/aiAccess';
import { enforceRateLimit, CAREER_GD_RATE_LIMITS } from '@/lib/rateLimit';
import {
  isSttError,
  SttUnavailableError,
  transcribeAudio,
} from '@/lib/interviewAi/stt';
import {
  GD_VOICE_MAX_CLIP_BYTES,
  baseAudioMime,
  isAllowedGdAudioMime,
  isUsableGdTranscript,
  normalizeGdTranscript,
} from '@/lib/careerGd/voice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 60;

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

export async function POST(req: Request) {
  // ① GD kill switch（server flag が最終権限）。OFF なら auth / STT へ到達する前に 404。
  const gdGate = requireCareerGdEnabled();
  if (gdGate) return gdGate;

  // ② identity（client 申告値は信用しない）。
  const identity = await resolveCareerRequestIdentity();

  // ③ 有料ゲート。**STT provider へ到達する前**に置く（未契約者に Whisper コストを出さない）。
  const accessDenied = await requireCareerAiAccess(identity);
  if (accessDenied) return accessDenied;
  // ここに来た時点で identity は必ず member（requireCareerAiAccess が guest を弾く）。
  const userId = identity.kind === 'member' ? identity.userId : '';

  // ④ rate limit（user 単位・fail-open）。formData の読み出しより前に判定して
  //    暴走クライアントのアップロード自体を止める。
  const limited = await enforceRateLimit(userId, CAREER_GD_RATE_LIMITS.stt);
  if (limited) return limited;

  // ⑤ multipart parse
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return jsonError('INVALID_FORM', 'リクエスト形式が不正です。', 400);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError('INVALID_FORM', 'リクエスト形式が不正です。', 400);
  }

  const audio = form.get('audio');
  if (!(audio instanceof Blob) || audio.size === 0) {
    return jsonError('MISSING_AUDIO', '音声データがありません。', 400);
  }
  if (audio.size > GD_VOICE_MAX_CLIP_BYTES) {
    return jsonError('AUDIO_TOO_LARGE', '音声が長すぎます。区切って話してください。', 400);
  }

  // Blob.type が空になる環境があるため、client 申告 mimeType を fallback に使う。
  // ★ 申告値は「どのコンテナか」の解釈にしか使わず、許可判定は必ずこちらで行う。
  const declared = typeof form.get('mimeType') === 'string' ? String(form.get('mimeType')) : '';
  const effectiveMime = baseAudioMime(audio.type || declared);
  if (!isAllowedGdAudioMime(effectiveMime)) {
    return jsonError('INVALID_AUDIO_TYPE', '対応していない音声形式です。', 400);
  }

  // ⑥ STT（メモリ上で transcribe するだけ。保存しない）。
  try {
    const audioBuffer = await audio.arrayBuffer();
    const { transcript } = await transcribeAudio({
      audio: audioBuffer,
      mimeType: effectiveMime,
    });
    // audioBuffer はここで参照終了（GC 対象）。保存しない。

    const normalized = normalizeGdTranscript(transcript);
    // usable=false でも 200 を返す。client は「聞き取れませんでした」を出して
    // **同じ発言をもう一度録り直させる**（エラー扱いにすると GD が止まる）。
    return Response.json({
      transcript: normalized,
      usable: isUsableGdTranscript(normalized),
    });
  } catch (err) {
    if (isSttError(err)) {
      const code = err instanceof SttUnavailableError ? 'STT_UNAVAILABLE' : 'STT_FAILED';
      devWarn('[career/gd/voice/stt] stt error', { name: (err as Error).name });
      return jsonError(
        code,
        err instanceof SttUnavailableError
          ? '音声の文字起こしを利用できません。時間をおいて再度お試しください。'
          : '音声を聞き取れませんでした。もう一度話してください。',
        502,
      );
    }
    captureRouteException(
      err,
      { route: 'career/gd/voice/stt', feature: 'gd', status: 500 },
      { status: 500, code: 'STT_ERROR' },
    );
    return jsonError('STT_ERROR', '音声の処理に失敗しました。', 500);
  }
}
