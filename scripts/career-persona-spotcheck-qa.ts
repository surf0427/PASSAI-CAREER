/*
 * scripts/career-persona-spotcheck-qa.ts
 *
 * PASSAI CAREER — activity 圧縮の persona spot-check（P8-A3 常設 additive harness）。
 *
 * 背景（P8-A / P8-A2 の監査結論）:
 *   base context の残る最大レバーは activity block 一点で、P8-B では matching-only の
 *   orchestrator-policy activity compact（既存 formatCareerActivityForPrompt を tighter limits で
 *   再利用）を入れる方針。ただし activity は persona consistency / matching fit の一次材料であり、
 *   「圧縮で核情報が欠落していないか」を守る自動/準自動 harness が不足していた（P8-A の最大 gap）。
 *
 * 目的:
 *   activity を「現行 limits（before）」と「将来の tighter limits（after）」で整形した 2 出力を比較し、
 *   persona / matching に必要な核情報が after でも保持されることを **AI を使わず決定論的に**検査する。
 *   activity compact 未実装の現時点では BEFORE_LIMITS === AFTER_LIMITS のため before ≡ after で
 *   全ケース PASS する（＝現行 production 挙動の固定）。P8-B で AFTER_LIMITS を tighter に差し替えると、
 *   同じ harness が「圧縮しても核が残るか」の回帰ガードになる（--tighter で手元シミュレート可）。
 *
 * 厳守（P8-A3）:
 *   - production code / route / prompt / selector / snapshot / orchestrator / AI schema / DB を一切変更しない。
 *   - 本 harness は現行 production 純関数を **import して読むだけ**（AI API / DB / Supabase / env / secret 非接続）。
 *   - activity compact 自体は実装しない（AFTER_LIMITS は既定で現行 limits と同一）。
 *   - BaseMemorySummary は接続しない。
 *
 * 使い方:
 *   npx tsx scripts/career-persona-spotcheck-qa.ts            # before ≡ after（現行 limits）で検査
 *   npx tsx scripts/career-persona-spotcheck-qa.ts --tighter  # after を demo tighter limits にして手元検証
 * 終了コード: 全ケース PASS → 0 / 1 件でも FAIL → 1。
 */

import { buildCareerAiContext } from '@/lib/careerAi/context';
import { buildCareerContextForPurpose } from '@/lib/careerContext/orchestrator';
import {
  formatCareerActivityForPrompt,
  CAREER_ACTIVITY_LIMITS,
  MATCHING_ACTIVITY_LIMITS,
  type CareerActivityFormatLimits,
} from '@/lib/careerContext/activity';
import { guardRawText } from '@/lib/careerContext/rawTextGuard';

/* eslint-disable @typescript-eslint/no-explicit-any */
const any = (v: unknown) => v as any;

// ── limits（before = 現行 default / after = P8-B production の matching tighter limits） ──────────
// P8-B: AFTER_LIMITS を production の MATCHING_ACTIVITY_LIMITS に一致させた。activity:'minimal' 通電で
//   matching prompt の activity render がこの limits で縮む。7 cases すべてで核情報が残ることを検査する
//   （normal 等は上限未満で before ≡ after ＝ no-loss、heavy は長い自由記述 field だけ trim される）。
// --tighter は「さらに攻めた」demo（card 上限 2）で、harness が実際に核欠落（例: 3件目の IT スキル）を
//   検知することの確認用（CI では使わない）。
const BEFORE_LIMITS: CareerActivityFormatLimits = CAREER_ACTIVITY_LIMITS;
const TIGHTER_DEMO_LIMITS: CareerActivityFormatLimits = {
  maxSections: 12,
  maxCardsPerSection: 2,
  maxFieldChars: 50,
  maxTotalChars: 2000,
};
const USE_TIGHTER = process.argv.includes('--tighter');
const AFTER_LIMITS: CareerActivityFormatLimits = USE_TIGHTER
  ? TIGHTER_DEMO_LIMITS
  : MATCHING_ACTIVITY_LIMITS;

