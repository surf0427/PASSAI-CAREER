// PASSAI 就活版 — 企業マッチングAI API（決定的スコアリングエンジン版）
//
// 就活版独自のコア機能。受験版のコピーではない。
//   - プロフィール・活動・自己分析・ES・面接・相談の結果を統合し、企業との相性を可視化する。
//   - 【スコア契約】AI は小スコア（AiMatchingSignal）と根拠のみ返す。総合スコア・順位・
//     不足優先度・ロードマップはすべてサーバ側の決定的エンジン（@/lib/careerMatching）が計算する。
//     AI が score / total / 順位を返してもサーバは一切採用しない。
//   - 課金 / quota / usage / DB / Supabase / Stripe には一切接続しない（localStorage のみ）。
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
import {
  runCareerMatch,
  deriveMatchWeights,
  normalizeBarTier,
  clampScore,
  buildMeasuredReadiness,
  mergeReadinessSignals,
  COMPANY_FLAG_VOCAB,
  MATCH_AXES,
  SUCCESS_AXES,
  CAREER_MATCHING_SCHEMA_VERSION,
  READINESS_DISCLAIMER,
} from '@/lib/careerMatching';
import type {
  CompanyEngineInput,
  ScoreSignal,
  EngineInput,
  CareerMatchEngineResult,
} from '@/lib/careerMatching';
import {
  normalizeGdMatchingSnapshot,
  formatGdMatchingForPrompt,
} from '@/lib/careerGd/context';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal, isAbortError } from '@/lib/aiTimeout';

const FEATURE_KEY = 'career-company-matching' as const;
const MODEL = 'claude-sonnet-4-6';
export const maxDuration = 80;

// 本 route は出力が大きめ（複数社 × signals）なので、既定 60 秒より少し長い個別 timeout を使う。
// maxDuration=80 の内側に収め、生成量削減（社数・rationale 短縮）とセットで abort を減らす。
const MATCHING_TIMEOUT_MS = 75_000;

// 生成量（＝生成時間）の主因は「社数 × 各社の signals/根拠 × テキスト配列」。
// タイムアウト対策として 4 社に抑える（決定的エンジン runCareerMatch は社数非依存で不変）。
const MAX_COMPANIES = 4;

const MATCH_KEYS = MATCH_AXES.map((a) => `match:${a}`);
const SUCCESS_KEYS = SUCCESS_AXES.map((a) => `success:${a}`);
// AI が判断してよい readiness シグナル（質的データから推定するもののみ）。
// SPI/プレゼン/語学/資格は measured（データ有無）でサーバが扱うので AI には判断させない。
const AI_READINESS_KEYS = ['readiness:es', 'readiness:interview', 'readiness:self_understanding'];
const FLAG_SET = new Set(COMPANY_FLAG_VOCAB);

// ── マッチングアナリストとしての役割・出力契約 ──
const MATCHING_PERSONA = [
  'あなたは新卒就活専門のキャリアアドバイザー兼マッチングアナリストです。',
  'プロフィール・活動・自己分析・ES・面接・相談の結果を統合し、本人と企業の「相性」を分析します。',
  '',
  '【最重要・スコア契約】',
  '- あなたは「総合点」「順位」「合否」「内定可能性」を一切出力してはいけません。',
  '- あなたが返すのは各観点の小スコア（0〜100）と、その根拠だけです。',
  '- 総合スコア・順位・不足優先度はサーバが計算します。',
  '',
  '【企業選定ルール】',
  `- 提案は最大 ${MAX_COMPANIES} 社。実在する日本国内企業のみ。架空企業は絶対に生成しない。`,
  '- 大手/ベンチャーを偏らせず、業界を分散させる。',
  '- 各社に matchReasons（なぜ向いているか）を必ず 1 つ以上付ける（根拠の無い企業は出さない）。',
  '- 年収・福利厚生・選考フロー等の事実は断定しない（必要なら公式情報での確認を促す）。',
].join('\n');

function signalKeyList(): string {
  return [...MATCH_KEYS, ...AI_READINESS_KEYS, ...SUCCESS_KEYS].join(' / ');
}

