// PASSAI 就活版 — ES（エントリーシート）添削AI API
//
// 役割: /career/es/[id] エディタの「AI添削」から呼ばれ、就活 ES 回答 1 本を採点・添削して
//       JSON で返すだけ。ES本文はユーザーが書き、AIは添削のみ（本文・完成例は返さない）。
//
// 設計思想（受験版 app/api/essay-review を参考。ただしコードは流用せず就活ES専用に再設計）:
//   - スコアは AI に出させ、ランクは「スコアから決定論で」導出する（AI にランクを決めさせない）。
//   - overallScore も breakdown 6 軸の平均から決定論で導出し、AI の自己申告に依存しない。
//   - AI 出力は defensive に normalize し、余計な文章・JSON 崩れでも壊れないようにする。
//   - 事実を捏造させない（与えられた回答文の範囲だけで判断・書き直す）。
//
// 非接続方針（生成系と同一）:
//   - 課金 / quota・usage 記録・DB / Supabase / Stripe には接続しない。
//   - AI 呼び出し系の純粋ユーティリティ（@/lib/ai / @/lib/aiTimeout）のみ利用する。

import type {
  CareerEsReview,
  CareerEsReviewBreakdown,
  CareerEsRank,
  CareerEsSelectionType,
} from '@/types/careerEs';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import {
  normalizeCompanyResearchSnapshot,
  formatCompanyResearchContextForPrompt,
} from '@/lib/careerCompanyResearch/context';
// prompt は lib へ lift 済み（QA harness から byte 検証するため。route の挙動は不変）。
import {
  ES_REVIEW_SYSTEM_PROMPT,
  buildEsReviewUserMessage,
} from '@/lib/careerEs/reviewPrompt';
// User Data Spine: 既存 orchestrator（purpose=es_review）経由で base context を組む。
//   ★ ES 独自 normalizer は作らない。buildCareerAiContext が canonical boundary。
import { buildCareerAiContext } from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';
import { renderSelfAnalysis } from '@/lib/careerMemory/renderers/interviewCrossFeature';
import { resolveEsReviewContextInputs } from './resolveContextInputs';
// Data Spine Layer 2（Personal Memory）: 全 Career AI route 共有の解決 seam。
import { resolvePersonalMemoryForPurpose } from '../resolvePersonalMemoryContext';
// P0（HARDENING）: 認証 identity / rate limit / body・入力サイズ上限の共通ガード（ES 4 route 共有）。
import { guardEsRequest } from '../es/requestGuard';
import { enforceCareerDailyQuota } from '@/lib/careerQuota/enforce';
// Company Data Spine A 層（公式情報）。未取得 / flag OFF / 企業未解決なら null（添削は成立）。
import { resolveEsReviewCompanyOfficial } from './resolveCompanyOfficial';
// T1 trigger: 企業名が server まで来ている地点で prefetch を起動しておく（after() 登録のみ）。
import { triggerCompanyPrefetch } from '@/lib/careerCompanyPrefetch/trigger.server';
import { anthropic, extractJson } from '@/lib/ai';
import {
  AI_BUDGET_PRESET_80S_WALL,
  createAiCallBudget,
  createTimeoutSignal,
} from '@/lib/aiTimeout';

// 機能キー（就活版共通基盤の出し分け）。
const FEATURE_KEY = 'career-es' as const;

// 生成系と同系の Sonnet を使用（課金/usage には接続しない）。
const MODEL = 'claude-sonnet-4-6';

// Vercel 実行時間上限。AI timeout（60s）+ 余裕。runtime は既定 nodejs。
export const maxDuration = 80;

// 6軸スコア + 各種コメント（良かった点/改善点/不足要素/採用担当視点/優先改善）を収める。
const MAX_TOKENS = 3000;

// 6 軸の固定キー（AI 出力の照合・normalize に使う）。
const BREAKDOWN_KEYS = [
  'logic',
  'specificity',
  'originality',
  'readability',
  'persuasion',
  'companyFit',
] as const;

