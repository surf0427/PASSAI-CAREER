// PASSAI 就活版 — プレゼン対策AI 共通プロンプト組み立て（theme / evaluate / qa 3 route 共有）。
//
// 受験版プレゼン機能の「テーマ→文字起こし→AI評価→発表後Q&A」思想を踏襲しつつ、
// 評価軸・役割・表現を新卒就活／ビジネス文脈へ全面的に差し替える。
//   - 大学受験・AO/推薦・志望校評価軸・「合格可能性」表現は一切持ち込まない。
//   - プロンプト土台は就活版共通基盤（@/lib/careerAi）からのみ組み立てる。
// 本ファイルは route ではない（共有モジュール）。

import { buildCareerAiContext } from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';
import type { CareerPersonalMemorySection } from '@/lib/careerMemory/persistence/schema';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
// P7-F: presentation は ES を presentation-local strict summary で受け取り render する
//   （full CareerEsResult carry をやめ、gakuchika/selfPr/motivation を 300 字 cap・headline 80 字 cap）。
// P15-A: render 自体は orchestrator 経由の canonical renderer が担うため、型のみ参照する。
import type { PresentationEsSummary } from '@/lib/careerMemory/presentationEs';
import type { CareerInterviewFinalResult } from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import type {
  CareerPresentationType,
  CareerPresentationQaTurn,
  CareerPresentationConfig,
  CareerPresentationRank,
} from '@/types/careerPresentation';
import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
import {
  CAREER_PRESENTATION_PROMPT_BASE,
  getSelectionTypeLabel,
  evalFocusLabels,
  resolveDifficulty,
  CAREER_PRESENTATION_DIFFICULTIES,
  buildJobTypeEmphasisLine,
  buildJobTypeThemeLine,
  buildJobTypeQaLine,
} from '@/app/career/presentation/presentationModes';

const FEATURE_KEY = 'career-presentation' as const;

export const CAREER_PRESENTATION_MODEL = 'claude-sonnet-4-6';

// 評価軸（就活・選考プレゼン文脈・お題ベース）。key は安定識別子、label は表示名。
// AI には全軸を 0〜100 で採点させ、UI でこの並びで表示する。
// 旧履歴の axes は各要素が自前の label を保持するため、ここを変えても既存表示は壊れない。
export const CAREER_PRESENTATION_AXES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'structure', label: '構成の分かりやすさ', hint: '話の順番・骨子が整理され、聞き手が追いやすいか' },
  { key: 'clarity', label: '主張の明確さ・結論ファースト', hint: '最初に結論・主張が明確に提示されているか' },
  { key: 'concreteness', label: '根拠の具体性', hint: '数字・役割・行動・成果など具体に裏づけられているか' },
  { key: 'logic', label: '論理の一貫性', hint: '主張→根拠→具体の筋が通り、矛盾がないか' },
  { key: 'persuasion', label: '説得力・聞き手意識', hint: '聞き手に響く説得力があり、相手目線で語れているか' },
  { key: 'delivery', label: '話し方・伝わりやすさ', hint: '言葉選び・テンポ・分かりやすい表現になっているか' },
  { key: 'timeManagement', label: '発表時間への収まり', hint: '発表時間に対して情報量が過不足ないか' },
  { key: 'connection', label: 'お題・企業・職種との接続／独自性', hint: 'お題や志望先・職種に接続し、自分ならではの視点があるか' },
];

// ── 総合点 / ランクの決定論算出（server が唯一の算出者）─────────────────
//
// route（evaluate/route.ts）から lift した純関数。QA harness が fixture で
// 直接検証できるようにするため（prompt を lift しているのと同じ理由）。
//
// 背景:
//   以前は AI が totalScore / rank を自己申告し、それがほぼそのまま採用されていたため
//   「8 軸が全部 40 点でも総合 85 点」が構造的に起こりえた。ES（6 軸平均）/ GD（加重平均）と
//   同じく **AI は軸だけ・総合点は server** という authority 分離に揃える。

