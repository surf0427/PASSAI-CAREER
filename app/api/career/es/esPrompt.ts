// PASSAI 就活版 — ES（エントリーシート）生成AI の prompt 組み立て（純関数・route から分離）。
//
// P15-C: これまで app/api/career/es/route.ts の POST 内にインラインで組まれていた ES 生成 prompt の
//   組み立てを、pure builder（buildEsGenerationPrompt）として本モジュールへ抽出した
//   （presentation/interview の *Prompt.ts と同じ責務分割）。route は request 検証・AI 実行・response
//   正規化に専念する。機能横断（自己分析）の render は Context Orchestrator 経由の canonical renderer
//   （lib/careerMemory/renderers/esGenerationCrossFeature）へ移設済みで、本 builder はその
//   orchestrated.crossFeatureContext を旧位置（researchBlock と questionBlock の間）に置く。
//   → 完成 system/user prompt は抽出前・移設前と UTF-8 byte 列として同一
//     （常設 harness scripts/career-es-orchestrator-parity-qa.ts で担保）。
//
// 純関数のみ（I/O / env / secret / DB / Supabase / 外部AI なし）。es_review（別 route・静的 SYSTEM_PROMPT）
//   には一切関与しない。

import {
  buildCareerAiContext,
  buildCareerFeatureInstruction,
} from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerEsSelectionType } from '@/types/careerEs';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CompanyResearchSnapshot } from '@/types/careerCompanyResearch';
import { formatCompanyResearchContextForPrompt } from '@/lib/careerCompanyResearch/context';

// 本ルートの機能キーは ES に固定する。
export const FEATURE_KEY = 'career-es' as const;

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

// ES 生成 prompt builder の入力（route が body から正規化した typed 値）。
export type EsGenerationPromptInput = {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  selfAnalysis: CareerSelfAnalysisResult | null;
  userInput: string;
  // 設問（trim 済み）。非空なら「設問への回答 1 本」を生成する answer モード。
  question: string;
  companyName: string; // trim 済み
  charLimit: number | null;
  selectionType: CareerEsSelectionType | null;
  industry: string; // trim 済み
  jobType: string; // trim 済み
  // 保存済み企業研究（正規化済みスナップショット・任意）。
  researchSnapshot: CompanyResearchSnapshot | null;
};

// ES 生成の完成 system / user prompt を組み立てる純関数。
//   P15-C: base は Context Orchestrator（purpose=es_generation）経由。自己分析ブロックは
//   orchestrated.crossFeatureContext として旧位置（researchBlock と questionBlock の間）に置く。
export function buildEsGenerationPrompt(
  input: EsGenerationPromptInput,
): { system: string; user: string } {
  const answerMode = input.question !== '';

  // 就活版共通基盤でコンテキスト → base system prompt を組み立てる。
  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile: input.profile,
    activity: input.activity,
    values: input.values,
    userInput: input.userInput,
  });
  const orchestrated = buildCareerContextForPurpose('es_generation', context, {
    esGeneration: { selfAnalysis: input.selfAnalysis },
  });

  // base（共通基盤）に「企業」「直近の自己分析」「設問 / 出力形式」を追記する。
  const companyBlock = input.companyName ? buildCompanyInstruction(input.companyName) : '';
  const targetingBlock = buildTargetingInstruction({
    selectionType: input.selectionType,
    industry: input.industry,
    jobType: input.jobType,
  });
  // 保存済み企業研究（任意・1 件）。あれば「ユーザー本人の根拠」として優先的に使う。
  const researchBlock = input.researchSnapshot
    ? buildCompanyResearchInstruction(
        formatCompanyResearchContextForPrompt([input.researchSnapshot]),
      )
    : '';
  const questionBlock = answerMode
    ? [
        '# ES設問（この設問に直接答えてください）',
        input.question,
        input.charLimit ? `\n指定文字数: ${input.charLimit} 字（±10% 以内を目安）` : '',
      ]
        .filter((s) => s !== '')
        .join('\n')
    : '';
  const outputFormat = answerMode
    ? buildAnswerFormatInstruction(input.charLimit)
    : OUTPUT_FORMAT_INSTRUCTION;

  const system = [
    orchestrated.systemPrompt,
    companyBlock,
    targetingBlock,
    researchBlock,
    // P15-C: 直近の自己分析ブロックは crossFeatureContext に決定的に集約済み（旧位置を維持）。
    orchestrated.crossFeatureContext,
    questionBlock,
    outputFormat,
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  // user メッセージは実行トリガ。機能別指示を再掲して JSON 出力を促す。
  const user = [
    buildCareerFeatureInstruction(FEATURE_KEY),
    '',
    answerMode
      ? '以上を踏まえ、指定の JSON 形式で設問への回答ドラフトのみを出力してください。'
      : '以上を踏まえ、指定の JSON 形式で ES ドラフトのみを出力してください。',
  ].join('\n');

  return { system, user };
}
