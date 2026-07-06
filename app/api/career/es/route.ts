// PASSAI 就活版 — ES（エントリーシート）作成AI API（最小版）
//
// 役割: /career/es/run から呼ばれ、就活向けの ES ドラフトを JSON で返すだけ。
//
// 重要（受験版からの分離方針）:
//   - 受験版 app/statement / /api/statement-review の「構成」は参考にするが、受験版依存は
//     一切持ち込まない（AO・推薦・大学受験の文脈・プロンプト・型を使わない）。
//   - 課金 / quota（ensurePlanQuota）・usage 記録（recordUsage / logAiUsage）・
//     DB / Supabase / Stripe には接続しない。本フェーズは「動く最小実装」に徹する。
//   - プロンプトは就活版共通基盤（@/lib/careerAi）からのみ組み立てる。
//   - 利用する共通ユーティリティは AI 呼び出し系の純粋なものに限定する:
//       @/lib/ai        … Anthropic クライアント singleton + extractJson（DB 非依存）
//       @/lib/aiTimeout … AbortSignal timeout helper（純粋・DB 非依存）

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
import type { CareerEsResult, CareerEsSelectionType } from '@/types/careerEs';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import {
  normalizeCompanyResearchSnapshot,
  formatCompanyResearchContextForPrompt,
} from '@/lib/careerCompanyResearch/context';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';

// 本ルートの機能キーは ES に固定する。
const FEATURE_KEY = 'career-es' as const;

// 受験版各ルートと同系の Sonnet を使用（課金/usage には接続しない）。
const MODEL = 'claude-sonnet-4-6';

// Vercel 実行時間上限。AI timeout（60s）+ 余裕。runtime は既定 nodejs。
export const maxDuration = 80;

// 期待する出力 JSON スキーマを明示する指示。system prompt（共通基盤）に追記する。
// 設問が無い「おまかせ生成モード」用。既存の 7 フィールド一括生成を維持する。
const OUTPUT_FORMAT_INSTRUCTION = [
  '# 出力形式（厳守）',
  '上記のプロフィール・活動・自己分析をもとに、新卒就活向けの ES ドラフトを作成してください。',
  '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
  '各フィールドは日本語で、本人の経験に即して具体的に記述してください。',
  '盛りすぎ・テンプレ化を避け、本人が自分の言葉で語れる自然で読みやすい就活向けの文にしてください。',
  '該当が無いフィールドは空配列 [] または空文字 "" にしてください（キーは省略しない）。',
  '',
  '{',
  '  "gakuchika": string,         // ガクチカ本文ドラフト（結論→具体→学び）',
  '  "selfPr": string,            // 自己PR本文ドラフト',
  '  "motivation": string,        // 志望動機本文ドラフト',
  '  "headline": string,          // キャッチコピー（自分を一言で表す見出し）',
  '  "appealPoints": string[],    // 企業へのアピールポイント',
  '  "interviewQuestions": string[], // 面接で深掘りされそうな想定質問',
  '  "improvements": string[]     // さらに良くするための改善点',
  '}',
].join('\n');

// 設問モード用の出力形式。設問に対する回答 1 本だけを生成する。
function buildAnswerFormatInstruction(charLimit: number | null): string {
  const lines = [
    '# 出力形式（厳守）',
    '指定された ES 設問に対する回答本文ドラフトを作成してください。',
    '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
    '',
    '回答作成のルール:',
    '- 問われていることに直接答える（設問の意図から外れない）。',
    '- 構成は「結論 → 具体経験 → 学び → 企業/仕事への接続」を基本にする。',
    '- 盛りすぎ・テンプレ化を避け、本人の経験に即した自然な文にする。',
    '- 活動・就活軸・自己分析に根拠がある内容だけを使い、事実を捏造しない。',
  ];
  if (charLimit) {
    lines.push(
      `- 文字数は ${charLimit} 字を目安に、±10% 以内（約 ${Math.round(
        charLimit * 0.9,
      )}〜${Math.round(charLimit * 1.1)} 字）に収める。`,
    );
  }
  lines.push(
    '',
    '{',
    '  "answer": string  // 設問に対する回答本文ドラフト',
    '}',
  );
  return lines.join('\n');
}

