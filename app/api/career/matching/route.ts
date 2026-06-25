// PASSAI 就活版 — 企業マッチングAI API（最小・ステートレス）
//
// 就活版独自のコア機能。受験版のコピーではない。
//   - プロフィール・活動・自己分析・ES・面接・相談の結果を統合し、企業との相性をスコアリングする。
//   - 「おすすめ企業」ではなく「企業マッチング」: 企業名の羅列ではなく「なぜ向いているのか」を可視化する。
//   - 課金 / quota / usage / DB / Supabase / Stripe には一切接続しない（localStorage のみ）。
//   - プロンプトは就活版共通基盤（@/lib/careerAi）経由（featureKey=career-company-matching）。
//   - Web 検索は常時実装しない。実在しない企業の生成・年収/福利厚生の断定は禁止。

import {
  buildCareerAiContext,
  buildCareerSystemPrompt,
  buildCareerFeatureInstruction,
} from '@/lib/careerAi';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerInterviewFinalResult } from '@/types/careerInterview';
import type { CareerConsultationResult } from '@/types/careerConsultation';
import type { CareerMatchingResult, CareerCompanyMatch } from '@/types/careerMatching';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';

const FEATURE_KEY = 'career-company-matching' as const;
const MODEL = 'claude-sonnet-4-6';
export const maxDuration = 80;

const MAX_COMPANIES = 5;

// マッチングアナリストとしての役割・評価軸・企業選定ルール（共通基盤の上に重ねる）。
const MATCHING_PERSONA = [
  'あなたは新卒就活専門のキャリアアドバイザー兼マッチングアナリストです。',
  'プロフィール・活動・自己分析・ES・面接・相談の結果を統合し、本人と企業の「相性」を分析します。',
  '',
  '【最重要】これは「おすすめ企業の羅列」ではなく「企業マッチング」です。',
  '企業名を挙げるだけでなく、「なぜ向いているのか」を必ず根拠とともに可視化してください。',
  '',
  '【評価軸（相性の分析にこれらの観点を用いる）】',
  '価値観 / 強み / 働き方 / 興味 / スキル / コミュニケーション傾向 / 成長志向 / 裁量権志向 /',
  'チーム志向 / 国際志向 / 安定志向 / 挑戦志向。',
  '',
  '【企業選定ルール】',
  `- 提案は最大 ${MAX_COMPANIES} 社。日本国内の企業を中心とする。`,
  '- 実在する企業のみを挙げる。実在しない企業・架空の企業名は絶対に生成しない。',
  '- 大手のみ / ベンチャーのみに偏らせない。規模をバランスよく混ぜる。',
  '- 業界を分散させる（同一業界に偏らせない）。',
  '- 根拠が弱い企業は company 名に「（候補）」を付けて明示する。',
  '',
  '【禁止・注意】',
  '- 年収・給与・福利厚生などの待遇は断定しない（必要なら公式情報での確認を促す）。',
  '- 事業内容・選考フロー等、事実確認が必要な情報は断定しない。',
  '- 各社について matchReasons（マッチ理由）を必ず 1 つ以上提示する（理由の無い企業は出さない）。',
].join('\n');

// 出力 JSON スキーマの指示。
const OUTPUT_FORMAT_INSTRUCTION = [
  '# 出力形式（厳守）',
  '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
  '各フィールドは日本語。配列は該当が無ければ空配列 [] にする（キーは省略しない）。',
  'score は 0〜100 の数値（相性の高さ）。companyMatches は最大 5 件。',
  '',
  '{',
  '  "profileSummary": string,        // 本人の総括（マッチングの前提）',
  '  "careerType": string,            // タイプ分類（例: 裁量重視の挑戦型）',
  '  "recommendedIndustries": string[], // 向いている業界（分散させる）',
  '  "recommendedJobs": string[],     // 向いている職種',
  '  "companyMatches": [',
  '    {',
  '      "company": string,           // 実在する日本国内企業（弱い根拠なら「（候補）」を付す）',
  '      "score": number,             // 0〜100',
  '      "matchReasons": string[],    // なぜ向いているのか（必須・1つ以上）',
  '      "strengthsUsed": string[],   // この企業で活きる本人の強み',
  '      "attentionPoints": string[], // 見極めるべき留意点（待遇は断定しない）',
  '      "nextActions": string[]      // この企業に向けた次の具体アクション',
  '    }',
  '  ],',
  '  "developmentAreas": string[],    // 伸ばすべき領域',
  '  "nextSteps": string[]            // 全体としての次の一歩',
  '}',
].join('\n');

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
  return Math.min(100, Math.max(0, Math.round(n)));
}

