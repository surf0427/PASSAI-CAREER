/*
 * scripts/career-memory-prompt-golden-qa.ts
 *
 * PASSAI CAREER — system prompt(base) の golden 固定 QA（P6-B 常設 harness）。
 *
 * 背景（P6-A の監査結論）:
 *   P5 までの byte harness（qa:careerMemory{Matching,Presentation,Interview,Consultation}）が
 *   守るのは **request body byte**（selector 出力の JSON.stringify）。
 *   実際に AI 挙動 / token / cache / PII に効くのは **system prompt byte** で、そちらは
 *   selector → route → buildCareerAiContext → buildCareerContextForPurpose →
 *   buildCareerSystemPrompt → renderProfile/renderActivity/renderValues を通って生成される。
 *
 * 目的:
 *   現在の base system prompt 出力を purpose 別に golden として固定し、P6-C 以降で
 *   prompt byte を **意図的に**変える（PII 除外 / activity 圧縮 / base 削減）際に、
 *   差分を明示的に更新できるようにする回帰ガード。
 *   加えて PII / raw のベースライン検出と、purpose 別の prompt 文字数ベースラインを出す。
 *
 * 厳守（P6-B）:
 *   - production route / prompt / selector / snapshot / AI schema / DB を一切変更しない。
 *   - 本 harness は現行 production 関数を **読むだけ**（純関数 fixture 実行）。env/secret 非接続。
 *   - PII 検出は P6-B では **baseline 報告**であり fail させない（現状 氏名 行は出る）。
 *     P6-C 以降で expectNoProfilePii に切り替える（docs §J 参照）。
 *
 * 使い方:
 *   npx tsx scripts/career-memory-prompt-golden-qa.ts            # golden と比較（既定）
 *   npx tsx scripts/career-memory-prompt-golden-qa.ts --update   # 現在の出力を golden に上書き
 * 終了コード: 全ケース golden 一致 → 0 / 1 件でも不一致・golden 欠落 → 1。
 *   （PII baseline は終了コードに影響しない。）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildCareerAiContext } from '@/lib/careerAi/context';
import { buildCareerContextForPurpose } from '@/lib/careerContext/orchestrator';
import type { CareerContextPurpose } from '@/lib/careerContext/purpose';
import type { CareerAiFeatureKey } from '@/lib/careerAi/types';
import { guardRawText } from '@/lib/careerContext/rawTextGuard';
import { compressCareerActivityForConsultation } from '@/lib/careerConsultation/historySnapshots';

/* eslint-disable @typescript-eslint/no-explicit-any */
const any = (v: unknown) => v as any;

const GOLDEN_DIR = join(process.cwd(), 'scripts/fixtures/prompt-golden');
const UPDATE = process.argv.includes('--update') || process.env.UPDATE === '1';

// ── purpose 設定（live CareerContextPurpose 単位。featureKey は各 route の FEATURE_KEY と一致） ──
//   consultation のみ route が compressCareerActivityForConsultation を通すので golden もそれを再現する。
//   interview_complete は base builder を interview_practice と共有するため base prompt は同一（golden で確認）。
type PurposeConfig = {
  purpose: CareerContextPurpose;
  featureKey: CareerAiFeatureKey;
  compressActivity: boolean;
};
const PURPOSES: PurposeConfig[] = [
  { purpose: 'consultation', featureKey: 'career-consultation', compressActivity: true },
  { purpose: 'matching', featureKey: 'career-company-matching', compressActivity: false },
  { purpose: 'interview_practice', featureKey: 'career-interview', compressActivity: false },
  { purpose: 'interview_complete', featureKey: 'career-interview', compressActivity: false },
  { purpose: 'presentation_feedback', featureKey: 'career-presentation', compressActivity: false },
];

// ── fixtures（profile / activity / values の生入力。normalize* が内部で正規化する） ──────────
type CaseFixture = { name: string; profile: any; activity: any; values: any };

// normal: 標準的な入力（氏名あり）。
const normal: CaseFixture = {
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
};

// heavy: 大量入力（consultation 圧縮が生入力と差が出るよう長文カードを含める）。
const heavy: CaseFixture = {
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
    notes: {
      priorities: '若手のうちから責任ある仕事を任されたい',
      avoidances: '評価が年齢で決まる環境は避けたい',
      careerGoals: '30代で海外駐在を経験したい',
    },
    overallNote: '成長と海外志向を軸に企業を見ている。',
  }),
};