// 企業名が与えられたときの指示ブロック。汎用文を避けつつ、未確認の事実は捏造させない。
function buildCompanyInstruction(companyName: string): string {
  return [
    `# 志望企業: ${companyName}`,
    `- どの企業にも当てはまる汎用文ではなく、「${companyName}」を志望する文脈に寄せた言い回しにしてください。`,
    '- ただし企業分析データは未接続です。事業内容・待遇・選考フロー・社風などの事実は',
    '  断定・捏造せず、本人の価値観や経験と企業の一般的な志望理由の接続にとどめてください。',
  ].join('\n');
}

// 選考種別・志望業界・志望職種が与えられたときの指示ブロック。
// このES1本に限った応募文脈に寄せる。該当が無ければ空文字を返し、prompt に出さない。
function buildTargetingInstruction(params: {
  selectionType: CareerEsSelectionType | null;
  industry: string;
  jobType: string;
}): string {
  const lines: string[] = [];
  if (params.selectionType === 'main') {
    lines.push(
      '# 選考種別: 本選考',
      '入社を前提とした本選考向けのESです。次の方針で表現を最適化してください:',
      '- 入社後にどう貢献できるか（再現性のある強み・行動）が伝わる構成にする。',
      '- 過去の経験を「入社後に活かせる力」として自然に接続し、活躍イメージを持たせる。',
      '- その企業・仕事への適合性（価値観・強みと企業の方向性の一致）を具体的に示す。',
      '- 志望度の強さ（なぜこの会社か・なぜこの職種か）を曖昧にせず明確にする。',
      '- 「学びたい」「成長したい」だけで終わる受け身の表現は避け、',
      '  「〜で貢献したい」「〜を実現したい」という主体的・貢献志向の表現にする。',
      '- 企業名・業界・職種の指定がある場合は、それに合わせて志望理由と活躍イメージを調整する。',
    );
  } else if (params.selectionType === 'internship') {
    lines.push(
      '# 選考種別: インターン応募',
      'インターンシップ応募向けのESです。次の方針で表現を最適化してください:',
      '- 業界・企業への関心と、参加目的（何を得たいか）を明確にする。',
      '- インターンで検証したい仮説や、確かめたい自分の適性・関心を自然に盛り込む。',
      '- 短期間で吸収し、主体的に行動できる姿勢（現場理解・業務理解への意欲）を出す。',
      '- 「学びたい」は使ってよいが、受け身ではなく「〜を理解するために」「〜を検証するために」',
      '  という主体的な学習目的として書く。',
      '- 「入社後に長く働く」前提や、断定的な入社意思には寄せすぎない（応募段階はインターン参加です）。',
    );
  }
  if (params.industry) {
    lines.push(
      `# 志望業界: ${params.industry}`,
      `- 「${params.industry}」で一般的に求められる素養・着眼点に接続した言い回しにしてください。`,
      '  ただし業界の事実（市場規模・動向・各社事情など）は断定・捏造しないでください。',
    );
  }
  if (params.jobType) {
    lines.push(
      `# 志望職種: ${params.jobType}`,
      `- 「${params.jobType}」で活きる強み・経験が伝わるように、本人の経験から自然に接続してください。`,
    );
  }
  return lines.join('\n');
}

// 保存済み企業研究（ユーザー本人が確認したもの）を使うときの指示ブロック。
// AI が企業情報を補完・断定しないよう、「ユーザーの企業研究に基づくと」という扱いに固定する。
function buildCompanyResearchInstruction(formatted: string): string {
  return [
    '# 保存済みの企業研究（ユーザー本人が作成・確認したもの）',
    formatted,
    '',
    'この企業研究は、ユーザー自身が調べて確認・保存した一次情報です。志望動機・企業別設問・',
    '入社後にやりたいこと・自己PRと企業の接続に、この内容を根拠として活用してください。',
    '- 「ユーザーの企業研究に基づくと」という扱いにし、AI が企業情報を補完・断定しないでください。',
    '- 企業研究で注目している点を志望理由に自然につなげてください。',
    '- 企業研究で不足・根拠不足と指摘されている点は、断定で埋めず「公式情報や説明会資料での',
    '  再確認」を前提にした表現にとどめてください。',
  ].join('\n');
}

