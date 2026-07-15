// PASSAI 就活版 — GD テーマ生成 route（ステートレス）。
//
// 役割: 形式・人数・制限時間から GD テーマ（JSON）を 1 つ生成して返す。
//   - DB / 課金 / usage には接続しない。
//   - parse 失敗時のみ 1 回だけ temperature 0 で再生成する。

import type { GdFormat } from '@/types/careerGd';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import {
  CAREER_GD_MODEL,
  buildThemeSystem,
  buildThemeUser,
  parseThemeJson,
} from '../gdPrompt';
import { coerceParticipantCount } from '@/lib/careerGd/participantCount';

export const maxDuration = 80;

function resolveFormat(value: unknown): GdFormat {
  return value === 'case' || value === 'abstract' ? value : 'free';
}

// テーマ生成プロンプト用の参加人数（4/6/8・不正は既定 4）。UI 表示・検証は各 create route が担う。
function resolveCount(value: unknown): number {
  return coerceParticipantCount(value);
}

function resolveTimeLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 900;
  return Math.min(1800, Math.max(300, Math.round(n)));
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'リクエストボディが不正です。' }, { status: 400 });
  }

  const b = (body && typeof body === 'object' ? body : {}) as {
    format?: unknown;
    participantCount?: unknown;
    timeLimitSec?: unknown;
    industry?: unknown;
    jobType?: unknown;
    difficulty?: unknown;
    themeType?: unknown;
  };
  const format = resolveFormat(b.format);
  const participantCount = resolveCount(b.participantCount);
  const timeLimitSec = resolveTimeLimit(b.timeLimitSec);
  // 任意の絞り込み条件（マルチGD テーマ設定ステップ用・未指定は AI にお任せ）。
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

  const system = buildThemeSystem();
  const user = buildThemeUser({
    format,
    participantCount,
    timeLimitSec,
    industry: str(b.industry),
    jobType: str(b.jobType),
    difficulty: str(b.difficulty),
    themeType: str(b.themeType),
  });

  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: CAREER_GD_MODEL,
          max_tokens: 500,
          temperature: attempt === 2 ? 0 : 0.8,
          system,
          messages: [{ role: 'user', content: user }],
        },
        { signal: createTimeoutSignal() },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';
      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_GD_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      const parsed = parseThemeJson((() => {
        try {
          return JSON.parse(extractJson(raw));
        } catch {
          return null;
        }
      })());

      if (parsed) {
        return Response.json({
          theme: {
            title: parsed.title,
            description: parsed.description,
            format,
            ...(parsed.constraints.length > 0 ? { constraints: parsed.constraints } : {}),
          },
        });
      }
      if (attempt === 2) {
        return Response.json(
          { error: 'AI_GD_PARSE_FAILED', detail: 'テーマを解釈できませんでした。' },
          { status: 502 },
        );
      }
    }
    return Response.json(
      { error: 'AI_GD_PARSE_FAILED', detail: 'テーマを解釈できませんでした。' },
      { status: 502 },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career GD theme API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: 'テーマの生成に失敗しました。' },
      { status: 500 },
    );
  }
}
