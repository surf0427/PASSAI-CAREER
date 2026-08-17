// PASSAI 就活版 — 面接AI complete route（最小・ステートレス）
//
// 役割: 面接のやり取り全体を受け取り、新卒就活の観点で最終評価（JSON）を返す。
//   - 受験版 /api/interview-ai/complete（generateFinalFeedback）の構造を踏襲しつつ、DB 保存・
//     課金・usage には接続しない。評価結果はクライアントが localStorage に保存する。

import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type {
  CareerInterviewTurn,
  CareerInterviewFinalResult,
  CareerInterviewTargetFeedback,
  CareerInterviewType,
} from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import {
  resolveInterviewType,
  normalizeInterviewTarget,
} from '@/app/career/interview/interviewModes';
import { normalizeInterviewCompanyResearchContext } from '@/lib/careerCompanyResearch/context';
import { anthropic, extractJson } from '@/lib/ai';
import {
  AI_BUDGET_PRESET_80S_WALL,
  createAiCallBudget,
  createTimeoutSignal,
} from '@/lib/aiTimeout';
import {
  CAREER_INTERVIEW_MODEL,
  buildInterviewBaseSystem,
  buildFinalUserPrompt,
  buildFinalFeedbackInstruction,
} from '../interviewPrompt';
// NEXT-6: base context（profile/activity/values）の由来解決。flag OFF なら request body のまま（byte 互換）。
import { resolveInterviewContextInputs } from '../resolveContextInputs';
// Company Data Spine A 層（公式情報）の read。未取得 / flag OFF / 企業未解決なら null（面接は成立）。
import { resolveInterviewCompanyOfficial } from '../resolveCompanyOfficial';
// Data Spine Layer 2（Personal Memory）。flag OFF / gate deny では I/O ゼロで空配列（従来 prompt）。
import { resolveInterviewPersonalMemory } from '../resolvePersonalMemory';

export const maxDuration = 80;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v) => v !== '');
}

function normalizeTurns(value: unknown): CareerInterviewTurn[] {
  if (!Array.isArray(value)) return [];
  const out: CareerInterviewTurn[] = [];
  for (const t of value) {
    if (!t || typeof t !== 'object') continue;
    const role = (t as { role?: unknown }).role;
    const content = str((t as { content?: unknown }).content);
    if ((role === 'question' || role === 'answer') && content) {
      out.push({ role, content });
    }
  }
  return out;
}

// targetFeedback を防御的に正規化する。全フィールドが空なら undefined（付けない）。
// これにより target 無し面接や AI が返さなかった場合でも result は従来形状のまま。
function normalizeTargetFeedback(
  raw: unknown,
): CareerInterviewTargetFeedback | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const fb: CareerInterviewTargetFeedback = {};
  const companyFitComment = str(r.companyFitComment);
  if (companyFitComment) fb.companyFitComment = companyFitComment;
  const phaseSpecificComment = str(r.phaseSpecificComment);
  if (phaseSpecificComment) fb.phaseSpecificComment = phaseSpecificComment;
  const jobFitComment = str(r.jobFitComment);
  if (jobFitComment) fb.jobFitComment = jobFitComment;
  const selectionTypeComment = str(r.selectionTypeComment);
  if (selectionTypeComment) fb.selectionTypeComment = selectionTypeComment;
  const weak = strArray(r.weakPointsForThisTarget);
  if (weak.length) fb.weakPointsForThisTarget = weak;
  const nextQ = strArray(r.nextPracticeQuestions);
  if (nextQ.length) fb.nextPracticeQuestions = nextQ;
  const reverseQ = strArray(r.suggestedReverseQuestions);
  if (reverseQ.length) fb.suggestedReverseQuestions = reverseQ;
  return Object.keys(fb).length > 0 ? fb : undefined;
}