// 任意の値を string に丸める。
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 任意の値を string[] に丸める（非配列・空要素を除去）。
function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v) => v !== '');
}

// 空の 7 フィールド土台。設問モードでは answer 以外を空で埋める。
function emptyResult(): CareerEsResult {
  return {
    gakuchika: '',
    selfPr: '',
    motivation: '',
    headline: '',
    appealPoints: [],
    interviewQuestions: [],
    improvements: [],
  };
}

// 生成時の応募メタ（企業・選考種別・業界・職種）。両モードで結果へ echo する。
type EsMeta = {
  companyName: string;
  selectionType: CareerEsSelectionType | null;
  industry: string;
  jobType: string;
};

// 応募メタ（企業・選考種別・業界・職種）を結果へ echo する（存在する分だけ）。
function applyMeta(result: CareerEsResult, meta: EsMeta): CareerEsResult {
  if (meta.companyName) result.companyName = meta.companyName;
  if (meta.selectionType) result.selectionType = meta.selectionType;
  if (meta.industry) result.industry = meta.industry;
  if (meta.jobType) result.jobType = meta.jobType;
  return result;
}

// AI 出力（パース済み unknown）を CareerEsResult 形状に正規化する（おまかせ生成モード）。
function normalizeResult(raw: unknown, meta: EsMeta): CareerEsResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return applyMeta(
    {
      gakuchika: str(r.gakuchika),
      selfPr: str(r.selfPr),
      motivation: str(r.motivation),
      headline: str(r.headline),
      appealPoints: strArray(r.appealPoints),
      interviewQuestions: strArray(r.interviewQuestions),
      improvements: strArray(r.improvements),
    },
    meta,
  );
}

// 設問モードの AI 出力を正規化する。answer を取り出し、設問・文字数・応募メタを echo する。
function normalizeAnswerResult(
  raw: unknown,
  meta: EsMeta & { question: string; charLimit: number | null },
): CareerEsResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const result: CareerEsResult = {
    ...emptyResult(),
    answer: str(r.answer),
    question: meta.question,
  };
  if (meta.charLimit) result.charLimit = meta.charLimit;
  return applyMeta(result, meta);
}