// pii-profile: 氏名 + 備考にメール等の PII を含む（P6-C で除外対象になることを baseline 化）。
const piiProfile: CaseFixture = {
  name: 'pii-profile',
  profile: any({
    name: '田中一郎',
    preferences: [{ university: '慶應義塾大学', faculty: '法学部' }],
    grade: '3年',
    graduationYear: '2027',
    targetIndustries: ['金融'],
    notes: '連絡先: ichiro.tanaka@example.com / 090-1234-5678',
  }),
  activity: any({ academics: { seminar: '商法ゼミ' } }),
  values: any({ selections: {}, notes: {}, overallNote: '' }),
};

// activity-multi-section: 活動を多セクション埋める（activity section の長さ baseline 用）。
const activityMultiSection: CaseFixture = {
  name: 'activity-multi-section',
  profile: any({ name: '鈴木健', preferences: [{ university: '大阪大学', faculty: '工学部' }], grade: '修士1年' }),
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
};

// values-notes: 就活軸に notes / overallNote を詰める（values section の長さ baseline 用）。
const valuesNotes: CaseFixture = {
  name: 'values-notes',
  profile: any({ name: '高橋みなみ', preferences: [{ university: '名古屋大学', faculty: '文学部' }], grade: '3年' }),
  activity: any({ academics: { seminar: '社会学ゼミ' } }),
  values: any({
    selections: {
      priorities: ['ワークライフバランス'],
      avoidances: ['転勤が多い'],
      industries: ['教育'],
      workStyles: ['リモート可'],
    },
    notes: {
      priorities: 'プライベートの時間も大切にしながら長く働きたい',
      avoidances: '頻繁な転勤で生活基盤が安定しないのは避けたい',
      industries: '人の成長に関わる仕事に興味がある',
      workStyles: '週数日はリモートで働ける環境が理想',
    },
    overallNote: '長期的に安定して働ける環境を重視している。',
  }),
};

const CASES: CaseFixture[] = [normal, heavy, piiProfile, activityMultiSection, valuesNotes];

// ── prompt 生成（各 route と同じ経路を再現） ──────────────────────────────────────
function buildPrompt(cfg: PurposeConfig, fx: CaseFixture): string {
  const activityInput = cfg.compressActivity
    ? compressCareerActivityForConsultation(any(fx.activity))
    : fx.activity;
  const context = buildCareerAiContext({
    featureKey: cfg.featureKey,
    profile: fx.profile,
    activity: any(activityInput),
    values: fx.values,
  });
  return buildCareerContextForPurpose(cfg.purpose, context).systemPrompt;
}

// ── section 抽出（golden 比較ではなく length baseline 用の近似抽出） ──────────────────
function extractSection(prompt: string, header: string): string | null {
  const marker = `# ${header}\n`;
  const start = prompt.indexOf(marker);
  if (start === -1) return null;
  const contentStart = start + marker.length;
  let end = prompt.indexOf('\n\n#', contentStart);
  if (end === -1) end = prompt.length;
  return prompt.slice(contentStart, end);
}

const PII_LABEL = '- 氏名:';
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// 氏名(構造化PII)行が prompt に無いことを strict 検証する purpose。
//   P6-C: matching / P6-D: presentation_feedback を追加。consultation / interview は baseline のまま
//   （氏名行が残っていても fail させない）。今後順次 strict へ寄せる。
//   email pattern（備考等の自由記述由来）は今回 strict 対象外＝baseline のまま。
const PII_STRICT_PURPOSES = new Set<CareerContextPurpose>(['matching', 'presentation_feedback']);

function goldenPath(cfg: PurposeConfig, fx: CaseFixture): string {
  return join(GOLDEN_DIR, `${cfg.purpose}__${fx.name}.txt`);
}

