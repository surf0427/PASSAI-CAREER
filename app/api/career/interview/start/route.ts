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
  isInterviewTargetComplete,
} from '@/app/career/interview/interviewModes';
import { normalizeInterviewCompanyResearchContext } from '@/lib/careerCompanyResearch/context';
import { anthropic } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import {
  CAREER_INTERVIEW_MODEL,
  buildInterviewBaseSystem,
  buildSeedUserPrompt,
} from '../interviewPrompt';
// NEXT-6: base context（profile/activity/values）の由来解決。flag OFF なら request body のまま（byte 互換）。
import { resolveInterviewContextInputs } from '../resolveContextInputs';
// Company Data Spine A 層（公式情報）の read。未取得 / flag OFF / 企業未解決なら null（面接は成立）。
import { resolveInterviewCompanyOfficial } from '../resolveCompanyOfficial';
// Data Spine Layer 2（Personal Memory）。flag OFF / gate deny では I/O ゼロで空配列（従来 prompt）。
import { resolveInterviewPersonalMemory } from '../resolvePersonalMemory';

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

  // NEXT-6: flag OFF（既定）では request body をそのまま返す＝従来と完全に同じ入力・同じ検証。
  // Batch 2（`D-S6`）: base に加えて cross-feature も kind 単位で server / bridge を選ぶ。
  const ctx = await resolveInterviewContextInputs(
    { ...b, companyResearch: normalizeInterviewCompanyResearchContext(b.companyResearch) },
    req,
  );
  const hasProfile = !!ctx.profile && Object.keys(ctx.profile).length > 0;
  const hasActivity = !!ctx.activity && Object.keys(ctx.activity).length > 0;
  if (!hasProfile && !hasActivity) {
    return Response.json(
      { error: '基本情報または活動整理のいずれかを入力してください。' },
      { status: 400 },
    );
  }

  const interviewType = resolveInterviewType(b.interviewType);
  // target は seed（初回質問の operative 指示）と system の両方で使うため一度だけ正規化する。
  const target = normalizeInterviewTarget(b.target);
  // ★ 新規面接の必須 4 項目（企業名 / 業界 / 職種 / 選考種別）を開始 boundary でも検証する。
  //   UI の disabled だけに頼らず、不完全な target で面接が始まらないようにする。
  //   検証は **start（新規開始）だけ**。turn / complete は旧セッションを完走させるため課さない。
  if (!isInterviewTargetComplete(target)) {
    return Response.json(
      {
        error: 'CAREER_INTERVIEW_TARGET_INCOMPLETE',
        detail: '企業名・業界・職種・選考種別を入力してください。',
      },
      { status: 400 },
    );
  }
  // Company Data Spine A 層（公式情報）。既存 read 経路を読むだけで、fetch / crawl は起動しない。
  //   自己分析モードでは要求しない（企業情報を主 context にしないため）。
  // ★ 面接 runtime からは prefetch / fetch / crawl を **起動しない**（read のみ）。
  //   これは既存の明示的な不変条件（career-interview-target-operative-qa H-8c）であり、
  //   Data Spine connection でも維持する。企業の取得は CompanyPicker の intent 通知と
  //   企業研究 / ES / プレゼンの trigger が担う。
  const companyOfficial = await resolveInterviewCompanyOfficial(target, interviewType);
  // Personal Memory（Layer 2）。bridge と重複する section は resolver 側で dedupe 済み。
  const personalMemory = await resolveInterviewPersonalMemory(
    { selfAnalysis: ctx.selfAnalysis, es: ctx.es },
    req,
  );
  const system = buildInterviewBaseSystem({
    profile: ctx.profile,
    activity: ctx.activity,
    values: ctx.values,
    selfAnalysis: ctx.selfAnalysis,
    es: ctx.es,
    matching: ctx.matching,
    consultationInsights: ctx.consultationInsights,
    companyResearch: ctx.companyResearch,
    companyOfficial,
    personalMemory,
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