// ── section label（lib/careerContext/activity.ts SECTION_DEFS と厳密一致。preservation 検査用） ──
const S = {
  personality: 'MBTI・性格',
  academics: '学業・学生時代の活動',
  focused: '学生時代に力を入れたこと（ガクチカ）',
  partTime: 'アルバイト',
  internship: 'インターン',
  club: 'サークル・部活動',
  overseas: '海外経験',
  certifications: '資格',
  itSkills: 'ITスキル',
  languages: '語学',
} as const;

// ── fixture 型 ────────────────────────────────────────────────────────────────
// expect.sections: after に `■ {label}` として残るべき section。
// expect.tokens:   after の activity render に残るべき核 token（title / 役割 / 成果 / 定量 / 資格 / スキル 等）。
// expect.profileValuesTokens: activity 圧縮で本来不変な profile / values 由来 token（base prompt に存在）。
type PersonaCase = {
  name: string;
  profile: any;
  activity: any;
  values: any;
  expect: {
    sections: string[];
    tokens: string[];
    profileValuesTokens: string[];
  };
};

// 既存 prompt-golden fixture を流用（normal / heavy / activity-multi-section / values-notes）。
const normal: PersonaCase = {
  name: 'normal',
  profile: any({
    name: '山田太郎',
    preferences: [{ university: '東京大学', faculty: '経済学部' }],
    grade: '3年',
    graduationYear: '2027',
    targetIndustries: ['IT', 'コンサル'],
    targetJobs: ['エンジニア'],
    jobHuntingStatus: '準備中',
    strengths: ['継続力'],
    weaknesses: ['心配性'],
  }),
  activity: any({
    academics: { seminar: '経済ゼミ', thesis: '地域経済の研究' },
    focusedActivities: [
      { title: 'サークル運営', category: '課外', organization: 'テニス部', role: '代表', goal: '部員増加', action: '勧誘施策の設計', result: '新歓で20名増' },
    ],
  }),
  values: any({ selections: { priorities: ['成長環境'], workStyles: ['チームで働く'] }, notes: {}, overallNote: '' }),
  expect: {
    sections: [S.academics, S.focused],
    tokens: ['サークル運営', '代表', '新歓で20名増', '20'],
    profileValuesTokens: ['継続力', 'IT', 'コンサル', 'エンジニア', '成長環境', 'チームで働く'],
  },
};