const OUTPUT_FORMAT_INSTRUCTION = [
  '# 出力形式（厳守）',
  '出力は次の JSON オブジェクトのみ。前後に説明文やコードブロック記号を付けない。',
  '各 value は 0〜100 の数値。配列は該当が無ければ空配列 []（キーは省略しない）。',
  '冗長さは避け、文章は簡潔に。各配列は 1〜2 項目、rationale は 25 字程度の短文（体言止め可）。',
  '',
  '{',
  '  "profileSummary": string,        // 本人の総括（1〜2文）',
  '  "careerType": string,            // タイプ分類（例: 裁量重視の挑戦型）',
  '  "recommendedIndustries": string[], // 3〜4個',
  '  "recommendedJobs": string[],       // 3〜4個',
  '  "developmentAreas": string[],    // 伸ばすべき領域（2〜3個）',
  '  "nextSteps": string[],           // 全体の次の一歩（2〜3個）',
  '  "companies": [                   // 最大 ' + MAX_COMPANIES + ' 社',
  '    {',
  '      "company": string,           // 実在する日本国内企業',
  '      "selectionTier": "S"|"A"|"B"|"C", // 選考難易度の推測（S=最難関）',
  `      "companyFlags": string[],    // 該当のみ・次の語彙: ${COMPANY_FLAG_VOCAB.join(', ')}`,
  '      "signals": [                 // 特に根拠の強い 4〜6 個に絞る。小スコアのみ・総合点は出さない',
  `        { "key": string, "value": number, "rationale": string(短文), "source": "ai_inferred" }`,
  '      ],',
  '      "matchReasons": string[],    // 必須1〜2個・本人データを短く引用',
  '      "strengthsUsed": string[],   // 1〜2個',
  '      "attentionPoints": string[], // 1〜2個・待遇は断定しない',
  '      "nextActions": string[]      // 1〜2個',
  '    }',
  '  ]',
  '}',
  '',
  `signals.key に使える値（これ以外は無視されます）: ${signalKeyList()}`,
  '- match:* … 相性（価値観/社風/働き方/成長/安定/待遇志向/業界職種の一致）',
  '- readiness:* … 選考準備度（ES/面接/自己理解）。SPI・語学等はサーバが扱うので出さない',
  '- success:* … 入社後の活躍可能性（強み/社風適応/動機/ストレス相性/成長志向）',
].join('\n');

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v) => v !== '');
}

// ── 統合コンテキストの整形（AI へ渡す可読テキスト） ──
function renderSelfAnalysis(r: CareerSelfAnalysisResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.summary)) lines.push(`- 全体所感: ${str(r.summary)}`);
  if (str(r.careerDirection)) lines.push(`- キャリアの方向性: ${str(r.careerDirection)}`);
  if (r.strengths?.length) lines.push(`- 強み: ${r.strengths.join('、')}`);
  if (r.strengthKeywords?.length) lines.push(`- 強みキーワード: ${r.strengthKeywords.join('、')}`);
  if (r.valueKeywords?.length) lines.push(`- 価値観キーワード: ${r.valueKeywords.join('、')}`);
  if (r.motivationSources?.length) lines.push(`- モチベーションの源泉: ${r.motivationSources.join('、')}`);
  if (r.stressFactors?.length) lines.push(`- ストレス要因: ${r.stressFactors.join('、')}`);
  if (r.weaknesses?.length) lines.push(`- 弱み: ${r.weaknesses.join('、')}`);
  if (r.suitableEnvironment?.length) lines.push(`- 向いている環境: ${r.suitableEnvironment.join('、')}`);
  if (r.companySelectionCriteria?.length) lines.push(`- 企業選びの条件: ${r.companySelectionCriteria.join('、')}`);
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

// GD（グループディスカッション）練習結果を補助文脈として整形する。
// AI が総合点や順位を作らないのと同様、GD も断定材料にはしない旨は formatter 側に含む。
function renderGd(raw: unknown): string {
  const snapshot = normalizeGdMatchingSnapshot(raw);
  return formatGdMatchingForPrompt(snapshot);
}

// ── AI 出力 → エンジン入力への正規化（AI の総合点・順位は採用しない） ──
type RawAiCompany = {
  company?: unknown;
  selectionTier?: unknown;
  companyFlags?: unknown;
  signals?: unknown;
  matchReasons?: unknown;
  strengthsUsed?: unknown;
  attentionPoints?: unknown;
  nextActions?: unknown;
};

function normalizeAiSignals(
  raw: unknown,
  allowedKeys: string[],
): ScoreSignal[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ScoreSignal[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const key = str(rec.key);
    if (!allowedKeys.includes(key) || seen.has(key)) continue;
    seen.add(key);
    const sourceRaw = str(rec.source);
    const source: ScoreSignal['source'] =
      sourceRaw === 'user_input' || sourceRaw === 'verified_fact' ? sourceRaw : 'ai_inferred';
    out.push({
      key,
      value: clampScore(rec.value),
      present: true,
      source,
      rationale: str(rec.rationale),
    });
  }
  return out;
}

