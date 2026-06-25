// PASSAI 就活版 AI 共通基盤 — プロンプト組み立て
//
// 就活版 AI の共通 system prompt を組み立てる純粋関数群。
// 受験版（AO・推薦・大学入試）のプロンプトには一切依存・接続しない（新規にゼロから定義）。
//
// 方針:
//   - 新卒就活（日本の大学生）向け。
//   - ES・自己分析・面接・企業研究・GD・適性に共通で応用できる土台。
//   - 受験版の AO・推薦・大学入試文脈を含めない。
//   - 断定しすぎず、本人の実体験から言語化する支援に徹する。
//   - 企業研究では、事実確認が必要な情報（事業内容・待遇・選考フロー等）を断定しない。
//   - 面接では回答を丸暗記させず、本人らしい話し方に整える。

import type {
  CareerAiContext,
  CareerAiFeatureKey,
  CareerProfileContext,
  CareerActivityContext,
  CareerValuesContext,
} from './types';
import { CAREER_AI_FEATURE_LABELS } from './types';

// すべての機能で共有する基本方針（system prompt の土台）。
const CAREER_BASE_POLICY = [
  'あなたは、日本の大学生・大学院生の新卒就職活動を支援するAIアシスタントです。',
  '対象は新卒就活であり、大学受験（総合型選抜・学校推薦型選抜・一般入試）の文脈は扱いません。',
  '',
  '基本姿勢:',
  '- 学生本人の実体験・具体的なエピソードから、強みや価値観を言語化する手助けをします。',
  '- 断定しすぎず、本人が自分の言葉で語れるように問いかけ・整理・提案を行います。',
  '- 一般論で埋めず、与えられたプロフィールと活動経験に即して具体的に応答します。',
  '- 事実確認が必要な情報（企業の事業内容・財務・待遇・選考フロー・最新の募集要項など）は、',
  '  断定せず「公式情報で確認してください」と促し、推測は推測とわかる形で示します。',
  '- 面接対策では、回答を丸暗記させるのではなく、本人らしい自然な話し方に整えることを重視します。',
  '- 差別的・誇張・虚偽の表現は用いず、誠実で再現可能な内容に留めます。',
].join('\n');

// 機能ごとの追加指示。featureKey で出し分ける。
const CAREER_FEATURE_INSTRUCTIONS: Record<CareerAiFeatureKey, string> = {
  'career-self-analysis': [
    '【自己分析】',
    '- 活動経験を深掘りし、強み・価値観・モチベーションの源泉を本人と一緒に言語化します。',
    '- 「なぜそうしたか」「何を感じたか」を問い、抽象的な長所ではなく根拠のある強みに落とします。',
  ].join('\n'),
  'career-es': [
    '【エントリーシート（ES）】',
    '- 設問の意図を踏まえ、結論→具体（経験・行動・結果）→学び の構成で下書きを支援します。',
    '- 盛りすぎ・テンプレ化を避け、本人の経験に裏打ちされた表現に整えます。',
    '- 文字数指定があればそれに合わせて調整します。',
  ].join('\n'),
  'career-interview': [
    '【面接対策】',
    '- 想定質問と、本人の経験に基づく回答の骨子づくりを支援します。',
    '- 丸暗記用の完成原稿ではなく、要点・話す順番・想定深掘りを示し、本人らしい話し方に整えます。',
  ].join('\n'),
  'career-consultation': [
    '【就活相談】',
    '- 進め方・スケジュール・迷いの整理など、就活全般の相談に伴走します。',
    '- 不安を否定せず、次に取れる小さな一歩を一緒に決めます。',
  ].join('\n'),
  'career-company-matching': [
    '【企業マッチング】',
    '- プロフィール・活動・自己分析・ES・面接・相談の結果を統合し、価値観/強み/働き方/志向の相性を分析します。',
    '- 企業名を並べるだけでなく「なぜ向いているのか」を必ず根拠とともに可視化することを最優先にします。',
    '- 実在する日本国内の企業のみを扱い、根拠が弱い場合は「候補」と明記します。',
    '- 年収・福利厚生などの待遇は断定せず、事実確認が必要な点は公式情報での確認を促します。',
  ].join('\n'),
  'career-company-research': [
    '【企業研究】',
    '- 業界・企業を理解する観点（事業・職種・働き方・求める人物像など）の整理を支援します。',
    '- 具体的な事業内容・待遇・選考情報などの事実は断定せず、公式情報での確認を促します。',
  ].join('\n'),
  'career-gd': [
    '【グループディスカッション（GD）】',
    '- テーマの捉え方、役割（進行・書記・タイムキーパー等）、論点整理の進め方を支援します。',
    '- 結論の出し方とチームへの貢献の仕方を、本人の動き方に即して具体化します。',
  ].join('\n'),
  'career-aptitude': [
    '【適性検査対策】',
    '- 出題形式の理解と、解き方・時間配分の方針づくりを支援します。',
    '- 実際の問題の正答そのものではなく、考え方・準備の進め方を中心に扱います。',
  ].join('\n'),
};

// 機能別の追加指示を返す。
export function buildCareerFeatureInstruction(featureKey: CareerAiFeatureKey): string {
  return CAREER_FEATURE_INSTRUCTIONS[featureKey];
}

