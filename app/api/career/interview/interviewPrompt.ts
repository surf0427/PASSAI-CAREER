// PASSAI 就活版 — 面接AI 共通プロンプト組み立て（start / turn / complete 3 route 共有）
//
// 受験版 lib/interviewAi/questionGen.ts / finalFeedback.ts の「構造」を踏襲しつつ、
// 脳みそ（役割・観点・評価軸）を新卒就活専用に差し替える。
//   - 役割: 新卒就活専門の面接官（大学入試・AO/推薦・大学評価軸は一切持ち込まない）。
//   - プロンプト土台は就活版共通基盤（@/lib/careerAi）からのみ組み立てる。
// 本ファイルは route ではない（route.ts 以外なのでエンドポイント化されない）。共有モジュール。

import { buildCareerAiContext } from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';
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
  CareerInterviewTarget,
} from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import {
  type InterviewCompanyResearchContext,
  formatInterviewCompanyResearchForPrompt,
} from '@/lib/careerCompanyResearch/context';
import {
  getInterviewModeConfig,
  SHARED_INTERVIEWER_RULES,
} from '@/app/career/interview/interviewModes';

// 機能キー（就活版共通基盤の出し分け）。
const FEATURE_KEY = 'career-interview' as const;

// 受験版面接AIと同系の Sonnet を使用（課金/usage には接続しない）。
export const CAREER_INTERVIEW_MODEL = 'claude-sonnet-4-6';

// 回答ターン上限（受験版 INTERVIEW_AI_MAX_ANSWER_TURNS=5 を踏襲）。
export const CAREER_INTERVIEW_MAX_TURNS = 5;

// 面接で扱う質問テーマ（新卒就活）。観点を変えながら深掘りするためのプール。
// 単なる「頑張ったこと」で終わらせず、就活で評価される情報まで自然に掘り下げる狙い。
const CAREER_INTERVIEW_TOPICS = [
  'ガクチカ（学生時代に力を入れたこと）と、その行動を選んだ理由・判断基準',
  '自己PR・強みと、それが発揮された具体的な場面・担った役割',
  '困難・挫折経験と、どう乗り越えたか（思考プロセス）',
  '成果の具体化（数字・Before/After・改善・周囲への影響）',
  'チームでの役割・協働経験と、周囲からの評価',
  '強みの再現性（他の場面でも同じ強みを発揮できそうか、なぜそう思うか）',
  '経験から育まれた価値観・大切にしたいこと',
  '力を発揮できる環境／避けたい環境',
  '志望動機・キャリア観と、興味のある業界・職種との接続',
  '就活軸との共通点',
];

// 深掘りで引き出したい観点（ES・面接・マッチング・企業分析AI で再利用できる粒度）。
// followup の質問は毎回この中から「その回答で最も価値が高く、まだ十分に聞けていない1点」を選んで掘る。
const CAREER_DEEP_DIVE_AXES = [
  '行動の理由・判断基準（なぜそれを選んだか／他に選択肢はあったか／何を基準に決めたか）',
  '発揮した能力・担った役割（具体的に何をしたか）',
  '定量的な成果・変化（数字／Before・After／改善の度合い／周囲への影響）',
  '一番苦労した点・悩んだ点と、その乗り越え方（思考プロセス）',
  '周囲からの評価（チーム・上長・顧客などの反応）',
  '強みの再現性（他の場面でも同じ強みを発揮できそうか、なぜそう思うか）',
  '価値観（その経験から大切にするようになったこと）',
  '力を発揮できる環境／避けたい環境',
  '興味のある業界・職種や就活軸との接続（この経験はどんな仕事で活きそうか）',
];

