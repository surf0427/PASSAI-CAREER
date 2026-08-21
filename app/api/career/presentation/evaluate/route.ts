// PASSAI 就活版 — プレゼン対策AI evaluate route（最小・ステートレス）。
//
// 役割: 発表の文字起こし＋テーマ＋時間をもとに、就活・ビジネスの観点で最終評価レポート（JSON）を返す。
//   - 受験版 /api/presentation/evaluate の「文字起こし→AI評価」構造を踏襲しつつ、DB 保存・課金・
//     Supabase Storage・usage には接続しない。評価結果はクライアントが localStorage に保存する。
//   - 数値スコア（0〜100）＋ランク（S/A/B/C/D）は就活版の方針として採用する。

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
  CareerPresentationConfig,
  CareerPresentationFinalResult,
  CareerPresentationRank,
  CareerPresentationAxisScore,
  CareerPresentationType,
} from '@/types/careerPresentation';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import {
  CAREER_PRESENTATION_MODEL,
  CAREER_PRESENTATION_AXES,
  buildPresentationSystemParts,
  buildEvaluateUserPrompt,
  buildEvaluateInstruction,
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
import { enforceCareerDailyQuota } from '@/lib/careerQuota/enforce';
// Company Data Spine A 層（公式情報）。企業未指定 / 未取得 / flag OFF なら null（評価は成立）。
import { resolvePresentationCompanyOfficial } from '../resolveCompanyOfficial';

export const maxDuration = 80;

// P0.5 timeout 予算是正:
//   旧実装は per-call 75s の signal を attempt 毎に新規発行していたため、JSON parse retry が走ると
//   75s + 75s = 150s 相当となり maxDuration=80s を超えて 504 になる構造だった。
//   対策として (1) per-call を 60s に下げ、(2) 1回目+2回目の合計 AI 時間 TOTAL_BUDGET_MS を wall(80s)
//   の内側に固定し、(3) 2回目 retry は残予算が足りる時だけ発火する（残予算を signal 上限にも使う）。
const TOTAL_BUDGET_MS = 74_000; // 1回目+2回目の合計 AI 時間の上限（wall 80s に対し余白 6s）
const PER_CALL_TIMEOUT_MS = 60_000; // 1回あたりの AI timeout（旧 75s から短縮）
const MIN_RETRY_BUDGET_MS = 30_000; // 2回目 retry を発火するのに必要な最低残予算

// 出力上限（P1 実測ベース）。
//
// ★ 背景（この route が構造的に成功不能だった理由・2026-08-21 実測）:
//     旧 max_tokens=4000 に対し、出力の自然長は **4144 tok**（stop_reason=end_turn）。
//     つまり時間内に終わっても必ず truncate（502）する設定だった。
//     さらに 4144 tok の生成には ~73s かかり、PER_CALL_TIMEOUT_MS=60s を先に超えて
//     abort（500）していた。max_tokens は「小さすぎて truncate」かつ
//     「到達不能なほど大きい」という両立不能な値だった。
//
// ★ 対処:
//     1. 出力契約を締める（presentationPrompt の buildEvaluateInstruction。評価項目は 1 つも
//        削らず、1 項目あたりの冗長さだけを縛る）→ 自然長 4144 → **2566 tok / 47s** に短縮。
//     2. 上限を「per-call timeout 内に必ず収まる長さ」に合わせる（下記）。
//        実測 throughput は **最低 52.6 tok/s**、ttfb 約 1.8s。
//        最悪ケースでも per-call 60s に収めるには (60 - 1.8) x 52.6 ≒ 3060 tok が上限なので
//        **3000** とする。これにより「上限まで生成しても時間内に終わる」ことが保証され、
//        時間 abort（500）は構造的に起きなくなる。
//        修正後の実測自然長は 2596〜2660 tok（46.5〜50.6s / stop_reason=end_turn）で、
//        上限まで約 340 tok の余白がある。
//     3. streaming で受ける（長い出力での HTTP timeout 回避。Anthropic の推奨既定）。
const MAX_OUTPUT_TOKENS = 3000;

const MAX_TRANSCRIPT_CHARS = 20000;

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

function rankFromScore(score: number): CareerPresentationRank {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

function normalizeRank(value: unknown, score: number): CareerPresentationRank {
  const v = str(value).toUpperCase();
  if (v === 'S' || v === 'A' || v === 'B' || v === 'C' || v === 'D') {
    return v as CareerPresentationRank;
  }
  return rankFromScore(score);
}

// AI が返した axes を CAREER_PRESENTATION_AXES の固定順・固定ラベルに正規化する。
function normalizeAxes(raw: unknown): CareerPresentationAxisScore[] {
  const byKey = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (a && typeof a === 'object') {
        const key = str((a as { key?: unknown }).key);
        if (key) byKey.set(key, a as Record<string, unknown>);
      }
    }
  }
  return CAREER_PRESENTATION_AXES.map((axis) => {
    const found = byKey.get(axis.key);
    return {
      key: axis.key,
      label: axis.label,
      score: clampScore(found?.score),
      comment: str(found?.comment),
    };
  });
}