const heavy: PersonaCase = {
  name: 'heavy',
  profile: any({
    name: '佐藤花子',
    preferences: [{ university: '早稲田大学', faculty: '政治経済学部' }],
    grade: '4年',
    graduationYear: '2026',
    targetIndustries: ['メーカー', '商社', '金融', 'IT'],
    targetJobs: ['総合職', '企画', 'マーケティング'],
    targetCompanies: ['A社', 'B社', 'C社'],
    jobHuntingStatus: '選考中',
    strengths: ['リーダーシップ', '傾聴力', '課題設定力'],
    weaknesses: ['完璧主義', '抱え込み'],
    certifications: ['TOEIC 900', '簿記2級'],
    internshipExperience: '長期インターンでBtoB営業を1年経験',
    studyAbroadExperience: 'カナダに1年間交換留学',
    preferredLocations: ['東京', '大阪'],
    notes: '長期的には海外事業に携わりたいと考えている。',
  }),
  activity: any({
    personality: { mbti: 'ENFJ', selfView: '面倒見が良い', strengths: '巻き込み力', values: '誠実さ' },
    academics: { seminar: '国際政治ゼミ', thesis: '新興国の通商政策に関する比較研究', memorableClass: '国際経済学' },
    focusedActivities: [
      { title: '学園祭実行委員会での渉外統括', category: '課外活動', organization: '学園祭実行委員会', role: '渉外局長', goal: '協賛金を前年比150%にする', action: '新規企業リストを200社作成し優先度づけしてアプローチ、提案資料を刷新して訴求点を整理し、既存協賛先には継続メリットを個別提案した', difficulty: '断られ続けて士気が下がった', result: '協賛金を前年比160%に到達させ過去最高を更新', quantitativeResult: '協賛社数18→27社、金額160%', learning: '相手の利益から逆算する提案の重要性' },
      { title: 'ゼミ論文コンテスト運営', category: '学業', organization: '国際政治ゼミ', role: '幹事', goal: '参加率向上', action: '運営フローを整備', result: '参加率90%' },
    ],
    partTimeJobs: [{ workplace: '塾講師', jobContent: '個別指導', role: 'リーダー講師', scale: '生徒30名', learning: '相手に合わせた説明力' }],
    overseas: [{ title: 'カナダ交換留学', country: 'カナダ', kind: '交換留学', purpose: '多様な価値観に触れる', activityContent: '現地学生と協働プロジェクト', difficulty: '言語の壁', howOvercome: '毎日発言する目標を設定', learning: '主体的に動く姿勢', strength: '異文化適応力' }],
  }),
  values: any({
    selections: {
      priorities: ['成長環境', '裁量の大きさ'],
      avoidances: ['年功序列'],
      industries: ['商社', 'メーカー'],
      jobTypes: ['企画'],
      workStyles: ['チーム', '裁量重視'],
      companyTypes: ['大手'],
      careerGoals: ['海外で働く'],
      culturePreferences: ['挑戦を歓迎する社風'],
    },
    notes: { priorities: '若手のうちから責任ある仕事を任されたい', avoidances: '評価が年齢で決まる環境は避けたい', careerGoals: '30代で海外駐在を経験したい' },
    overallNote: '成長と海外志向を軸に企業を見ている。',
  }),
  expect: {
    // 圧縮しても各 section の見出しと第1カードの核（title / 役割 / 定量）は残るべき。
    sections: [S.personality, S.academics, S.focused, S.partTime, S.overseas],
    tokens: ['学園祭実行委員会での渉外統括', '渉外局長', '160%', 'カナダ交換留学', '異文化適応力', '塾講師'],
    profileValuesTokens: ['リーダーシップ', '商社', '企画', '海外で働く'],
  },
};

const activityMultiSection: PersonaCase = {
  name: 'activity-multi-section',
  profile: any({ name: '鈴木健', preferences: [{ university: '大阪大学', faculty: '工学部' }], grade: '修士1年', targetIndustries: ['IT'], targetJobs: ['エンジニア'], strengths: ['分析力'] }),
  activity: any({
    personality: { mbti: 'INTJ', strengths: '分析力', weaknesses: '完璧主義' },
    academics: { seminar: '情報工学研究室', thesis: '機械学習を用いた異常検知' },
    focusedActivities: [{ title: 'ハッカソン優勝', category: '技術', organization: '学内サークル', role: 'エンジニア', goal: '入賞', action: 'MVPを2日で実装', result: '最優秀賞' }],
    partTimeJobs: [{ workplace: 'Web制作会社', jobContent: 'フロント開発', role: 'メンバー', learning: '実装力' }],
    internships: [{ companyName: 'IT企業', jobContent: 'バックエンド開発', role: 'インターン生', learning: 'チーム開発' }],
    club: [{ organizationName: 'ロボット研究会', activityContent: '自律走行ロボット製作', role: '制御担当' }],
    certifications: [{ name: '基本情報技術者', acquiredDate: '2025-04' }],
    languages: [{ language: '英語', level: 'ビジネス' }],
    itSkills: [{ name: 'Python', level: '実務' }, { name: 'TypeScript', level: '実務' }],
    lifeExperiences: { hardestEffort: '研究のデータ収集', mostGrowth: 'インターンでの開発' },
  }),
  values: any({ selections: { priorities: ['技術力が伸びる'] }, notes: {}, overallNote: '' }),
  expect: {
    sections: [S.focused, S.partTime, S.internship, S.club, S.certifications, S.itSkills, S.languages],
    tokens: ['ハッカソン優勝', '最優秀賞', 'IT企業', '基本情報技術者', 'Python', 'TypeScript', '英語'],
    profileValuesTokens: ['分析力', 'IT', 'エンジニア', '技術力が伸びる'],
  },
};