// 受験先・選考の想定（target）を面接官 system prompt 用のブロックに整形する。
// companyName が無ければ空文字（従来どおり企業を特定しない面接）。
// 企業の事実は断定させず、学生メモ（companyMemo）を最優先根拠にする方針を明示する。
function buildTargetBlock(target: CareerInterviewTarget | null | undefined): string {
  if (!target || !target.companyName) return '';
  const lines: string[] = [
    '# 今回の受験先・選考の想定',
    `この面接は「${target.companyName}」を受ける想定で行ってください。志望動機・企業理解・職種理解に関する深掘りを自然に増やしてください。`,
    `ただし「${target.companyName}」の事業内容・待遇・選考フロー・社風などの事実は断定・捏造せず、学生自身の理解と理由を問う形にしてください。`,
  ];
  if (target.industry) lines.push(`- 志望業界: ${target.industry}`);
  if (target.jobType) lines.push(`- 志望職種: ${target.jobType}`);

  if (target.selectionType === 'main') {
    lines.push(
      '- 選考種別: 本選考。入社後の貢献可能性・志望度の強さ・企業適合性・過去経験の再現性・「なぜこの会社か」を重視して深掘りしてください。',
    );
  } else if (target.selectionType === 'internship') {
    lines.push(
      '- 選考種別: インターン。参加目的・業界や企業への関心・現場理解・学びたいこと・検証したい仮説を重視して深掘りしてください。',
      '  長期の入社を前提とした断定的な志望確認に寄せすぎないでください。',
    );
  }

  switch (target.interviewPhase) {
    case 'first':
      lines.push(
        '- 選考フェーズ: 一次面接。人柄・基本的なガクチカ・自己PR・志望動機の土台・コミュニケーションの自然さを中心に確認してください。',
      );
      break;
    case 'second':
      lines.push(
        '- 選考フェーズ: 二次面接。経験の深掘り・企業や職種への理解・価値観との一致・強みの再現性を中心に確認してください。',
      );
      break;
    case 'final':
      lines.push(
        '- 選考フェーズ: 最終面接。志望度・覚悟・入社後の展望・他社比較・長期的なキャリア観を中心に確認してください。',
      );
      break;
    case 'internship':
      lines.push(
        '- 選考フェーズ: インターン面接。参加目的・学習意欲・業界理解・主体性・インターンで得たいことを中心に確認してください。',
      );
      break;
    case 'casual':
      lines.push(
        '- 選考フェーズ: カジュアル面談。形式ばりすぎず自然な会話を意識し、企業理解の確認・相互理解・学生からの逆質問も歓迎する姿勢で進めてください。',
      );
      break;
    default:
      break;
  }

  if (target.companyMemo) {
    lines.push(
      `# 学生が把握している企業情報（最優先で尊重する）\n${target.companyMemo}`,
      'この企業メモは学生本人が調べた内容です。企業に関する前提はこのメモを最優先の根拠にし、メモを超える事実は断定しないでください。',
    );
  }
  if (target.focusPoint) {
    lines.push(
      `# 学生が特に対策したいこと\n${target.focusPoint}`,
      'この点を意識して、質問・深掘り・最終フィードバックに自然に反映してください。',
    );
  }
  return lines.join('\n');
}

// 面接官の人格・話し方を、面接の種類（interviewType）に応じて組み立てる。
// 「新卒就活の面接官」という土台 + モード固有の人格 + 全モード共通ルールをまとめる。
function buildPersonaBlock(interviewType: CareerInterviewType | undefined): string {
  const config = getInterviewModeConfig(interviewType);
  return [
    'あなたは新卒就活の面接官です。大学生・大学院生の新卒採用面接を担当します。',
    '大学受験（総合型選抜・学校推薦型選抜・一般入試）の文脈や、大学の評価軸は一切持ち込みません。',
    '',
    `【今回の面接】${config.label}（担当: ${config.interviewerRole}）`,
    config.persona,
    '',
    SHARED_INTERVIEWER_RULES,
  ].join('\n');
}

// 直近の自己分析結果を可読テキストに整形（未提供なら空文字）。
function renderSelfAnalysis(result: CareerSelfAnalysisResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  // v2 フィールドは旧ログで undefined になり得るため、空・非配列は無視して防御する。
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  const pushList = (label: string, values: string[] | undefined) => {
    if (values && values.length > 0) lines.push(`- ${label}: ${values.join('、')}`);
  };
  push('全体所感', result.summary);
  push('キャリアの方向性', result.careerDirection);
  pushList('強み', result.strengths);
  pushList('弱み', result.weaknesses);
  pushList('今後伸ばすべき点', result.developmentPoints);
  pushList('ガクチカ候補', result.gakuchikaIdeas);
  pushList('自己PR候補', result.selfPrIdeas);
  return lines.join('\n');
}

