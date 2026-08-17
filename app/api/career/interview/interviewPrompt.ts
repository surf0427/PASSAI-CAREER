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
import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
// P15-B: 企業研究ブロックの render は orchestrator 経由の interview canonical renderer が担うため、
//   本ファイルでは型のみ参照する（formatInterviewCompanyResearchForPrompt の呼び出しは renderer 側）。
import type { InterviewCompanyResearchContext } from '@/lib/careerCompanyResearch/context';
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
// companyName が無ければ空文字（＝旧 target / 企業を特定しない過去セッションでは従来どおり）。
// 企業の事実は断定させない（企業情報は企業分析 / Company Data Spine 側の領分。
// 面接側でユーザーに企業メモを再入力させる設計は廃止した）。
//
// ★ モード差の担保（自己分析モードだけ target の使い方が違う）:
//   自己分析モードは「自分自身を説明する力」を鍛える場なので、企業名が与えられていても
//   志望動機・企業理解の深掘りを増やさない。target は背景情報としてのみ渡す。
//   企業理解 / 本番 / 圧迫は従来どおり志望動機・企業理解・職種理解の深掘りを増やす。
//
// ★ hasCompanyOfficial（A 層あり）のときだけ、事実の扱いを **より厳密に**書き分ける。
//   A 層が無いときは「企業の事実は一切断定しない」で正しいが、A 層があるときに同じ文言のままだと
//   「出典付きで与えた公式事実すら使ってはいけない」と読めてしまい、統合の意味が消える。
//   そこで「断定してよいのは公式情報 block にある事実だけ」と範囲を限定する
//   （捏造禁止は緩めない。むしろ根拠の所在を明示する分だけ強い制約になる）。
function buildTargetBlock(
  target: CareerInterviewTarget | null | undefined,
  interviewType?: CareerInterviewType,
  hasCompanyOfficial = false,
): string {
  if (!target || !target.companyName) return '';
  const selfOnly = interviewType === 'self_analysis';
  const lines: string[] = [
    '# 今回の受験先・選考の想定',
    selfOnly
      ? `この面接は「${target.companyName}」を受ける想定です。ただし今回は自己分析モードのため、志望動機・企業理解の確認は主題にせず、この情報は背景としてのみ扱ってください（学生自身の経験・強み・価値観の深掘りに集中する）。`
      : `この面接は「${target.companyName}」を受ける想定で行ってください。志望動機・企業理解・職種理解に関する深掘りを自然に増やしてください。`,
    hasCompanyOfficial
      ? `「${target.companyName}」について事実として言及してよいのは、下の【公式情報】ブロックに出典付きで示されている内容だけです。そこに無い事業内容・待遇・選考フロー・社風などは断定・捏造せず、学生自身の理解と理由を問う形にしてください。`
      : `ただし「${target.companyName}」の事業内容・待遇・選考フロー・社風などの事実は断定・捏造せず、学生自身の理解と理由を問う形にしてください。`,
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

// P15-B: 機能横断（自己分析 / ES / マッチング / 相談AI / 企業研究）の render は Context Orchestrator 経由の
//   canonical renderer（lib/careerMemory/renderers/interviewCrossFeature）へ移設した。
//   builder 側は同じ横断情報を再 render しない（byte 出力は移設前と 1 byte も変えない）。
//   Interview 固有 contract（自己分析の developmentPoints / ES cap なし / マッチングの developmentAreas）は
//   canonical 実装側で維持する（presentation renderer へは寄せない）。

export type CareerInterviewContextInput = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  selfAnalysis?: CareerSelfAnalysisResult | null;
  es?: CareerEsResult | null;
  // 任意の参考データ（存在しなくても落ちない／プロンプトに出さないだけ）。
  matching?: CareerMatchEngineResult | null;
  consultationInsights?: string[] | null;
  // 保存済み企業研究（Company Data Spine B 層 = User Private Evidence）。
  //   ★ ユーザー本人の解釈・メモ。「あなたの記述では」と扱う（A 層の公式事実とは別物）。
  companyResearch?: InterviewCompanyResearchContext | null;
  // Company Data Spine A 層（Company Official Facts）の read 結果。
  //   ★ 外部・公式の一次情報（出典 URL + 取得日付き）。route が server 側で read して渡す
  //     （本 builder は純関数のまま。I/O は持たない）。
  //   未指定 / unavailable / disabled のときは renderer が空 block を返し、prompt は従来と byte 互換。
  companyOfficial?: CompanyOfficialReadResult | null;
  // 前段で入力した受験先・選考の想定。企業・業界・職種・選考種別に合わせて深掘りする。
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
  // P15-B: 機能横断 context（自己分析/ES/マッチング/相談AI/企業研究）の組み立ても orchestrator へ移設。
  //   builder 側は手組みせず、orchestrated.crossFeatureContext を targetBlock と面接の狙いの間に置く
  //   （挿入位置・順序・見出しは移設前と同一）。output byte は不変（byte parity harness で担保）。
  const orchestrated = buildCareerContextForPurpose('interview_practice', context, {
    interview: {
      selfAnalysis: input.selfAnalysis ?? null,
      es: input.es ?? null,
      matching: input.matching ?? null,
      consultationInsights: input.consultationInsights ?? null,
      companyResearch: input.companyResearch ?? null,
    },
    // Company Data Spine A 層。renderer が purpose allowlist / budget / provenance を強制する。
    //   ★ 既存 company_research_review と **同じ type・同じ renderer・同じ extras key** を使う
    //     （面接専用の並行 architecture を作らない）。
    ...(input.companyOfficial ? { company: input.companyOfficial } : {}),
  });

  const config = getInterviewModeConfig(input.interviewType);
  // 前段で入力した受験先・選考の想定。企業名があるときのみ出す（旧セッション互換で欠損可）。
  //   A 層 block が実際に出るときだけ、事実として言及してよい範囲を公式情報へ限定する。
  const targetBlock = buildTargetBlock(
    input.target,
    input.interviewType,
    orchestrated.companyOfficialContext !== '',
  );

  return [
    buildPersonaBlock(input.interviewType),
    // P3-B: 機能別指示は orchestrated.systemPrompt（buildCareerSystemPrompt 内）に既に含まれるため、
    //   同一 system message 内の二重 append を削除（schema・評価指示は不変の純粋な重複除去）。
    orchestrated.systemPrompt,
    targetBlock,
    // Company Data Spine A 層（公式情報）。★ B 層（下の crossFeatureContext 内の企業研究メモ）とは
    //   **別ブロック**として並べる。公式事実 / 本人の解釈 / AI 派生を混ぜないのが Spine の中核契約。
    //   data が無い（A 層未取得 / flag OFF / 企業未解決 / 自己分析モード）ときは '' ＝ 従来 byte 互換。
    orchestrated.companyOfficialContext,
    // P15-B: 自己分析/ES/マッチング/相談AI/企業研究の各ブロックは crossFeatureContext に決定的に集約済み。
    orchestrated.crossFeatureContext,
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

// operative prompt へ target 原文を差し込む際の安全な長さ制限（肥大化防止）。
// system 側にも同じ値が入るため、user 側は必要最小限の参照にとどめる。
function clipForPrompt(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// target（受験先・選考の想定）を初回質問（seed）の operative な入口選択指示に変換する。
// companyName が無ければ空文字（＝従来どおり byte 不変）。「答えやすい入口」という性質は保つ。
// 反映優先度は focusPoint → jobType。未入力項目は指示に含めない。
function buildSeedTargetHook(
  target: CareerInterviewTarget | null | undefined,
): string {
  if (!target || !target.companyName) return '';
  const lines: string[] = [
    'この面接は特定の受験先を想定しています。1問目は答えやすい入口のまま、次に配慮して切り口を選んでください（初回から詰問・細かい数値・失敗理由の深掘りはしない）:',
  ];
  if (target.focusPoint) {
    lines.push(
      `- 学生が特に練習したいのは「${clipForPrompt(target.focusPoint)}」。この点へ後の質問でつなげやすい、経験の全体像を話せる入口を優先する。`,
    );
  }
  if (target.jobType) {
    lines.push(
      `- 志望職種は「${target.jobType}」。この職種で求められる力を後の深掘りで確認しやすいエピソードに触れられる入口を選ぶ。`,
    );
  }
  lines.push('- ただし target の語句をそのまま復唱せず、自然で答えやすい質問文にする。');
  return lines.join('\n');
}

// target を中盤深掘り（followup）の operative な質問選択の優先度指示に変換する。
// 既存の CAREER_DEEP_DIVE_AXES を置き換えず、優先順位だけ足す。companyName 無しは空文字。
// focusPoint を最優先扱いにする。未入力項目は指示に含めない。
function buildFollowupTargetHook(
  target: CareerInterviewTarget | null | undefined,
): string {
  if (!target || !target.companyName) return '';
  const lines: string[] = [
    '受験先の想定を踏まえた質問選択の優先度（上の汎用深掘り軸は残したまま、優先順位だけ調整する）:',
  ];
  if (target.focusPoint) {
    lines.push(
      `- 最優先: 学生が特に練習したい「${clipForPrompt(target.focusPoint)}」に関わる力・経験・根拠がまだ十分に確認できていなければ、次の質問で優先的に掘る。ただし既に十分聞けた／直前に同じ観点を聞いた／回答と接続できない／不自然な話題転換になる場合は無理に聞かない。`,
    );
  }
  if (target.jobType) {
    lines.push(
      `- 志望職種「${target.jobType}」で必要になりそうな力（課題把握・関係構築・提案の組み立て・巻き込み・目標への行動・再現性などのうち回答文脈に合うもの）が回答から確認できていなければ、それを確認する深掘りを候補に含める。職種名だけから企業固有の採用基準は捏造しない。`,
    );
  }
  lines.push(
    '- いずれも target の語句をそのまま復唱せず、直前までの回答と自然に統合した1問にする。既出の論点・聞き方は繰り返さない。',
  );
  return lines.join('\n');
}

// seed（1問目）生成の user プロンプト。面接の種類に応じて切り口を変える。
// target があるときのみ、入口選択の operative な指示を追加する（未入力時は byte 不変）。
export function buildSeedUserPrompt(
  interviewType?: CareerInterviewType,
  target?: CareerInterviewTarget | null,
): string {
  const config = getInterviewModeConfig(interviewType);
  const lines: string[] = [
    `新卒就活の面接（${config.label}）を始めます。`,
    `全${CAREER_INTERVIEW_MAX_TURNS}問程度で、後から具体を掘り下げられるように深掘りしていきます。`,
    `1問目の切り口: ${config.seedFocus}`,
    'いきなり数字や細部を問い詰めず、まずは経験の全体像を話しやすい入口にしてください。',
  ];
  const targetHook = buildSeedTargetHook(target);
  if (targetHook) lines.push(targetHook);
  lines.push('出力は質問文そのものだけ（前置き・説明・記号・引用符は付けない）。');
  return lines.join('\n');
}

// followup（回答を踏まえた次質問）生成の user プロンプト。JSON {reaction, question} を要求する。
// target があるときのみ、汎用深掘り軸に加えて質問選択の優先度指示を差し込む（未入力時は byte 不変）。
export function buildFollowupUserPrompt(
  turns: CareerInterviewTurn[],
  interviewType?: CareerInterviewType,
  target?: CareerInterviewTarget | null,
): string {
  const config = getInterviewModeConfig(interviewType);
  const questionNumber = Math.min(countAnswers(turns) + 1, CAREER_INTERVIEW_MAX_TURNS);
  const lines: string[] = [
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
  ];
  const targetHook = buildFollowupTargetHook(target);
  if (targetHook) lines.push('', targetHook);
  lines.push(
    '',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '{ "reaction": string, "question": string }',
  );
  return lines.join('\n');
}

// target（受験先・選考の想定）に応じた最終フィードバックの評価観点を組み立てる。
// companyName が無ければ空文字（従来どおりの汎用フィードバック）。
// 企業の事実は断定させない（企業情報は企業分析 / Company Data Spine 側の領分）。
function buildTargetFeedbackGuidance(
  target: CareerInterviewTarget | null | undefined,
): string {
  if (!target || !target.companyName) return '';
  const lines: string[] = [
    '# 受験先・選考の想定に向けた追加評価（targetFeedback）',
    `この面接は「${target.companyName}」を受ける想定です。上記の総合評価に加え、この企業・選考に向けた実戦的なフィードバックを targetFeedback にまとめてください。`,
    `- companyFitComment: 「${target.companyName}」を受ける面接として、回答の説得力を評価し、志望動機・企業理解・職種理解の不足を具体的に指摘する。`,
  ];
  lines.push(
    '  企業固有の事実は断定せず、一般的な面接観点として説得力・志望動機の接続を評価する。',
  );
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

  // ★ 選考フェーズ（interviewPhase）入力は廃止。phaseSpecificComment も出力させない
  //   （型・結果画面は過去ログ表示のためだけに残している）。
  lines.push(
    '- weakPointsForThisTarget: この企業・選考で特に落ちやすい弱点を具体的に挙げる。',
    '- nextPracticeQuestions: この企業・選考で次に練習すべき想定質問を挙げる。',
    '- suggestedReverseQuestions: 学生から企業への逆質問案を挙げる（志望職種に紐づけ、特に最終面接・インターンで有効なもの）。',
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
      '    "jobFitComment": string,           // 職種適性・職種理解の評価（職種指定がなければ空文字）',
      '    "selectionTypeComment": string,    // 本選考/インターン別の評価（種別指定がなければ空文字）',
      '    "weakPointsForThisTarget": string[],   // この企業・選考で落ちやすい弱点',
      '    "nextPracticeQuestions": string[],     // 次に練習すべき想定質問',
      '    "suggestedReverseQuestions": string[]  // 逆質問案（志望職種に紐づける）',
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