// 直近の自己分析結果を system prompt 用の可読テキストに整形する。
// 未提供（自己分析未実行）なら空文字を返し、prompt 側で section を出さない。
function renderSelfAnalysis(result: CareerSelfAnalysisResult | null): string {
  if (!result) return '';
  const lines: string[] = [];
  // v2 フィールドは旧ログで undefined になり得るため、空・非文字列は無視して防御する。
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  const pushList = (label: string, values: string[] | undefined) => {
    if (values && values.length > 0) lines.push(`- ${label}: ${values.join('、')}`);
  };
  push('全体所感', result.summary);
  push('キャリアの方向性', result.careerDirection);
  pushList('強み', result.strengths);
  pushList('強みキーワード', result.strengthKeywords);
  pushList('価値観キーワード', result.valueKeywords);
  pushList('弱み', result.weaknesses);
  pushList('ガクチカ候補', result.gakuchikaIdeas);
  pushList('自己PR候補', result.selfPrIdeas);
  pushList('ESで使える切り口', result.esAngles);
  return lines.length > 0 ? lines.join('\n') : '';
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
    userInput?: string;
    question?: string;
    charLimit?: number;
    companyName?: string;
    selectionType?: unknown;
    industry?: string;
    jobType?: string;
    companyResearchContext?: unknown;
  };

  const profile = b.profile ?? null;
  const activity = b.activity ?? null;
  const values = b.values ?? null;
  const selfAnalysis = b.selfAnalysis ?? null;
  const userInput = typeof b.userInput === 'string' ? b.userInput : '';

  // 設問モードの入力。設問が非空なら「設問への回答 1 本」を生成する分岐に入る。
  const question = typeof b.question === 'string' ? b.question.trim() : '';
  const companyName = typeof b.companyName === 'string' ? b.companyName.trim() : '';
  const charLimit =
    typeof b.charLimit === 'number' && Number.isFinite(b.charLimit) && b.charLimit > 0
      ? Math.floor(b.charLimit)
      : null;
  // 応募メタ（このES1本に限った文脈）。未指定は許容する。
  const selectionType: CareerEsSelectionType | null =
    b.selectionType === 'main' || b.selectionType === 'internship'
      ? b.selectionType
      : null;
  const industry = typeof b.industry === 'string' ? b.industry.trim() : '';
  const jobType = typeof b.jobType === 'string' ? b.jobType.trim() : '';
  const meta: EsMeta = { companyName, selectionType, industry, jobType };
  const answerMode = question !== '';

  // 材料が何も無ければ ES を作れないので弾く。
  const hasProfile = !!profile && Object.keys(profile).length > 0;
  const hasActivity = !!activity && Object.keys(activity).length > 0;
  if (!hasProfile && !hasActivity) {
    return Response.json(
      { error: '基本情報または活動整理のいずれかを入力してください。' },
      { status: 400 },
    );
  }

  // 就活版共通基盤でコンテキスト → system prompt を組み立てる。
  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile,
    activity,
    values,
    userInput,
  });

  // base（共通基盤）に「企業」「直近の自己分析」「設問 / 出力形式」を追記する。
  // 設問モードでは設問ブロックと answer 用出力形式、それ以外は従来の 7 フィールド出力形式。
  const selfAnalysisBlock = renderSelfAnalysis(selfAnalysis);
  const companyBlock = companyName ? buildCompanyInstruction(companyName) : '';
  const targetingBlock = buildTargetingInstruction({ selectionType, industry, jobType });
  // 保存済み企業研究（任意・1 件）。あれば「ユーザー本人の根拠」として優先的に使う。
  const researchSnapshot = normalizeCompanyResearchSnapshot(b.companyResearchContext);
  const researchBlock = researchSnapshot
    ? buildCompanyResearchInstruction(formatCompanyResearchContextForPrompt([researchSnapshot]))
    : '';
  const questionBlock = answerMode
    ? [
        '# ES設問（この設問に直接答えてください）',
        question,
        charLimit ? `\n指定文字数: ${charLimit} 字（±10% 以内を目安）` : '',
      ]
        .filter((s) => s !== '')
        .join('\n')
    : '';
  const outputFormat = answerMode
    ? buildAnswerFormatInstruction(charLimit)
    : OUTPUT_FORMAT_INSTRUCTION;

  const systemPrompt = [
    buildCareerSystemPrompt(context),
    companyBlock,
    targetingBlock,
    researchBlock,
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    questionBlock,
    outputFormat,
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  // user メッセージは実行トリガ。機能別指示を再掲して JSON 出力を促す。
  const userMessage = [
    buildCareerFeatureInstruction(FEATURE_KEY),
    '',
    answerMode
      ? '以上を踏まえ、指定の JSON 形式で設問への回答ドラフトのみを出力してください。'
      : '以上を踏まえ、指定の JSON 形式で ES ドラフトのみを出力してください。',
  ].join('\n');

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する（受験版各ルートと同方針）。
    let result: CareerEsResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: MODEL,
          max_tokens: 2500,
          temperature: attempt === 2 ? 0 : 0.5,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: createTimeoutSignal() },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      // max_tokens 到達の途中切れは長さ起因なので retry せず明示エラーで返す。
      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_ES_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        const parsed = JSON.parse(extractJson(raw));
        result = answerMode
          ? normalizeAnswerResult(parsed, { ...meta, question, charLimit })
          : normalizeResult(parsed, meta);
        break;
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          { error: 'AI_ES_PARSE_FAILED', detail: 'AI応答をJSONとして解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    if (!result) {
      return Response.json(
        { error: 'AI_ES_PARSE_FAILED', detail: 'AI応答をJSONとして解釈できませんでした。' },
        { status: 502 },
      );
    }

    return Response.json({ result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career ES API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: 'ESの生成に失敗しました。' },
      { status: 500 },
    );
  }
}