/**
 * 8 軸スコア → 総合点（0〜100 の整数）。
 *
 * 重み: プレゼンには既存の重み概念が無い（presentationModes / prompt / config の
 *   いずれにも軸別ウェイトの定義が無い）ため **単純平均**。
 *   evaluationFocus（ユーザーが選ぶ「特に評価してほしい観点」）は prompt 側で
 *   採点の着眼点として既に効いているので、ここで二重に重み付けしない。
 *   将来ウェイトを入れる場合もこの関数 1 箇所を変えれば済む。
 */
export function computePresentationTotalScore(
  axes: readonly { score: number }[],
): number {
  if (axes.length === 0) return 0;
  const sum = axes.reduce((acc, a) => acc + (Number.isFinite(a.score) ? a.score : 0), 0);
  return Math.round(Math.max(0, Math.min(100, sum / axes.length)));
}

/**
 * 総合点 → ランク。
 * ★ プレゼン固有の閾値（S90+ / A80 / B65 / C50 / D）。他機能へ揃えない。
 */
export function presentationRankFromScore(score: number): CareerPresentationRank {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

// お題ベースプレゼンの評価コンテキスト（persona / prompt が共有）。
export type CareerPresentationPromptContext = {
  theme?: string;
  config?: CareerPresentationConfig | null;
  // 後方互換: 旧 presentationType（新規フローでは未使用でも良い）。
  presentationType?: CareerPresentationType;
  /**
   * Company Data Spine A 層（公式情報）ブロックが実際に prompt へ出るか。
   *
   * ★ true のときだけ「企業の事実を断定してよい範囲」を **公式情報ブロック内に限定**して開放する。
   *   false（既定）では従来どおり企業固有の事実を全面的に断定禁止＝出力 byte 完全互換。
   */
  hasCompanyOfficial?: boolean;
};

// お題・企業/業界/職種・選考種別・評価観点・補足メモを条件ブロックに整形する。
function buildConditionLines(ctx: CareerPresentationPromptContext): string[] {
  const cfg = ctx.config ?? undefined;
  const lines: string[] = [];
  lines.push(`【お題】${(ctx.theme ?? '').trim() || '（未入力）'}`);
  lines.push(CAREER_PRESENTATION_PROMPT_BASE.guidance);

  const conds: string[] = [];
  if (cfg?.companyName?.trim()) conds.push(`企業名: ${cfg.companyName.trim()}`);
  if (cfg?.industry?.trim()) conds.push(`業界: ${cfg.industry.trim()}`);
  if (cfg?.jobType?.trim()) conds.push(`職種: ${cfg.jobType.trim()}`);
  const selectionLabel = getSelectionTypeLabel(cfg?.selectionType);
  if (selectionLabel) conds.push(`選考種別: ${selectionLabel}`);
  if (conds.length > 0) {
    lines.push('', '【発表条件】' + conds.join(' / '));
  }

  // 職種（自由入力）から推定した「求められる力」の重心を足す（未入力なら何も足さない）。
  const jobLine = buildJobTypeEmphasisLine(cfg?.jobType);
  if (jobLine) lines.push(jobLine);

  if (cfg?.focusPoint?.trim()) {
    lines.push(`【特に練習したいこと】${cfg.focusPoint.trim()}`);
  }

  const focus = evalFocusLabels(cfg?.evaluationFocus);
  if (focus.length > 0) {
    lines.push(`【特に評価してほしい観点】${focus.join('・')}（この観点を重点的に見る）`);
  }
  if (cfg?.note?.trim()) {
    lines.push(`【補足メモ】${cfg.note.trim()}`);
  }
  return lines;
}

// 面接官・採用担当としての評価者人格（お題ベース・全セッション共通の土台）。
function buildEvaluatorPersona(ctx: CareerPresentationPromptContext): string {
  return [
    'あなたは新卒採用の選考でプレゼンを評価する、企業の採用担当（人事・現場社員・役員クラス）です。',
    'ユーザーが設定した「お題」に対する就活・選考プレゼンを評価します。',
    '大学受験（総合型選抜・学校推薦型選抜・一般入試）の文脈や、大学の評価軸・「合格可能性」という表現は一切使いません。',
    '評価は新卒就活・ビジネスの観点で行います。',
    '',
    ...buildConditionLines(ctx),
    '',
    '【評価者としての姿勢】',
    '- 「優しいが甘すぎない」。良い点は具体的に認め、課題は率直に、しかし建設的に伝える。',
    '- 抽象的な発表には具体例・数字・役割・成果を求める。盛りすぎ・嘘っぽい内容には現実性を確認する。',
    '- お題に対して「何を主張し、どんな根拠で、どう伝えたか」を軸に、結論・論理・具体性・説得力・聞き手意識・時間配分を見る。',
    '- ケース課題・企業課題提案ではビジネス妥当性・実行可能性・顧客視点・リスク認識を見る。',
    '- 人格否定・侮辱・脅しは禁止（指摘は発表内容にのみ向ける）。不安を煽りすぎず、次に何を直せばよいかを明確にする。',
    '- 事実確認が必要な企業・業界情報は断定しない。企業名だけを根拠に具体的な事業内容・課題を捏造しない（不足時は一般的な業界課題・仮説として扱う）。',
  ].join('\n');
}

// P15-A: 機能横断（自己分析 / ES / 面接 / マッチング / 相談AI）の render は Context Orchestrator 経由の
//   canonical renderer（lib/careerMemory/renderers/presentationCrossFeature）へ移設した。
//   route 側は同じ横断情報を再 render しない（byte 出力は移設前と 1 byte も変えない）。
//   ES の 4 field / cap / useCareerContext gate も canonical 実装側で不変（P7-F 由来）。

export type CareerPresentationContextInput = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  selfAnalysis?: CareerSelfAnalysisResult | null;
  // P7-F: presentation-local strict summary（cap 済み）。full CareerEsResult は受け取らない。
  es?: PresentationEsSummary | null;
  interview?: CareerInterviewFinalResult | null;
  matching?: CareerMatchEngineResult | null;
  consultationInsights?: string[] | null;
  // お題ベースプレゼンの条件（企業名・職種・観点など）。
  config?: CareerPresentationConfig | null;
  // お題（発表テーマ）。
  theme?: string;
  // 後方互換のため残す（新規フローでは未使用）。
  presentationType?: CareerPresentationType;
  // Company Data Spine A 層（Company Official Facts）の read 結果。
  //   ★ 外部・公式の一次情報（出典 URL + 取得日付き）。route が server 側で read して渡す
  //     （本 builder は純関数のまま。I/O は持たない）。
  //   未指定 / unavailable / disabled / 企業未指定のときは renderer が空 block を返し、
  //   prompt は従来と byte 互換。
  companyOfficial?: CompanyOfficialReadResult | null;
  userInput?: string;
  // Data Spine Layer 2（Personal Memory）。route が read gate / stale veto / bridge dedupe 済みで渡す。
  //   ★ `config.useCareerContext !== true`（＝本人が参考情報オフを選んだ）ときは route 側が
  //     そもそも解決しないため空になる。未指定 / 空では personalMemoryContext が '' ＝ 従来 byte 互換。
  personalMemory?: readonly CareerPersonalMemorySection[];
};