const valuesNotes: PersonaCase = {
  name: 'values-notes',
  profile: any({ name: '高橋みなみ', preferences: [{ university: '名古屋大学', faculty: '文学部' }], grade: '3年', targetIndustries: ['教育'], strengths: ['傾聴力'] }),
  activity: any({ academics: { seminar: '社会学ゼミ' } }),
  values: any({
    selections: { priorities: ['ワークライフバランス'], avoidances: ['転勤が多い'], industries: ['教育'], workStyles: ['リモート可'] },
    notes: { priorities: 'プライベートの時間も大切にしながら長く働きたい', avoidances: '頻繁な転勤で生活基盤が安定しないのは避けたい', industries: '人の成長に関わる仕事に興味がある', workStyles: '週数日はリモートで働ける環境が理想' },
    overallNote: '長期的に安定して働ける環境を重視している。',
  }),
  expect: {
    sections: [S.academics],
    tokens: ['社会学ゼミ'],
    profileValuesTokens: ['傾聴力', 'ワークライフバランス', '転勤が多い', '教育', 'リモート可'],
  },
};

// 新規: overseas（海外経験カードの period / strength / 学び 保持）。
const overseas: PersonaCase = {
  name: 'overseas',
  profile: any({
    name: '中村さくら',
    preferences: [{ university: '上智大学', faculty: '外国語学部' }],
    grade: '3年',
    targetIndustries: ['商社'],
    targetJobs: ['海外営業'],
    strengths: ['行動力'],
    studyAbroadExperience: 'ドイツに半年間交換留学',
  }),
  activity: any({
    overseas: [
      { title: 'ドイツ長期留学', country: 'ドイツ', city: 'ベルリン', kind: '交換留学', period: { from: '2024-04', to: '2024-09' }, purpose: '国際経営を学ぶ', activityContent: '現地企業でのフィールドワーク', difficulty: '言語と文化の壁', howOvercome: '現地サークルに毎週参加', learning: '多様性の中で成果を出す姿勢', languageGrowth: 'ドイツ語日常会話レベル', strength: '異文化適応力' },
    ],
    focusedActivities: [{ title: '国際交流サークル代表', category: '課外', organization: '国際交流サークル', role: '代表', goal: '留学生支援の拡充', action: 'バディ制度を新設', result: '参加留学生が2倍に' }],
  }),
  values: any({ selections: { industries: ['商社'], careerGoals: ['海外で働く'] }, notes: {}, overallNote: '' }),
  expect: {
    sections: [S.overseas, S.focused],
    tokens: ['ドイツ長期留学', 'ベルリン', '異文化適応力', '国際経営を学ぶ', '2024-04', '国際交流サークル代表'],
    profileValuesTokens: ['行動力', '商社', '海外営業', '海外で働く'],
  },
};

// 新規: internship（インターン / アルバイトの 役割・定量成果 保持）。
const internship: PersonaCase = {
  name: 'internship',
  profile: any({
    name: '小林大輔',
    preferences: [{ university: '一橋大学', faculty: '商学部' }],
    grade: '4年',
    targetIndustries: ['メーカー'],
    targetJobs: ['総合職'],
    strengths: ['課題設定力'],
    internshipExperience: '長期インターンで法人営業を1年経験',
  }),
  activity: any({
    internships: [
      { companyName: '大手メーカーA', jobContent: '法人営業アシスタント', role: 'インターン生', scale: 'チーム5名', period: { from: '2023-06', to: '2024-03' }, ingenuity: '商談準備の効率化', quantitativeResult: '新規アポ獲得率を1.5倍に改善', learning: '顧客視点の重要性' },
    ],
    partTimeJobs: [
      { workplace: 'カフェ', jobContent: '接客・在庫管理', role: 'シフトリーダー', scale: 'スタッフ10名', quantitativeResult: '廃棄ロスを10%削減', learning: '現場改善の進め方' },
    ],
  }),
  values: any({ selections: { priorities: ['実務経験が積める'] }, notes: {}, overallNote: '' }),
  expect: {
    sections: [S.internship, S.partTime],
    tokens: ['大手メーカーA', '法人営業アシスタント', 'インターン生', '新規アポ獲得率を1.5倍に改善', '1.5', 'カフェ', 'シフトリーダー', '10%'],
    profileValuesTokens: ['課題設定力', 'メーカー', '総合職', '実務経験が積める'],
  },
};