function normalizeResult(raw: unknown): CareerInterviewFinalResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const result: CareerInterviewFinalResult = {
    overallComment: str(r.overallComment),
    strengths: strArray(r.strengths),
    improvements: strArray(r.improvements),
    sampleAnswers: strArray(r.sampleAnswers),
    deepDiveTopics: strArray(r.deepDiveTopics),
    nextActions: strArray(r.nextActions),
    companyFit: str(r.companyFit),
  };
  // 企業研究ログを使った面接でのみ AI が返す（未使用なら空文字は付けない）。
  const companyResearchFit = str(r.companyResearchFit);
  if (companyResearchFit) result.companyResearchFit = companyResearchFit;
  // target 入力があった面接でのみ AI が返す（空なら付けない＝後方互換）。
  const targetFeedback = normalizeTargetFeedback(r.targetFeedback);
  if (targetFeedback) result.targetFeedback = targetFeedback;
  return result;
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
    turns?: unknown;
  };

  const turns = normalizeTurns(b.turns);
  // 回答が 1 件も無ければ評価対象にしない。
  if (turns.filter((t) => t.role === 'answer').length === 0) {
    return Response.json({ error: '回答がありません。' }, { status: 409 });
  }

  // NEXT-6: flag OFF（既定）では request body をそのまま使う＝従来と byte 互換。
  // Batch 2（`D-S6`）: base + cross-feature を kind 単位で解決する。
  const ctx = await resolveInterviewContextInputs(
    { ...b, companyResearch: normalizeInterviewCompanyResearchContext(b.companyResearch) },
    req,
  );
  const interviewType = resolveInterviewType(b.interviewType);
  const companyResearch = ctx.companyResearch;
  const target = normalizeInterviewTarget(b.target);
  // Company Data Spine A 層（公式情報）。評価も start / turn と同じ企業文脈の上で行う。
  //   fetch / crawl は起動しない（既存 snapshot の read のみ）。
  const companyOfficial = await resolveInterviewCompanyOfficial(target, interviewType);
  // Personal Memory（Layer 2）。bridge と重複する section は resolver 側で dedupe 済み。
  const personalMemory = await resolveInterviewPersonalMemory(
    { selfAnalysis: ctx.selfAnalysis, es: ctx.es },
    req,
  );
  try {
    // ★ prompt builder も route の error boundary の内側で実行する。
    //   builder が throw すると（例: 壊れた Layer 1 データ）catch されず
    //   非 JSON 500 になり、client には汎用エラーしか見えなくなる。
    const system = [
      buildInterviewBaseSystem({
        profile: ctx.profile,
        activity: ctx.activity,
        values: ctx.values,
        selfAnalysis: ctx.selfAnalysis,
        es: ctx.es,
        matching: ctx.matching,
        consultationInsights: ctx.consultationInsights,
        companyResearch,
        companyOfficial,
        personalMemory,
        target,
        interviewType,
        userInput: typeof b.userInput === 'string' ? b.userInput : '',
      }),
      buildFinalFeedbackInstruction(interviewType, !!companyResearch, target),
    ].join('\n\n');

    let result: CareerInterviewFinalResult | null = null;
    // AI 合計時間予算（wall 80s の内側に固定）。retry ごとに満額 signal を再発行すると
    // 合計が wall を超えて 504（非JSON）になり、client には汎用エラーしか見えなくなる。
    const aiBudget = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const callTimeoutMs = aiBudget.nextCallTimeoutMs();
      // 残予算が retry に足りない → retry せず打ち切る（wall 超過による 504 を防ぐ）。
      if (callTimeoutMs === null) {
        return Response.json(
          { error: 'AI_INTERVIEW_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
      const message = await anthropic.messages.create(
        {
          model: CAREER_INTERVIEW_MODEL,
          max_tokens: 4000,
          temperature: attempt === 2 ? 0 : 0.4,
          system,
          messages: [{ role: 'user', content: buildFinalUserPrompt(turns) }],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_INTERVIEW_TRUNCATED', detail: '評価が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        result = normalizeResult(JSON.parse(extractJson(raw)));
        break;
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          { error: 'AI_INTERVIEW_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    if (!result) {
      return Response.json(
        { error: 'AI_INTERVIEW_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
        { status: 502 },
      );
    }

    return Response.json({ result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career interview complete API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '評価の生成に失敗しました。' },
      { status: 500 },
    );
  }
}