/**
 * プレゼンAIの土台 system prompt と、その付随フラグ。
 *
 * ★ `hasCompanyOfficial` をここで返す理由:
 *   route（app/ 配下）は **renderer を直接 import してはいけない**
 *   （Orchestrator が唯一の注入口という既存の architecture 不変条件。
 *     career-collective-intelligence-production-prep-qa が app/ からの
 *     careerContextRenderers import を 0 に固定している）。
 *   そのため「公式情報 block が実際に出たか」の判定は本 builder が
 *   orchestrator の出力から 1 度だけ行い、route へ渡す。
 *   これにより user prompt 側の guard と system 側の block が乖離しない。
 */
export type PresentationSystemParts = {
  system: string;
  hasCompanyOfficial: boolean;
};

export function buildPresentationSystemParts(
  input: CareerPresentationContextInput,
): PresentationSystemParts {
  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile: input.profile ?? null,
    activity: input.activity ?? null,
    values: input.values ?? null,
    userInput: input.userInput ?? '',
  });
  // P3-C: base system prompt を Context Orchestrator（purpose=presentation_feedback）経由で取得する。
  //   委譲のため出力は現行と同一（evaluate/qa の response・schema・P0.5 予算は不変）。
  // P15-A: 機能横断 context（自己分析/ES/面接/マッチング/相談AI）の組み立ても orchestrator へ移設。
  //   route 側は手組みせず、orchestrated.crossFeatureContext を受け取る。useCareerContext gate は
  //   canonical renderer 側で不変。output byte は移設前と同一（byte parity harness で担保）。
  const orchestrated = buildCareerContextForPurpose('presentation_feedback', context, {
    presentation: {
      useCareerContext: input.config?.useCareerContext === true,
      selfAnalysis: input.selfAnalysis ?? null,
      es: input.es ?? null,
      interview: input.interview ?? null,
      matching: input.matching ?? null,
      consultationInsights: input.consultationInsights ?? null,
    },
    // Company Data Spine A 層。renderer が purpose allowlist / budget / provenance を強制する。
    //   ★ 面接・企業研究と **同じ type・同じ renderer・同じ extras key** を使う
    //     （プレゼン専用の並行 architecture を作らない）。
    ...(input.companyOfficial ? { company: input.companyOfficial } : {}),
    // Data Spine Layer 2（Personal Memory）。allowlist は self_analysis / interview。
    //   面接の長期傾向（繰り返し指摘された改善点 / 安定した強み）は crossFeature が描画しない
    //   情報で、発表の改善提案に直結する。
    ...(input.personalMemory && input.personalMemory.length > 0
      ? { personalMemory: input.personalMemory }
      : {}),
  });

  const ctx: CareerPresentationPromptContext = {
    theme: input.theme,
    config: input.config ?? undefined,
    presentationType: input.presentationType,
    // A 層 block が実際に出るときだけ、企業事実の扱いを「公式情報の範囲内」へ開放する。
    hasCompanyOfficial: orchestrated.companyOfficialContext !== '',
  };

  const system = [
    buildEvaluatorPersona(ctx),
    // P3-C: 機能別指示は orchestrated.systemPrompt 内に既に含まれるため、同一 system 内の
    //   二重 append を削除（純粋な重複除去）。
    orchestrated.systemPrompt,
    // Company Data Spine A 層（公式情報）。★ 他 block とは **別ブロック**として並べる。
    //   公式事実 / 本人の経験・内省 / AI 派生を混ぜないのが Spine の中核契約。
    //   企業未指定 / 未取得 / flag OFF のときは '' ＝ 従来 byte 互換。
    orchestrated.companyOfficialContext,
    // P15-A: refGuard + 各参考ブロックは orchestrated.crossFeatureContext に決定的に集約済み。
    orchestrated.crossFeatureContext,
    // Data Spine Layer 2（Personal Memory）。★ 公式情報 / crossFeature とは **別ブロック**の
    //   低優先な参考情報として 1 回だけ結合する。section が無ければ '' ＝ 従来 byte 互換。
    orchestrated.personalMemoryContext,
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  return { system, hasCompanyOfficial: orchestrated.companyOfficialContext !== '' };
}

