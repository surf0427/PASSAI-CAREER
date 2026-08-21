// PASSAI 就活版 — GD 発言生成 route（ステートレス）。
//
// 役割: AI 参加者 1 名の「次の発言」を生成して返す。
//   - 会話状態（transcript）・参加者一覧・話者・テーマはクライアントが送る。
//   - DB / 課金 / usage には接続しない。
//   - AI は強すぎないよう、簡潔（1〜3文）な発言を返す。

import type {
  GdFormat,
  GdParticipant,
  GdUtterance,
  GdRole,
} from '@/types/careerGd';
import { anthropic } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import { CAREER_GD_MODEL, buildTurnSystem, buildTurnUser } from '../gdPrompt';
import { requireCareerGdEnabled } from '@/lib/careerGdGate/flags.server';

// P0（HARDENING）: 認証 identity / rate limit / 入力サイズ上限の共通ガード。
import { guardCareerAiRequest } from '@/lib/careerApi/requestGuard';
import { CAREER_AI_RATE_LIMITS } from '@/lib/rateLimit';
import { requireCareerAiAccess } from '@/lib/careerBilling/aiAccess';

export const maxDuration = 80;

const MAX_TRANSCRIPT = 60; // 直近 N 発言までを文脈に使う（トークン節約）
const MAX_UTTERANCE_CHARS = 600;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const ROLES: GdRole[] = ['facilitator', 'scribe', 'timekeeper', 'presenter', 'member'];

function normalizeParticipant(raw: unknown): GdParticipant | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const p: GdParticipant = {
    id: r.id,
    type: r.type === 'ai' ? 'ai' : 'user',
    displayName: str(r.displayName) || '参加者',
    role: ROLES.includes(r.role as GdRole) ? (r.role as GdRole) : 'member',
  };
  if (r.isSelf === true) p.isSelf = true;
  if (r.persona && typeof r.persona === 'object') {
    const per = r.persona as Record<string, unknown>;
    const a = per.assertiveness;
    p.persona = {
      assertiveness: a === 1 || a === 2 || a === 3 ? a : 2,
      style: str(per.style) || '一般型',
    };
  }
  return p;
}

function normalizeTranscript(raw: unknown): GdUtterance[] {
  if (!Array.isArray(raw)) return [];
  const out: GdUtterance[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.participantId !== 'string') continue;
    out.push({
      id: r.id,
      participantId: r.participantId,
      content: str(r.content),
      createdAt: str(r.createdAt),
      ...(r.kind === 'system' ? { kind: 'system' as const } : {}),
    });
  }
  return out.slice(-MAX_TRANSCRIPT);
}

export async function POST(req: Request) {
  // ── STEP-GD-31: GD kill switch（server flag が最終権限）──
  //    OFF なら body parse / auth / DB / AI へ到達する前に 404。UI flag は権限に影響しない。
  const gdGate = requireCareerGdEnabled();
  if (gdGate) return gdGate;

  // P0（HARDENING）: 認証 identity / rate limit / body サイズ上限の共通ガード。
  //   ★ kill switch の**後ろ**に置く（OFF 中は identity 解決すらせず 404 のまま）。
  //   ★ AI・prompt 構築より前に通す。429 ならここで返るので Anthropic コールは 0 回。
  const guard = await guardCareerAiRequest(req, {
    rules: {
      member: CAREER_AI_RATE_LIMITS.gdTurnMember,
      guest: CAREER_AI_RATE_LIMITS.gdTurnGuest,
    },
    label: 'gd-turn',
    badRequest: () => Response.json({ error: 'リクエストボディが不正です。' }, { status: 400 }),
  });
  if (!guard.ok) return guard.response;

  // 有料ゲート（PASSAI CAREER 単一プラン）。AI 到達前・Quota より前に必ず通す。
  //   guest / 未契約 / 契約状態が確認できない場合はここで終了し、AI コストを 0 にする。
  //   ★ Quota より前に置くのが必須（未契約者に Quota を消費させない）。
  const accessDenied = await requireCareerAiAccess(guard.identity);
  if (accessDenied) return accessDenied;
  const body = guard.body;

  const b = (body && typeof body === 'object' ? body : {}) as {
    theme?: { title?: unknown; description?: unknown; constraints?: unknown };
    format?: unknown;
    participants?: unknown;
    speakerId?: unknown;
    transcript?: unknown;
    wrapUp?: unknown;
  };

  const theme = {
    title: str(b.theme?.title),
    description: str(b.theme?.description),
    constraints: Array.isArray(b.theme?.constraints)
      ? (b.theme?.constraints as unknown[]).filter((c): c is string => typeof c === 'string')
      : [],
  };
  if (!theme.title) {
    return Response.json({ error: 'テーマがありません。' }, { status: 400 });
  }

  const participants = Array.isArray(b.participants)
    ? b.participants.map(normalizeParticipant).filter((p): p is GdParticipant => p !== null)
    : [];
  const speaker = participants.find((p) => p.id === str(b.speakerId));
  if (!speaker) {
    return Response.json({ error: '発言者が特定できません。' }, { status: 400 });
  }
  if (speaker.type !== 'ai') {
    return Response.json({ error: 'AI 参加者のみ発言を生成できます。' }, { status: 400 });
  }

  const format: GdFormat =
    b.format === 'case' || b.format === 'abstract' ? b.format : 'free';
  const transcript = normalizeTranscript(b.transcript);
  const wrapUp = b.wrapUp === true;

  const system = buildTurnSystem(speaker, format);
  const user = buildTurnUser({ theme, speaker, participants, transcript, wrapUp });

  try {
    const message = await anthropic.messages.create(
      {
        model: CAREER_GD_MODEL,
        max_tokens: 300,
        temperature: 0.8,
        system,
        messages: [{ role: 'user', content: user }],
      },
      { signal: createTimeoutSignal() },
    );

    const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';
    const content = raw.trim().slice(0, MAX_UTTERANCE_CHARS);
    if (!content) {
      return Response.json(
        { error: 'AI_GD_EMPTY', detail: '発言を生成できませんでした。' },
        { status: 502 },
      );
    }
    return Response.json({ content });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career GD turn API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '発言の生成に失敗しました。' },
      { status: 500 },
    );
  }
}