// 直近の ES 結果を可読テキストに整形（未提供なら空文字）。
function renderEs(result: CareerEsResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  const push = (label: string, value: string) => {
    if (value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  push('キャッチコピー', result.headline);
  push('ガクチカ', result.gakuchika);
  push('自己PR', result.selfPr);
  push('志望動機', result.motivation);
  return lines.join('\n');
}

// 就活マッチング結果を可読テキストに整形（未提供なら空文字）。
// 「想定企業との相性」を語るための材料として参照する（断定はしない）。
function renderMatching(result: CareerMatchEngineResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  const pushList = (label: string, values: string[] | undefined, max: number) => {
    if (values && values.length > 0) {
      lines.push(`- ${label}: ${values.slice(0, max).join('、')}`);
    }
  };
  push('適性タイプ', result.careerType);
  pushList('相性の良い業界', result.recommendedIndustries, 5);
  pushList('相性の良い職種', result.recommendedJobs, 5);
  pushList('今後の伸ばしどころ', result.developmentAreas, 4);
  return lines.join('\n');
}

// 相談AIでの最近の気づきを可読テキストに整形（参考程度・未提供なら空文字）。
function renderConsultationInsights(insights: string[] | null | undefined): string {
  if (!insights || insights.length === 0) return '';
  return insights
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .slice(0, 5)
    .map((s) => `- ${s}`)
    .join('\n');
}

export type CareerInterviewContextInput = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  selfAnalysis?: CareerSelfAnalysisResult | null;
  es?: CareerEsResult | null;
  // 任意の参考データ（存在しなくても落ちない／プロンプトに出さないだけ）。
  matching?: CareerMatchEngineResult | null;
  consultationInsights?: string[] | null;
  // 保存済み企業研究（選択時のみ）。ユーザー本人の企業研究を根拠に深掘りする。
  companyResearch?: InterviewCompanyResearchContext | null;
  // 前段で入力した受験先・選考の想定（任意）。企業・選考フェーズに合わせて深掘りする。
  target?: CareerInterviewTarget | null;
  interviewType?: CareerInterviewType;
  userInput?: string;
};

// 面接AIの土台 system prompt を組む。
// 就活版共通基盤（プロフィール+活動）+ 自己分析 + ES + 面接官人格を 1 つにまとめる。
export function buildInterviewBaseSystem(input: CareerInterviewContextInput): string {
  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile: input.profile ?? null,
    activity: input.activity ?? null,
    values: input.values ?? null,
    userInput: input.userInput ?? '',
  });
  // P3-A: base system prompt を Context Orchestrator（purpose=interview_practice）経由で取得する。
  //   start/turn/complete が共有する builder。委譲のため出力は現行と byte 単位で同一。
  const orchestrated = buildCareerContextForPurpose('interview_practice', context);

  const config = getInterviewModeConfig(input.interviewType);
  const selfAnalysisBlock = renderSelfAnalysis(input.selfAnalysis);
  const esBlock = renderEs(input.es);
  const matchingBlock = renderMatching(input.matching);
  const consultationBlock = renderConsultationInsights(input.consultationInsights);
  // 企業研究ログが選択されているときのみブロックを出す（未選択なら従来どおり）。
  const companyResearchBlock = formatInterviewCompanyResearchForPrompt(input.companyResearch);
  // 前段で入力した受験先・選考の想定（任意）。企業名があるときのみ出す。
  const targetBlock = buildTargetBlock(input.target);

  return [
    buildPersonaBlock(input.interviewType),
    // P3-B: 機能別指示は orchestrated.systemPrompt（buildCareerSystemPrompt 内）に既に含まれるため、
    //   同一 system message 内の二重 append を削除（schema・評価指示は不変の純粋な重複除去）。
    orchestrated.systemPrompt,
    targetBlock,
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    esBlock ? `# 直近の ES ドラフト\n${esBlock}` : '',
    matchingBlock ? `# 就活マッチング結果（参考・断定しない）\n${matchingBlock}` : '',
    consultationBlock ? `# 相談AIでの最近の気づき（参考程度）\n${consultationBlock}` : '',
    companyResearchBlock,
    `# この面接の狙い（${config.label}）\n${config.guidance}`,
    `# 深掘りで扱える観点（毎回この中から最も価値が高い1点を選ぶ）\n${CAREER_INTERVIEW_TOPICS.map((t) => `- ${t}`).join('\n')}`,
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}