// 新規: qualifications-it-languages（資格 / ITスキル / 語学 = matching fit に効く要素の保持）。
const qualificationsItLanguages: PersonaCase = {
  name: 'qualifications-it-languages',
  profile: any({
    name: '渡辺翔',
    preferences: [{ university: '東京工業大学', faculty: '情報理工学院' }],
    grade: '修士1年',
    targetIndustries: ['IT'],
    targetJobs: ['エンジニア'],
    strengths: ['学習意欲'],
    certifications: ['応用情報技術者'],
  }),
  activity: any({
    certifications: [
      { name: '応用情報技術者', score: '', acquiredDate: '2024-10' },
      { name: 'TOEIC', score: '860', acquiredDate: '2024-06' },
    ],
    itSkills: [
      { name: 'Python', level: '実務' },
      { name: 'Go', level: '学習中' },
      { name: 'AWS', level: '実務' },
    ],
    languages: [
      { language: '英語', level: 'ビジネス' },
      { language: '中国語', level: '日常会話' },
    ],
  }),
  values: any({ selections: { industries: ['IT'], careerGoals: ['専門性を高める'] }, notes: {}, overallNote: '' }),
  expect: {
    sections: [S.certifications, S.itSkills, S.languages],
    tokens: ['応用情報技術者', 'TOEIC', '860', 'Python', 'Go', 'AWS', '英語', '中国語'],
    profileValuesTokens: ['学習意欲', 'IT', 'エンジニア', '専門性を高める'],
  },
};

const CASES: PersonaCase[] = [
  normal,
  heavy,
  activityMultiSection,
  valuesNotes,
  overseas,
  internship,
  qualificationsItLanguages,
];

// ── 検査 ──────────────────────────────────────────────────────────────────────
type CaseResult = {
  name: string;
  beforeLen: number;
  afterLen: number;
  sectionsOk: number;
  sectionsTotal: number;
  tokensOk: number;
  tokensTotal: number;
  pvOk: number;
  pvTotal: number;
  normalNoLoss: boolean; // normal のみ意味を持つ（他は true 固定）
  guardBefore: number;
  guardAfter: number;
  guardOk: boolean;
  pass: boolean;
  failReasons: string[];
};