function normalizeCompany(raw: RawAiCompany, measuredReadiness: ScoreSignal[]): CompanyEngineInput | null {
  const company = str(raw.company);
  const matchReasons = strArray(raw.matchReasons);
  if (company === '' || matchReasons.length === 0) return null;

  const allAiSignals = Array.isArray(raw.signals) ? raw.signals : [];
  const matchSignals = normalizeAiSignals(allAiSignals, MATCH_KEYS);
  const successSignals = normalizeAiSignals(allAiSignals, SUCCESS_KEYS);
  const aiReadiness = normalizeAiSignals(allAiSignals, AI_READINESS_KEYS);

  const companyFlags = strArray(raw.companyFlags).filter((f) => FLAG_SET.has(f));

  return {
    company,
    matchSignals,
    readinessSignals: mergeReadinessSignals(measuredReadiness, aiReadiness),
    successSignals,
    barTier: normalizeBarTier(raw.selectionTier),
    companyFlags,
    matchReasons,
    strengthsUsed: strArray(raw.strengthsUsed),
    attentionPoints: strArray(raw.attentionPoints),
    nextActions: strArray(raw.nextActions),
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
    gdSnapshot?: unknown;
    userInput?: string;
  };

  const hasProfile = !!b.profile && Object.keys(b.profile).length > 0;
  const hasActivity = !!b.activity && Object.keys(b.activity).length > 0;
  const hasSelfAnalysis = !!b.selfAnalysis;
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

  // ── 決定的な重み・避けたい条件・measured シグナル（AI を通さない） ──
  const priorities = Array.isArray(b.values?.selections?.priorities)
    ? (b.values!.selections!.priorities as string[])
    : [];
  const avoidances = Array.isArray(b.values?.selections?.avoidances)
    ? (b.values!.selections!.avoidances as string[])
    : [];
  const matchWeights = deriveMatchWeights(priorities);
  // measured readiness は ACL（lib/careerMatching）に委譲。route は既存データを渡すだけ。
  const measuredReadiness = buildMeasuredReadiness({
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    selfAnalysis: b.selfAnalysis ?? null,
    es: b.es ?? null,
    interview: b.interviewResult ?? null,
    spi: null,
    presentation: null,
  });

  const selfAnalysisBlock = renderSelfAnalysis(b.selfAnalysis);
  const esBlock = renderEs(b.es);
  const interviewBlock = renderInterview(b.interviewResult);
  const consultationBlock = renderConsultation(b.consultation);
  // GD は補助文脈（主情報は活動・自己分析・就活軸）。formatGdMatchingForPrompt が見出し・断定回避を含む。
  const gdBlock = renderGd(b.gdSnapshot);

  const systemPrompt = [
    MATCHING_PERSONA,
    buildCareerSystemPrompt(context),
    buildCareerFeatureInstruction(FEATURE_KEY),
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    esBlock ? `# 直近の ES ドラフト\n${esBlock}` : '',
    interviewBlock ? `# 直近の面接練習の結果\n${interviewBlock}` : '',
    consultationBlock ? `# 直近の就活相談の結果\n${consultationBlock}` : '',
    gdBlock,
    OUTPUT_FORMAT_INSTRUCTION,
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  const userMessage = [
    buildCareerFeatureInstruction(FEATURE_KEY),
    '',
    '上記の統合情報をもとに、各企業の小スコア（signals）と根拠を指定 JSON で出力してください。',
    '総合点・順位は出さないでください（サーバが計算します）。',
  ].join('\n');

  try {
    let companies: CompanyEngineInput[] | null = null;
    let meta: {
      profileSummary: string;
      careerType: string;
      recommendedIndustries: string[];
      recommendedJobs: string[];
      developmentAreas: string[];
      nextSteps: string[];
    } | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: MODEL,
          max_tokens: 3200,
          temperature: attempt === 2 ? 0 : 0.5,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: createTimeoutSignal(MATCHING_TIMEOUT_MS) },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_MATCHING_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        const parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
        const rawCompanies = Array.isArray(parsed.companies) ? parsed.companies : [];
        companies = rawCompanies
          .map((c) => normalizeCompany(c as RawAiCompany, measuredReadiness))
          .filter((c): c is CompanyEngineInput => c !== null)
          .slice(0, MAX_COMPANIES);
        meta = {
          profileSummary: str(parsed.profileSummary),
          careerType: str(parsed.careerType),
          recommendedIndustries: strArray(parsed.recommendedIndustries),
          recommendedJobs: strArray(parsed.recommendedJobs),
          developmentAreas: strArray(parsed.developmentAreas),
          nextSteps: strArray(parsed.nextSteps),
        };
        break;
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          { error: 'AI_MATCHING_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    if (!companies || !meta) {
      return Response.json(
        { error: 'AI_MATCHING_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
        { status: 502 },
      );
    }

    // ── 決定的エンジンで総合スコア・順位・不足優先度・ロードマップを計算 ──
    const engineInput: EngineInput = {
      profile: { matchWeights, avoidances, schemaVersion: CAREER_MATCHING_SCHEMA_VERSION },
      companies,
    };
    const scoredCompanies = runCareerMatch(engineInput);

    const result: CareerMatchEngineResult = {
      schemaVersion: CAREER_MATCHING_SCHEMA_VERSION,
      profileSummary: meta.profileSummary,
      careerType: meta.careerType,
      recommendedIndustries: meta.recommendedIndustries,
      recommendedJobs: meta.recommendedJobs,
      developmentAreas: meta.developmentAreas,
      nextSteps: meta.nextSteps,
      companies: scoredCompanies,
      readinessDisclaimer: READINESS_DISCLAIMER,
    };

    return Response.json({ result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career matching API error:', msg);
    // timeout / abort は専用メッセージ + 504 で返し、ユーザーに再試行を促す。
    if (isAbortError(error)) {
      return Response.json(
        {
          error: 'AI_MATCHING_TIMEOUT',
          detail: '混み合っており、時間内にマッチングを生成できませんでした。少し時間をおいてもう一度お試しください。',
        },
        { status: 504 },
      );
    }
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: 'マッチングの生成に失敗しました。' },
      { status: 500 },
    );
  }
}
