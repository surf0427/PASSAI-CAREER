// PASSAI 就活版 — プレゼン対策AI theme route（AI即興テーマ生成・ステートレス）。
//
// 役割: プレゼンの種類とプロフィール等から、本番でありそうな発表テーマ（お題）を1つ生成して返す。
//   - 受験版 /api/presentation/theme の構造を踏襲しつつ、DB・課金・Supabase・usage 非接続。
//   - 大学受験のプレゼン入試テーマではなく、就活のプレゼン選考テーマを生成する。

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
  CareerPresentationType,
} from '@/types/careerPresentation';
import { anthropic } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import {
  CAREER_PRESENTATION_MODEL,
  buildPresentationSystemParts,
  buildThemeUserPrompt,
} from '../presentationPrompt';
import { resolvePresentationContextInputs } from '../resolveContextInputs';
// P0（HARDENING）: 認証 identity / rate limit / body サイズ上限の共通ガード。
import { guardPresentationRequest } from '../requestGuard';
// Company Data Spine A 層（公式情報）。企業未指定 / 未取得 / flag OFF なら null（お題生成は成立）。
import { resolvePresentationCompanyOfficial } from '../resolveCompanyOfficial';
// T1 trigger: 企業名が server まで来ている地点で prefetch を起動しておく（after() 登録のみ）。
import { triggerCompanyPrefetch } from '@/lib/careerCompanyPrefetch/trigger.server';

export const maxDuration = 80;

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('')
    .trim()
    // 念のため前後の引用符・コードフェンスを除去。
    .replace(/^```[a-zA-Z]*\n?|\n?```$/g, '')
    .replace(/^["「『]|["」』]$/g, '')
    .trim();
}

export async function POST(req: Request) {
  // P0（HARDENING）: identity 確定 → rate limit → body サイズ上限を **AI 到達前**に通す。
  //   guest は 401 にせず IP キーの厳しい上限へ回す（プレゼンは guest 利用を正式に許可する機能）。
  const guard = await guardPresentationRequest(req, 'theme');
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
    timeLimitSec?: unknown;
    difficulty?: unknown;
    excludeThemes?: unknown;
  };

  const config = b.config ?? null;
  const timeLimitSec = typeof b.timeLimitSec === 'number' ? b.timeLimitSec : 0;
  // 直近生成お題（連続生成で似すぎないようにする）。文字列配列のみ・最大5件。
  const excludeThemes = Array.isArray(b.excludeThemes)
    ? b.excludeThemes.filter((t): t is string => typeof t === 'string').slice(0, 5)
    : [];
  // Company Data Spine A 層（公式情報）。既存 read 経路を読むだけで fetch / crawl は起動しない。
  //   ★ context resolver と互いに独立なので **並列**に走らせる（応答時間を増やさない）。
  const companyOfficialPromise = resolvePresentationCompanyOfficial(config, b.presentationType);
  // 次回以降のために prefetch を起動しておく（応答時間に影響しない・失敗してもお題生成は続行）。
  triggerCompanyPrefetch(config?.companyName ?? '', req);

  // Closure Batch（`D-S9`）: base + cross-feature を kind 単位で server / bridge から選ぶ。
  const [companyOfficial, ctx] = await Promise.all([
    companyOfficialPromise,
    resolvePresentationContextInputs(b, req),
  ]);
  try {
    // ★ prompt builder も route の error boundary の内側で実行する。
    //   builder が throw すると（例: 壊れた Layer 1 データ）catch されず
    //   非 JSON 500 になり、client には汎用エラーしか見えなくなる。
    // user prompt 側の guard と system 側の block を **同一判定**にする（乖離させない）。
    //   判定は builder が orchestrator 出力から 1 度だけ行う（route は renderer を import しない）。
    const { system, hasCompanyOfficial } = buildPresentationSystemParts({
      profile: ctx.profile,
      activity: ctx.activity,
      values: ctx.values,
      selfAnalysis: ctx.selfAnalysis as typeof b.selfAnalysis,
      es: ctx.es as typeof b.es,
      interview: ctx.interview as typeof b.interview,
      matching: ctx.matching as typeof b.matching,
      consultationInsights: ctx.consultationInsights,
      config,
      presentationType: b.presentationType,
      companyOfficial,
    });

    const message = await anthropic.messages.create(
      {
        model: CAREER_PRESENTATION_MODEL,
        max_tokens: 300,
        temperature: 1,
        system,
        messages: [
          {
            role: 'user',
            content: buildThemeUserPrompt({
              config,
              timeLimitSec,
              difficulty: b.difficulty,
              excludeThemes,
              // A 層 block が system 側に出るときだけ、企業事実の扱いを公式情報の範囲へ開放する。
              hasCompanyOfficial,
            }),
          },
        ],
      },
      { signal: createTimeoutSignal() },
    );

    const theme = extractText(message.content as Array<{ type: string; text?: string }>);
    if (!theme) {
      return Response.json(
        { error: 'AI_PRESENTATION_EMPTY', detail: 'テーマの生成に失敗しました。' },
        { status: 502 },
      );
    }
    return Response.json({ theme });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career presentation theme API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: 'テーマの生成に失敗しました。' },
      { status: 500 },
    );
  }
}