// 会話履歴を transcript テキストに整形（受験版 buildTranscript 同形）。
export function buildTranscript(turns: CareerInterviewTurn[]): string {
  return turns
    .map((t) => (t.role === 'question' ? `面接官: ${t.content}` : `学生: ${t.content}`))
    .join('\n');
}

// 既出質問数（= 回答済みの質問数 ≒ answer 件数）。
export function countAnswers(turns: CareerInterviewTurn[]): number {
  return turns.filter((t) => t.role === 'answer').length;
}

// seed（1問目）生成の user プロンプト。面接の種類に応じて切り口を変える。
export function buildSeedUserPrompt(interviewType?: CareerInterviewType): string {
  const config = getInterviewModeConfig(interviewType);
  return [
    `新卒就活の面接（${config.label}）を始めます。`,
    `全${CAREER_INTERVIEW_MAX_TURNS}問程度で、後から具体を掘り下げられるように深掘りしていきます。`,
    `1問目の切り口: ${config.seedFocus}`,
    'いきなり数字や細部を問い詰めず、まずは経験の全体像を話しやすい入口にしてください。',
    '出力は質問文そのものだけ（前置き・説明・記号・引用符は付けない）。',
  ].join('\n');
}

// followup（回答を踏まえた次質問）生成の user プロンプト。JSON {reaction, question} を要求する。
export function buildFollowupUserPrompt(
  turns: CareerInterviewTurn[],
  interviewType?: CareerInterviewType,
): string {
  const config = getInterviewModeConfig(interviewType);
  const questionNumber = Math.min(countAnswers(turns) + 1, CAREER_INTERVIEW_MAX_TURNS);
  return [
    'これまでのやり取り:',
    buildTranscript(turns),
    '',
    `これは${questionNumber}問目（全${CAREER_INTERVIEW_MAX_TURNS}問程度）です。面接の種類は「${config.label}」です。`,
    `学生の直前の回答に対して、まず一言リアクション（最大1文・${config.reactionTone}）をし、`,
    'それを自然に踏まえて、次の質問を1つだけ作ってください。',
    '',
    `この面接の狙い: ${config.guidance}`,
    '',
    '深掘りの方針（重要）:',
    '- 直前の回答内容に合わせて、次の観点のうち「最も価値が高く、まだ十分に聞けていない1点」だけを選び、自然な会話の流れで1問だけ掘り下げる。',
    ...CAREER_DEEP_DIVE_AXES.map((axis) => `  ・${axis}`),
    '- 回答が抽象的・一般論なら具体例を求め、盛りすぎ・嘘っぽさを感じたら現実性（数字・事実・再現性）をやんわり確認する。',
    '- 文脈に合えば、STAR（状況・課題・行動・結果）・数字・Before/After・判断理由・学び・再現性まで自然に引き出す（ただし一度に複数を問い詰めず、尋問にしない）。',
    '- 既に聞いた論点・聞き方は繰り返さない。Yes/Noで終わる質問・答えにくい質問・説教めいた質問は避ける。',
    '- 目的は「多く質問すること」ではなく、ES・面接・マッチングで再利用できる具体的な情報を引き出すこと。',
    '',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '{ "reaction": string, "question": string }',
  ].join('\n');
}