/** 既存 callsite / byte parity harness 互換の薄い wrapper（出力は従来と同一）。 */
export function buildPresentationBaseSystem(input: CareerPresentationContextInput): string {
  return buildPresentationSystemParts(input).system;
}

// AIお題生成の user プロンプト（企業/業界/職種・選考種別・発表時間・難易度・
// 直近お題(excludeThemes)を考慮。連続生成で似すぎないよう切り口を変える）。
export function buildThemeUserPrompt(params: {
  config?: CareerPresentationConfig | null;
  timeLimitSec?: number;
  difficulty?: unknown;
  excludeThemes?: string[];
  /**
   * Company Data Spine A 層 block が system 側に出ているか（既定 false）。
   * true のときだけ「公式情報にある事実は使ってよい」へ緩める（範囲は公式情報内に限定）。
   */
  hasCompanyOfficial?: boolean;
}): string {
  const cfg = params.config ?? undefined;
  const difficulty = resolveDifficulty(params.difficulty);
  const diffCfg = CAREER_PRESENTATION_DIFFICULTIES.find((d) => d.key === difficulty);
  const timeLimitSec = typeof params.timeLimitSec === 'number' ? params.timeLimitSec : 0;
  const fmtTime = timeLimitSec > 0 ? `${Math.floor(timeLimitSec / 60)}分` : '指定なし';

  const selectionLabel = getSelectionTypeLabel(cfg?.selectionType);

  const conds: string[] = [];
  if (cfg?.companyName?.trim()) conds.push(`企業名: ${cfg.companyName.trim()}`);
  if (cfg?.industry?.trim()) conds.push(`業界: ${cfg.industry.trim()}`);
  if (cfg?.jobType?.trim()) conds.push(`職種: ${cfg.jobType.trim()}`);
  if (selectionLabel) conds.push(`選考種別: ${selectionLabel}`);
  if (cfg?.focusPoint?.trim()) conds.push(`特に練習したいこと: ${cfg.focusPoint.trim()}`);

  // 直近生成お題（重複・空を除き最大5件）。
  const exclude = (params.excludeThemes ?? [])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t) => t !== '')
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 5);

  return [
    '新卒就活の選考プレゼン練習用に、本番でありそうな「お題（プレゼンテーマ）」を1つだけ提案してください。',
    `狙い: ${CAREER_PRESENTATION_PROMPT_BASE.themeFocus}`,
    `発表時間: ${fmtTime}（この時間で発表しきれる粒度にする）`,
    `難易度: ${diffCfg?.label ?? '標準'}（${diffCfg?.hint ?? ''}）`,
    conds.length > 0 ? `考慮する条件: ${conds.join(' / ')}` : '',
    buildJobTypeThemeLine(cfg?.jobType),
    `切り口の例（この中から選ぶ／別の切り口でもよい）: ${CAREER_PRESENTATION_PROMPT_BASE.angles.join('、')}`,
    exclude.length > 0
      ? [
          '次のお題は既に出したものです。これらと似すぎる内容・論点は避けてください:',
          ...exclude.map((t) => `- ${t}`),
          '切り口を変え、前回とは異なる論点のお題にしてください。',
        ].join('\n')
      : '',
    cfg?.companyName?.trim()
      ? params.hasCompanyOfficial
        ? 'この企業を受ける想定のお題にする。企業の事実として使ってよいのは system 側の【公式情報】ブロックにある内容だけで、そこに無い事業内容・制度・課題は断定・捏造しない。'
        : 'この企業を受ける想定のお題にする。ただし企業の事業内容・制度・課題を断定・捏造しない。'
      : '',
    cfg?.industry?.trim() && !cfg?.companyName?.trim()
      ? 'その業界で出やすいテーマに寄せる。特定企業の事実は出さない。'
      : '',
    // 企業情報の確度に関わらず常に置く hallucination ガード
    //（旧「企業メモが無い場合は…」という companyMemo 前提の分岐を、無条件の指示に置き換えた）。
    //   A 層がある場合も「公式情報の外は断定しない」という制約は残す（緩めるのは範囲だけ）。
    params.hasCompanyOfficial
      ? '【公式情報】に無い企業・業界の具体的な事実は断定せず、情報が不足する範囲は一般的な業界課題・職種理解・選考文脈として扱う。'
      : '企業・業界の具体的な事実は断定せず、情報が不足する範囲は一般的な業界課題・職種理解・選考文脈として扱う。',
    '出力はお題の文そのものだけ（前置き・説明・記号・引用符・コードブロックは付けない）。',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

// 評価対象（発表内容）を整形した user プロンプト（お題・条件を含む）。
export function buildEvaluateUserPrompt(params: {
  theme: string;
  timeLimitSec: number;
  durationSec: number;
  transcript: string;
  config?: CareerPresentationConfig | null;
}): string {
  const { theme, timeLimitSec, durationSec, transcript, config } = params;
  const fmt = (sec: number) => (sec > 0 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : '未設定');
  return [
    '# 評価対象のプレゼン',
    ...buildConditionLines({ theme, config }),
    '',
    `発表時間: 制限 ${fmt(timeLimitSec)} / 実測 ${fmt(durationSec)}`,
    '',
    '発表の文字起こし（または発表原稿）:',
    transcript || '（発表内容が空です）',
    '',
    'このお題に対する発表を評価し、最終レポート JSON を出力してください。',
    '時間配分（timeManagement）は、制限時間と実際の発表時間の差をもとに判定してください（制限時間が「未設定」の場合は情報量の過不足で判断する）。',
  ].join('\n');
}

// 評価レポートの出力スキーマ・採点基準。
export function buildEvaluateInstruction(ctx: CareerPresentationPromptContext): string {
  const axisList = CAREER_PRESENTATION_AXES.map(
    (a) => `    { "key": "${a.key}", "label": "${a.label}", "score": 0〜100の整数, "comment": "${a.hint}に関する具体的な所見（1文・60字以内）" }`,
  ).join(',\n');
  const jobEmphasis = buildJobTypeEmphasisLine(ctx.config?.jobType);
  return [
    '# 最終レポート（出力形式・厳守）',
    'このお題に対する発表を、新卒就活・選考プレゼンの観点で評価し、最終レポートを作成してください。',
    `今回特に重視する観点: ${CAREER_PRESENTATION_PROMPT_BASE.evaluationEmphasis}`,
    jobEmphasis
      ? `${jobEmphasis} この職種観点は companyFit・expectedQuestions・interviewerConcerns にも反映する。`
      : '',
    '評価軸（axes）は以下の8軸すべてを、それぞれ 0〜100 の整数で採点し、key/label は指定どおりにしてください。',
    // ★ 総合点・ランクは AI に出させない（server が 8 軸から決定論で算出する）。
    //   以前は AI が totalScore / rank を自己申告し、それがほぼそのまま採用されていたため、
    //   「8 軸が全部 40 点でも総合 85 点」が構造的に起こりえた。
    '★ 総合点（totalScore）とランク（rank）は出力しないでください。8軸のスコアから自動的に算出されます。',
    '★ そのため、8軸それぞれの採点が総合評価そのものになります。印象で甘くつけず、軸ごとに根拠をもって採点してください。',
    'structureFeedback は構成（話す順番・骨子）への、persuasionFeedback は説得力への、deliveryFeedback は話し方・伝え方への、それぞれ2文の個別フィードバック。',
    // 出力長の契約（P1: runtime budget 内に収めるための上限）。
    //   ★ 評価項目そのものは 1 つも削っていない（8 軸・全 field を維持）。
    //     1 項目あたりの冗長さだけを縛る。実測で自然長 4144 tok / 73s → budget 超過だったため。
    'overallComment は2文。各文は簡潔に書き、同じ内容を言い換えて繰り返さない。前置き・要約の再掲をしない。',
    'improvedStructure は「改善版の構成例（話す順番のアウトライン）」であり、発表の完成原稿を代筆してはいけません（箇条書きの構成のみ）。',
    'passLikelihood は選考通過可能性についての所見を、断定せず根拠とともに2文で述べる（「合格可能性」という受験表現は使わない）。',
    ctx.hasCompanyOfficial
      ? 'companyFit は志望業界・職種・志望企業との相性・接続を2文で述べる。企業側の事実は【公式情報】ブロックにある内容だけを根拠にし、発表がその実像と噛み合っているかで評価する。'
      : 'companyFit は志望業界・職種（あれば志望企業）との相性・接続を2文で述べる。企業条件が未設定なら一般的なビジネス視点で述べる。',
    'expectedQuestions と interviewerConcerns では、この発表に対して想定される追加質問・深掘り質問・突っ込まれそうな点を挙げる。',
    ctx.hasCompanyOfficial
      ? '各配列は2〜3個・1 要素 1 文（40字以内）で入れ、空配列にしない。発表内容に即した具体的な指摘にし、テンプレ文を避ける。【公式情報】に無い企業情報は断定しない。'
      : '各配列は2〜3個・1 要素 1 文（40字以内）で入れ、空配列にしない。発表内容に即した具体的な指摘にし、テンプレ文を避ける。事実確認が必要な企業情報は断定しない。',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '',
    '{',
    '  "overallComment": string,',
    '  "axes": [',
    axisList,
    '  ],',
    '  "goodPoints": string[],',
    '  "improvements": string[],',
    '  "priorityImprovements": string[],',
    '  "nextPractice": string[],',
    '  "expectedQuestions": string[],',
    '  "improvedStructure": string[],',
    '  "structureFeedback": string,',
    '  "persuasionFeedback": string,',
    '  "deliveryFeedback": string,',
    '  "passLikelihood": string,',
    '  "companyFit": string,',
    '  "interviewerConcerns": string[]',
    '}',
  ].join('\n');
}

// 発表後Q&A（ターン制）の transcript 整形。
function buildQaTranscript(turns: CareerPresentationQaTurn[]): string {
  return turns
    .map((t) => (t.role === 'question' ? `面接官: ${t.content}` : `学生: ${t.content}`))
    .join('\n');
}

export function countQaAnswers(turns: CareerPresentationQaTurn[]): number {
  return turns.filter((t) => t.role === 'answer').length;
}

export const CAREER_PRESENTATION_QA_MAX_TURNS = 4;

// ── 発表後 Q&A 全体の最終評価 ────────────────────────────────────────
//
// ★ 本編プレゼン評価（CAREER_PRESENTATION_AXES / buildEvaluateInstruction）とは責務を分ける。
//   本編は「発表そのもの」を 8 軸で評価する。こちらは **質疑応答での受け答えだけ**を評価し、
//   本編評価の再掲・スコア再算出はしない（result.result は一切書き換えない）。
//
// Q&A 評価軸（4 軸）。key は安定識別子、label は表示名（本編 axes と同じ形）。
export const CAREER_PRESENTATION_QA_AXES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'qaLogic', label: '回答の論理性', hint: '質問の意図を捉え、主張→根拠の筋が通っているか' },
  { key: 'qaDirectness', label: '質問への直接性', hint: '聞かれたことに正面から答え、論点をずらしていないか' },
  { key: 'qaEvidence', label: '根拠・具体性', hint: '数字・役割・行動・成果など具体に裏づけて答えているか' },
  { key: 'qaConsistency', label: '発表本編との一貫性', hint: '発表で述べた主張と矛盾せず、深掘りに耐えているか' },
];