// ── 統合コンテキストの整形（各機能の最新結果を可読テキストに） ──
function renderSelfAnalysis(r: CareerSelfAnalysisResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.summary)) lines.push(`- 全体所感: ${str(r.summary)}`);
  // v2 構造化フィールド（旧ログには無いので ?. で防御）。マッチングの相性根拠に直結するため優先反映。
  if (str(r.careerDirection)) lines.push(`- キャリアの方向性: ${str(r.careerDirection)}`);
  if (r.strengths?.length) lines.push(`- 強み: ${r.strengths.join('、')}`);
  if (r.strengthKeywords?.length) lines.push(`- 強みキーワード: ${r.strengthKeywords.join('、')}`);
  if (r.valueKeywords?.length) lines.push(`- 価値観キーワード: ${r.valueKeywords.join('、')}`);
  if (r.weaknesses?.length) lines.push(`- 弱み: ${r.weaknesses.join('、')}`);
  if (r.recommendedIndustries?.length) lines.push(`- 向いている業界: ${r.recommendedIndustries.join('、')}`);
  if (r.recommendedJobs?.length) lines.push(`- 向いている職種: ${r.recommendedJobs.join('、')}`);
  if (r.suitableEnvironment?.length) lines.push(`- 向いている環境: ${r.suitableEnvironment.join('、')}`);
  if (r.companySelectionCriteria?.length) lines.push(`- 企業選びの条件: ${r.companySelectionCriteria.join('、')}`);
  if (r.gakuchikaIdeas?.length) lines.push(`- ガクチカ候補: ${r.gakuchikaIdeas.join('、')}`);
  return lines.join('\n');
}

function renderEs(r: CareerEsResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.headline)) lines.push(`- キャッチコピー: ${str(r.headline)}`);
  if (str(r.selfPr)) lines.push(`- 自己PR: ${str(r.selfPr)}`);
  if (str(r.motivation)) lines.push(`- 志望動機: ${str(r.motivation)}`);
  return lines.join('\n');
}

function renderInterview(r: CareerInterviewFinalResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.overallComment)) lines.push(`- 総合評価: ${str(r.overallComment)}`);
  if (r.strengths?.length) lines.push(`- 良かった点: ${r.strengths.join('、')}`);
  if (r.improvements?.length) lines.push(`- 改善点: ${r.improvements.join('、')}`);
  return lines.join('\n');
}

function renderConsultation(r: CareerConsultationResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.answer)) lines.push(`- 直近の相談要点: ${str(r.answer)}`);
  if (r.keyInsights?.length) lines.push(`- ポイント: ${r.keyInsights.join('、')}`);
  return lines.join('\n');
}

function normalizeCompany(raw: unknown): CareerCompanyMatch {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    company: str(c.company),
    score: clampScore(c.score),
    matchReasons: strArray(c.matchReasons),
    strengthsUsed: strArray(c.strengthsUsed),
    attentionPoints: strArray(c.attentionPoints),
    nextActions: strArray(c.nextActions),
  };
}

function normalizeResult(raw: unknown): CareerMatchingResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const companies = Array.isArray(r.companyMatches) ? r.companyMatches : [];
  return {
    profileSummary: str(r.profileSummary),
    careerType: str(r.careerType),
    recommendedIndustries: strArray(r.recommendedIndustries),
    recommendedJobs: strArray(r.recommendedJobs),
    companyMatches: companies
      .map(normalizeCompany)
      // 企業名と理由がある社のみ採用（理由の無い企業は出さない）。
      .filter((c) => c.company !== '' && c.matchReasons.length > 0)
      .slice(0, MAX_COMPANIES),
    developmentAreas: strArray(r.developmentAreas),
    nextSteps: strArray(r.nextSteps),
  };
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
    interviewResult?: CareerInterviewFinalResult | null;
    consultation?: CareerConsultationResult | null;
    userInput?: string;
  };

  const hasProfile = !!b.profile && Object.keys(b.profile).length > 0;
  const hasActivity = !!b.activity && Object.keys(b.activity).length > 0;
  const hasSelfAnalysis = !!b.selfAnalysis;
  // マッチングは判断材料が必要。プロフィール/活動/自己分析のいずれも無ければ弾く。
  if (!hasProfile && !hasActivity && !hasSelfAnalysis) {
    return Response.json(
      { error: '基本情報・活動整理・自己分析のいずれかを入力してください。' },
      { status: 400 },
    );
  }

  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    userInput: typeof b.userInput === 'string' ? b.userInput : '',
  });

  const selfAnalysisBlock = renderSelfAnalysis(b.selfAnalysis);
  const esBlock = renderEs(b.es);
  const interviewBlock = renderInterview(b.interviewResult);
  const consultationBlock = renderConsultation(b.consultation);

  const systemPrompt = [
    MATCHING_PERSONA,
    buildCareerSystemPrompt(context),
    buildCareerFeatureInstruction(FEATURE_KEY),
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    esBlock ? `# 直近の ES ドラフト\n${esBlock}` : '',
    interviewBlock ? `# 直近の面接練習の結果\n${interviewBlock}` : '',
    consultationBlock ? `# 直近の就活相談の結果\n${consultationBlock}` : '',
    OUTPUT_FORMAT_INSTRUCTION,
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  const userMessage = [
    buildCareerFeatureInstruction(FEATURE_KEY),
    '',
    '上記の統合情報をもとに企業マッチングを行い、指定の JSON 形式で結果のみを出力してください。',
    '各企業について「なぜ向いているのか」を必ず根拠付きで示してください。',
  ].join('\n');

  try {
    let result: CareerMatchingResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: MODEL,
          max_tokens: 3500,
          temperature: attempt === 2 ? 0 : 0.5,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: createTimeoutSignal() },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_MATCHING_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        result = normalizeResult(JSON.parse(extractJson(raw)));
        break;
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          { error: 'AI_MATCHING_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    if (!result) {
      return Response.json(
        { error: 'AI_MATCHING_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
        { status: 502 },
      );
    }

    return Response.json({ result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career matching API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: 'マッチングの生成に失敗しました。' },
      { status: 500 },
    );
  }
}