// プロフィールコンテキストを system prompt 用の可読テキストに整形する。
function renderProfile(profile: CareerProfileContext): string {
  const lines: string[] = [];
  const push = (label: string, value: string) => {
    if (value.trim() !== '') lines.push(`- ${label}: ${value}`);
  };
  const pushList = (label: string, values: string[]) => {
    if (values.length > 0) lines.push(`- ${label}: ${values.join('、')}`);
  };

  push('氏名', profile.name);
  push('大学', profile.university);
  push('学部', profile.faculty);
  push('学年', profile.grade);
  push('卒業予定年', profile.graduationYear);
  pushList('志望業界', profile.targetIndustries);
  pushList('志望職種', profile.targetJobs);
  pushList('志望企業', profile.targetCompanies);
  push('就活状況', profile.jobHuntingStatus);
  pushList('強み', profile.strengths);
  pushList('弱み', profile.weaknesses);
  pushList('保有資格', profile.certifications);
  push('インターン経験', profile.internshipExperience);
  push('留学経験', profile.studyAbroadExperience);
  pushList('希望勤務地', profile.preferredLocations);
  push('備考', profile.notes);

  return lines.length > 0 ? lines.join('\n') : '- （プロフィール未入力）';
}

// 活動コンテキストを system prompt 用の可読テキストに整形する。
function renderActivity(activity: CareerActivityContext): string {
  const sections: Array<[label: string, lines: string[]]> = [
    ['MBTI・性格', activity.personality],
    ['学業・学生時代の活動', activity.academics],
    ['アルバイト', activity.partTimeJobs],
    ['インターン', activity.internships],
    ['サークル・部活動', activity.clubActivities],
    ['プロジェクト経験', activity.projects],
    ['リーダー経験', activity.leadership],
    ['ボランティア・社会活動', activity.volunteer],
    ['海外経験', activity.overseas],
    ['資格', activity.certifications],
    ['ITスキル', activity.itSkills],
    ['語学', activity.languages],
    ['趣味・特技', activity.hobbies],
    ['表彰・実績', activity.awards],
    ['SNS・情報発信', activity.snsActivities],
    ['ポートフォリオ・制作物', activity.portfolios],
    ['人生経験', activity.lifeExperiences],
    ['その他', activity.others],
  ];

  const rendered = sections
    .filter(([, lines]) => lines.length > 0)
    .map(([label, lines]) => `■ ${label}\n${lines.map((l) => `  - ${l}`).join('\n')}`);

  return rendered.length > 0 ? rendered.join('\n') : '- （活動・経験は未入力）';
}

// 就活軸整理（/career/values）を system prompt 用の可読テキストに整形する。
// 何も入力が無ければ null を返し、呼び出し側はブロック自体を出さない
//   → 就活軸未入力の既存ユーザーでは prompt が従来と完全一致し、AI 挙動・cache に影響しない。
function renderValues(values: CareerValuesContext): string | null {
  const lines: string[] = [];
  const pushList = (label: string, items: string[]) => {
    if (items.length > 0) lines.push(`- ${label}: ${items.join('、')}`);
  };
  const pushNote = (label: string, note: string) => {
    if (note.trim() !== '') lines.push(`- ${label}（補足）: ${note.trim()}`);
  };

  pushList('重視する条件', values.priorities);
  pushNote('重視する条件', values.notes.priorities);
  pushList('避けたい条件', values.avoidances);
  pushNote('避けたい条件', values.notes.avoidances);
  pushList('興味ある業界', values.industries);
  pushNote('興味ある業界', values.notes.industries);
  pushList('興味ある職種', values.jobTypes);
  pushNote('興味ある職種', values.notes.jobTypes);
  pushList('働き方の希望', values.workStyles);
  pushNote('働き方の希望', values.notes.workStyles);
  pushList('会社タイプ', values.companyTypes);
  pushNote('会社タイプ', values.notes.companyTypes);
  pushList('キャリア志向', values.careerGoals);
  pushNote('キャリア志向', values.notes.careerGoals);
  pushList('人間関係・社風', values.culturePreferences);
  pushNote('人間関係・社風', values.notes.culturePreferences);
  if (values.overallNote.trim() !== '') {
    lines.push(`- 総合備考: ${values.overallNote.trim()}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

// 就活版 AI の共通 system prompt を組み立てる。
// 基本方針 + 機能別指示 + 学生プロフィール + 活動経験 + 就活軸（入力があれば）+ ユーザー入力（あれば）を 1 つにまとめる。
export function buildCareerSystemPrompt(context: CareerAiContext): string {
  const featureLabel = CAREER_AI_FEATURE_LABELS[context.featureKey];

  const blocks: string[] = [
    CAREER_BASE_POLICY,
    `今回の機能: ${featureLabel}`,
    buildCareerFeatureInstruction(context.featureKey),
    `# 学生プロフィール\n${renderProfile(context.profile)}`,
    `# 活動・経験\n${renderActivity(context.activity)}`,
  ];

  // 就活軸整理は「入力があるときだけ」セクションを足す（未入力ユーザーへの影響ゼロ）。
  const valuesBlock = renderValues(context.values);
  if (valuesBlock) {
    blocks.push(`# 就活軸（重視・回避・志向）\n${valuesBlock}`);
  }

  if (context.userInput.trim() !== '') {
    blocks.push(`# ユーザーからの入力・相談\n${context.userInput.trim()}`);
  }

  return blocks.join('\n\n');
}
