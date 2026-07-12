/*
 * scripts/career-es-orchestrator-parity-qa.ts
 *
 * PASSAI CAREER — P15-C: ES 生成 prompt の byte parity QA（dev-only 常設 harness）。
 *
 * 目的（P15-C）:
 *   「ES 生成で使用している機能横断 context（自己分析）の組み立てを Context Orchestrator 側へ移す」
 *   構造変更（+ route inline assembly の pure builder 抽出）の前後で、完成 system / user prompt が
 *   **UTF-8 byte 列として同一**であることを常設で守る。
 *
 *   本 harness は自己完結の legacyBuild（リファクタ前の route inline assembly を **逐語複製**した
 *   old 参照）と、production の buildEsGenerationPrompt（新経路）を全 fixture で比較する。
 *   legacyBuild は local renderSelfAnalysis と 2 引数 orchestrator 呼び出し（extras なし）を使い、
 *   production は orchestrated.crossFeatureContext を使う。両者が byte 一致すれば移設・抽出が正しい。
 *   golden も併せて固定し回帰を検知する。
 *
 * 厳守:
 *   - production の純関数（esPrompt.ts の buildEsGenerationPrompt）を **読むだけ**。
 *   - route / AI schema / request・response body / model / timeout / retry / DB / Supabase / env / secret
 *     非接続。外部 AI 非実行・実データ非参照。日時・乱数・不安定 key 順を持ち込まない。
 *   - es_generation のみが対象（es_review / presentation / interview は扱わない）。
 *
 * 使い方:
 *   npx tsx scripts/career-es-orchestrator-parity-qa.ts            # legacy vs production 比較 + golden
 *   npx tsx scripts/career-es-orchestrator-parity-qa.ts --update   # golden を現在の production 出力に固定
 * 終了コード: 全 fixture EXACT_MATCH（legacy==production, golden一致）→ 0 / 差分 → 1。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
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
import {
  buildEsGenerationPrompt,
  type EsGenerationPromptInput,
} from '@/app/api/career/es/esPrompt';

const cast = <T>(v: unknown): T => v as T;

const GOLDEN_DIR = join(process.cwd(), 'scripts/fixtures/es-orchestrator-parity');
const UPDATE = process.argv.includes('--update') || process.env.UPDATE === '1';

// ══════════════════════════════════════════════════════════════════════════
//  legacyBuild — リファクタ前（route.ts inline assembly）の逐語複製（old 参照）
//  helpers / local renderSelfAnalysis / 2 引数 orchestrator 呼び出しをそのまま再現する。
// ══════════════════════════════════════════════════════════════════════════
const LEGACY_FEATURE_KEY = 'career-es' as const;

const LEGACY_OUTPUT_FORMAT_INSTRUCTION = [
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

function legacyBuildAnswerFormatInstruction(charLimit: number | null): string {
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
  lines.push('', '{', '  "answer": string  // 設問に対する回答本文ドラフト', '}');
  return lines.join('\n');
}

function legacyBuildCompanyInstruction(companyName: string): string {
  return [
    `# 志望企業: ${companyName}`,
    `- どの企業にも当てはまる汎用文ではなく、「${companyName}」を志望する文脈に寄せた言い回しにしてください。`,
    '- ただし企業分析データは未接続です。事業内容・待遇・選考フロー・社風などの事実は',
    '  断定・捏造せず、本人の価値観や経験と企業の一般的な志望理由の接続にとどめてください。',
  ].join('\n');
}

function legacyBuildTargetingInstruction(params: {
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

function legacyBuildCompanyResearchInstruction(formatted: string): string {
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

function legacyRenderSelfAnalysis(result: CareerSelfAnalysisResult | null): string {
  if (!result) return '';
  const lines: string[] = [];
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

function legacyBuild(input: EsGenerationPromptInput): { system: string; user: string } {
  const answerMode = input.question !== '';
  const context = buildCareerAiContext({
    featureKey: LEGACY_FEATURE_KEY,
    profile: input.profile,
    activity: input.activity,
    values: input.values,
    userInput: input.userInput,
  });
  // 旧経路: 2 引数呼び出し（extras なし）。
  const orchestrated = buildCareerContextForPurpose('es_generation', context);

  const selfAnalysisBlock = legacyRenderSelfAnalysis(input.selfAnalysis);
  const companyBlock = input.companyName ? legacyBuildCompanyInstruction(input.companyName) : '';
  const targetingBlock = legacyBuildTargetingInstruction({
    selectionType: input.selectionType,
    industry: input.industry,
    jobType: input.jobType,
  });
  const researchBlock = input.researchSnapshot
    ? legacyBuildCompanyResearchInstruction(
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
    ? legacyBuildAnswerFormatInstruction(input.charLimit)
    : LEGACY_OUTPUT_FORMAT_INSTRUCTION;

  const system = [
    orchestrated.systemPrompt,
    companyBlock,
    targetingBlock,
    researchBlock,
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    questionBlock,
    outputFormat,
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  const user = [
    buildCareerFeatureInstruction(LEGACY_FEATURE_KEY),
    '',
    answerMode
      ? '以上を踏まえ、指定の JSON 形式で設問への回答ドラフトのみを出力してください。'
      : '以上を踏まえ、指定の JSON 形式で ES ドラフトのみを出力してください。',
  ].join('\n');

  return { system, user };
}

// ══════════════════════════════════════════════════════════════════════════
//  fixtures（決定的。PII 項目・全生成分岐を網羅）
// ══════════════════════════════════════════════════════════════════════════
const selfAnalysis = (multi: boolean): CareerSelfAnalysisResult =>
  cast({
    summary: '全体所感テキスト',
    careerDirection: '方向性テキスト',
    strengths: multi ? ['強みA', '強みB', '強みC'] : ['強みA'],
    strengthKeywords: multi ? ['論理', '推進'] : ['論理'],
    valueKeywords: multi ? ['挑戦', '誠実'] : ['挑戦'],
    weaknesses: multi ? ['弱みA', '弱みB'] : ['弱みA'],
    gakuchikaIdeas: multi ? ['ガクチカ1', 'ガクチカ2'] : ['ガクチカ1'],
    selfPrIdeas: multi ? ['PR1', 'PR2'] : ['PR1'],
    esAngles: multi ? ['切り口1', '切り口2'] : ['切り口1'],
  });

// PII 項目を明示的に埋めた profile（policy=include のため base prompt に出る想定）。
const profilePii = cast<CareerProfileInput>({
  name: '山田太郎',
  university: '東京大学',
  faculty: '工学部',
  email: 'yamada@example.com',
  phone: '090-1234-5678',
});

const activityMulti = cast<CareerActivityInput>({
  academics: { detail: '研究室でのデータ分析' },
  extracurricular: { detail: 'サークルの代表として運営' },
  work: { detail: '長期インターンで新規事業開発' },
});

const valuesMulti = cast<CareerValuesInput>({
  selections: { priorities: ['成長', '社会貢献', '裁量'] },
  overallNote: '裁量のある環境で働きたい',
});

const research = (): CompanyResearchSnapshot =>
  cast({
    logId: 'log1',
    companyName: 'サンプル株式会社',
    industry: 'IT・通信',
    interestLevel: 'high',
    updatedAt: '2026-07-01T00:00:00.000Z',
    verifiedResearchTextPreview: '本人記述の抜粋テキスト',
    reviewSummary: 'AI添削サマリ',
    fitSummary: '本人情報とのすり合わせ',
    interviewContextSummary: '面接連携メモ',
  });

// 基本の base（profile or activity のいずれか必須）。
const baseProfile = cast<CareerProfileInput>({ name: '本人', targetIndustries: ['IT'] });

type Fixture = { name: string; input: EsGenerationPromptInput };
const F = (over: Partial<EsGenerationPromptInput>): EsGenerationPromptInput => ({
  profile: baseProfile,
  activity: null,
  values: null,
  selfAnalysis: null,
  userInput: '',
  question: '',
  companyName: '',
  charLimit: null,
  selectionType: null,
  industry: '',
  jobType: '',
  researchSnapshot: null,
  ...over,
});

const FIXTURES: Fixture[] = [
  { name: 'normal', input: F({ selfAnalysis: selfAnalysis(false), companyName: 'サンプル株式会社', industry: 'IT・通信', jobType: 'エンジニア', selectionType: 'main' }) },
  { name: 'heavy', input: F({ profile: profilePii, activity: activityMulti, values: valuesMulti, selfAnalysis: selfAnalysis(true), companyName: 'サンプル株式会社', industry: 'IT・通信', jobType: 'プロダクトマネージャー', selectionType: 'main', researchSnapshot: research(), question: '学生時代に力を入れたことを教えてください', charLimit: 400 }) },
  { name: 'missing', input: F({}) },
  { name: 'pii-profile', input: F({ profile: profilePii }) },
  { name: 'activity-multi-section', input: F({ activity: activityMulti }) },
  { name: 'values-multi', input: F({ values: valuesMulti }) },
  { name: 'self-analysis-single', input: F({ selfAnalysis: selfAnalysis(false) }) },
  { name: 'self-analysis-multi', input: F({ selfAnalysis: selfAnalysis(true) }) },
  { name: 'company-basic', input: F({ companyName: 'サンプル株式会社' }) },
  { name: 'company-research', input: F({ companyName: 'サンプル株式会社', researchSnapshot: research() }) },
  { name: 'question-mode', input: F({ question: 'あなたの強みは何ですか', selfAnalysis: selfAnalysis(false) }) },
  { name: 'charLimit-small', input: F({ question: 'あなたの強みは何ですか', charLimit: 120 }) },
  { name: 'charLimit-large', input: F({ question: 'あなたの強みは何ですか', charLimit: 800 }) },
  { name: 'selection-main', input: F({ selectionType: 'main', industry: 'IT・通信', jobType: 'エンジニア' }) },
  { name: 'selection-internship', input: F({ selectionType: 'internship', industry: 'コンサル' }) },
  { name: 'selection-none', input: F({ industry: 'メーカー', jobType: '営業' }) },
  {
    name: 'all-context',
    input: F({
      profile: profilePii, activity: activityMulti, values: valuesMulti, selfAnalysis: selfAnalysis(true),
      companyName: 'サンプル株式会社', industry: 'IT・通信', jobType: 'エンジニア', selectionType: 'main',
      researchSnapshot: research(), question: '志望動機を教えてください', charLimit: 600, userInput: '補足メモ',
    }),
  },
];

// PII 項目別（種類・件数を old/new で一致させる）。
const PII_ITEMS: Record<string, string> = {
  氏名: '山田太郎',
  大学: '東京大学',
  学部: '工学部',
  メール: 'yamada@example.com',
  電話: '090-1234-5678',
};

// 位置観測用マーカー（indexOf を old/new で一致させる）。
const POSITION_MARKERS: Record<string, string> = {
  charLimit_question: '指定文字数: ',
  charLimit_answerfmt: '文字数は ',
  question: '# ES設問（この設問に直接答えてください）',
  selection_main: '# 選考種別: 本選考',
  selection_intern: '# 選考種別: インターン応募',
  company_research: '# 保存済みの企業研究（ユーザー本人が作成・確認したもの）',
  self_analysis: '# 直近の自己分析結果',
  company: '# 志望企業: ',
  industry: '# 志望業界: ',
  jobType: '# 志望職種: ',
};

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const countOccur = (s: string, sub: string) => (sub === '' ? 0 : s.split(sub).length - 1);
const lineCount = (s: string) => s.split('\n').length;

type Metrics = {
  systemBytes: number; systemHash: string; systemLines: number;
  userBytes: number; userHash: string;
  pii: Record<string, number>;
  positions: Record<string, number>;
};
function metricsOf(system: string, user: string): Metrics {
  const pii: Record<string, number> = {};
  for (const [k, v] of Object.entries(PII_ITEMS)) pii[k] = countOccur(system, v);
  const positions: Record<string, number> = {};
  for (const [k, v] of Object.entries(POSITION_MARKERS)) positions[k] = system.indexOf(v);
  return {
    systemBytes: bytes(system), systemHash: sha256(system), systemLines: lineCount(system),
    userBytes: bytes(user), userHash: sha256(user),
    pii, positions,
  };
}

const goldenPath = (name: string) => join(GOLDEN_DIR, `${name}.txt`);
const metricsPath = (name: string) => join(GOLDEN_DIR, `${name}.metrics.json`);
if (UPDATE && !existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

let failures = 0;
const note = (ok: boolean, msg: string) => {
  if (!ok) { console.log(`❌ ${msg}`); failures++; }
};

console.log(`# ES generation orchestrator byte parity QA (${UPDATE ? 'UPDATE' : 'COMPARE'})`);
console.log('');
console.log('| Fixture | sys bytes | lines | hash(head) | 氏名 | legacy==prod | golden |');
console.log('|---|---:|---:|---|---:|---|---|');

for (const f of FIXTURES) {
  const prod = buildEsGenerationPrompt(f.input);
  const legacy = legacyBuild(f.input);
  const mProd = metricsOf(prod.system, prod.user);

  // 1) legacy（旧経路の逐語複製）== production（新経路）を byte で検証。
  const legacyByteEqual =
    Buffer.compare(Buffer.from(prod.system, 'utf8'), Buffer.from(legacy.system, 'utf8')) === 0 &&
    Buffer.compare(Buffer.from(prod.user, 'utf8'), Buffer.from(legacy.user, 'utf8')) === 0;
  const mLegacy = metricsOf(legacy.system, legacy.user);
  const piiEqual = Object.keys(PII_ITEMS).every((k) => mProd.pii[k] === mLegacy.pii[k]);
  const posEqual = Object.keys(POSITION_MARKERS).every((k) => mProd.positions[k] === mLegacy.positions[k]);
  note(legacyByteEqual, `legacy==production (byte) | ${f.name}`);
  note(piiEqual, `PII 項目別件数一致 (legacy vs prod) | ${f.name}`);
  note(posEqual, `位置(indexOf)一致 (legacy vs prod) | ${f.name}`);

  // 2) golden（回帰安定）
  const combined = `===SYSTEM===\n${prod.system}\n===USER===\n${prod.user}`;
  let goldenVerdict = 'n/a';
  if (UPDATE) {
    writeFileSync(goldenPath(f.name), combined, 'utf8');
    writeFileSync(metricsPath(f.name), JSON.stringify(mProd, null, 2) + '\n', 'utf8');
    goldenVerdict = 'WROTE';
  } else if (!existsSync(goldenPath(f.name)) || !existsSync(metricsPath(f.name))) {
    note(false, `golden 欠落 | ${f.name}`);
    goldenVerdict = 'NO_GOLDEN';
  } else {
    const g = readFileSync(goldenPath(f.name), 'utf8');
    const gm = cast<Metrics>(JSON.parse(readFileSync(metricsPath(f.name), 'utf8')));
    const gByte = Buffer.compare(Buffer.from(combined, 'utf8'), Buffer.from(g, 'utf8')) === 0;
    const gPii = Object.keys(PII_ITEMS).every((k) => mProd.pii[k] === gm.pii[k]);
    const gPos = Object.keys(POSITION_MARKERS).every((k) => mProd.positions[k] === gm.positions[k]);
    const gBudget = mProd.systemBytes <= gm.systemBytes && mProd.userBytes <= gm.userBytes;
    note(gByte, `golden byte 一致 | ${f.name}`);
    note(gPii, `golden PII 一致 | ${f.name}`);
    note(gPos, `golden 位置一致 | ${f.name}`);
    note(gBudget, `golden budget 増加なし | ${f.name}`);
    goldenVerdict = gByte && gPii && gPos && gBudget ? 'MATCH' : 'DIFF';
  }

  const verdict = legacyByteEqual && piiEqual && posEqual ? 'EXACT_MATCH' : 'DIFF';
  console.log(`| ${f.name} | ${mProd.systemBytes} | ${mProd.systemLines} | ${mProd.systemHash.slice(0, 10)} | ${mProd.pii['氏名']} | ${verdict} | ${goldenVerdict} |`);

  if (!legacyByteEqual) {
    const a = prod.system, b = legacy.system;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.log(`   sys first diff at char ${i}:`);
    console.log(`   prod  : ${JSON.stringify(a.slice(Math.max(0, i - 20), i + 40))}`);
    console.log(`   legacy: ${JSON.stringify(b.slice(Math.max(0, i - 20), i + 40))}`);
  }
}

console.log('');
if (UPDATE) { console.log('GOLDEN_WRITTEN'); process.exit(0); }
console.log(failures === 0 ? 'ALL_EXACT_MATCH' : `FAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
