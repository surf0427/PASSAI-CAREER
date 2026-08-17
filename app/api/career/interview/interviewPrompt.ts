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
import type { CareerPersonalMemorySection } from '@/lib/careerMemory/persistence/schema';
// P15-B: 企業研究ブロックの render は orchestrator 経由の interview canonical renderer が担うため、
//   本ファイルでは型のみ参照する（formatInterviewCompanyResearchForPrompt の呼び出しは renderer 側）。
import type { InterviewCompanyResearchContext } from '@/lib/careerCompanyResearch/context';
import {
  getInterviewModeConfig,
  buildInterviewRubricLines,
  SHARED_INTERVIEWER_RULES,
  type CareerInterviewModeConfig,
} from '@/app/career/interview/interviewModes';

// 機能キー（就活版共通基盤の出し分け）。
const FEATURE_KEY = 'career-interview' as const;

// 受験版面接AIと同系の Sonnet を使用（課金/usage には接続しない）。
export const CAREER_INTERVIEW_MODEL = 'claude-sonnet-4-6';

// 回答ターン上限（受験版 INTERVIEW_AI_MAX_ANSWER_TURNS=5 を踏襲）。
export const CAREER_INTERVIEW_MAX_TURNS = 5;

// 面接で扱う質問テーマ / 深掘り軸は **モード固有**（interviewModes.ts の config.topicPool /
// config.deepDiveAxes）。
//   ★ ここに全モード共通のプールを置かない。共通プールに戻すと「モード名だけ違う面接」へ退行し、
//     質問の種類・配分・深掘り方法がモード間で同一になってしまう（career-interview-mode-差別化 QA が禁止）。