// target（受験先・選考の想定）に応じた最終フィードバックの評価観点を組み立てる。
// companyName が無ければ空文字（従来どおりの汎用フィードバック）。
// 企業の事実は断定させず、companyMemo を最優先根拠にする方針を明示する。
function buildTargetFeedbackGuidance(
  target: CareerInterviewTarget | null | undefined,
): string {
  if (!target || !target.companyName) return '';
  const lines: string[] = [
    '# 受験先・選考の想定に向けた追加評価（targetFeedback）',
    `この面接は「${target.companyName}」を受ける想定です。上記の総合評価に加え、この企業・選考に向けた実戦的なフィードバックを targetFeedback にまとめてください。`,
    `- companyFitComment: 「${target.companyName}」を受ける面接として、回答の説得力を評価し、志望動機・企業理解・職種理解の不足を具体的に指摘する。`,
  ];
  if (target.companyMemo) {
    lines.push(
      `  企業理解の根拠は、学生の企業メモ（${target.companyMemo}）を最優先にする。メモにない事実は断定せず「入力情報上は」「企業メモを踏まえると」のように表現する。`,
    );
  } else {
    lines.push(
      '  企業メモは未入力です。企業固有の事実は断定せず、一般的な面接観点として説得力・志望動機の接続を評価する。',
    );
  }
  if (target.jobType) {
    lines.push(
      `- jobFitComment: 「${target.jobType}」で求められそうな再現性・行動特性・強みが回答から伝わるかを評価し、職種理解が浅ければ指摘し、回答内の経験がその職種でどう活きるかを補強する。`,
    );
  }

  if (target.selectionType === 'main') {
    lines.push(
      '- selectionTypeComment: 本選考として、入社後の貢献可能性・志望度の強さ・企業適合性・過去経験の再現性・「他社ではなくこの企業である理由」・採用する理由が伝わるかを評価する。',
      '  「学びたい」「成長したい」だけの受け身表現は厳しめに見て、貢献・主体性に転換するよう促す。',
    );
  } else if (target.selectionType === 'internship') {
    lines.push(
      '- selectionTypeComment: インターンとして、参加目的の明確さ・業界/企業への関心・現場理解への意欲・学びたいことの具体性・検証したい仮説・本選考への自然な接続を評価する。',
      '  「入社したい」という長期の入社意思に寄せすぎず、参加目的・学習意欲・仮説検証を重視する。',
    );
  }

  switch (target.interviewPhase) {
    case 'first':
      lines.push(
        '- phaseSpecificComment: 一次面接として、人柄が伝わるか・基本的なガクチカ/自己PRが自然か・コミュニケーションが分かりやすいか・志望動機の土台があるかを評価する。',
      );
      break;
    case 'second':
      lines.push(
        '- phaseSpecificComment: 二次面接として、経験の深掘りに耐えられるか・企業/職種理解があるか・価値観と企業の接続があるか・入社後の再現性が見えるかを評価する。',
      );
      break;
    case 'final':
      lines.push(
        '- phaseSpecificComment: 最終面接として、志望度が十分か・覚悟が伝わるか・入社後の展望があるか・他社比較に耐えられるか・長期的なキャリア観が自然かを評価する。',
      );
      break;
    case 'internship':
      lines.push(
        '- phaseSpecificComment: インターン面接として、参加目的が明確か・学習意欲が伝わるか・業界理解があるか・主体性があるか・インターンで得たいことが具体的かを評価する。',
      );
      break;
    case 'casual':
      lines.push(
        '- phaseSpecificComment: カジュアル面談として、自然な会話として成立しているか・一方的なアピールになりすぎていないか・企業理解を深める姿勢があるか・逆質問につながる観点があるか・相互理解の場として適切かを評価する。',
      );
      break;
    default:
      lines.push(
        '- phaseSpecificComment: 選考フェーズの指定はありません。一般的な面接として、この企業・選考に向けた評価を述べる。',
      );
      break;
  }

  lines.push(
    '- weakPointsForThisTarget: この企業・選考で特に落ちやすい弱点を具体的に挙げる。',
    '- nextPracticeQuestions: この企業・選考・フェーズで次に練習すべき想定質問を挙げる。',
    '- suggestedReverseQuestions: 学生から企業への逆質問案を挙げる（企業メモ・職種に紐づけ、特にカジュアル面談・最終面接・インターンで有効なもの）。',
  );
  if (target.focusPoint) {
    lines.push(
      `# 学生が特に対策したいこと（必ず触れる）\n「${target.focusPoint}」について、targetFeedback と改善点（improvements）・次にやるべきこと（nextActions）の中で必ず具体的に言及する。`,
    );
  }
  return lines.join('\n');
}

