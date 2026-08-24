/**
 * PASSAI 就活版 — GD 読み上げ route（STEP-GD-VOICE）。
 *
 * POST /api/career/gd/voice/tts   application/json
 *   { text, speakerKey? }
 *     text        … 読み上げる本文（AI 参加者の発言 / 進行アナウンス）
 *     speakerKey  … 話者の声を決める key。AI persona_key（leader / logical …）、
 *                   進行アナウンスは 'moderator'、ソロ GD は 'solo:<index>'。
 *                   未知・未指定なら既定の声。
 *
 * 役割は **音声化だけ**。テキストは既に client が保持している（AI 発言は messages に
 * 保存済み / 進行アナウンスは client 生成）ので、本 route は何も保存しない。
 *   - 生成音声を DB / Storage に書かない（response で 1 回返すだけ）。
 *   - recordUsage / Daily Quota を消費しない（GD の消費点は評価のみ）。
 *
 * 失敗時の契約:
 *   TTS が使えなくても GD は止めない。client は 502 を受けたら
 *   **ブラウザの speechSynthesis へ降格**して読み上げを継続する。
 *   したがって本 route の失敗は「音質が落ちる」であって「無音になる」ではない。
 *
 * レスポンス:
 *   200 audio/mpeg（バイナリ）
 *   400 { error: 'INVALID_BODY' | 'EMPTY_TEXT' }
 *   401/403 … 未ログイン / 未契約
 *   404 … GD kill switch OFF
 *   429 … rate limit
 *   502 { error: 'TTS_UNAVAILABLE' | 'TTS_FAILED' } … client は browser TTS へ降格
 *   500 { error: 'TTS_ERROR' }
 */

import 'server-only';

import { devWarn } from '@/lib/devLog';
import { captureRouteException } from '@/lib/sentry/capture';
import { requireCareerGdEnabled } from '@/lib/careerGdGate/flags.server';
import { resolveCareerRequestIdentity } from '@/lib/careerApi/requestGuard';
import { requireCareerAiAccess } from '@/lib/careerBilling/aiAccess';
import { enforceRateLimit, CAREER_GD_RATE_LIMITS } from '@/lib/rateLimit';
import {
  isTtsError,
  synthesizeSpeech,
  TtsUnavailableError,
} from '@/lib/interviewAi/tts';
import {
  GD_TTS_DEFAULT_DELIVERY,
  gdSoloTtsDeliveryFor,
  gdTtsDeliveryFor,
  type GdTtsDelivery,
} from '@/lib/careerGd/voice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 60;

// 1 発言ぶんの読み上げ。GD の発言上限（600 文字）に揃える。
const MAX_TTS_CHARS = 600;

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

/**
 * speakerKey → 声。
 *   'solo:<n>' … ソロ GD（persona_key を持たない）。index で決定的にローテーション。
 *   それ以外   … マルチ GD の persona_key / 'moderator'。
 */
function resolveDelivery(speakerKey: string): GdTtsDelivery {
  if (!speakerKey) return GD_TTS_DEFAULT_DELIVERY;
  if (speakerKey.startsWith('solo:')) {
    const index = Number(speakerKey.slice('solo:'.length));
    return gdSoloTtsDeliveryFor(Number.isFinite(index) ? index : 0);
  }
  return gdTtsDeliveryFor(speakerKey);
}

export async function POST(req: Request) {
  // ① GD kill switch（server flag が最終権限）。
  const gdGate = requireCareerGdEnabled();
  if (gdGate) return gdGate;

  // ② identity。
  const identity = await resolveCareerRequestIdentity();

  // ③ 有料ゲート（TTS provider へ到達する前）。
  const accessDenied = await requireCareerAiAccess(identity);
  if (accessDenied) return accessDenied;
  const userId = identity.kind === 'member' ? identity.userId : '';

  // ④ rate limit（user 単位・fail-open）。
  const limited = await enforceRateLimit(userId, CAREER_GD_RATE_LIMITS.tts);
  if (limited) return limited;

  // ⑤ body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('INVALID_BODY', 'リクエストボディが不正です。', 400);
  }
  const b = (body && typeof body === 'object' ? body : {}) as {
    text?: unknown;
    speakerKey?: unknown;
  };
  const text = (typeof b.text === 'string' ? b.text : '').trim().slice(0, MAX_TTS_CHARS);
  if (!text) return jsonError('EMPTY_TEXT', '読み上げる本文がありません。', 400);
  const speakerKey =
    typeof b.speakerKey === 'string' ? b.speakerKey.trim().slice(0, 64) : '';

  const delivery = resolveDelivery(speakerKey);

  // ⑥ 音声化（保存しない）。
  try {
    const { audio, contentType } = await synthesizeSpeech({
      text,
      voice: delivery.voice,
      speed: delivery.speed,
      instructions: delivery.instructions,
    });
    return new Response(audio, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(audio.byteLength),
        // 生成音声はどこにも残さない（CDN / browser にも溜めない）。
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    if (isTtsError(err)) {
      const code = err instanceof TtsUnavailableError ? 'TTS_UNAVAILABLE' : 'TTS_FAILED';
      devWarn('[career/gd/voice/tts] tts error', { name: (err as Error).name });
      // client はこれを受けて browser TTS へ降格する（GD は継続する）。
      return jsonError(code, '読み上げ音声を生成できませんでした。', 502);
    }
    captureRouteException(
      err,
      { route: 'career/gd/voice/tts', feature: 'gd', status: 500 },
      { status: 500, code: 'TTS_ERROR' },
    );
    return jsonError('TTS_ERROR', '読み上げ音声の生成に失敗しました。', 500);
  }
}