// ── 小さなヘルパー ───────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 0〜100 の整数へ丸める（範囲外・非数は 0）。
function clampScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function strArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => str(v))
    .filter((v) => v !== '')
    .slice(0, max);
}

// スコアからランクを決定論で導出する（AI には決めさせない）。
function deriveRank(score: number): CareerEsRank {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}

// AI 出力（パース済み unknown）を CareerEsReview 形状に正規化する。
// overallScore / rank は AI の値を使わず、breakdown から決定論で再計算する。
function normalizeReview(raw: unknown): CareerEsReview {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawBreakdown =
    r.breakdown && typeof r.breakdown === 'object'
      ? (r.breakdown as Record<string, unknown>)
      : {};

  const breakdown = BREAKDOWN_KEYS.reduce((acc, key) => {
    acc[key] = clampScore(rawBreakdown[key]);
    return acc;
  }, {} as CareerEsReviewBreakdown);

  // overallScore は 6 軸の平均（決定論）。AI の自己申告 overallScore は採用しない。
  const sum = BREAKDOWN_KEYS.reduce((acc, key) => acc + breakdown[key], 0);
  const overallScore = Math.round(sum / BREAKDOWN_KEYS.length);

  return {
    overallScore,
    rank: deriveRank(overallScore),
    overallComment: str(r.overallComment),
    breakdown,
    strengths: strArray(r.strengths, 5),
    improvements: strArray(r.improvements, 5),
    missingElements: strArray(r.missingElements, 5),
    recruiterComments: strArray(r.recruiterComments, 5),
    priorityActions: strArray(r.priorityActions, 5),
  };
}

