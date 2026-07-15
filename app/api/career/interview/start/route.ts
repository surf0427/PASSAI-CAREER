// PASSAI 就活版 — 面接AI start route（最小・ステートレス）
//
// 役割: 面接の最初の質問（seed）を生成して返す。
//   - 受験版 /api/interview-ai/turn(kickoff) の「seed 生成」構造を踏襲しつつ、DB セッション・
//     課金・usage には一切接続しない（会話状態はクライアントが localStorage で保持する）。
//   - プロンプトは就活版共通基盤（@/lib/careerAi）経由（app/api/career/interview/interviewPrompt.ts）。
//   - 利用ユーティリティは AI 呼び出し系の純粋なものに限定（@/lib/ai / @/lib/aiTimeout）。

import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerInterviewType } from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import {
  resolveInterviewType,
  normalizeInterviewTarget,
} from '@/app/career/interview/interviewModes';
import { normalizeInterviewCompanyResearchContext } from '@/lib/careerCompanyResearch/context';
import { anthropic } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import {
  CAREER_INTERVIEW_MODEL,
  buildInterviewBaseSystem,
  buildSeedUserPrompt,
} from '../interviewPrompt';

export const maxDuration = 80;

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'リクエストボディが不正です。' }, { status: 400 });
  }

  const b = (body && typeof body === 'object' ? body : {}) as {
    profile?: CareerProfileInput | null;
    activity?: CareerActivityInput | null;
    values?: CareerValuesInput | null;
    selfAnalysis?: CareerSelfAnalysisResult | null;
    es?: CareerEsResult | null;
    matching?: CareerMatchEngineResult | null;
    consultationInsights?: string[] | null;
    companyResearch?: unknown;
    target?: unknown;
    interviewType?: CareerInterviewType;
    userInput?: string;
  };

  const hasProfile = !!b.profile && Object.keys(b.profile).length > 0;
  const hasActivity = !!b.activity && Object.keys(b.activity).length > 0;
  if (!hasProfile && !hasActivity) {
    return Response.json(
      { error: '基本情報または活動整理のいずれかを入力してください。' },
      { status: 400 },
    );
  }

  const interviewType = resolveInterviewType(b.interviewType);
  // target は seed（初回質問の operative 指示）と system の両方で使うため一度だけ正規化する。
  const target = normalizeInterviewTarget(b.target);
  const system = buildInterviewBaseSystem({
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    selfAnalysis: b.selfAnalysis ?? null,
    es: b.es ?? null,
    matching: b.matching ?? null,
    consultationInsights: b.consultationInsights ?? null,
    companyResearch: normalizeInterviewCompanyResearchContext(b.companyResearch),
    target,
    interviewType,
    userInput: typeof b.userInput === 'string' ? b.userInput : '',
  });

  try {
    const message = await anthropic.messages.create(
      {
        model: CAREER_INTERVIEW_MODEL,
        max_tokens: 400,
        temperature: 0.6,
        system,
        messages: [{ role: 'user', content: buildSeedUserPrompt(interviewType, target) }],
      },
      { signal: createTimeoutSignal() },
    );

    const question = extractText(
      message.content as Array<{ type: string; text?: string }>,
    );
    if (!question) {
      return Response.json(
        { error: 'AI_INTERVIEW_EMPTY', detail: '質問の生成に失敗しました。' },
        { status: 502 },
      );
    }

    return Response.json({ question });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career interview start API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '面接の開始に失敗しました。' },
      { status: 500 },
    );
  }
}
