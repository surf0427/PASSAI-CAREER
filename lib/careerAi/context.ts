// PASSAI 就活版 AI 共通基盤 — コンテキスト正規化
//
// /career/profile・/career/activity の localStorage データを、就活 AI 用の
// CareerAiContext に変換する純粋関数群。
//
// 重要: 本ファイルはブラウザの localStorage を直接読まない。呼び出し側で読み出した
// profile / activity を引数で受け取り、正規化するだけの純粋関数として実装する。
// （SSR 安全・テスト容易・受験版ストレージ非依存を保つため）

import type {
  CareerProfileContext,
  CareerActivityContext,
  CareerValuesContext,
  CareerAiContext,
  CareerAiContextMetadata,
  CareerAiFeatureKey,
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from './types';

// 現行スキーマバージョン。将来コンテキスト形状を変えたら上げる。
const CAREER_CONTEXT_SCHEMA_VERSION = 1;

// ── 小さなヘルパー ────────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v) => v !== '');
}

// 「ラベル: 値」形式の行を、値が空の部分を捨ててから ' / ' で連結する。
// 活動 1 件を 1 行の可読文字列にまとめるために使う。
function joinFields(parts: Array<[label: string, value: unknown]>): string {
  return parts
    .map(([label, value]) => [label, str(value)] as const)
    .filter(([, value]) => value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join(' / ');
}

function periodText(period: unknown): string {
  if (!period || typeof period !== 'object') return '';
  const from = str((period as { from?: unknown }).from);
  const to = str((period as { to?: unknown }).to);
  if (!from && !to) return '';
  return `${from || '?'}〜${to || '?'}`;
}

// ── プロフィール正規化 ────────────────────────────────────────────

// BasicInfo（+ 将来の就活フィールド）を CareerProfileContext に正規化する。
// 大学・学部は BasicInfo.preferences[0] から引く（受験版の志望校データ構造を流用）。
// 就活固有フィールド（業界・職種・企業 等）は未入力なら空配列・空文字で埋める。
export function normalizeCareerProfileContext(
  input: CareerProfileInput | null | undefined,
): CareerProfileContext {
  const i = input ?? {};
  const firstPreference = Array.isArray(i.preferences) ? i.preferences[0] : undefined;

  return {
    name: str(i.name),
    university: str(firstPreference?.university),
    faculty: str(firstPreference?.faculty),
    grade: str(i.grade),
    graduationYear: str(i.graduationYear),
    targetIndustries: strArray(i.targetIndustries),
    targetJobs: strArray(i.targetJobs),
    targetCompanies: strArray(i.targetCompanies),
    jobHuntingStatus: str(i.jobHuntingStatus),
    strengths: strArray(i.strengths),
    weaknesses: strArray(i.weaknesses),
    certifications: strArray(i.certifications),
    internshipExperience: str(i.internshipExperience),
    studyAbroadExperience: str(i.studyAbroadExperience),
    preferredLocations: strArray(i.preferredLocations),
    notes: str(i.notes),
  };
}

// ── 活動正規化 ────────────────────────────────────────────────────

// 単発オブジェクトセクションを「ラベル: 値」の行配列に正規化する。
// 値が空の行は捨てる。全フィールド空なら空配列を返す。
function labeledLines(pairs: Array<[label: string, value: unknown]>): string[] {
  return pairs
    .map(([label, value]) => [label, str(value)] as const)
    .filter(([, value]) => value !== '')
    .map(([label, value]) => `${label}: ${value}`);
}

// CareerActivity（就活版「活動整理」の 18 セクション）を、就活 AI 向けの可読な
// string[] 群に正規化する。各セクションは「全フィールド空なら空配列」になり、
// renderActivity 側で空セクションは出力されない（未入力ユーザーへの影響なし）。
export function normalizeCareerActivityContext(
  input: CareerActivityInput | null | undefined,
): CareerActivityContext {
  const a = input ?? {};
  const dropEmpty = (lines: string[]) => lines.filter((line) => line.trim() !== '');

  // ① MBTI・性格
  const p = a.personality ?? {};
  const personality = labeledLines([
    ['MBTI', (p as Record<string, unknown>).mbti],
    ['自分で思う性格', (p as Record<string, unknown>).selfView],
    ['周囲から言われる性格', (p as Record<string, unknown>).othersView],
    ['強み', (p as Record<string, unknown>).strengths],
    ['弱み', (p as Record<string, unknown>).weaknesses],
    ['大切にしている価値観', (p as Record<string, unknown>).values],
    ['モチベーションが上がる環境', (p as Record<string, unknown>).motivationUp],
    ['モチベーションが下がる環境', (p as Record<string, unknown>).motivationDown],
  ]);

  // ② 学業・学生時代の活動
  const ac = a.academics ?? {};
  const academics = labeledLines([
    ['力を入れたこと', (ac as Record<string, unknown>).focusedEffort],
    ['ゼミ・研究', (ac as Record<string, unknown>).seminar],
    ['卒業研究・卒論', (ac as Record<string, unknown>).thesis],
    ['印象に残った授業', (ac as Record<string, unknown>).memorableClass],
    ['GPA', (ac as Record<string, unknown>).gpa],
    ['成績・受賞歴', (ac as Record<string, unknown>).academicAwards],
  ]);

  // 経験系の共通フィールド（役割・人数規模・期間・工夫・定量的な成果・学び）を行末尾に付ける。
  // ES・面接 AI が「規模・役割・定量成果・学び（＝強みの根拠）」を読み取れるようにする。
  const experienceFields = (
    e: Partial<{
      role: string;
      scale: string;
      period: { from?: string; to?: string };
      ingenuity: string;
      quantitativeResult: string;
      learning: string;
    }>,
  ): Array<[label: string, value: unknown]> => [
    ['役割', e.role],
    ['人数規模', e.scale],
    ['期間', periodText(e.period)],
    ['工夫', e.ingenuity],
    ['定量的な成果', e.quantitativeResult],
    ['学び', e.learning],
  ];

  // ③ アルバイト
  const partTimeJobs = (a.partTimeJobs ?? []).map((j) =>
    joinFields([
      ['勤務先', j.workplace],
      ['業務内容', j.jobContent],
      ...experienceFields(j),
    ]),
  );

  // ④ インターン
  const internships = (a.internships ?? []).map((i) =>
    joinFields([
      ['企業名', i.companyName],
      ['業務内容', i.jobContent],
      ...experienceFields(i),
    ]),
  );

  // ⑤ サークル・部活動（複数登録）
  const clubActivities = (a.club ?? []).map((c) =>
    joinFields([
      ['団体名', c.organizationName],
      ['活動内容', c.activityContent],
      ...experienceFields(c),
    ]),
  );

  // ⑥ プロジェクト経験
  const projects = (a.projects ?? []).map((pr) =>
    joinFields([
      ['プロジェクト名', pr.name],
      ['内容', pr.content],
      ...experienceFields(pr),
    ]),
  );

  // ⑦ リーダー経験（複数登録）
  const leadership = (a.leadership ?? []).map((l) =>
    joinFields([['経験内容', l.experience], ...experienceFields(l)]),
  );

  // ⑧ ボランティア・社会活動（複数登録）
  const volunteer = (a.volunteer ?? []).map((v) =>
    joinFields([['活動内容', v.activityContent], ...experienceFields(v)]),
  );

  // ⑨ 海外経験
  const ov = a.overseas ?? {};
  const overseas = labeledLines([
    ['内容', (ov as Record<string, unknown>).description],
    ['期間', (ov as Record<string, unknown>).period],
    ['学び', (ov as Record<string, unknown>).learning],
  ]);

  // ⑩ 資格
  const certifications = (a.certifications ?? []).map((c) =>
    joinFields([
      ['資格', c.name],
      ['スコア・級', c.score],
      ['取得時期', c.acquiredDate],
    ]),
  );

  // ⑪ ITスキル — "スキル名（レベル）"。レベル未選択なら名前のみ。
  const itSkills = (a.itSkills ?? [])
    .map((s) => {
      const name = str(s.name);
      if (name === '') return '';
      const level = str(s.level);
      return level !== '' ? `${name}（${level}）` : name;
    });

  // ⑫ 語学 — "言語（レベル）"。
  const languages = (a.languages ?? [])
    .map((l) => {
      const lang = str(l.language);
      if (lang === '') return '';
      const level = str(l.level);
      return level !== '' ? `${lang}（${level}）` : lang;
    });

  // ⑬⑭⑱ 自由記述（単一テキスト → 1 行 or 空）
  const hobbies = str(a.hobbies) !== '' ? [str(a.hobbies)] : [];
  const awards = str(a.awards) !== '' ? [str(a.awards)] : [];
  const others = str(a.freeNote) !== '' ? [str(a.freeNote)] : [];

  // ⑮ SNS・情報発信（複数登録）— 発信内容・継続性・得意分野・マーケ/発信力の根拠を渡す。
  const snsActivities = (a.snsActivities ?? []).map((s) =>
    joinFields([
      ['プラットフォーム', s.platform],
      ['アカウント', s.accountName],
      ['URL', s.url],
      ['内容・テーマ', s.theme],
      ['運営期間', periodText(s.period)],
      ['フォロワー/登録者数', s.followers],
      ['月間PV/再生数', s.monthlyViews],
      ['一番力を入れたこと', s.focusedEffort],
      ['学び', s.learning],
    ]),
  );

  // ⑯ ポートフォリオ・制作物（複数登録）— 技術スタック・課題解決力・デザイン/開発経験の根拠を渡す。
  const portfolios = (a.portfolios ?? []).map((p) =>
    joinFields([
      ['サービス名', p.name],
      ['種類', p.kind],
      ['URL', p.url],
      ['使用技術', p.techStack],
      ['担当', p.role],
      ['制作期間', periodText(p.period)],
      ['概要', p.overview],
      ['工夫', p.ingenuity],
      ['成果', p.result],
      ['学び', p.learning],
    ]),
  );

  // ⑰ 人生経験
  const le = a.lifeExperiences ?? {};
  const lifeExperiences = labeledLines([
    ['一番頑張った経験', (le as Record<string, unknown>).hardestEffort],
    ['一番失敗した経験', (le as Record<string, unknown>).biggestFailure],
    ['一番嬉しかった経験', (le as Record<string, unknown>).happiest],
    ['一番悔しかった経験', (le as Record<string, unknown>).mostFrustrated],
    ['挫折経験', (le as Record<string, unknown>).setback],
    ['人生の転機', (le as Record<string, unknown>).turningPoint],
    ['一番成長した経験', (le as Record<string, unknown>).mostGrowth],
  ]);

  return {
    personality,
    academics,
    partTimeJobs: dropEmpty(partTimeJobs),
    internships: dropEmpty(internships),
    clubActivities: dropEmpty(clubActivities),
    projects: dropEmpty(projects),
    leadership: dropEmpty(leadership),
    volunteer: dropEmpty(volunteer),
    overseas,
    certifications: dropEmpty(certifications),
    itSkills: dropEmpty(itSkills),
    languages: dropEmpty(languages),
    hobbies,
    awards,
    snsActivities: dropEmpty(snsActivities),
    portfolios: dropEmpty(portfolios),
    lifeExperiences,
    others,
  };
}

// ── 就活軸正規化 ──────────────────────────────────────────────────

// CareerValues（/career/values の localStorage / Supabase 形状）を、就活 AI 向けの
// CareerValuesContext に正規化する。未入力・部分データでも空配列・空文字で安全に埋める。
// 本ファイルは constants（careerValuesCategories）に依存しない（選択肢の妥当性検証は
// 保存層 careerValuesStorage が担保済み。ここでは型と空除去のみ行う純粋関数）。
export function normalizeCareerValuesContext(
  input: CareerValuesInput | null | undefined,
): CareerValuesContext {
  const v = input ?? {};
  const sel: Partial<CareerValuesContext> = v.selections ?? {};
  const notes: Partial<CareerValuesContext['notes']> = v.notes ?? {};

  return {
    priorities: strArray(sel.priorities),
    avoidances: strArray(sel.avoidances),
    industries: strArray(sel.industries),
    jobTypes: strArray(sel.jobTypes),
    workStyles: strArray(sel.workStyles),
    companyTypes: strArray(sel.companyTypes),
    careerGoals: strArray(sel.careerGoals),
    culturePreferences: strArray(sel.culturePreferences),
    notes: {
      priorities: str(notes.priorities),
      avoidances: str(notes.avoidances),
      industries: str(notes.industries),
      jobTypes: str(notes.jobTypes),
      workStyles: str(notes.workStyles),
      companyTypes: str(notes.companyTypes),
      careerGoals: str(notes.careerGoals),
      culturePreferences: str(notes.culturePreferences),
    },
    overallNote: str(v.overallNote),
  };
}

// ── 統合コンテキスト構築 ──────────────────────────────────────────

// profile / activity（生データ）と featureKey / userInput から CareerAiContext を組む。
// metadata は既定値を与え、呼び出し側が一部上書きできる。純粋関数（副作用なし）。
export function buildCareerAiContext(params: {
  featureKey: CareerAiFeatureKey;
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  // 就活軸整理（/career/values）。未指定なら空コンテキストで埋める（後方互換）。
  values?: CareerValuesInput | null;
  userInput?: string;
  metadata?: Partial<CareerAiContextMetadata>;
}): CareerAiContext {
  const metadata: CareerAiContextMetadata = {
    source: 'career',
    schemaVersion: CAREER_CONTEXT_SCHEMA_VERSION,
    locale: 'ja-JP',
    ...params.metadata,
  };

  return {
    profile: normalizeCareerProfileContext(params.profile),
    activity: normalizeCareerActivityContext(params.activity),
    values: normalizeCareerValuesContext(params.values),
    featureKey: params.featureKey,
    userInput: str(params.userInput),
    metadata,
  };
}
