/**
 * PASSAI 就活版 — GD 音声機能の可用性照会（STEP-GD-VOICE）。
 *
 * GET /api/career/gd/voice/capabilities → { stt: boolean, tts: boolean }
 *
 * 目的は **早期失敗**。GD は音声でしか進行できないため、
 * 「部屋に入って、開始して、話そうとした瞬間に文字起こしが使えないと分かる」のが最悪。
 * setup / ロビーの段階でこれを引き、stt=false なら開始そのものをブロックして案内する。
 *
 * 返すのは boolean 2 個だけ。env 名・provider 名・key の断片は一切返さない。
 * 認証は要求する（未ログインに server 構成を推測させない）が、契約は要求しない
 * （契約前のユーザーにも「この端末で音声 GD ができるか」は答えてよい）。
 */

import 'server-only';

import { requireCareerGdEnabled } from '@/lib/careerGdGate/flags.server';
import { resolveCareerRequestIdentity } from '@/lib/careerApi/requestGuard';
import { loginRequiredResponse } from '@/lib/careerBilling/entitlement';
import { getGdVoiceCapabilities } from '@/lib/careerGd/voice.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET() {
  const gdGate = requireCareerGdEnabled();
  if (gdGate) return gdGate;

  const identity = await resolveCareerRequestIdentity();
  if (identity.kind !== 'member') return loginRequiredResponse();

  return Response.json(getGdVoiceCapabilities(), {
    headers: { 'cache-control': 'no-store' },
  });
}