// 最終評価 system prompt（JSON 出力スキーマを明示）。面接の種類に応じて重視点を足す。
// hasCompanyResearch=true（企業研究ログを使った面接）のときは、企業研究との接続評価
// （companyResearchFit）も出力させる。未使用なら従来どおり companyFit までで完結する。
// target（受験先・選考の想定）があるときは targetFeedback も出力させる。
export function buildFinalFeedbackInstruction(
  interviewType?: CareerInterviewType,
  hasCompanyResearch = false,
  target?: CareerInterviewTarget | null,
): string {
  const hasTarget = !!(target && target.companyName);
  const config = getInterviewModeConfig(interviewType);
  const lines = [
    '# 最終フィードバック（出力形式・厳守）',
    `これまでの面接（${config.label}）のやり取り全体をもとに、新卒就活の観点で最終フィードバックを作成してください。`,
    '評価は「優しいが甘すぎない」面接官として、STAR（状況・課題・行動・結果）・結論ファースト・成果の具体性・強みの再現性・志望動機との一貫性を見て行ってください。',
    `この面接の種類で特に重視する観点: ${config.feedbackEmphasis}`,
    config.pressure
      ? '圧迫面接の評価でも、指摘は厳しくてよいが、フィードバック自体は学生が次に改善できるよう建設的にすること（人格否定は禁止）。'
      : '指摘は率直にしつつ、学生が次に改善できるよう建設的にすること。',
    '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
    '各配列は2〜4個入れ、空配列にしない。実際の回答内容に即した具体的な指摘にし、テンプレ文を避ける。',
    '事実確認が必要な企業・業界情報は断定しない。companyFit は志望業界・職種・就活軸（あれば志望企業）との相性・接続を、回答内容に即して2〜4文で述べる。',
  ];
  if (hasCompanyResearch) {
    lines.push(
      'この面接ではユーザー本人の保存済み企業研究を文脈に使いました。companyResearchFit に「企業研究との接続評価」を',
      '2〜4文で述べてください。観点は ①企業理解の活用度（企業研究で注目した点を面接で活かせたか）',
      '②志望理由との接続 ③自己分析・活動経験との接続 ④入社後ビジョンの具体性。',
      '文体は「企業研究で注目していた○○を面接で十分に活用できています」「企業研究内容はありますが志望理由への接続が弱いです」',
      '「自己分析と企業研究がうまく結びついています」のように、保存済み企業研究を根拠にする。企業情報は断定しない。',
    );
  }
  // target（受験先・選考の想定）があるときは、追加評価の観点を先に述べる。
  const targetGuidance = buildTargetFeedbackGuidance(target);
  if (targetGuidance) lines.push(targetGuidance);

  lines.push(
    '',
    '{',
    '  "overallComment": string,      // 全体評価の総括（数文）',
    '  "strengths": string[],         // 良かった点・強み',
    '  "improvements": string[],      // 改善点',
    '  "sampleAnswers": string[],     // より良い回答の例（具体的に）',
    '  "deepDiveTopics": string[],    // さらに深掘りされそうな論点',
    '  "nextActions": string[],       // 本番までに次にやるべきこと',
    `  "companyFit": string${hasCompanyResearch || hasTarget ? ',' : ''}           // 志望業界・職種・就活軸との相性・接続についての所見`,
  );
  if (hasCompanyResearch) {
    lines.push(
      `  "companyResearchFit": string${hasTarget ? ',' : ''}   // 保存済み企業研究との接続評価（企業理解の活用度・志望理由/自己分析との接続・入社後ビジョンの具体性）`,
    );
  }
  if (hasTarget) {
    lines.push(
      '  "targetFeedback": {              // 受験先・選考の想定に向けた追加フィードバック',
      '    "companyFitComment": string,       // この企業向けの説得力・不足点（企業事実は断定しない）',
      '    "phaseSpecificComment": string,    // 選考フェーズ別の評価',
      '    "jobFitComment": string,           // 職種適性・職種理解の評価（職種指定がなければ空文字）',
      '    "selectionTypeComment": string,    // 本選考/インターン別の評価（種別指定がなければ空文字）',
      '    "weakPointsForThisTarget": string[],   // この企業・選考で落ちやすい弱点',
      '    "nextPracticeQuestions": string[],     // 次に練習すべき想定質問',
      '    "suggestedReverseQuestions": string[]  // 逆質問案（企業メモ・職種に紐づける）',
      '  }',
    );
  }
  lines.push('}');
  return lines.join('\n');
}

// 最終評価 user プロンプト。
export function buildFinalUserPrompt(turns: CareerInterviewTurn[]): string {
  return [
    '面接のやり取り:',
    buildTranscript(turns),
    '',
    '上記をもとに、最終フィードバック JSON を出力してください。',
  ].join('\n');
}
