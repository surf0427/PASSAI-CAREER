// PASSAI 就活版 — プレゼン対策AI qa route（発表後の質疑応答・ターン制・ステートレス）。
//
// 役割: 発表内容に対する採用担当からの質問を、ターン制（kickoff / followup）で生成して返す。
//   - 受験版 /api/presentation/qa の kickoff/answer/followup 思想を踏襲しつつ、DB・課金・usage 非接続。
//   - 会話状態（turns）はクライアントが送る。上限到達で done を返す。
//   - `mode: 'final'` のときは質問を作らず、**質疑応答全体の最終評価**（review）を返す。
//     質問生成と同じ system（＝同じ Data Spine / 企業公式情報 / config 文脈）の上で評価するため、
//     専用 route を分けずにこの route が担う（context の二重注入を作らない）。

import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
// P7-F: presentation は ES を presentation-local strict summary で受け取る（full CareerEsResult carry 廃止）。
import type { PresentationEsSummary } from '@/lib/careerMemory/presentationEs';
import type { CareerInterviewFinalResult } from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import type {
  CareerPresentationAxisScore,
  CareerPresentationConfig,
  CareerPresentationQaReview,
  CareerPresentationQaTurn,
  CareerPresentationType,
} from '@/types/careerPresentation';
import { anthropic, extractJson } from '@/lib/ai';
import {
  AI_BUDGET_PRESET_80S_WALL,
  createAiCallBudget,
  createTimeoutSignal,
} from '@/lib/aiTimeout';
import {
  CAREER_PRESENTATION_MODEL,
  CAREER_PRESENTATION_QA_AXES,
  CAREER_PRESENTATION_QA_MAX_TURNS,
  buildPresentationSystemParts,
  buildQaFinalUserPrompt,
  buildQaUserPrompt,
  computePresentationTotalScore,
  countQaAnswers,
  presentationRankFromScore,
} from '../presentationPrompt';
import { resolvePresentationContextInputs } from '../resolveContextInputs';
// Data Spine Layer 2（Personal Memory）: 全 Career AI route 共有の解決 seam。
import { resolvePersonalMemoryForPurpose } from '../../resolvePersonalMemoryContext';
// dedupe presence は prompt に実際に載る renderer を正本にする。
import {
  renderSelfAnalysis as renderPresentationSelfAnalysis,
  renderInterview as renderPresentationInterview,
} from '@/lib/careerMemory/renderers/presentationCrossFeature';
// P0（HARDENING）: 認証 identity / rate limit / body サイズ上限の共通ガード。
import { guardPresentationRequest } from '../requestGuard';
// Company Data Spine A 層（公式情報）。企業未指定 / 未取得 / flag OFF なら null（評価は成立）。
import { resolvePresentationCompanyOfficial } from '../resolveCompanyOfficial';
import { requireCareerAiAccess } from '@/lib/careerBilling/aiAccess';

export const maxDuration = 80;

const MAX_ANSWER_CHARS = 8000;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v) => v !== '');
}

function clampScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// AI が返した axes を CAREER_PRESENTATION_QA_AXES の固定順・固定ラベルに正規化する
// （evaluate route の normalizeAxes と同じ契約。欠損軸は 0 点・コメント空で埋める）。
function normalizeQaAxes(raw: unknown): CareerPresentationAxisScore[] {
  const byKey = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (a && typeof a === 'object') {
        const key = str((a as { key?: unknown }).key);
        if (key) byKey.set(key, a as Record<string, unknown>);
      }
    }
  }
  return CAREER_PRESENTATION_QA_AXES.map((axis) => {
    const found = byKey.get(axis.key);
    return {
      key: axis.key,
      label: axis.label,
      score: clampScore(found?.score),
      comment: str(found?.comment),
    };
  });
}

// AI 出力 → CareerPresentationQaReview。
//   ★ authority: 4 軸だけが AI 由来。総合点とランクは server が軸から導出する
//     （AI が totalScore / rank を返しても読まない。prompt でも出力を禁止済み）。
function normalizeQaReview(raw: unknown): CareerPresentationQaReview {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const axes = normalizeQaAxes(r.axes);
  const totalScore = computePresentationTotalScore(axes);
  return {
    totalScore,
    rank: presentationRankFromScore(totalScore),
    overallComment: str(r.overallComment),
    axes,
    goodPoints: strArray(r.goodPoints),
    improvements: strArray(r.improvements),
    nextPractice: strArray(r.nextPractice),
  };
}