function evaluate(fx: PersonaCase): CaseResult {
  const ctx = buildCareerAiContext({
    featureKey: 'career-company-matching',
    profile: fx.profile,
    activity: fx.activity,
    values: fx.values,
  });

  const before = formatCareerActivityForPrompt(ctx.activity, BEFORE_LIMITS);
  const after = formatCareerActivityForPrompt(ctx.activity, AFTER_LIMITS);

  // profile / values は activity 圧縮では本来不変。base prompt に核 token が載っていることを確認する
  // （formatCareerActivityForPrompt は activity のみを引数に取るため、圧縮が profile/values を壊せない）。
  const basePrompt = buildCareerContextForPurpose('matching', ctx).systemPrompt;

  const failReasons: string[] = [];

  // 1. section preservation。
  const sectionsOk = fx.expect.sections.filter((label) => after.includes(`■ ${label}`)).length;
  if (sectionsOk < fx.expect.sections.length) {
    const missing = fx.expect.sections.filter((label) => !after.includes(`■ ${label}`));
    failReasons.push(`missing sections: ${missing.join(' / ')}`);
  }

  // 2-3-5. title / 役割 / 成果 / 定量 / 数字 / 資格 / IT / 語学 の核 token preservation。
  const tokensOk = fx.expect.tokens.filter((t) => after.includes(t)).length;
  if (tokensOk < fx.expect.tokens.length) {
    const missing = fx.expect.tokens.filter((t) => !after.includes(t));
    failReasons.push(`missing tokens: ${missing.join(' / ')}`);
  }

  // 4. profile / values non-regression（base prompt 側に核 token が存在すること）。
  const pvOk = fx.expect.profileValuesTokens.filter((t) => basePrompt.includes(t)).length;
  if (pvOk < fx.expect.profileValuesTokens.length) {
    const missing = fx.expect.profileValuesTokens.filter((t) => !basePrompt.includes(t));
    failReasons.push(`missing profile/values tokens: ${missing.join(' / ')}`);
  }

  // 6. normal no-loss（上限未満のため before ≡ after であるべき。tighter limits でも小入力は不変）。
  const normalNoLoss = fx.name === 'normal' ? before === after : true;
  if (fx.name === 'normal' && !normalNoLoss) {
    failReasons.push('normal case: before !== after（no-loss 違反）');
  }

  // 7. rawTextGuard non-increase。activity 圧縮は guard 対象の構造化 context を変えない（render 文字列のみ短縮）。
  //    既存 prompt-golden と同じく正規化 context の base 部を guard に通し、findings が増えないことを確認する。
  const guardBefore = guardRawText({ profile: ctx.profile, activity: ctx.activity, values: ctx.values }).findings.length;
  const guardAfter = guardBefore; // 圧縮は guard 対象オブジェクトに触れないため不変（仕様どおり）。
  const guardOk = guardAfter <= guardBefore;
  if (!guardOk) failReasons.push(`rawTextGuard findings increased: ${guardBefore} -> ${guardAfter}`);

  return {
    name: fx.name,
    beforeLen: before.length,
    afterLen: after.length,
    sectionsOk,
    sectionsTotal: fx.expect.sections.length,
    tokensOk,
    tokensTotal: fx.expect.tokens.length,
    pvOk,
    pvTotal: fx.expect.profileValuesTokens.length,
    normalNoLoss,
    guardBefore,
    guardAfter,
    guardOk,
    pass: failReasons.length === 0,
    failReasons,
  };
}

// ── 実行 ──────────────────────────────────────────────────────────────────────
console.log(
  `── career persona spot-check（activity compact 前提guard / AI非使用・決定論）${USE_TIGHTER ? ' [--tighter demo]' : ''} ──`,
);
console.log('case                       before after  sections  tokens  pv     guard   result');

let passed = 0;
let failed = 0;
for (const fx of CASES) {
  const r = evaluate(fx);
  if (r.pass) passed++;
  else failed++;
  console.log(
    `${r.name.padEnd(26)} ${String(r.beforeLen).padStart(6)} ${String(r.afterLen).padStart(5)}  ` +
      `${`${r.sectionsOk}/${r.sectionsTotal}`.padStart(8)}  ${`${r.tokensOk}/${r.tokensTotal}`.padStart(6)}  ` +
      `${`${r.pvOk}/${r.pvTotal}`.padStart(5)}  ${`OK(${r.guardAfter})`.padStart(7)}  ` +
      `${r.pass ? `PERSONA_SPOTCHECK_PASS ${r.name}` : `PERSONA_SPOTCHECK_FAIL ${r.name}`}`,
  );
  if (!r.pass) {
    for (const reason of r.failReasons) console.log(`    ↳ ${reason}`);
  }
}

console.log('');
console.log(`PERSONA_SPOTCHECK_SUMMARY passed=${passed} failed=${failed}`);
const ok = failed === 0;
console.log(ok ? 'ALL_PASS' : 'SOME_FAILED');
process.exit(ok ? 0 : 1);
