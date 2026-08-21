// PASSAI 就活版 — 面接AI turn route（最小・ステートレス）
//
// 役割: 直前の回答を受け取り、一言リアクション + 次の深掘り質問（JSON）を返す。
//   - 受験版 /api/interview-ai/turn(answer→followup) の構造を踏襲しつつ、DB セッション・課金・
//     usage には接続しない。会話状態（turns）はクライアントが送る（ステートレス）。
//   - ターン上限（CAREER_INTERVIEW_MAX_TURNS）に達したら done を返し、followup を生成しない。

import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type {
  CareerInterviewTurn,
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
  CAREER_INTERVIEW_MAX_TURNS,
  buildInterviewBaseSystem,
  buildFollowupUserPrompt,
  countAnswers,
} from '../interviewPrompt';
// NEXT-6: base context（profile/activity/values）の由来解決。flag OFF なら request body のまま（byte 互換）。
import { resolveInterviewContextInputs } from '../resolveContextInputs';
// Company Data Spine A 層（公式情報）の read。未取得 / flag OFF / 企業未解決なら null（面接は成立）。
import { resolveInterviewCompanyOfficial } from '../resolveCompanyOfficial';
// Data Spine Layer 2（Personal Memory）。flag OFF / gate deny では I/O ゼロで空配列（従来 prompt）。
import { resolveInterviewPersonalMemory } from '../resolvePersonalMemory';
// P0-1（HARDENING）: 認証 identity / rate limit / body・turns サイズ上限の共通ガード。
import { guardInterviewRequest } from '../requestGuard';
import { requireCareerAiAccess } from '@/lib/careerBilling/aiAccess';

export const maxDuration = 80;

const MAX_ANSWER_CHARS = 8000;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 受信した turns を {role, content} の交互列に正規化する（壊れた要素は除去）。
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

export async function POST(req: Request) {
  // P0-1（HARDENING）: identity 確定 → rate limit → body / turns 上限を **AI 到達前**に通す。
  //   turn は最頻（1 面接で最大 4 回）。正常な面接が引っかからない上限にしてある。
  const guard = await guardInterviewRequest(req, 'turn');
  if (!guard.ok) return guard.response;

  // 有料ゲート（PASSAI CAREER 単一プラン）。AI 到達前・Quota より前に必ず通す。
  //   guest / 未契約 / 契約状態が確認できない場合はここで終了し、AI コストを 0 にする。
  //   ★ Quota より前に置くのが必須（未契約者に Quota を消費させない）。
  const accessDenied = await requireCareerAiAccess(guard.identity);
  if (accessDenied) return accessDenied;
  const body: unknown = guard.body;

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
    answer?: unknown;
  };

  const turns = normalizeTurns(b.turns);
  const answer = str(b.answer);

  if (!answer) {
    return Response.json({ error: '回答が空です。' }, { status: 400 });
  }
  if (answer.length > MAX_ANSWER_CHARS) {
    return Response.json({ error: '回答が長すぎます。' }, { status: 413 });
  }
  // 直前に未回答の質問が必要（末尾が question）。
  const last = turns[turns.length - 1];
  if (!last || last.role !== 'question') {
    return Response.json({ error: '回答対象の質問がありません。' }, { status: 409 });
  }

  // 回答を会話に加えた後の回答数。上限到達なら followup を生成せず done。
  const newAnswerCount = countAnswers(turns) + 1;
  if (newAnswerCount >= CAREER_INTERVIEW_MAX_TURNS) {
    return Response.json({ done: true, reaction: '', question: null });
  }

  const priorTurns: CareerInterviewTurn[] = [
    ...turns,
    { role: 'answer', content: answer },
  ];

  // NEXT-6: flag OFF（既定）では request body をそのまま使う＝従来と byte 互換。
  // Batch 2（`D-S6`）: base + cross-feature を kind 単位で解決する。
  const ctx = await resolveInterviewContextInputs(
    { ...b, companyResearch: normalizeInterviewCompanyResearchContext(b.companyResearch) },
    req,
  );
  const interviewType = resolveInterviewType(b.interviewType);
  // target は followup（次質問の operative 指示）と system の両方で使うため一度だけ正規化する。
  const target = normalizeInterviewTarget(b.target);
  // Company Data Spine A 層（公式情報）。ターンごとに同じ system を組み直すため、start と同条件で読む
  //   （途中から企業公式情報が消える／現れることが無いようにする）。fetch / crawl は起動しない。
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

    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する。
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
          max_tokens: 500,
          temperature: attempt === 2 ? 0 : 0.6,
          system,
          messages: [
            { role: 'user', content: buildFollowupUserPrompt(priorTurns, interviewType, target) },
          ],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_INTERVIEW_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        const parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
        const question = str(parsed.question);
        if (!question) throw new Error('empty-question');
        return Response.json({
          reaction: str(parsed.reaction),
          question,
          done: false,
        });
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          { error: 'AI_INTERVIEW_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    return Response.json(
      { error: 'AI_INTERVIEW_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
      { status: 502 },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career interview turn API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '次の質問の生成に失敗しました。' },
      { status: 500 },
    );
  }
}
