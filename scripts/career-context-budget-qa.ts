/*
 * scripts/career-context-budget-qa.ts
 *
 * PASSAI CAREER — purpose 別 context budget 実測レポート生成（P3-H）。
 *
 * 目的:
 *   P3-G で追加した lib/careerContext/budget.ts（createContextBudgetReport ほか）と
 *   lib/careerContext/rawTextGuard.ts（guardRawText）を使い、purpose 別 context の
 *   「base 文字数」「route 固有 block 文字数」「policy 上限との比較」を **観測だけ** する。
 *   raw 本文の横断混入ゼロ検証（safe / leak / allowedRawKeys）も併せて self-check する。
 *
 * 厳守（P3-H の制約）:
 *   - 本番 route / prompt / AI schema / API response / timeout / DB / Supabase を一切変更しない。
 *   - context 削減は実装しない（測るだけ・レポート化するだけ）。
 *   - production code は import のみ（buildCareerContextForPurpose / budget / rawTextGuard）。
 *   - Supabase / env / secret / 本番ユーザーデータには接続しない（mock / fixture のみ）。
 *   - 文字数ベースであり token 実測ではない。
 *
 * 使い方:  npx tsx scripts/career-context-budget-qa.ts
 *   --write   docs/qa/p3h_context_budget_report.md を（再）生成する。
 * 終了コード: rawTextGuard self-check が全 PASS → 0 / 1 件でも FAIL → 1。
 *
 * dev-only。本番ビルド（next build）には含まれない。package.json の CI にも未接続
 *   （CI/self-check 化は P3-I 案 D として別途検討）。
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { CareerAiContext } from '../lib/careerAi/types';
import type { CareerAiFeatureKey } from '../lib/careerAi/types';
import {
  buildCareerContextForPurpose,
  createContextBudgetReport,
  formatContextBudgetReport,
  guardRawText,
  type ContextBlock,
  type ContextBudgetReport,
  type RawTextGuardResult,
  type CareerContextPurpose,
} from '../lib/careerContext';

// ─────────────────────────────────────────────────────────────────────────
// 0. self-check ハーネス
// ─────────────────────────────────────────────────────────────────────────
let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 決定論的なダミー本文生成（Math.random は使わない）。
function filler(unit: string, chars: number): string {
  if (chars <= 0) return '';
  let out = '';
  while (out.length < chars) out += unit;
  return out.slice(0, chars);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. base context の mock CareerAiContext（normal / heavy）
//    base は buildCareerContextForPurpose → buildCareerSystemPrompt で生成される。
//    profile / activity(≤3500 で P2-A 圧縮) / values から決定論的に決まる。
// ─────────────────────────────────────────────────────────────────────────
type Scenario = 'normal' | 'heavy';

const EMPTY_VALUES_NOTES = {
  priorities: '',
  avoidances: '',
  industries: '',
  jobTypes: '',
  workStyles: '',
  companyTypes: '',
  careerGoals: '',
  culturePreferences: '',
};

function emptyActivity(): CareerAiContext['activity'] {
  return {
    personality: [],
    academics: [],
    focusedActivities: [],
    partTimeJobs: [],
    internships: [],
    clubActivities: [],
    projects: [],
    leadership: [],
    volunteer: [],
    overseas: [],
    certifications: [],
    itSkills: [],
    languages: [],
    hobbies: [],
    awards: [],
    snsActivities: [],
    portfolios: [],
    lifeExperiences: [],
    others: [],
  };
}

// 1 カード行（context.ts の joinFields と同じ ' / ' 区切りの "label: value"）。
function card(fields: Array<[string, string]>): string {
  return fields.map(([l, v]) => `${l}: ${v}`).join(' / ');
}

function mockContext(scenario: Scenario, featureKey: CareerAiFeatureKey): CareerAiContext {
  const heavy = scenario === 'heavy';
  const activity = emptyActivity();

  if (!heavy) {
    // normal: 一般ユーザー想定（数セクション・短めカード）。P2-A 圧縮に掛からない量。
    activity.focusedActivities = [
      card([
        ['活動', 'テニスサークルの新歓運営'],
        ['役割', '副リーダー'],
        ['成果', '新入部員を前年比1.4倍に'],
      ]),
    ];
    activity.internships = [card([['企業', 'IT系スタートアップ'], ['期間', '2か月'], ['内容', 'マーケ支援']])];
    activity.certifications = ['TOEIC 820', '基本情報技術者'];
    activity.itSkills = ['Python（基礎）', 'SQL（基礎）'];
    activity.languages = ['英語（日常会話）'];
  } else {
    // heavy: 長文・複数カード・多セクション（P2-A 圧縮が効く量）。
    const longCard = (topic: string) =>
      card([
        ['活動', topic],
        ['役割', filler('主体的に企画・実行しチームを牽引した', 120)],
        ['具体', filler('現状分析と課題設定を行い施策を継続改善した', 180)],
        ['成果', filler('定量的な成果を出し再現可能な学びを得た', 120)],
      ]);
    activity.personality = ['ENFJ / 外向・調整型', filler('几帳面で粘り強い', 60)];
    activity.academics = [longCard('ゼミでの共同研究'), longCard('学部横断プロジェクト')];
    activity.focusedActivities = [longCard('サークル運営改革'), longCard('長期インターン'), longCard('地域ボランティア'), longCard('研究発表')];
    activity.partTimeJobs = [longCard('塾講師'), longCard('カフェ接客')];
    activity.internships = [longCard('外資コンサル 3day'), longCard('メガベンチャー 2か月'), longCard('地方企業 1か月')];
    activity.clubActivities = [longCard('テニスサークル')];
    activity.projects = [longCard('ハッカソン最優秀'), longCard('学園祭アプリ開発')];
    activity.leadership = [longCard('サークル副代表')];
    activity.volunteer = [longCard('被災地支援')];
    activity.overseas = [longCard('カナダ交換留学 半年')];
    activity.certifications = ['TOEIC 920', '基本情報技術者', '簿記2級', '統計検定2級'];
    activity.itSkills = ['Python', 'TypeScript', 'SQL', 'React', 'AWS(基礎)'];
    activity.languages = ['英語（ビジネス）', '中国語（初級）'];
    activity.hobbies = ['写真', 'ランニング', '読書'];
    activity.awards = [filler('学内ビジネスコンテスト最優秀賞', 40)];
    activity.lifeExperiences = [longCard('浪人経験からの学び')];
    activity.others = [longCard('個人ブログ運営')];
  }

  const profile: CareerAiContext['profile'] = {
    name: '田中 太郎',
    university: heavy ? '架空大学 経済学部 経営学科' : '架空大学',
    faculty: '経済学部',
    grade: '3年',
    graduationYear: '2027',
    targetIndustries: heavy ? ['IT', 'コンサル', 'メーカー', '商社'] : ['IT', 'コンサル'],
    targetJobs: heavy ? ['エンジニア', 'コンサルタント', '企画'] : ['エンジニア'],
    targetCompanies: heavy ? ['A社', 'B社', 'C社', 'D社', 'E社'] : ['A社'],
    jobHuntingStatus: heavy ? '本選考エントリー中（5社面接進行）' : '準備中',
    strengths: heavy ? ['計画性', '巻き込み力', '継続力'] : ['計画性'],
    weaknesses: heavy ? ['慎重すぎる', '完璧主義'] : ['慎重すぎる'],
    certifications: heavy ? ['TOEIC 920', '基本情報'] : ['TOEIC 820'],
    internshipExperience: heavy ? filler('複数のインターンで実務経験を積んだ。', 120) : '',
    studyAbroadExperience: heavy ? 'カナダ半年' : '',
    preferredLocations: heavy ? ['東京', '大阪', 'リモート可'] : ['東京'],
    notes: heavy ? filler('長期的には事業開発に携わりたいと考えている。', 120) : '',
  };

  const values: CareerAiContext['values'] = heavy
    ? {
        priorities: ['成長環境', '裁量', '若手登用'],
        avoidances: ['過度な残業', '年功序列'],
        industries: ['IT', 'コンサル', 'メーカー'],
        jobTypes: ['エンジニア', '企画'],
        workStyles: ['リモート併用', 'フレックス'],
        companyTypes: ['メガベンチャー', '外資'],
        careerGoals: ['専門性を深めたい', '将来は事業を作りたい'],
        culturePreferences: ['フラット', '挑戦を歓迎'],
        notes: {
          ...EMPTY_VALUES_NOTES,
          priorities: filler('若いうちから裁量を持って挑戦できる環境を重視する。', 100),
          careerGoals: filler('専門性を軸にしつつ将来的にはマネジメントも視野に。', 100),
        },
        overallNote: filler('自分の強みを活かせて成長できる環境を最優先に考えている。', 120),
      }
    : {
        priorities: ['成長環境'],
        avoidances: ['過度な残業'],
        industries: ['IT'],
        jobTypes: ['エンジニア'],
        workStyles: ['リモート併用'],
        companyTypes: ['メガベンチャー'],
        careerGoals: ['専門性を深めたい'],
        culturePreferences: ['フラット'],
        notes: { ...EMPTY_VALUES_NOTES },
        overallNote: '',
      };

  return {
    profile,
    activity,
    values,
    featureKey,
    userInput: '', // base は route が userInput を別途渡すため空で計測（cross-feature block は route 側）。
    metadata: { source: 'career', schemaVersion: 1, locale: 'ja-JP' },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. route 固有 block の fixture（現行 route の上限・実装に合わせた文字列）
//    ※ 意味・内容は変えず、サイズ感だけを現行 route の cap に合わせる。
//    ※ 各 block のサイズ根拠は P3-H route mapping（docs/qa レポート参照）。
// ─────────────────────────────────────────────────────────────────────────
type PurposeFixture = {
  purpose: CareerContextPurpose;
  featureKey: CareerAiFeatureKey;
  routeBlocks: (scenario: Scenario) => ContextBlock[];
};

// 1 ブロックを目標文字数ちょうどの決定論的テキストにする（char 計測用）。
function txt(unit: string, chars: number): string {
  return filler(unit, chars);
}

// route 固有 block の cap は P3-H route mapping（Explore）で実測した現行値に合わせる:
//   consultation: HISTORY_LIMIT=3×4種, companyResearch max5(preview280), gd .slice(0,3)×2,
//     matching .slice(0,2), 会話 MAX_MESSAGE_LENGTH=1000×HISTORY_MAX_TURNS=10, outputFormat 固定~2k
//   presentation: transcript MAX_TRANSCRIPT_CHARS=20000(超過は reject), outputFormat 8軸~2.5k, qa 最大4turn
//   company_research: verifiedResearchText は route 側 char cap 無し（本文）
//   self_analysis: pastLog SELF_ANALYSIS_PAST_LIMIT=3, conversation cap 無し, outputFormat~2.5k
//   interview: targetConfig(companyMemo) cap 無し, companyResearchFit preview200, outputFormat~2.5k
//   es: companyResearch 1 snapshot(preview~1200), outputFormat~1.2k
const PURPOSE_FIXTURES: PurposeFixture[] = [
  // consultation（司令塔）: 手組みアグリゲート。会話履歴（≤10×1000）が最大の変動要因。
  {
    purpose: 'consultation',
    featureKey: 'career-consultation',
    routeBlocks: (s) => {
      const heavy = s === 'heavy';
      return [
        // 4種(自己分析/ES/面接/プレゼン)×最大3件、各要約~250字級。
        { label: 'historySnapshots', text: txt('履歴要約。', heavy ? 3000 : 800) },
        // 最大5件・preview280。
        { label: 'companyResearchSnapshots', text: txt('企業研究要約。', heavy ? 2000 : 600) },
        // gd + gdRoom（各 .slice(0,3)）をまとめて観測。
        { label: 'gdSnapshots', text: txt('GD要約。', heavy ? 1600 : 200) },
        // 最大2件。
        { label: 'matchingSnapshots', text: txt('マッチング要約。', heavy ? 1000 : 300) },
        // 最大の変動: MAX_MESSAGE_LENGTH=1000 × HISTORY_MAX_TURNS=10。
        { label: 'conversationMessages', text: txt('会話ターン本文。', heavy ? 8000 : 900) },
        { label: 'outputFormat', text: txt('出力フォーマット指示。', 2000) },
      ];
    },
  },
  // matching: cross-feature block は個々に小さい（すべて要約・list slice 済み）。
  {
    purpose: 'matching',
    featureKey: 'career-company-matching',
    routeBlocks: (s) => {
      const heavy = s === 'heavy';
      return [
        { label: 'selfAnalysis', text: txt('自己分析まとめ。', heavy ? 500 : 250) },
        { label: 'es', text: txt('ES要約。', heavy ? 350 : 180) },
        { label: 'interview', text: txt('面接まとめ。', heavy ? 250 : 150) },
        { label: 'consultation', text: txt('相談気づき。', heavy ? 400 : 200) },
        { label: 'gd', text: txt('GD結果。', heavy ? 400 : 150) },
        { label: 'outputFormat', text: txt('出力フォーマット指示。', 2000) },
      ];
    },
  },
  // presentation: transcript（≤20000）が支配的。
  {
    purpose: 'presentation_feedback',
    featureKey: 'career-presentation',
    routeBlocks: (s) => {
      const heavy = s === 'heavy';
      return [
        { label: 'transcript', text: txt('プレゼン書き起こし本文。', heavy ? 10000 : 1500) },
        { label: 'optionalCareerContext', text: heavy ? txt('任意キャリア文脈要約。', 900) : '' },
        { label: 'outputFormat', text: txt('評価8軸と出力フォーマット指示。', 2500) },
        { label: 'qaContext', text: heavy ? txt('Q&A文脈。', 3000) : '' },
      ];
    },
  },
  // interview: targetConfig（companyMemo cap 無し）が変動要因。
  {
    purpose: 'interview_practice',
    featureKey: 'career-interview',
    routeBlocks: (s) => {
      const heavy = s === 'heavy';
      return [
        { label: 'selfAnalysis', text: txt('自己分析。', heavy ? 500 : 300) },
        { label: 'es', text: txt('ES要約。', heavy ? 350 : 180) },
        { label: 'matching', text: txt('マッチング。', heavy ? 280 : 150) },
        { label: 'consultationInsights', text: heavy ? txt('相談気づき。', 250) : '' },
        { label: 'companyResearchFit', text: heavy ? txt('企業研究フィット。', 600) : '' },
        // companyMemo に長文を貼ると膨らむ（route 側 cap 無し）。
        { label: 'targetConfig', text: txt('面接設定（企業/職種/形式/メモ）。', heavy ? 1500 : 200) },
        { label: 'outputFormat', text: txt('出力フォーマット指示。', 2500) },
      ];
    },
  },
  // company_research_review: verifiedResearchText（route cap 無しの本文）が支配的。
  {
    purpose: 'company_research_review',
    featureKey: 'career-company-research',
    routeBlocks: (s) => {
      const heavy = s === 'heavy';
      return [
        { label: 'selfAnalysis', text: txt('自己分析。', heavy ? 500 : 300) },
        { label: 'matching', text: txt('マッチング。', heavy ? 300 : 180) },
        { label: 'verifiedResearchText', text: txt('本人の企業研究一次メモ本文。', heavy ? 4000 : 1000) },
        { label: 'outputFormat', text: txt('添削観点と出力フォーマット指示。', 1500) },
      ];
    },
  },
  // self_analysis: conversation（cap 無し）が変動要因。pastLog は SELF_ANALYSIS_PAST_LIMIT=3。
  {
    purpose: 'self_analysis',
    featureKey: 'career-self-analysis',
    routeBlocks: (s) => {
      const heavy = s === 'heavy';
      return [
        { label: 'coverage', text: txt('未カバー観点の棚卸し。', heavy ? 400 : 250) },
        { label: 'conversation', text: txt('対話ターン本文。', heavy ? 4000 : 800) },
        { label: 'pastLog', text: txt('過去自己分析ログ要約。', heavy ? 700 : 320) },
        { label: 'outputFormat', text: txt('出力フォーマット指示。', 2500) },
      ];
    },
  },
  // self_analysis_deep_dive: userPrompt（過去ターンの transcript, cap 無し）が変動要因。
  {
    purpose: 'self_analysis_deep_dive',
    featureKey: 'career-self-analysis',
    routeBlocks: (s) => {
      const heavy = s === 'heavy';
      return [
        { label: 'coverage', text: txt('カバレッジ棚卸し。', heavy ? 400 : 250) },
        { label: 'pastLog', text: txt('過去自己分析ログ要約。', heavy ? 700 : 320) },
        { label: 'topics', text: txt('深掘りトピック（固定8）。', 300) },
        { label: 'userPrompt', text: txt('質問生成指示＋過去ターン。', heavy ? 2000 : 300) },
      ];
    },
  },
  // es_generation: companyResearch は選択時のみ（1 snapshot, preview~1200）。
  {
    purpose: 'es_generation',
    featureKey: 'career-es',
    routeBlocks: (s) => {
      const heavy = s === 'heavy';
      return [
        { label: 'companyResearch', text: heavy ? txt('企業研究文脈。', 1200) : '' },
        { label: 'selfAnalysis', text: txt('自己分析まとめ。', heavy ? 500 : 250) },
        { label: 'question', text: txt('ES設問と文字数指定。', 300) },
        { label: 'outputFormat', text: txt('出力フォーマット指示。', 1200) },
      ];
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────
// 3. budget 実測
// ─────────────────────────────────────────────────────────────────────────
type Row = {
  purpose: string;
  scenario: Scenario;
  report: ContextBudgetReport;
};

function measureAll(): Row[] {
  const rows: Row[] = [];
  for (const fx of PURPOSE_FIXTURES) {
    for (const scenario of ['normal', 'heavy'] as Scenario[]) {
      const ctx = mockContext(scenario, fx.featureKey);
      const base = buildCareerContextForPurpose(fx.purpose, ctx);
      const routeBlocks = fx.routeBlocks(scenario).filter((b) => b.text.length > 0);
      const report = createContextBudgetReport({
        purpose: fx.purpose,
        baseChars: base.estimatedChars,
        routeSpecificBlocks: routeBlocks,
        policyMaxContextChars: base.policy.maxContextChars,
      });
      rows.push({ purpose: fx.purpose, scenario, report });
    }
  }
  return rows;
}

// top heavy blocks（base 含む）を chars 降順で n 件。
function topBlocks(report: ContextBudgetReport, n = 3): string {
  return [...report.blocks]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, n)
    .map((b) => `${b.label}=${b.chars}`)
    .join(', ');
}

// ─────────────────────────────────────────────────────────────────────────
// 4. rawTextGuard self-check（A safe / B leak / C allowedRawKeys）
// ─────────────────────────────────────────────────────────────────────────

// A. 横断 snapshot として安全な fixture（要約のみ。raw 本文キーなし・長文なし）。
const SAFE_SNAPSHOT = {
  consultationHistory: { summary: '相談の要点を1〜2文で要約。', updatedAt: '2026-07' },
  matchingSnapshot: { summary: 'マッチング上位の要約。', topFit: 'A社' },
  interviewSummary: { summary: '面接練習の気づきの要約。' },
  esSummary: { summary: 'ES設問ごとの方向性の要約。' },
  companyResearchSummary: { summary: '企業研究の観点整理の要約。', companyName: 'A社' },
  gdSummary: { summary: 'GD貢献の要約。' },
  presentationSummary: { summary: 'プレゼン構成の要約。' },
};

// B. raw 本文が混入した fixture（危険キー + 長文自由記述）。
const LEAK_SNAPSHOT = {
  essayBody: '本人が書いたES本文の全文（横断 snapshot には入れてはいけない）。',
  answer: '面接回答の全文。',
  transcript: 'GD発話の全文書き起こし。',
  verifiedResearchText: '企業研究の一次メモ全文。',
  prompt: 'AIへの生プロンプト全文。',
  response: 'AI応答の全文。',
  email: 'user@example.com',
  name: '田中 太郎',
  freeText: filler('区切りのない長文自由記述本文。', 800), // long_free_text 検出用（>500）。
};

// C. 正当な添削・評価対象（allowedRawKeys で許可すると検出しない）。
const CRR_TARGET = { verifiedResearchText: filler('本人の企業研究一次メモ本文。', 900) };
const GD_TARGET = { transcript: filler('GD発話の書き起こし本文。', 900) };
const ES_TARGET = { essay: filler('ES本文。', 900), essayBody: filler('ES本文（body）。', 900) };

function fmtGuard(r: RawTextGuardResult): string {
  if (r.ok) return 'ok=true findings=[]';
  return `ok=false findings=${r.findings.length} (${r.findings.map((f) => `${f.path}:${f.reason}`).join('; ')})`;
}

function runGuardSelfChecks(): {
  safe: RawTextGuardResult;
  leak: RawTextGuardResult;
  crrAllowed: RawTextGuardResult;
  crrDenied: RawTextGuardResult;
  gdAllowed: RawTextGuardResult;
  esAllowed: RawTextGuardResult;
} {
  const safe = guardRawText(SAFE_SNAPSHOT);
  const leak = guardRawText(LEAK_SNAPSHOT);
  const crrAllowed = guardRawText(CRR_TARGET, { allowedRawKeys: ['verifiedResearchText'] });
  const crrDenied = guardRawText(CRR_TARGET); // 横断 snapshot（allowなし）では検出される。
  const gdAllowed = guardRawText(GD_TARGET, { allowedRawKeys: ['transcript'] });
  const esAllowed = guardRawText(ES_TARGET, { allowedRawKeys: ['essay', 'essayBody'] });

  console.log('\n[rawTextGuard self-check]');
  console.log(`  A safe:        ${fmtGuard(safe)}`);
  console.log(`  B leak:        ${fmtGuard(leak)}`);
  console.log(`  C crr allowed: ${fmtGuard(crrAllowed)}`);
  console.log(`  C crr denied:  ${fmtGuard(crrDenied)}`);
  console.log(`  C gd allowed:  ${fmtGuard(gdAllowed)}`);
  console.log(`  C es allowed:  ${fmtGuard(esAllowed)}`);

  check('A: 安全 snapshot は ok=true / findings=[]', safe.ok && safe.findings.length === 0, fmtGuard(safe));
  check('B: 混入 fixture は ok=false かつ path 付き findings', !leak.ok && leak.findings.length > 0 && leak.findings.every((f) => !!f.path));
  check('B: essayBody / answer / transcript / verifiedResearchText を検出', ['essayBody', 'answer', 'transcript', 'verifiedResearchText'].every((k) => leak.findings.some((f) => f.key === k)));
  check('B: email / name / prompt / response を検出', ['email', 'name', 'prompt', 'response'].every((k) => leak.findings.some((f) => f.key === k)));
  check('B: 長文自由記述(freeText>500) を long_free_text で検出', leak.findings.some((f) => f.key === 'freeText' && f.reason === 'long_free_text'));
  check('C: verifiedResearchText は allowedRawKeys 指定で ok', crrAllowed.ok);
  check('C: verifiedResearchText は allow 無し（横断）では検出される', !crrDenied.ok);
  check('C: transcript は allowedRawKeys 指定で ok', gdAllowed.ok);
  check('C: essay/essayBody は allowedRawKeys 指定で ok', esAllowed.ok);

  return { safe, leak, crrAllowed, crrDenied, gdAllowed, esAllowed };
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Markdown レポート生成（--write 時）
// ─────────────────────────────────────────────────────────────────────────
function pipeCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function findRow(rows: Row[], purpose: string, scenario: Scenario): Row {
  const r = rows.find((x) => x.purpose === purpose && x.scenario === scenario);
  if (!r) throw new Error(`row not found: ${purpose}/${scenario}`);
  return r;
}
function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';
}

function buildMarkdown(rows: Row[], guard: ReturnType<typeof runGuardSelfChecks>, meta: { head: string; date: string }): string {
  const heavyRanking = [...rows]
    .filter((r) => r.scenario === 'heavy')
    .sort((a, b) => b.report.totalChars - a.report.totalChars);

  const baseOver = rows.filter((r) => r.report.isBaseOverBudget);
  const totalOver = rows.filter((r) => r.report.isTotalOverBudget);

  // Interpretation 用に data 由来の事実を計算する。
  const consultH = findRow(rows, 'consultation', 'heavy').report;
  const consultN = findRow(rows, 'consultation', 'normal').report;
  const matchH = findRow(rows, 'matching', 'heavy').report;
  const presH = findRow(rows, 'presentation_feedback', 'heavy').report;
  const crrH = findRow(rows, 'company_research_review', 'heavy').report;
  const ddH = findRow(rows, 'self_analysis_deep_dive', 'heavy').report;
  const ddN = findRow(rows, 'self_analysis_deep_dive', 'normal').report;

  const matchCross = matchH.blocks.filter((b) => !['base', 'outputFormat'].includes(b.label));
  const matchMaxCross = [...matchCross].sort((a, b) => b.chars - a.chars)[0];
  const presTranscript = presH.blocks.find((b) => b.label === 'transcript')!;
  const crrVerified = crrH.blocks.find((b) => b.label === 'verifiedResearchText')!;
  const ddPast = ddH.blocks.find((b) => b.label === 'pastLog')!;
  const ddCov = ddH.blocks.find((b) => b.label === 'coverage')!;

  const budgetTable = [
    '| purpose | scenario | base | route | total | policyMax | baseOver | totalOver | top heavy blocks | warnings |',
    '|---|---|---:|---:|---:|---:|:--:|:--:|---|---|',
    ...rows.map((r) => {
      const rp = r.report;
      return `| ${r.purpose} | ${r.scenario} | ${rp.baseChars} | ${rp.routeSpecificChars} | ${rp.totalChars} | ${rp.policyMaxContextChars ?? '-'} | ${rp.isBaseOverBudget ? '⚠️' : '—'} | ${rp.isTotalOverBudget ? '⚠️' : '—'} | ${pipeCell(topBlocks(rp))} | ${rp.warnings.join(', ') || 'none'} |`;
    }),
  ].join('\n');

  const rankTable = [
    '| # | purpose (heavy) | total | policyMax | totalOver | dominant block |',
    '|---:|---|---:|---:|:--:|---|',
    ...heavyRanking.map((r, i) => {
      const rp = r.report;
      const dom = [...rp.blocks].sort((a, b) => b.chars - a.chars)[0];
      return `| ${i + 1} | ${r.purpose} | ${rp.totalChars} | ${rp.policyMaxContextChars ?? '-'} | ${rp.isTotalOverBudget ? '⚠️' : '—'} | ${dom.label}=${dom.chars} |`;
    }),
  ].join('\n');

  return `# P3-H Context Budget 実測レポート

> 自動生成: \`npx tsx scripts/career-context-budget-qa.ts --write\`
> 本レポートは **観測のみ**。context 削減・本番 route / prompt / AI schema / API / UI / DB / timeout は一切変更していない。

## 1. Summary

- 実施日: ${meta.date}
- branch: \`feature/career-mvp\`
- HEAD commit: \`${meta.head}\`
- 変更範囲: dev-only 計測スクリプト + 本 QA レポートのみ（本番 runtime 不変）
- 本番 runtime 不変確認: production code は **import のみ**（buildCareerContextForPurpose / budget / rawTextGuard）。route から自動実行しない。

## 2. Measurement Method

- fixture 方針: 実 DB / Supabase / 本番ユーザーデータに接続せず、mock \`CareerAiContext\` と文字列 fixture で計測。
- base: \`buildCareerContextForPurpose(purpose, mockContext)\` の \`estimatedChars\`（= \`buildCareerSystemPrompt\` の文字数）。
- route 固有 block: 現行 route の上限・実装に合わせた文字列 fixture（意味・内容は変えない）。
- scenario:
  - **normal**: 一般ユーザー想定（数セクション・短めカード・snapshot 少数）。
  - **heavy**: 長文・複数 snapshot・長め transcript 想定（P2-A 活動圧縮が効く量）。
- env / secret / API key / Supabase URL / token は読まない・出力しない。
- **文字数ベースであり token 実測ではない**（policy.maxContextChars も文字数目安）。

> **policyMaxContextChars(=3500) は registry 上「base context の目安上限」**（\`purpose.ts\` の
> \`maxContextChars\` コメント／orchestrator \`isOverPolicyBudget\`）であって、prompt 全体の予算ではない。
> route 固有 block（cross-feature 要約・添削本文・静的 outputFormat）は base とは別に正当に積まれる。
> → 実効的なシグナルは **isBaseOverBudget**。isTotalOverBudget は「total の内訳観測」であり超過自体は設計上想定内。

## 3. Budget Results

### 3.1 purpose × scenario

${budgetTable}

### 3.2 heavy total ランキング

${rankTable}

- base が policy(base目安3500) 超過: ${baseOver.length ? baseOver.map((r) => `${r.purpose}/${r.scenario}`).join(', ') : 'なし'}
- total が policy 超過（＝内訳観測。設計上想定内）: ${totalOver.length ? totalOver.map((r) => `${r.purpose}/${r.scenario}`).join(', ') : 'なし'}

## 4. Raw Text Guard Results

| ケース | 期待 | 結果 |
|---|---|---|
| A 横断 safe snapshot | ok=true / findings=[] | ${guard.safe.ok ? '✅ ok=true' : '❌ ' + fmtGuard(guard.safe)} |
| B raw 本文混入 | ok=false / path 付き findings | ${!guard.leak.ok ? `✅ ok=false (${guard.leak.findings.length} findings)` : '❌ ok=true'} |
| C-1 verifiedResearchText allowed | ok=true | ${guard.crrAllowed.ok ? '✅ ok=true' : '❌'} |
| C-1 verifiedResearchText 横断(allow無) | 検出される | ${!guard.crrDenied.ok ? '✅ 検出' : '❌ 未検出'} |
| C-2 transcript allowed | ok=true | ${guard.gdAllowed.ok ? '✅ ok=true' : '❌'} |
| C-3 essay/essayBody allowed | ok=true | ${guard.esAllowed.ok ? '✅ ok=true' : '❌'} |

B の findings（path:reason）:

${guard.leak.findings.map((f) => `- \`${f.path}\` — ${f.reason}`).join('\n')}

## 5. Interpretation（依頼の 10 問）

1. **base だけで policy(base目安3500) を超える purpose はあるか** —
   normal では **なし**（base ~1.0–1.2k）。heavy では **全 purpose が超過**（base ${consultH.baseChars}〜${presH.baseChars}）。
   heavy base の内訳は「活動整理(P2-A で ≤3500 に圧縮済み) + profile + 就活軸 + 基本方針/機能指示」で、
   data-rich ユーザーでは活動 3500 上限だけで base 目安をほぼ使い切る。

2. **total で policy を超える purpose はどれか** —
   heavy は全 purpose。normal でも **${totalOver.filter((r) => r.scenario === 'normal').map((r) => r.purpose).join(' / ')}** が超過。
   ただし §3 冒頭の通り 3500 は base 目安であり、total 超過は「静的 outputFormat(~1.2–2.5k) + 正当な route block」が
   base の外に積まれる設計上の内訳。**total を 3500 に収めることは設計目標ではない**。

3. **重い原因は base か route 固有 block か** —
   - **normal**: 支配は多くの purpose で **静的 outputFormat(~2–2.5k)**（＋base ~1k）。ユーザーデータではなく固定指示が主因。
   - **heavy**: **base(活動圧縮上限)** と、purpose ごとの **大きな本文 block**（consultation 会話 / presentation transcript /
     company_research verifiedText / self_analysis 会話）の 2 つ。

4. **consultation は本当に route 固有 block が重いか** — **YES**。
   heavy で route=${consultH.routeSpecificChars}（base の ${(consultH.routeSpecificChars / consultH.baseChars).toFixed(1)} 倍）、
   単一最大は **conversationMessages=${consultH.blocks.find((b) => b.label === 'conversationMessages')!.chars}**（MAX_MESSAGE_LENGTH 1000 × HISTORY_MAX_TURNS 10 の上限）。
   normal でも route=${consultN.routeSpecificChars} が base=${consultN.baseChars} を上回る。司令塔ゆえ手組みアグリゲートが支配的。

5. **matching はどの cross-feature block が重いか** —
   実は **突出した cross-feature block は無い**。cross-feature（selfAnalysis/es/interview/consultation/gd）は各
   ≤${matchMaxCross.chars}（最大は ${matchMaxCross.label}）で、すべて要約・list slice 済み。matching の重さは
   **base + 静的 outputFormat(2000)** に由来する。→ matching で削るべき「重い cross-feature」は存在しない。

6. **presentation は transcript が支配的か** — **YES**。
   heavy で transcript=${presTranscript.chars}（route の ${pct(presTranscript.chars, presH.routeSpecificChars)}、単一最大 block）。
   route 側で MAX_TRANSCRIPT_CHARS=20000 を超えると reject（truncate ではない）＝上限は既に存在。

7. **self_analysis_deep_dive の pastLog / coverage は許容範囲か** — **YES**。
   pastLog=${ddPast.chars}（SELF_ANALYSIS_PAST_LIMIT=3 で頭打ち）、coverage=${ddCov.chars}。deep_dive は
   **normal で唯一 total も policy 未超過（total=${ddN.totalChars}）**。変動要因は pastLog/coverage ではなく userPrompt(過去ターン transcript)。

8. **company_research_review は verifiedResearchText が支配的か** — **YES**。
   heavy で verifiedResearchText=${crrVerified.chars}（route の ${pct(crrVerified.chars, crrH.routeSpecificChars)}）。route 側に char cap が無い本人一次メモ本文。
   ただしこれは **添削対象そのもの**であり、削ると添削品質が直接落ちる（rawTextGuard でも allowedRawKeys で許可する正当本文）。

9. **削減に進むならどこが最小リスクか** —
   - 触ると危険: 静的 **outputFormat**（AI 出力 schema・評価軸に直結）、**添削/評価対象の本文**（transcript / verifiedResearchText /
     conversation）＝品質と直結。
   - 既に cap 済み: 活動(P2-A ≤3500)、consultation 会話(1000×10)、presentation transcript(≤20000)、pastLog(≤3)、各 snapshot slice。
   - 最小リスク候補（§6 参照）: **cap の無い自由本文 block に決定論的な上限を "追加観測" として先に測る**
     （interview targetConfig.companyMemo / self_analysis conversation / deep_dive userPrompt）。ただし削減自体は本人本文に触れるため慎重に。

10. **Memory 永続化前にまだ確認すべきこと** —
   - **token 実測**（本 report は文字数。日本語は文字≠token、比率は概算 1.5–2 char/token）。
   - **実 route の base 実測**（本 report は mock base。実 profile/activity/values 形状での再測）。
   - **横断 snapshot formatter 出力に対する rawTextGuard の実データ回し**（historySnapshots / matching consultationContext /
     companyResearch context の生成結果を guard に通す）。
   - consultation の会話 10×1000 が実運用でどの程度発生するかの分布確認。

## 6. Recommendation for P3-I

評価軸（最小差分・revert 容易・AI 出力 schema 不変・品質低下しにくい 順）で順位付け。

1. **案E+D（推奨）: まだ削減せず、rawTextGuard を self-check/CI 化して Memory 化前の安全網にする。**
   - 最小差分・revert 容易・schema 完全不変・品質影響ゼロ。
   - 本 runner（\`scripts/career-context-budget-qa.ts\`）を package.json の \`qa:*\` に接続し、
     横断 snapshot formatter の実出力を guard に通す test を足すだけ。削減判断のデータは本 report で揃っている。

2. **案A: presentation transcript の上限を "実装前に" dev-only 測定で詰める（削減はしない）。**
   - transcript は heavy で単一最大かつ既に 20000 reject 済み。truncate 化する前に「20000 が実際に効いているか / 適正閾値か」を観測追加。
   - schema 不変・本番挙動不変。ただし transcript は評価対象本文 → 実削減は品質リスクありのため観測に留める。

3. **案C: matching cross-feature block の観測詳細化（削減はしない）。**
   - §5-5 の通り matching は cross-feature が既に軽い。詳細化しても削減余地は小さいと確認するための観測に留まる。低優先。

4. **案B: consultation route 固有 block をさらに分解観測（削減はしない）。**
   - conversationMessages が支配的なのは判明済み。分解観測の追加価値は限定的。低優先。

**まだ削減しない方がよい箇所**: 静的 outputFormat、添削/評価対象本文（transcript / verifiedResearchText / conversation）、
base の profile/activity（人格一貫性・P2-A で既に圧縮済み）。これらは品質・人格一貫性に直結する。

**P4 / Memory 化前の残課題**: token 実測、実 route base 実測、snapshot formatter の guard 実データ回し（§5-10）。

## 7. Final State

- git status: この時点では未 commit（レビュー後に指示があれば commit）。
- commit / push: 未実施。
- secret: 非出力（fixture のみ・env/secret/Supabase 未読取）。
`;
}

// ─────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────
function main(): void {
  const rows = measureAll();

  console.log('[context budget report]\n');
  for (const r of rows) {
    console.log(`── ${r.purpose} [${r.scenario}] ──`);
    console.log(formatContextBudgetReport(r.report));
    console.log(`   top: ${topBlocks(r.report)}\n`);
  }

  const guard = runGuardSelfChecks();

  const write = process.argv.includes('--write');
  if (write) {
    // HEAD / date は環境変数で受け取る（スクリプトから git/日付を触らない = 決定論的・純粋寄り）。
    const head = process.env.P3H_HEAD ?? '(unknown)';
    const date = process.env.P3H_DATE ?? '(unknown)';
    const md = buildMarkdown(rows, guard, { head, date });
    const out = path.join(process.cwd(), 'docs', 'qa', 'p3h_context_budget_report.md');
    writeFileSync(out, md, 'utf8');
    console.log(`\n[write] ${out}`);
  }

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : `FAIL: ${failures} 件 ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