// 面接中の「これまでの回答との整合性」確認（本番 / 圧迫モードのみ）。
//   ★ 学生が実際に発言していない内容を捏造させないことが最優先の制約。
function buildConsistencyCheckBlock(config: CareerInterviewModeConfig): string {
  if (!config.checksAnswerConsistency) return '';
  return [
    'これまでの回答との整合性（このモードでのみ行う）:',
    config.pressure
      ? '- 上のやり取り全体を見て、発言の食い違い・言い換えによるすり替え・当初の主張からの後退があれば、それを最優先で突く。「先ほどは〇〇とおっしゃいましたが、今の説明とどう両立しますか」のように、該当箇所を示して説明を求める。'
      : '- 上のやり取り全体を見て、明らかな食い違いや説明の後退があれば、「先ほど〇〇とおっしゃっていましたが、今の回答との関係を説明してください」のように自然に確認する。',
    '- ★ 引用してよいのは上の transcript に実際にある学生の発言だけ。言っていない内容を「先ほど〇〇と言っていましたが」と作り出すことは絶対に禁止。',
    '- 矛盾が見当たらないときはこの深掘りを行わず、通常の深掘り軸から選ぶ（無理に矛盾を作らない）。',
  ].join('\n');
}

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
  if (target.industry) {
    lines.push(
      selfOnly
        ? `- 志望業界: ${target.industry}（今回は背景情報。業界理解の確認は主題にしない）`
        : `- 志望業界: ${target.industry}。「なぜこの業界か」「業界の変化・課題をどう捉えているか」「他業界ではなくこの業界である理由」「自分の経験と業界の接続」を確認できる質問を必要に応じて含めてください。業界の統計・動向を事実として断定しないこと。`,
    );
  }
  if (target.jobType) {
    lines.push(
      selfOnly
        ? `- 志望職種: ${target.jobType}（今回は背景情報。職種適性の確認は主題にしない）`
        : `- 志望職種: ${target.jobType}。この職種で求められる力・適性・必要な経験・強みの活かし方・志望理由の重心を、この職種に合わせて変えてください。ただしこの企業固有の採用要件・求める人物像を知らないまま断定・捏造しないこと。`,
    );
  }

  // 選考種別は「表示項目」ではなく、深掘りの重心そのものを変える指示にする。
  //   ★ 自己分析モードでは選考種別で質問の重心を変えない（自分自身の言語化に集中する場のため）。
  if (target.selectionType === 'main') {
    lines.push(
      selfOnly
        ? '- 選考種別: 本選考（今回は背景情報）。'
        : '- 選考種別: 本選考。入社意思・志望度の強さ・キャリアとの一貫性・企業適合性・過去経験の再現性・入社後に何ができるか・「なぜ競合ではなくこの企業か」の比重を上げて深掘りしてください。',
    );
  } else if (target.selectionType === 'internship') {
    lines.push(
      selfOnly
        ? '- 選考種別: インターン（今回は背景情報）。'
        : '- 選考種別: インターン。学習意欲・好奇心・成長可能性・参加目的・行動力・プログラムとの適合・インターンを通して何を得たいか・検証したい仮説の比重を上げて深掘りしてください。',
      selfOnly
        ? ''
        : '  長期の入社意思を前提にした断定的な志望確認（入社後の貢献の詰め）には寄せすぎないでください。',
    );
  }

  if (target.focusPoint) {
    lines.push(
      `# 学生が特に対策したいこと（重点対策）\n「${target.focusPoint}」`,
      'この面接は「通常の面接 + 重点対策」です。上のテーマに関わる論点は、通常より一段深く連鎖的に掘ってください（主張 → なぜそう言えるのか → その判断の根拠 → 本人の経験との接続、の順に降りる）。',
      'ただし全質問をこのテーマだけにしないでください。通常の面接進行の中に重点対策を織り込み、他の観点も確認してください。',
    );
  }
  return lines.filter((s) => s !== '').join('\n');
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
  // Data Spine Layer 2（Personal Memory）の **検証済み fresh section**（route の server loader が read/gate/dedupe 済み）。
  //   ★ ユーザー由来の参考情報であり信頼済み instruction ではない（renderer が injection 境界を付ける）。
  //   未指定 / 空 のときは personalMemoryContext が '' になり、prompt は従来と byte 互換。
  personalMemory?: readonly CareerPersonalMemorySection[] | null;
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
    // Data Spine Layer 2（Personal Memory）。orchestrator が purpose 別に選択・render・budget enforce する。
    //   route 側で bridge と重複する section は dedupe 済み（bridge wins / memory fills gaps）。
    ...(input.personalMemory && input.personalMemory.length > 0
      ? { personalMemory: input.personalMemory }
      : {}),
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
    // Data Spine Layer 2（Personal Memory）。★ base / crossFeature / 公式情報とは **別ブロック**の
    //   低優先な参考情報として、1 回だけ結合する。section が無ければ '' ＝ 従来 byte 互換。
    orchestrated.personalMemoryContext,
    `# この面接の狙い（${config.label}）\n${config.guidance}`,
    // ★ モード固有の質問領域プール。モードが変われば質問の種類・配分そのものが変わる。
    `# この面接で扱う質問領域（${config.label}／毎回この中から最も価値が高い1点を選ぶ）\n${config.topicPool
      .map((t) => `- ${t}`)
      .join('\n')}`,
    // ★ 与えた context を全部毎回使わせない（token / latency 抑制と、モード別の焦点付けを兼ねる）。
    `# 参照する文脈の優先順位（${config.label}）\n${config.contextUsage}`,
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
// 反映優先度は focusPoint → jobType → industry → selectionType。未入力項目は指示に含めない。
//
// ★ モード差: 自己分析モードは業界・選考種別で入口を変えない（学生自身の経験から入る）。
//   企業理解モードは 1 問目から企業・業界への関心を入口にしてよい（他モードは経験から入る）。
function buildSeedTargetHook(
  target: CareerInterviewTarget | null | undefined,
  interviewType?: CareerInterviewType,
): string {
  if (!target || !target.companyName) return '';
  const selfOnly = interviewType === 'self_analysis';
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
      selfOnly
        ? `- 志望職種は「${target.jobType}」だが、今回は自己分析モードなので職種要件から入らない。学生自身の経験・価値観が表れる入口を選ぶ。`
        : `- 志望職種は「${target.jobType}」。この職種で求められる力を後の深掘りで確認しやすいエピソードに触れられる入口を選ぶ。`,
    );
  }
  if (target.industry && !selfOnly) {
    lines.push(
      interviewType === 'motivation'
        ? `- 志望業界は「${target.industry}」。企業理解モードのため、1問目から企業・業界への関心の入口（なぜここに関心を持ったか）にしてよい。ただし業界知識を問うクイズにはしない。`
        : `- 志望業界は「${target.industry}」。1問目では業界知識を問わず、後の質問で業界との接続を確認しやすい入口にとどめる。`,
    );
  }
  if (target.selectionType && !selfOnly) {
    lines.push(
      target.selectionType === 'internship'
        ? '- 選考種別はインターン。入社意思の確認から入らず、関心・行動・学びたいことにつながる入口を選ぶ。'
        : '- 選考種別は本選考。1問目から圧をかけず、後の深掘りで志望度・再現性を確認できる入口を選ぶ。',
    );
  }
  lines.push('- ただし target の語句をそのまま復唱せず、自然で答えやすい質問文にする。');
  return lines.join('\n');
}

