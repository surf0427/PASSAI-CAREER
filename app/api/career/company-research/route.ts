// PASSAI 就活版 — 企業研究 添削AI API
//
// 役割: /career/company-research/do から呼ばれ、ユーザーが確認・修正した企業研究テキスト
//       （verifiedResearchText）を添削する。AI は企業情報の「生成者」ではなく「添削者（家庭教師）」。
//   - 企業情報の正解を断定しない。「あなたの記述を見る限り」「根拠が不足しています」
//     「公式情報や説明会資料で再確認してください」という文体に徹する。
//   - 添削対象はアップロードファイルそのものではなく、必ず人が確認した verifiedResearchText。
//   - スコアは AI に出させ、overallScore / rank は breakdown から決定論で導出する。
//   - 本人情報（自己分析・就活軸・活動整理・マッチング）とのすり合わせ（fitAnalysis）と、
//     面接機能へ渡す要約（interviewContextSummary）も返す。
//
// 非接続方針（他 career API と同一）:
//   - 課金 / quota・usage 記録・DB / Supabase / Stripe には接続しない。
//   - プロンプトは就活版共通基盤（@/lib/careerAi）経由（featureKey=career-company-research）。

import { buildCareerAiContext } from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import type {
  CareerCompanyResearchReview,
  CareerCompanyResearchBreakdown,
  CareerCompanyResearchFitAnalysis,
  CareerCompanyResearchRank,
  CareerCompanyInterestLevel,
} from '@/types/careerCompanyResearch';
import { CAREER_COMPANY_INTEREST_LABELS } from '@/types/careerCompanyResearch';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
// P17-M1: Personal Memory（Layer 2）を owner-scoped で server read（flag OFF/gate deny では I/O ゼロ・fail-open）。
import { loadPersonalMemorySectionsForPrompt } from '@/lib/careerMemory/persistence/personalMemoryReadServer.server';
// D-R2: client canonical revision（header 由来・veto 専用）。未提示なら Memory は使われない。
import { readSourceSyncSignal } from '@/lib/careerSourceSync/request.server';
// Batch 1: base context の server 化 + Personal Memory と bridge の重複注入防止。
import { resolveCompanyResearchContextInputs } from './resolveContextInputs';
import { dedupePersonalMemorySections } from '@/lib/careerMemory/personalMemoryDedupe';
// Canary observability（enum + 件数のみ）。
import {
  normalizeContextOutcome,
  normalizeMemoryOutcome,
  normalizeSyncOutcome,
} from '@/lib/careerDataSpineCanary/observation';
import { recordCanaryObservation } from '@/lib/careerDataSpineCanary/counters.server';

const FEATURE_KEY = 'career-company-research' as const;
const MODEL = 'claude-sonnet-4-6';
export const maxDuration = 80;

const MAX_TOKENS = 3000;

const BREAKDOWN_KEYS = [
  'companyUnderstanding',
  'industryUnderstanding',
  'competitorUnderstanding',
  'evidenceQuality',
  'depthOfThought',
  'motivationConnection',
] as const;

// ── 小さなヘルパー ───────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

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

function deriveRank(score: number): CareerCompanyResearchRank {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}

function interestLabel(value: unknown): string {
  return value === 'high' || value === 'mid' || value === 'low' || value === 'watch'
    ? CAREER_COMPANY_INTEREST_LABELS[value as CareerCompanyInterestLevel]
    : '';
}

function normalizeReview(raw: unknown): CareerCompanyResearchReview {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawBreakdown =
    r.breakdown && typeof r.breakdown === 'object'
      ? (r.breakdown as Record<string, unknown>)
      : {};

  const breakdown = BREAKDOWN_KEYS.reduce((acc, key) => {
    acc[key] = clampScore(rawBreakdown[key]);
    return acc;
  }, {} as CareerCompanyResearchBreakdown);

  const sum = BREAKDOWN_KEYS.reduce((acc, key) => acc + breakdown[key], 0);
  const overallScore = Math.round(sum / BREAKDOWN_KEYS.length);

  return {
    overallScore,
    rank: deriveRank(overallScore),
    overallComment: str(r.overallComment),
    breakdown,
    goodPoints: strArray(r.goodPoints, 6),
    missingInfo: strArray(r.missingInfo, 8),
    weakAssumptions: strArray(r.weakAssumptions, 6),
    nextResearchActions: strArray(r.nextResearchActions, 8),
  };
}