export async function POST(req: Request) {
  // P0（HARDENING）: identity 確定 → rate limit → body / 入力サイズ上限を **AI 到達前**に通す。
  //   添削は 1 ES につき「初回 + もう一度添削 + 改善版」の複数回が正常系。
  //   ★ answer はこれまで完全に無制限だった（Audit P0）。guard 側で 8,000 字上限を掛ける。
  const guard = await guardEsRequest(req, 'review');
  if (!guard.ok) return guard.response;
  const body: unknown = guard.body;

  const b = (body && typeof body === 'object' ? body : {}) as {
    answer?: string;
    question?: string;
    companyName?: string;
    // Company Data Spine 解決の hint（権威ではない。server 側が canonical company を決める）。
    companyId?: string;
    charLimit?: number;
    selectionType?: unknown;
    industry?: string;
    jobType?: string;
    companyResearchContext?: unknown;
    // User Data Spine bridge（未指定なら従来どおり ES 設定のみで添削する）。
    profile?: CareerProfileInput | null;
    activity?: CareerActivityInput | null;
    values?: CareerValuesInput | null;
    selfAnalysis?: CareerSelfAnalysisResult | null;
  };

  const answer = str(b.answer);
  const question = str(b.question);
  const companyName = str(b.companyName);
  const companyId = str(b.companyId);
  const charLimit =
    typeof b.charLimit === 'number' && Number.isFinite(b.charLimit) && b.charLimit > 0
      ? Math.floor(b.charLimit)
      : null;
  // 応募メタ（添削時の企業適合性・整合性評価の文脈に使う）。
  // 新規作成では必須だが、旧ログ（旧「指定なし」= 欠損）からの再添削もあるため未指定を許容する。
  const selectionType: CareerEsSelectionType | null =
    b.selectionType === 'main' || b.selectionType === 'internship'
      ? b.selectionType
      : null;
  const industry = str(b.industry);
  const jobType = str(b.jobType);
  // 保存済み企業研究（任意・1 件）。あれば回答との整合性評価に使う。
  const researchSnapshot = normalizeCompanyResearchSnapshot(b.companyResearchContext);
  const researchBlock = researchSnapshot
    ? formatCompanyResearchContextForPrompt([researchSnapshot])
    : '';

  // 添削対象が無ければ弾く。
  if (answer === '') {
    return Response.json(
      { error: '添削する本文がありません。' },
      { status: 400 },
    );
  }

  // 日次利用回数（PASSAI Career BASIC / ES = 1 本 1 回）。
  //   ★ anchor は添削だけ。同一 ES ワークフローの materials / deep×N / organize は
  //     内部 call なので消費しない（ES 1 本 ＝ 最大 10 AI call でも利用回数は 1）。
  //   ★ ユーザーが明示的に行う「再添削 / 改善版の添削」は本文が変わるため別 operation ＝
  //     ES bucket の +1（商品仕様どおり新規作成と再添削を合わせて 10 回/日）。
  //   ★ 同一本文の再送（retry / 二重送信）は operation dedupe で +0。
  //   ★ 必須入力の検証**後** / AI 到達**前**に置く。
  const quotaBlocked = await enforceCareerDailyQuota({
    identity: guard.identity,
    feature: 'es',
    operationSource: body,
  });
  if (quotaBlocked) return quotaBlocked;

  // 保存済み企業研究を使う場合の評価指示（断定を避けた添削者の文体を維持）。
  const researchInstruction = researchBlock
    ? [
        '# 保存済みの企業研究（ユーザー本人が作成・確認したもの）',
        researchBlock,
        '',
        'この企業研究はユーザー自身が確認・保存した一次情報です。添削では次も評価してください:',
        '- 企業研究で注目している点が、回答（特に志望動機）に活かされているか（企業理解の深さ・志望動機の具体性）。',
        '- 企業研究ログで「不足・根拠不足」と指摘された点（競合比較など）が放置されていないか。',
        '- 自己分析 / 活動整理 / 就活軸との接続が取れているか。',
        'コメントは「あなたの企業研究メモを見る限り」「保存済み企業研究によると」という文体にし、',
        '企業情報を断定せず、根拠不足は公式情報・説明会資料での再確認を促してください。',
      ].join('\n')
    : '';

  // T1 trigger: 企業名は既に server へ来ている。次回以降のために prefetch を起動しておく
  //   （after() 登録のみ・本 request の応答時間に影響しない・失敗しても添削は続行）。
  //   同一企業への重複 trigger は company-scoped idempotency が畳む。
  triggerCompanyPrefetch(companyName, req);

  // ── Data Spine の 2 read（互いに独立なので **並列**に走らせる）────────────
  //   Company Data Spine（A 層 = 公式情報）:
  //     flag OFF / DDL 未適用 / 未ログイン / 企業未解決では data を持たない status が返り、
  //     renderer が '' を返す（＝ 従来 prompt と byte 互換・fail-open）。
  //   User Data Spine:
  //     server context canary が無効な環境（既定）では I/O ゼロで request body をそのまま使う。
  //   ★ どちらも never-throw なので Promise.all が reject する経路は無い。
  const [companyOfficial, ctx] = await Promise.all([
    resolveEsReviewCompanyOfficial(companyName, companyId || null),
    resolveEsReviewContextInputs(b, req),
  ]);
  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile: ctx.profile,
    activity: ctx.activity,
    values: ctx.values,
    userInput: '',
  });
  // 直近の自己分析（canonical renderer を再利用。ES 専用 renderer は作らない）。
  const selfAnalysisBlock = renderSelfAnalysis(ctx.selfAnalysis);

  // Data Spine Layer 2（Personal Memory）。es_review allowlist は self_analysis / es。
  //   - self_analysis: 上の block を実際に描画するときは重複するので落とす（bridge wins）。
  //   - es           : ES 添削 prompt は過去 ES の設問メタを描画しないので常に gap（＝Memory が埋める）。
  //     `EsLongTerm.companies` は「志望動機の企業固有性チェック用」に設計された field で、
  //     使い回し志望動機の検出という添削観点に直結する。
  //   gate OFF / 未認証 / veto では空配列 ＝ 従来 prompt と byte 互換（never-throw）。
  //   ★ 観測の context outcome は resolveEsReviewContextInputs が既に 1 件打っているため null。
  const personalMemory = await resolvePersonalMemoryForPurpose({
    purpose: 'es_review',
    presence: { self_analysis: selfAnalysisBlock !== '' },
    req,
    contextOutcome: null,
  });

  // P3-F: base system prompt / 公式情報 block を Context Orchestrator（purpose=es_review）経由で取得。
  //   ★ orchestrator は純関数。I/O（上の read）は route の責務という既存分離を守る。
  const orchestrated = buildCareerContextForPurpose('es_review', context, {
    ...(companyOfficial ? { company: companyOfficial } : {}),
    ...(personalMemory.length > 0 ? { personalMemory } : {}),
  });

  // system: 添削者ペルソナ（静的）→ 本人の土台（profile/activity/values）→ 公式情報 → 自己分析。
  //   ★ 公式事実（A 層）/ 本人の自己分析 / 本人の企業研究メモ（user メッセージ側）を
  //     **別ブロック**に保つ。混ぜないことが Data Spine の中核契約。
  //   すべて空なら join 後は ES_REVIEW_SYSTEM_PROMPT 単体＝従来と byte 一致。
  const systemPrompt = [
    ES_REVIEW_SYSTEM_PROMPT,
    orchestrated.systemPrompt,
    orchestrated.companyOfficialContext,
    selfAnalysisBlock ? `# 直近の自己分析結果（本人の内省。ES 本文の裏付けとして使う）\n${selfAnalysisBlock}` : '',
    // Data Spine Layer 2（Personal Memory）。★ 公式情報 / 自己分析 block とは **別ブロック**の
    //   低優先な参考情報として 1 回だけ結合する。section が無ければ '' ＝ 従来 byte 互換。
    orchestrated.personalMemoryContext,
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  // user メッセージ: ES 設定（設問 / 文字数 / 企業名 / 業界 / 職種 / 選考種別）を
  // 提出先コンテキスト + 添削基準として積み、最後に添削対象本文を置く。
  // 欠損項目（旧ログ）はブロックごと出さない（AI に埋めさせない）。
  const userMessage = buildEsReviewUserMessage({
    answer,
    question,
    charLimit,
    companyName,
    industry,
    jobType,
    selectionType,
    researchInstruction,
    // A 層 block が実際に出るときだけ、事実として言及してよい範囲を公式情報へ限定する。
    hasCompanyOfficial: orchestrated.companyOfficialContext !== '',
  });

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する（生成系と同方針）。
    let review: CareerEsReview | null = null;
    // AI 合計時間予算（wall 80s の内側に固定）。retry ごとに満額 signal を再発行すると
    // 合計が wall を超えて 504（非JSON）になり、client には汎用エラーしか見えなくなる。
    const aiBudget = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const callTimeoutMs = aiBudget.nextCallTimeoutMs();
      // 残予算が retry に足りない → retry せず打ち切る（wall 超過による 504 を防ぐ）。
      if (callTimeoutMs === null) {
        return Response.json(
          {
            error: 'AI_ES_REVIEW_PARSE_FAILED',
            detail: 'AI応答をJSONとして解釈できませんでした。',
          },
          { status: 502 },
        );
      }
      const message = await anthropic.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: attempt === 2 ? 0 : 0.4,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      // max_tokens 到達の途中切れは長さ起因なので retry せず明示エラーで返す。
      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_ES_REVIEW_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        review = normalizeReview(JSON.parse(extractJson(raw)));
        break;
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          {
            error: 'AI_ES_REVIEW_PARSE_FAILED',
            detail: 'AI応答をJSONとして解釈できませんでした。',
          },
          { status: 502 },
        );
      }
    }

    if (!review) {
      return Response.json(
        {
          error: 'AI_ES_REVIEW_PARSE_FAILED',
          detail: 'AI応答をJSONとして解釈できませんでした。',
        },
        { status: 502 },
      );
    }

    return Response.json({ review });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career ES review API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: 'ESの添削に失敗しました。' },
      { status: 500 },
    );
  }
}