function normalizeTurns(value: unknown): CareerPresentationQaTurn[] {
  if (!Array.isArray(value)) return [];
  const out: CareerPresentationQaTurn[] = [];
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
  // P0（HARDENING）: identity 確定 → rate limit → body サイズ上限を **AI 到達前**に通す。
  //   Q&A は 1 セッション最大 5 call（kickoff + 回答 4 回）を見込んだ上限。
  const guard = await guardPresentationRequest(req, 'qa');
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
    es?: PresentationEsSummary | null;
    interview?: CareerInterviewFinalResult | null;
    matching?: CareerMatchEngineResult | null;
    consultationInsights?: string[] | null;
    config?: CareerPresentationConfig | null;
    // 旧セッション互換（新規フローは常に 'real'）。企業公式情報の出し分けに使う。
    presentationType?: CareerPresentationType;
    theme?: unknown;
    transcript?: unknown;
    turns?: unknown;
    // 'final' … 質問生成ではなく質疑応答全体の最終評価を返す（既定は質問生成）。
    mode?: unknown;
  };

  const transcript = str(b.transcript);
  if (!transcript) {
    return Response.json({ error: '発表内容がありません。' }, { status: 400 });
  }

  const turns = normalizeTurns(b.turns);
  // 末尾が answer でその回答が長すぎる場合は弾く（直近回答のバリデーション）。
  const lastTurn = turns[turns.length - 1];
  if (lastTurn && lastTurn.role === 'answer' && lastTurn.content.length > MAX_ANSWER_CHARS) {
    return Response.json({ error: '回答が長すぎます。' }, { status: 413 });
  }

  const isFinal = str(b.mode) === 'final';

  if (isFinal) {
    // 最終評価は「回答が 1 件以上ある」ことが前提（面接 complete route と同じ契約）。
    //   ★ 1 問だけ答えて終わったケースも正当な評価対象にする（回答 1 件で成立する）。
    if (countQaAnswers(turns) === 0) {
      return Response.json({ error: '回答がありません。' }, { status: 409 });
    }
  } else if (countQaAnswers(turns) >= CAREER_PRESENTATION_QA_MAX_TURNS) {
    // 既に上限の質問数に達していれば done（これ以上質問しない）。
    //   client はこの done を受けて mode:'final' で最終評価を取りに来る。
    return Response.json({ done: true, reaction: '', question: null });
  }

  const config = b.config ?? null;
  const theme = str(b.theme);

  // Company Data Spine A 層（公式情報）。既存 read 経路を読むだけで fetch / crawl は起動しない。
  //   ★ context resolver と互いに独立なので **並列**に走らせる（応答時間を増やさない）。
  const companyOfficialPromise = resolvePresentationCompanyOfficial(config, b.presentationType);

  // Closure Batch（`D-S9`）: base + cross-feature を kind 単位で server / bridge から選ぶ。
  const [companyOfficial, ctx] = await Promise.all([
    companyOfficialPromise,
    resolvePresentationContextInputs(b, req),
  ]);
  try {
    // ★ prompt builder も route の error boundary の内側で実行する。
    //   builder が throw すると（例: 壊れた Layer 1 データ）catch されず
    //   非 JSON 500 になり、client には汎用エラーしか見えなくなる。
    // Data Spine Layer 2（Personal Memory）。
    //   ★ `useCareerContext !== true`（本人が「他機能データを参考にしない」を選んだ）ときは
    //     **解決自体を行わない**（I/O ゼロ）。参考情報オフというユーザーの意思を Layer 2 でも尊重する。
    //   presence は crossFeature renderer と同一実装で判定し、bridge が出す block とは重複させない。
    const usePersonalMemory = config?.useCareerContext === true;
    const personalMemory = await resolvePersonalMemoryForPurpose({
      purpose: 'presentation_feedback',
      enabled: usePersonalMemory,
      presence: {
        self_analysis:
          usePersonalMemory &&
          renderPresentationSelfAnalysis(ctx.selfAnalysis as typeof b.selfAnalysis) !== '',
        interview:
          usePersonalMemory &&
          renderPresentationInterview(ctx.interview as typeof b.interview) !== '',
      },
      req,
      // 観測の context outcome は resolvePresentationContextInputs が既に 1 件打っているため null。
      contextOutcome: null,
    });
    const { system } = buildPresentationSystemParts({
      profile: ctx.profile,
      activity: ctx.activity,
      values: ctx.values,
      selfAnalysis: ctx.selfAnalysis as typeof b.selfAnalysis,
      es: ctx.es as typeof b.es,
      interview: ctx.interview as typeof b.interview,
      matching: ctx.matching as typeof b.matching,
      consultationInsights: ctx.consultationInsights,
      config,
      theme,
      presentationType: b.presentationType,
      companyOfficial,
      personalMemory,
    });

    // AI 合計時間予算（wall 80s の内側に固定）。retry ごとに満額 signal を再発行すると
    // 合計が wall を超えて 504（非JSON）になり、client には汎用エラーしか見えなくなる。
    const aiBudget = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL });

    // ── mode:'final' … 質疑応答全体の最終評価を返す ──────────────────
    //   質問生成と **同じ system**（Data Spine / 企業公式情報 / config 文脈）の上で評価する。
    //   評価対象は turns（＝最後のユーザー回答まで含む確定済みの全記録）。
    if (isFinal) {
      const finalPrompt = buildQaFinalUserPrompt({ theme, transcript, turns, config });
      for (let attempt = 1; attempt <= 2; attempt++) {
        const callTimeoutMs = aiBudget.nextCallTimeoutMs();
        if (callTimeoutMs === null) {
          return Response.json(
            { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
            { status: 502 },
          );
        }
        const message = await anthropic.messages.create(
          {
            model: CAREER_PRESENTATION_MODEL,
            // 4 軸 + 3 配列（各 2〜3 要素・1 要素 40 字以内）+ 総評 2 文。
            //   出力契約を締めた上での上限で、per-call timeout 内に必ず収まる長さ。
            max_tokens: 1500,
            temperature: attempt === 2 ? 0 : 0.4,
            system,
            messages: [{ role: 'user', content: finalPrompt }],
          },
          { signal: createTimeoutSignal(callTimeoutMs) },
        );

        const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

        if (message.stop_reason === 'max_tokens') {
          return Response.json(
            { error: 'AI_PRESENTATION_TRUNCATED', detail: '評価が途中で切れました。' },
            { status: 502 },
          );
        }

        try {
          const review = normalizeQaReview(JSON.parse(extractJson(raw)));
          return Response.json({ done: true, review });
        } catch {
          if (attempt === 1) continue;
          return Response.json(
            { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
            { status: 502 },
          );
        }
      }

      return Response.json(
        { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
        { status: 502 },
      );
    }

    const userPrompt = buildQaUserPrompt({ theme, transcript, turns, config });

    for (let attempt = 1; attempt <= 2; attempt++) {
      const callTimeoutMs = aiBudget.nextCallTimeoutMs();
      // 残予算が retry に足りない → retry せず打ち切る（wall 超過による 504 を防ぐ）。
      if (callTimeoutMs === null) {
        return Response.json(
          { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
      const message = await anthropic.messages.create(
        {
          model: CAREER_PRESENTATION_MODEL,
          max_tokens: 500,
          temperature: attempt === 2 ? 0 : 0.6,
          system,
          messages: [{ role: 'user', content: userPrompt }],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_PRESENTATION_TRUNCATED', detail: 'AI応答が途中で切れました。' },
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
          { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    return Response.json(
      { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
      { status: 502 },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career presentation qa API error:', msg);
    return Response.json(
      {
        error: 'AI_REQUEST_FAILED',
        detail: isFinal ? '評価の生成に失敗しました。' : '質問の生成に失敗しました。',
      },
      { status: 500 },
    );
  }
}