function normalizeFitAnalysis(raw: unknown): CareerCompanyResearchFitAnalysis {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    selfAnalysisFit: str(r.selfAnalysisFit),
    valuesFit: str(r.valuesFit),
    activityFit: str(r.activityFit),
    matchingFit: str(r.matchingFit),
    gaps: strArray(r.gaps, 6),
    strengthsToUse: strArray(r.strengthsToUse, 6),
  };
}

// ── 横断コンテキストの可読化（fitAnalysis のすり合わせ材料） ──────────

function renderSelfAnalysis(r: CareerSelfAnalysisResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.summary)) lines.push(`- 全体所感: ${str(r.summary)}`);
  if (str(r.careerDirection)) lines.push(`- キャリアの方向性: ${str(r.careerDirection)}`);
  if (r.strengths?.length) lines.push(`- 強み: ${r.strengths.join('、')}`);
  if (r.weaknesses?.length) lines.push(`- 弱み: ${r.weaknesses.join('、')}`);
  if (r.valueKeywords?.length) lines.push(`- 価値観キーワード: ${r.valueKeywords.join('、')}`);
  if (r.recommendedIndustries?.length)
    lines.push(`- 向いている業界: ${r.recommendedIndustries.join('、')}`);
  if (r.companySelectionCriteria?.length)
    lines.push(`- 企業選びの条件: ${r.companySelectionCriteria.join('、')}`);
  return lines.join('\n');
}

function renderMatching(r: CareerMatchEngineResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.careerType)) lines.push(`- キャリアタイプ: ${str(r.careerType)}`);
  if (str(r.profileSummary)) lines.push(`- プロフィール要約: ${str(r.profileSummary)}`);
  if (r.recommendedIndustries?.length)
    lines.push(`- 推奨業界: ${r.recommendedIndustries.join('、')}`);
  if (r.recommendedJobs?.length) lines.push(`- 推奨職種: ${r.recommendedJobs.join('、')}`);
  if (r.developmentAreas?.length)
    lines.push(`- 伸ばすべき点: ${r.developmentAreas.join('、')}`);
  return lines.join('\n');
}

// ── 添削者ペルソナ（共通基盤の上に重ねる） ───────────────────────────

const RESEARCHER_PERSONA = [
  'あなたは新卒就活の「企業研究」を指導する家庭教師です。',
  'あなたの役割は企業情報を生成することではなく、学生が自分で行った企業研究メモを添削することです。',
  '',
  '【最重要の振る舞い】',
  '- あなたは企業分析の生成者ではなく、添削者です。「この企業は〜です」と事実を断定しないでください。',
  '- 企業の事業内容・財務・待遇・選考フロー・競合関係などの事実を、あなたの知識で断定・補完しないでください。',
  '  代わりに次のような文体で、本人が自分で確認・深掘りできるように導いてください:',
  '  「あなたの記述を見る限り〜」「根拠が不足しています」「公式情報や説明会資料で再確認してください」',
  '  「この点は追加調査すると志望理由に使いやすくなります」「あなたの就活軸との間にギャップがある可能性があります」',
  '- あなたが企業情報を埋めてしまうと、本人の調べる力が育たず、情報ミスのリスクも生みます。それは避けてください。',
  '- 評価は「本人の研究メモの質（調べ方・考察・根拠・接続）」に対して行い、企業そのものの優劣は判定しません。',
  '- 与えられたテキストは、ユーザーがアップロード資料やメモから確認・修正したものです。OCR 由来の誤りが残る',
  '  可能性があるので、明らかに不自然な記述は「転記ミスの可能性があるので原典で確認してください」と添えてください。',
  '',
  '【評価する観点（6 軸・各 0〜100 の整数）】',
  '- companyUnderstanding: 企業理解度（事業・強み・らしさを自分の言葉で捉えられているか）',
  '- industryUnderstanding: 業界理解度（業界構造・トレンドの把握）',
  '- competitorUnderstanding: 競合理解度（他社との違い・立ち位置を説明できているか）',
  '- evidenceQuality: 根拠の質（情報源が示され、事実と推測が区別されているか）',
  '- depthOfThought: 考察の深さ（事実の列挙で終わらず、自分なりの解釈に踏み込めているか）',
  '- motivationConnection: 志望理由への接続度（研究が志望動機・自分の強みに繋がっているか）',
  '',
  '【すり合わせ（fitAnalysis）】',
  '与えられた本人情報（自己分析・就活軸・活動整理・マッチング結果）と、この企業研究を照らし合わせます。',
  '- selfAnalysisFit / valuesFit / activityFit / matchingFit: それぞれの情報との整合を 1〜3 文で述べる。',
  '  対象情報が与えられていない／不足している場合は、無理に断定せず「情報が不足している」と述べてください。',
  '- gaps: 本人情報と研究内容のギャップ・確認すべき点（配列）。',
  '- strengthsToUse: この企業で活かせる本人の強み（配列）。',
  '',
  '【面接連携要約（interviewContextSummary）】',
  '後で面接練習機能に渡すための短い要約（3〜5文程度）を作ってください。',
  'この企業に対して本人が語れる志望の核・接点・まだ弱い論点を、面接官AIが文脈として使える形でまとめます。',
  '研究メモに無い事実を足さないでください。',
  '',
  '【スコアのルール】',
  '- 6 軸の breakdown を必ず埋めてください。総合点・ランクは書かなくてよい（スコアから自動で決まります）。',
  '- 記述が空・薄い観点は低めに採点し、何を書けば上がるかを missingInfo / nextResearchActions で具体的に示します。',
].join('\n');