/**
 * Q&A 最終評価の user プロンプト。JSON {overallComment, axes, goodPoints, improvements, nextPractice} を要求。
 *
 * ★ 入力は「発表の文字起こし」＋「質疑応答の全ターン」。turns には **最後のユーザー回答まで**が
 *   含まれている前提（route が countQaAnswers >= 1 を検証し、client は確定済み配列を送る）。
 * ★ 総合点・ランクは AI に出させない（server が 4 軸から決定論で算出する）。
 *   本編評価・ES・GD と同じ authority 分離。
 */
export function buildQaFinalUserPrompt(params: {
  theme: string;
  transcript: string;
  turns: CareerPresentationQaTurn[];
  config?: CareerPresentationConfig | null;
}): string {
  const { theme, transcript, turns, config } = params;
  const axisList = CAREER_PRESENTATION_QA_AXES.map(
    (a) => `    { "key": "${a.key}", "label": "${a.label}", "score": 0〜100の整数, "comment": "${a.hint}に関する具体的な所見（1文・60字以内）" }`,
  ).join(',\n');
  const jobEmphasis = buildJobTypeEmphasisLine(config?.jobType);
  const lines: string[] = [
    'これはプレゼン発表後の質疑応答（想定: 採用担当からの質問）が終了した後の、**質疑応答全体の最終評価**です。',
    `お題: ${theme || '（未入力）'}`,
    '',
    '発表の文字起こし:',
    transcript || '（発表内容が空です）',
    '',
    '質疑応答の全記録（これが評価対象です）:',
    buildQaTranscript(turns),
    '',
    '# 出力形式（厳守）',
    '学生の**回答（質疑応答での受け答え）**だけを評価してください。発表本編の評価は別途行っているため、ここでは再掲しません。',
    jobEmphasis ? `${jobEmphasis} この職種観点は改善アドバイスにも反映する。` : '',
    '評価軸（axes）は以下の4軸すべてを、それぞれ 0〜100 の整数で採点し、key/label は指定どおりにしてください。',
    '★ 総合点（totalScore）とランク（rank）は出力しないでください。4軸のスコアから自動的に算出されます。',
    '★ そのため、4軸それぞれの採点が総合評価そのものになります。印象で甘くつけず、軸ごとに根拠をもって採点してください。',
    'overallComment は質疑応答全体の総評を2文で。回答ごとの逐次コメントの羅列にしない。',
    'goodPoints・improvements・nextPractice は各2〜3個・1要素1文（40字以内）で入れ、空配列にしない。',
    'improvements は「どの質問への回答が、なぜ弱かったか」が分かる具体的な指摘にする。テンプレ文を避ける。',
    'nextPractice は次回の質疑応答に向けて何を準備・改善すべきかの行動アドバイスにする。',
    '人格否定はせず、指摘は回答内容にのみ向ける。事実確認が必要な企業情報は断定しない。',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '',
    '{',
    '  "overallComment": string,',
    '  "axes": [',
    axisList,
    '  ],',
    '  "goodPoints": string[],',
    '  "improvements": string[],',
    '  "nextPractice": string[]',
    '}',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

// Q&A の質問生成 user プロンプト（kickoff / followup 兼用）。JSON {reaction, question} を要求。
export function buildQaUserPrompt(params: {
  theme: string;
  transcript: string;
  turns: CareerPresentationQaTurn[];
  config?: CareerPresentationConfig | null;
}): string {
  const { theme, transcript, turns, config } = params;
  const isKickoff = turns.length === 0;
  const lines: string[] = [
    'これはプレゼン発表後の質疑応答（想定: 採用担当からの質問）です。',
    `お題: ${theme || '（未入力）'}`,
    '',
    '発表の文字起こし:',
    transcript || '（発表内容が空です）',
  ];
  if (!isKickoff) {
    lines.push('', 'これまでの質疑応答:', buildQaTranscript(turns));
  }
  const jobQaLine = buildJobTypeQaLine(config?.jobType);
  lines.push('', `本番聞かれやすい深掘りの方向: ${CAREER_PRESENTATION_PROMPT_BASE.qaFocus}`);
  if (jobQaLine) lines.push(jobQaLine);
  lines.push(
    isKickoff
      ? '発表内容に対して、採用担当が実際に聞きそうな鋭い質問を1つだけ作ってください。最初の reaction は空文字で構いません。'
      : '学生の直前の回答に対して、まず一言リアクション（最大1文・甘すぎない）をし、それを踏まえて次の質問を1つだけ作ってください。',
    '抽象的な回答には具体例・数字・根拠を求める質問にし、発表の弱点や一貫性を確認する。Yes/Noで終わる質問・人格否定は避ける。',
    '職種の方向は本番で聞かれそうな深掘りの手掛かりに留め、発表内容に無い前提を作り込みすぎない。',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '{ "reaction": string, "question": string }',
  );
  return lines.join('\n');
}