// target を中盤深掘り（followup）の operative な質問選択の優先度指示に変換する。
// モード固有の深掘り軸（config.deepDiveAxes）を置き換えず、優先順位だけ足す。companyName 無しは空文字。
// focusPoint を最優先扱いにする。未入力項目は指示に含めない。
//
// ★ モード差: 自己分析モードは業界・選考種別・企業固有性で深掘り優先度を変えない
//   （企業対策は企業理解モード以降の役割）。
function buildFollowupTargetHook(
  target: CareerInterviewTarget | null | undefined,
  interviewType?: CareerInterviewType,
): string {
  if (!target || !target.companyName) return '';
  const selfOnly = interviewType === 'self_analysis';
  const lines: string[] = [
    '受験先の想定を踏まえた質問選択の優先度（上の深掘り軸は残したまま、優先順位だけ調整する）:',
  ];
  if (target.focusPoint) {
    lines.push(
      `- 最優先: 学生が特に練習したい「${clipForPrompt(target.focusPoint)}」に関わる力・経験・根拠がまだ十分に確認できていなければ、次の質問で優先的に掘る。1回の確認で終わらせず、既に一度聞けている場合は一段深い層（主張 → なぜそう言えるか → 判断の根拠 → 本人の経験との接続）へ降ろす。ただし既に十分聞けた／直前に同じ観点を聞いた／回答と接続できない／不自然な話題転換になる場合は無理に聞かない。`,
    );
  }
  if (target.jobType) {
    lines.push(
      selfOnly
        ? `- 志望職種「${target.jobType}」は背景情報にとどめる。職種要件の確認より、学生自身の行動理由・強みの再現性を優先して掘る。`
        : `- 志望職種「${target.jobType}」で必要になりそうな力（課題把握・関係構築・提案の組み立て・巻き込み・目標への行動・再現性などのうち回答文脈に合うもの）が回答から確認できていなければ、それを確認する深掘りを候補に含める。職種名だけから企業固有の採用基準は捏造しない。`,
    );
  }
  if (target.industry && !selfOnly) {
    lines.push(
      `- 志望業界「${target.industry}」について、「なぜこの業界か」「業界の変化・課題をどう捉えているか」「他業界ではなくこの業界である理由」「自分の経験がこの業界でどう活きるか」のうち、まだ確認できていない点があれば深掘り候補に含める。業界の統計・動向を面接官側から事実として断定しない。`,
    );
  }
  if (target.selectionType && !selfOnly) {
    lines.push(
      target.selectionType === 'main'
        ? '- 選考種別は本選考。入社意思・志望度の強さ・キャリアとの一貫性・「なぜ競合ではなくこの企業か」・過去経験の再現性・入社後に何ができるか を確認する深掘りを優先度上位に置く。'
        : '- 選考種別はインターン。参加目的・学びたいこと・好奇心と行動力・成長可能性・プログラムで検証したい仮説 を確認する深掘りを優先度上位に置く。長期の入社意思を問い詰める方向には寄せない。',
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
  const targetHook = buildSeedTargetHook(target, interviewType);
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
    `深掘りの方針（${config.label}／重要）:`,
    '- 直前の回答内容に合わせて、次の観点のうち「最も価値が高く、まだ十分に聞けていない1点」だけを選び、自然な会話の流れで1問だけ掘り下げる。',
    // ★ モード固有の深掘り軸。ここが全モード共通に戻ると「深掘り方法が同じ面接」へ退行する。
    ...config.deepDiveAxes.map((axis) => `  ・${axis}`),
    `- 追及の強さ（このモードの水準）: ${config.followupIntensity}`,
    '- 回答が抽象的・一般論なら具体例を求め、盛りすぎ・嘘っぽさを感じたら現実性（数字・事実・再現性）を確認する。',
    '- 既に聞いた論点・聞き方は繰り返さない。Yes/Noで終わる質問・答えにくい質問・説教めいた質問は避ける。',
    '- 目的は「多く質問すること」ではなく、ES・面接・マッチングで再利用できる具体的な情報を引き出すこと。',
  ];
  const consistencyBlock = buildConsistencyCheckBlock(config);
  if (consistencyBlock) lines.push('', consistencyBlock);
  const targetHook = buildFollowupTargetHook(target, interviewType);
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
  if (target.industry) {
    lines.push(
      `  併せて「${target.industry}」業界を志望する理由（なぜ他業界ではないのか・業界の変化や課題の捉え方・自分の経験と業界の接続）が回答から伝わるかも評価する。業界の統計・動向は断定しない。`,
    );
  }
  if (target.jobType) {
    lines.push(
      `- jobFitComment: 「${target.jobType}」で求められそうな再現性・行動特性・強みが回答から伝わるかを評価し、職種理解が浅ければ指摘し、回答内の経験がその職種でどう活きるかを補強する。`,
    );
  }

  // ★ 選考種別は「表示項目」ではなく評価ウェイトそのものを動かす。
  //   上のモード別 rubric に対する上書き指示として扱う。
  if (target.selectionType === 'main') {
    lines.push(
      '- selectionTypeComment: 本選考として、入社意思・志望度の強さ・キャリアとの一貫性・企業適合性・過去経験の再現性・入社後に何ができるか・「なぜ競合ではなくこの企業か」・採用する理由が伝わるかを評価する。',
      '  ★ 本選考のため、上の評価ウェイトのうち 企業理解・企業適合 / 志望理由の深さ / 強みの再現性 を一段上げて採点する（インターンより厳しい水準で見る）。',
      '  「学びたい」「成長したい」だけの受け身表現は厳しめに見て、貢献・主体性に転換するよう促す。',
    );
  } else if (target.selectionType === 'internship') {
    lines.push(
      '- selectionTypeComment: インターンとして、学習意欲・好奇心・成長可能性・参加目的の明確さ・行動力・プログラムとの適合・インターンを通して何を得たいか・検証したい仮説を評価する。',
      '  ★ インターンのため、上の評価ウェイトのうち 学習意欲・好奇心・成長可能性・参加目的の具体性 を一段上げ、入社意思の強さ・入社後の貢献可能性の比重は下げて採点する。',
      '  「入社したい」という長期の入社意思の弱さを減点材料にしない。参加目的・学習意欲・仮説検証の具体性で判断する。',
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
      `# 学生が特に対策したいこと（重点対策・必ず触れる）\n学生は「${target.focusPoint}」を重点対策として指定しています。`,
      '改善点（improvements）の少なくとも1つは、この重点対策そのものへの評価にしてください。文頭を「重点対策として指定された「（テーマ）」については、」の形で始め、今回の回答でその点がどこまでできていたか・何が足りなかったかを具体的に述べる。',
      '次にやるべきこと（nextActions）にも、この重点対策を伸ばすための具体的な次アクションを1つ以上入れる。',
      '重点対策に触れられるだけの材料が回答内に無い場合は、その旨（今回の面接では十分に確認できなかった）を書き、次に何を準備して臨むべきかを示す。材料が無いまま評価を捏造しない。',
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
    '',
    // ── モード別の評価ウェイト（単一の共通 rubric にしない） ────────────────
    `## 評価ウェイト（${config.label}）`,
    '同じ回答でも、面接の種類によって配点は変わります。今回は次のウェイトで採点してください。',
    '[最重視] は総合評価を実質的に決める軸、[重視] は弱いと総合評価が下がる軸、[通常] は標準配点、[参考] は大きく加点も減点もしない軸、[対象外] は今回の面接では評価しない軸です。',
    ...buildInterviewRubricLines(config),
    '[対象外] の観点は overallComment / strengths / improvements の主題にしないでください（今回の練習目的から外れるため）。',
    '',
    // ── 採点難易度（threshold そのものを変える。固定減点はしない） ──────────
    `## 採点の水準（難易度 ${config.difficultyRank}/4）`,
    '面接の種類ごとに「何を満たせば高評価か」の到達条件が違います（自己分析モード < 企業理解モード < 本番モード < 圧迫面接モード の順に要求水準が上がります）。',
    config.scoringStandard,
    '★ 難易度に応じて一律に点を引くような不自然な減点はしないでください。上の到達条件を満たしているかどうかだけで判断してください。',
    '',
    `## 改善提案の重心（${config.label}）`,
    `improvements と nextActions は次を中心に構成してください: ${config.improvementFocus}`,
    config.pressure
      ? '圧迫面接の評価でも、指摘は厳しくてよいが、フィードバック自体は学生が次に改善できるよう建設的にすること（人格否定・人格への言及は禁止。評価対象は回答内容のみ）。'
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