const OUTPUT_FORMAT_INSTRUCTION = [
  '# 出力形式（厳守）',
  '出力は次の JSON オブジェクトのみとし、前後に説明文・コードブロック記号（```）を一切付けないでください。',
  '出力の 1 文字目が { 、最後の文字が } であること。配列は該当が無ければ空配列 [] にする（キーは省略しない）。',
  'すべてのコメント・指摘は、断定を避けた添削者の文体（です・ます調）で日本語で書いてください。',
  '',
  '{',
  '  "review": {',
  '    "overallComment": string,            // 総評（2〜3文。断定を避けた添削者の所感）',
  '    "breakdown": {',
  '      "companyUnderstanding": number,    // 0〜100',
  '      "industryUnderstanding": number,   // 0〜100',
  '      "competitorUnderstanding": number, // 0〜100',
  '      "evidenceQuality": number,         // 0〜100',
  '      "depthOfThought": number,          // 0〜100',
  '      "motivationConnection": number     // 0〜100',
  '    },',
  '    "goodPoints": string[],              // よく調べられている/考察が良い点（最大6件）',
  '    "missingInfo": string[],             // 不足している情報・調べきれていない観点（最大8件）',
  '    "weakAssumptions": string[],         // 思い込み・根拠不足・断定しすぎの指摘（最大6件）',
  '    "nextResearchActions": string[]      // 次に調べるべき具体的アクション（最大8件）',
  '  },',
  '  "fitAnalysis": {',
  '    "selfAnalysisFit": string,           // 自己分析との整合（1〜3文。無ければ不足と述べる）',
  '    "valuesFit": string,                 // 就活軸との整合（1〜3文）',
  '    "activityFit": string,               // 活動・経験との整合（1〜3文）',
  '    "matchingFit": string,               // 企業マッチング結果との整合（1〜3文）',
  '    "gaps": string[],                    // 本人情報とのギャップ・確認すべき点（最大6件）',
  '    "strengthsToUse": string[]           // この企業で活かせる本人の強み（最大6件）',
  '  },',
  '  "interviewContextSummary": string      // 面接機能へ渡す文脈要約（3〜5文）',
  '}',
].join('\n');

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'リクエストボディが不正です。' }, { status: 400 });
  }

  const b = (body && typeof body === 'object' ? body : {}) as {
    companyName?: string;
    industry?: string;
    interestLevel?: unknown;
    verifiedResearchText?: string;
    sources?: string;
    profile?: CareerProfileInput | null;
    activity?: CareerActivityInput | null;
    values?: CareerValuesInput | null;
    selfAnalysis?: CareerSelfAnalysisResult | null;
    matching?: CareerMatchEngineResult | null;
  };

  const companyName = str(b.companyName);
  if (companyName === '') {
    return Response.json({ error: '企業名を入力してください。' }, { status: 400 });
  }

  // 添削対象は「ユーザーが確認・修正したテキスト」のみ。
  const verifiedResearchText = str(b.verifiedResearchText);
  if (verifiedResearchText === '') {
    return Response.json(
      { error: '確認済みの企業研究テキストを入力してください。' },
      { status: 400 },
    );
  }

  const industry = str(b.industry);
  const interest = interestLabel(b.interestLevel);
  const sources = str(b.sources);

  // Batch 2（`D-S6`）: base に加えて selfAnalysis / matching も kind 単位で server / bridge を選ぶ。
  //   これで本 route の request-body bridge は **すべて** server 化候補になった。
  const ctx = await resolveCompanyResearchContextInputs(b, req);
  // 就活版共通基盤でプロフィール+活動+就活軸の土台を組む。
  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile: ctx.profile,
    activity: ctx.activity,
    values: ctx.values,
    userInput: '',
  });
  // P17-M1: Personal Memory を server read（base / self_analysis のみ）。企業の客観情報は歪めず、
  //   「そのユーザーにとって注目すべき観点」の調整にだけ使う（renderer が injection 境界を付ける）。
  //   flag OFF / gate deny / 未認証 では I/O ゼロで空配列。read 失敗も従来 prompt へ fail-open。
  const syncSignal = readSourceSyncSignal(req);
  // ★ `D-S13`: 第 4 引数の `req` により、上の resolver が既に読んだ kind は再 read されない
  //   （1 request / 1 Layer 1 snapshot）。
  const memoryOutcome = await loadPersonalMemorySectionsForPrompt(
    'company_research_review',
    syncSignal,
    undefined,
    req,
  );
  recordCanaryObservation({
    purpose: 'company_research_review',
    sync: normalizeSyncOutcome(memoryOutcome.meta, Object.keys(syncSignal.revisions).length > 0),
    memory: normalizeMemoryOutcome(memoryOutcome.meta),
    context: normalizeContextOutcome(ctx.source),
    memorySectionCount: memoryOutcome.meta.sectionCount,
    // Batch 2: source kind 別の観測を **同じ 1 件**へ合流させる（二重計上しない）。
    sourceOrigins: ctx.observation.sourceOrigins,
    sourceVerdicts: ctx.observation.sourceVerdicts,
    coverage: ctx.observation.coverage,
  });
  // ↑ memory 観測は read 時点の値。重複除去後の実注入数は下の dedupe で決まる。
  const selfAnalysisBlock = renderSelfAnalysis(ctx.selfAnalysis);
  const matchingBlock = renderMatching(ctx.matching);

  // ★ Batch 1（D-S5）: bridge と重複する Personal Memory section を落とす。
  //   base       : base system prompt が profile/activity/values を必ず描画するため常に重複。
  //   self_analysis: 自己分析 block を実際に描画するときだけ重複（空なら memory で埋めてよい）。
  //   「bridge wins / memory fills gaps」= prompt は増える方向にしか変わらない。
  const dedupe = dedupePersonalMemorySections(memoryOutcome.sections, {
    base: true,
    self_analysis: selfAnalysisBlock !== '',
  });
  const personalMemory = dedupe.sections;
  // P3-C: base system prompt を Context Orchestrator（purpose=company_research_review）経由で取得する。
  //   委譲のため出力は現行と同一。添削対象の verifiedResearchText 等は user メッセージ側で不変。
  const orchestrated = buildCareerContextForPurpose('company_research_review', context, {
    personalMemory,
  });

  const systemPrompt = [
    RESEARCHER_PERSONA,
    // P3-C: 同一 system 内の feature instruction 二重 append を削除（純粋な重複除去）。
    orchestrated.systemPrompt,
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    matchingBlock ? `# 直近の企業マッチング結果\n${matchingBlock}` : '',
    // P17-M1: Personal Memory 参考 block（低優先・ユーザー由来の参考情報）。空なら filter で除去＝従来互換。
    orchestrated.personalMemoryContext,
    OUTPUT_FORMAT_INSTRUCTION,
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  const userMessage = [
    '# 添削対象：ユーザーが確認・修正した企業研究テキスト',
    `■ 企業名: ${companyName}`,
    industry ? `■ 業界: ${industry}` : '',
    interest ? `■ 志望度: ${interest}` : '',
    sources ? `■ 参考にした情報源: ${sources}` : '',
    '',
    '── 企業研究テキスト ──',
    verifiedResearchText,
    '',
    '上記の企業研究テキストを、指定の JSON 形式で添削してください。',
    '企業情報の事実を断定・補完せず、本人が自分で確認・深掘りできるように導いてください。',
  ]
    .filter((s) => s !== '')
    .join('\n');

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する（他 career API と同方針）。
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: attempt === 2 ? 0 : 0.4,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: createTimeoutSignal() },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_COMPANY_RESEARCH_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        const parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
        const review = normalizeReview(parsed.review);
        const fitAnalysis = normalizeFitAnalysis(parsed.fitAnalysis);
        const interviewContextSummary = str(parsed.interviewContextSummary);
        return Response.json({ review, fitAnalysis, interviewContextSummary });
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          {
            error: 'AI_COMPANY_RESEARCH_PARSE_FAILED',
            detail: 'AI応答をJSONとして解釈できませんでした。',
          },
          { status: 502 },
        );
      }
    }

    return Response.json(
      {
        error: 'AI_COMPANY_RESEARCH_PARSE_FAILED',
        detail: 'AI応答をJSONとして解釈できませんでした。',
      },
      { status: 502 },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career company-research API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '企業研究の添削に失敗しました。' },
      { status: 500 },
    );
  }
}