// ── 実行 ────────────────────────────────────────────────────────────────────────
if (UPDATE && !existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

let mismatches = 0;
type Row = {
  purpose: string;
  caseName: string;
  total: number;
  profileLen: number;
  activityLen: number;
  valuesLen: number;
  hasPiiLabel: boolean;
  hasEmail: boolean;
  guardFindings: number;
};
const rows: Row[] = [];

for (const cfg of PURPOSES) {
  for (const fx of CASES) {
    const prompt = buildPrompt(cfg, fx);
    const p = goldenPath(cfg, fx);

    if (UPDATE) {
      writeFileSync(p, prompt, 'utf8');
      console.log(`📝 wrote   | ${cfg.purpose} / ${fx.name}`);
    } else if (!existsSync(p)) {
      mismatches++;
      console.log(`❌ MISSING | ${cfg.purpose} / ${fx.name} (run with --update to bootstrap)`);
    } else {
      const golden = readFileSync(p, 'utf8');
      if (golden === prompt) {
        console.log(`✅ match   | ${cfg.purpose} / ${fx.name}`);
      } else {
        mismatches++;
        console.log(`❌ MISMATCH| ${cfg.purpose} / ${fx.name} (prompt changed — re-run --update if intended)`);
      }
    }

    // baseline 計測（golden 比較とは独立・fail させない）。
    const profileSection = extractSection(prompt, '学生プロフィール') ?? '';
    const activitySection = extractSection(prompt, '活動・経験') ?? '';
    const valuesSection = extractSection(prompt, '就活軸（重視・回避・志向）') ?? '';
    // guardRawText は正規化済み CareerAiContext の base 部（key ベース）へ通す。
    const ctxForGuard = buildCareerAiContext({
      featureKey: cfg.featureKey,
      profile: fx.profile,
      activity: fx.activity,
      values: fx.values,
    });
    const guard = guardRawText({
      profile: ctxForGuard.profile,
      activity: ctxForGuard.activity,
      values: ctxForGuard.values,
    });
    rows.push({
      purpose: cfg.purpose,
      caseName: fx.name,
      total: prompt.length,
      profileLen: profileSection.length,
      activityLen: activitySection.length,
      valuesLen: valuesSection.length,
      hasPiiLabel: prompt.includes(PII_LABEL),
      hasEmail: EMAIL_RE.test(prompt),
      guardFindings: guard.findings.length,
    });
  }
}

// ── prompt length baseline（文字数ベース。token 実測ではない） ─────────────────────
console.log('');
console.log('── prompt length baseline（文字数ベース / not token 実測）──────────────────');
console.log('purpose                 case                    total  profile activity values');
for (const r of rows) {
  console.log(
    `${r.purpose.padEnd(23)} ${r.caseName.padEnd(23)} ${String(r.total).padStart(5)}  ${String(r.profileLen).padStart(7)} ${String(r.activityLen).padStart(8)} ${String(r.valuesLen).padStart(6)}`,
  );
}

// ── PII / raw baseline + strict assertion ─────────────────────────────────────────
console.log('');
console.log('── PII / raw baseline & strict（strict purpose:氏名行0 / others:baseline）────');
const emailHits = rows.filter((r) => r.hasEmail).length;
const guardTotal = rows.reduce((s, r) => s + r.guardFindings, 0);

// strict purpose は氏名行 0 を要求（違反したら piiStrictFailures を積む＝exit code に反映）。
const strictRows = rows.filter((r) => PII_STRICT_PURPOSES.has(r.purpose as CareerContextPurpose));
const baselineRows = rows.filter((r) => !PII_STRICT_PURPOSES.has(r.purpose as CareerContextPurpose));
let piiStrictFailures = 0;
for (const r of strictRows) {
  if (r.hasPiiLabel) {
    piiStrictFailures++;
    console.log(`❌ PII STRICT FAIL | ${r.purpose} / ${r.caseName} — "${PII_LABEL}" が残存`);
  }
}
// strict purpose ごとに氏名行数を出す（各 0 期待）。
for (const purpose of PII_STRICT_PURPOSES) {
  const pr = strictRows.filter((r) => r.purpose === purpose);
  const hits = pr.filter((r) => r.hasPiiLabel).length;
  console.log(`[strict]   ${purpose.padEnd(21)} 氏名行: ${hits}/${pr.length}（期待 0）→ ${hits === 0 ? 'PASS ✅' : 'FAIL ❌'}`);
}
const baselinePiiHits = baselineRows.filter((r) => r.hasPiiLabel).length;
console.log(
  `[baseline] others (consultation/interview) 氏名行: ${baselinePiiHits}/${baselineRows.length}（現状維持・fail させない）`,
);
console.log(`[baseline] email パターン:   ${emailHits}/${rows.length} ケース（備考 等の自由記述由来・strict 対象外）`);
console.log(`[baseline] guardRawText:     ${guardTotal} 件（base context の key ベース。raw data 側は不変）`);
console.log('※ consultation / interview は今後順次 PII_STRICT_PURPOSES へ追加予定（docs §J）。');

// ── 終了判定（golden 一致 + matching strict PII の両方で決まる） ───────────────────
console.log('');
if (UPDATE) {
  console.log(`updated ${PURPOSES.length * CASES.length} goldens`);
  console.log('GOLDEN_UPDATED');
  process.exit(0);
}
console.log(
  `total=${PURPOSES.length * CASES.length} match=${PURPOSES.length * CASES.length - mismatches} mismatch=${mismatches} piiStrictFail=${piiStrictFailures}`,
);
const ok = mismatches === 0 && piiStrictFailures === 0;
console.log(ok ? 'ALL_MATCH' : 'DIFF_FOUND');
process.exit(ok ? 0 : 1);