function normalizeResult(raw: unknown): CareerPresentationFinalResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const totalScore = clampScore(r.totalScore);
  return {
    totalScore,
    rank: normalizeRank(r.rank, totalScore),
    overallComment: str(r.overallComment),
    axes: normalizeAxes(r.axes),
    goodPoints: strArray(r.goodPoints),
    improvements: strArray(r.improvements),
    priorityImprovements: strArray(r.priorityImprovements),
    nextPractice: strArray(r.nextPractice),
    expectedQuestions: strArray(r.expectedQuestions),
    improvedStructure: strArray(r.improvedStructure),
    structureFeedback: str(r.structureFeedback) || undefined,
    persuasionFeedback: str(r.persuasionFeedback) || undefined,
    deliveryFeedback: str(r.deliveryFeedback) || undefined,
    passLikelihood: str(r.passLikelihood),
    companyFit: str(r.companyFit),
    interviewerConcerns: strArray(r.interviewerConcerns),
  };
}

export async function POST(req: Request) {
  // P0（HARDENING）: identity 確定 → rate limit → body サイズ上限を **AI 到達前**に通す。
  //   evaluate は 1 request 最大 2 attempt × 4000 tok と最も高価なため上限が最も厳しい。
  const guard = await guardPresentationRequest(req, 'evaluate');
  if (!guard.ok) return guard.response;
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
    timeLimitSec?: unknown;
    durationSec?: unknown;
    transcript?: unknown;
  };

  const transcript = str(b.transcript);
  if (!transcript) {
    return Response.json({ error: '発表内容が空です。' }, { status: 400 });
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    return Response.json({ error: '発表内容が長すぎます。' }, { status: 413 });
  }

  // 日次利用回数（PASSAI Career BASIC / プレゼン = 1 セッション 1 回）。
  //   ★ anchor は評価だけ。同一セッションの theme / Q&A は消費しない。
  //   ★ 同一 transcript の再送（retry / 二重送信）は operation dedupe で +0。
  //   ★ 入力検証（空 / 長すぎ）の**後**、AI 到達**前**に置く。
  const quotaBlocked = await enforceCareerDailyQuota({
    identity: guard.identity,
    feature: 'presentation',
    operationSource: body,
  });
  if (quotaBlocked) return quotaBlocked;

  const config = b.config ?? null;
  const theme = str(b.theme);
  const timeLimitSec = clampSecond(b.timeLimitSec);
  const durationSec = clampSecond(b.durationSec);

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
    // 出力 schema 指示側の guard を system の block と **同一判定**にする（乖離させない）。
    //   判定は builder が orchestrator 出力から 1 度だけ行う（route は renderer を import しない）。
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
    const { system: baseSystem, hasCompanyOfficial } = buildPresentationSystemParts({
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
    const system = [
      baseSystem,
      buildEvaluateInstruction({
        theme,
        config,
        presentationType: b.presentationType,
        hasCompanyOfficial,
      }),
    ].join('\n\n');

    const userPrompt = buildEvaluateUserPrompt({ theme, timeLimitSec, durationSec, transcript, config });

    let result: CareerPresentationFinalResult | null = null;
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remainingMs = TOTAL_BUDGET_MS - (Date.now() - startedAt);
      // 残予算が 2回目に足りなければ retry せず打ち切る（maxDuration 超過による 504 を防ぐ）。
      if (attempt === 2 && remainingMs < MIN_RETRY_BUDGET_MS) {
        return Response.json(
          { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
      const callTimeoutMs = Math.min(PER_CALL_TIMEOUT_MS, Math.max(0, remainingMs));
      // ★ streaming で受ける（非 streaming の長い出力は HTTP timeout に当たりやすい）。
      //   受け取り方が変わるだけで、prompt・model・temperature・schema は不変。
      const message = await anthropic.messages
        .stream(
          {
            model: CAREER_PRESENTATION_MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: attempt === 2 ? 0 : 0.4,
            system,
            messages: [{ role: 'user', content: userPrompt }],
          },
          { signal: createTimeoutSignal(callTimeoutMs) },
        )
        .finalMessage();

      const rawText = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_PRESENTATION_TRUNCATED', detail: '評価が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        result = normalizeResult(JSON.parse(extractJson(rawText)));
        break;
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    if (!result) {
      return Response.json(
        { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
        { status: 502 },
      );
    }

    return Response.json({ result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career presentation evaluate API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '評価の生成に失敗しました。' },
      { status: 500 },
    );
  }
}

// 秒数の正規化（0〜3600 にクランプ。不正は 0）。
function clampSecond(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(3600, Math.round(n));
}
