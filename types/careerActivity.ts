// PASSAI 就活版（PASSAI CAREER）— 「活動整理」(/career/activity) のデータ型。
//
// 役割:
//   受験版の「活動整理」(@/types/activity の ActivityData) を就活版向けに置き換える、
//   就活版専用の型。ユーザーのこれまでの経験・性格・スキルを AI（自己分析・ES・面接・
//   企業マッチング・相談 等）が理解するための「基盤データベース」。
//
// 設計方針:
//   - 受験版（AO・推薦・大学入試）の型・ストレージには一切依存しない（careerValues と同じ独立土台）。
//   - 基本情報（/career/profile）・就活軸整理（/career/values）と重複する項目は持たない。
//     ここでは「これまでの経験・人物像・スキル」を中心に整理する。
//   - すべての入力は任意。未入力・部分入力でも保存・正規化できる構造にする。
//   - 将来 Supabase へミラーしやすいよう、単発オブジェクト（personality 等）と
//     複数登録リスト（経験系）を明確に分離した構造化 JSON とする。
//   - 経験系（アルバイト・インターン・サークル・プロジェクト・リーダー・ボランティア）は
//     すべて「複数登録可能なリスト」。ES・面接・自己分析で AI が最適なエピソードを選べるよう、
//     各経験に共通の定量フィールド（期間・役割・人数規模・定量的な成果・工夫・学び）を持たせる。
//   - 複数登録リストの各要素は React キー / 将来の行 ID 用に `id` を持つ。

// ── 共通サブ型 ───────────────────────────────────────────────────────

// 期間（自由文字列。"2024年4月" / "2024-04" などフォーマットは問わない）。
export type CareerPeriod = {
  from: string;
  to: string;
};

// 経験系の各エピソードが共通で持つ定量・深掘りフィールド。
// ES・面接で説得力を出すための「規模・役割・定量成果・工夫・学び」を標準化する。
export type ExperienceCommon = {
  period: CareerPeriod; // 期間
  role: string; // 役割
  scale: string; // 人数規模・組織/案件の規模
  ingenuity: string; // 工夫したこと
  quantitativeResult: string; // 定量的な成果（数字を含む結果）
  learning: string; // 学んだこと
};

// ── 複数登録リストの各要素（経験系） ─────────────────────────────────

// ③ アルバイト
export type PartTimeJobEntry = ExperienceCommon & {
  id: string;
  workplace: string; // 勤務先
  jobContent: string; // 業務内容
};

// ④ インターン
export type InternshipEntry = ExperienceCommon & {
  id: string;
  companyName: string; // 企業名
  jobContent: string; // 業務内容
};

// ⑤ サークル・部活動
export type ClubEntry = ExperienceCommon & {
  id: string;
  organizationName: string; // 団体名
  activityContent: string; // 活動内容
};

// ⑥ プロジェクト経験（個人開発 / アプリ開発 / 起業 / ハッカソン 等）
export type ProjectEntry = ExperienceCommon & {
  id: string;
  name: string; // プロジェクト名
  content: string; // 内容
};

// ⑦ リーダー経験
export type LeadershipEntry = ExperienceCommon & {
  id: string;
  experience: string; // 経験内容
};

// ⑧ ボランティア・社会活動
export type VolunteerEntry = ExperienceCommon & {
  id: string;
  activityContent: string; // 活動内容
};

// ── 複数登録リストの各要素（スキル・資格系） ─────────────────────────

// ⑩ 資格（TOEIC / 簿記 / IT 資格 等）
export type CertificationEntry = {
  id: string;
  name: string; // 資格名
  score: string; // スコア・級（例：850点 / 2級）
  acquiredDate: string; // 取得時期
};

// ⑪ IT スキル
export type ItSkillLevel = '' | '未経験' | '初級' | '中級' | '上級';
export type ItSkillEntry = {
  id: string;
  name: string; // スキル名（例：Excel / Python / Figma）
  level: ItSkillLevel; // スキルレベル
};

// ⑮ SNS・情報発信経験（YouTube / TikTok / X / note / ブログ 等）
// 発信内容・継続性・得意分野・マーケ/コミュニケーション経験を AI が読み取れるよう構造化する。
export type SnsEntry = {
  id: string;
  platform: string; // プラットフォーム
  url: string; // URL
  accountName: string; // アカウント名（任意）
  theme: string; // 内容・テーマ
  period: CareerPeriod; // 運営期間（任意）
  followers: string; // フォロワー数・登録者数（任意）
  monthlyViews: string; // 月間PV・再生数など（任意）
  focusedEffort: string; // 一番力を入れたこと
  learning: string; // 学んだこと
};

// ⑯ ポートフォリオ・制作物（GitHub / Web / アプリ / Qiita / Figma 等）
// 技術スタック・制作経験・課題解決力・デザイン力・主体性・継続性を AI が読み取れるよう構造化する。
export type PortfolioEntry = {
  id: string;
  name: string; // サービス名
  url: string; // URL
  kind: string; // 制作物の種類
  period: CareerPeriod; // 制作期間
  techStack: string; // 使用技術
  role: string; // 担当
  overview: string; // 概要
  ingenuity: string; // 工夫したこと
  result: string; // 成果
  learning: string; // 学んだこと
};

// ⑫ 語学
export type LanguageLevel =
  | ''
  | 'ネイティブ'
  | 'C2'
  | 'C1'
  | 'B2'
  | 'B1'
  | 'A2'
  | 'A1';
export type LanguageEntry = {
  id: string;
  language: string; // 言語（英語 / 中国語 等）
  level: LanguageLevel; // レベル（CEFR + ネイティブ）
};

// ── 単発オブジェクト（複数登録なし） ─────────────────────────────────

// ① MBTI・性格
export type PersonalitySection = {
  mbti: string;
  selfView: string; // 自分で思う性格
  othersView: string; // 周囲から言われる性格
  strengths: string; // 強み
  weaknesses: string; // 弱み
  values: string; // 大切にしている価値観
  motivationUp: string; // モチベーションが上がる環境
  motivationDown: string; // モチベーションが下がる環境
};

// ② 学業・学生時代の活動
export type AcademicsSection = {
  focusedEffort: string; // 学生時代に力を入れたこと
  seminar: string; // ゼミ・研究
  thesis: string; // 卒業研究・卒論（任意）
  memorableClass: string; // 印象に残った授業
  gpa: string; // GPA（任意）
  academicAwards: string; // 成績・受賞歴（任意）
};

// ⑨ 海外経験（留学 / ワーホリ / 語学学校 / 海外旅行 / 国際交流）
export type OverseasSection = {
  description: string; // 内容（種類・行き先など自由記述）
  period: string; // 期間
  learning: string; // 学び
};

// ⑰ 人生経験
export type LifeExperiencesSection = {
  hardestEffort: string; // 一番頑張った経験
  biggestFailure: string; // 一番失敗した経験
  happiest: string; // 一番嬉しかった経験
  mostFrustrated: string; // 一番悔しかった経験
  setback: string; // 挫折経験
  turningPoint: string; // 人生の転機
  mostGrowth: string; // 一番成長した経験
};

// ── 全体型 ───────────────────────────────────────────────────────────

export type CareerActivity = {
  personality: PersonalitySection; // ①
  academics: AcademicsSection; // ②
  partTimeJobs: PartTimeJobEntry[]; // ③
  internships: InternshipEntry[]; // ④
  club: ClubEntry[]; // ⑤（複数登録可）
  projects: ProjectEntry[]; // ⑥
  leadership: LeadershipEntry[]; // ⑦（複数登録可）
  volunteer: VolunteerEntry[]; // ⑧（複数登録可）
  overseas: OverseasSection; // ⑨
  certifications: CertificationEntry[]; // ⑩
  itSkills: ItSkillEntry[]; // ⑪
  languages: LanguageEntry[]; // ⑫
  hobbies: string; // ⑬ 趣味・特技
  awards: string; // ⑭ 表彰・実績
  snsActivities: SnsEntry[]; // ⑮ SNS・情報発信経験（複数登録可）
  portfolios: PortfolioEntry[]; // ⑯ ポートフォリオ・制作物（複数登録可）
  lifeExperiences: LifeExperiencesSection; // ⑰
  freeNote: string; // ⑱ その他
  // 最終更新時刻（ISO 文字列）。LS / 将来の DB 同期で保持する。
  updatedAt?: string;
};

// ── 空の初期値・ファクトリ ───────────────────────────────────────────

// 複数登録リストの行 ID。React キー / 将来の DB 行 ID 用。
// crypto.randomUUID が無い環境（古い WebView 等）でも落ちないようフォールバックする。
export function newActivityId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `a_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function emptyPeriod(): CareerPeriod {
  return { from: '', to: '' };
}

// 経験系の共通フィールドの空値。
function emptyExperienceCommon(): ExperienceCommon {
  return {
    period: emptyPeriod(),
    role: '',
    scale: '',
    ingenuity: '',
    quantitativeResult: '',
    learning: '',
  };
}

export function newPartTimeJobEntry(): PartTimeJobEntry {
  return { id: newActivityId(), workplace: '', jobContent: '', ...emptyExperienceCommon() };
}

export function newInternshipEntry(): InternshipEntry {
  return { id: newActivityId(), companyName: '', jobContent: '', ...emptyExperienceCommon() };
}

export function newClubEntry(): ClubEntry {
  return {
    id: newActivityId(),
    organizationName: '',
    activityContent: '',
    ...emptyExperienceCommon(),
  };
}

export function newProjectEntry(): ProjectEntry {
  return { id: newActivityId(), name: '', content: '', ...emptyExperienceCommon() };
}

export function newLeadershipEntry(): LeadershipEntry {
  return { id: newActivityId(), experience: '', ...emptyExperienceCommon() };
}

export function newVolunteerEntry(): VolunteerEntry {
  return { id: newActivityId(), activityContent: '', ...emptyExperienceCommon() };
}

export function newCertificationEntry(): CertificationEntry {
  return { id: newActivityId(), name: '', score: '', acquiredDate: '' };
}

export function newItSkillEntry(): ItSkillEntry {
  return { id: newActivityId(), name: '', level: '' };
}

export function newLanguageEntry(): LanguageEntry {
  return { id: newActivityId(), language: '', level: '' };
}

export function newSnsEntry(): SnsEntry {
  return {
    id: newActivityId(),
    platform: '',
    url: '',
    accountName: '',
    theme: '',
    period: emptyPeriod(),
    followers: '',
    monthlyViews: '',
    focusedEffort: '',
    learning: '',
  };
}

export function newPortfolioEntry(): PortfolioEntry {
  return {
    id: newActivityId(),
    name: '',
    url: '',
    kind: '',
    period: emptyPeriod(),
    techStack: '',
    role: '',
    overview: '',
    ingenuity: '',
    result: '',
    learning: '',
  };
}

export function emptyCareerActivity(): CareerActivity {
  return {
    personality: {
      mbti: '',
      selfView: '',
      othersView: '',
      strengths: '',
      weaknesses: '',
      values: '',
      motivationUp: '',
      motivationDown: '',
    },
    academics: {
      focusedEffort: '',
      seminar: '',
      thesis: '',
      memorableClass: '',
      gpa: '',
      academicAwards: '',
    },
    partTimeJobs: [],
    internships: [],
    club: [],
    projects: [],
    leadership: [],
    volunteer: [],
    overseas: { description: '', period: '', learning: '' },
    certifications: [],
    itSkills: [],
    languages: [],
    hobbies: '',
    awards: '',
    snsActivities: [],
    portfolios: [],
    lifeExperiences: {
      hardestEffort: '',
      biggestFailure: '',
      happiest: '',
      mostFrustrated: '',
      setback: '',
      turningPoint: '',
      mostGrowth: '',
    },
    freeNote: '',
  };
}

// 「すべて空か」を判定する（表示・同期判断・readiness 用）。
// すべてのセクション（単発オブジェクト・リスト・自由記述）を横断して、
// 1 つでも非空文字 / 1 件でもリスト要素があれば false を返す。
export function isCareerActivityEmpty(activity: CareerActivity): boolean {
  const objHasValue = (obj: Record<string, string>): boolean =>
    Object.values(obj).some((v) => typeof v === 'string' && v.trim() !== '');

  if (objHasValue(activity.personality)) return false;
  if (objHasValue(activity.academics)) return false;
  if (objHasValue(activity.overseas)) return false;
  if (objHasValue(activity.lifeExperiences)) return false;

  if (activity.partTimeJobs.length > 0) return false;
  if (activity.internships.length > 0) return false;
  if (activity.club.length > 0) return false;
  if (activity.projects.length > 0) return false;
  if (activity.leadership.length > 0) return false;
  if (activity.volunteer.length > 0) return false;
  if (activity.certifications.length > 0) return false;
  if (activity.itSkills.length > 0) return false;
  if (activity.languages.length > 0) return false;
  if (activity.snsActivities.length > 0) return false;
  if (activity.portfolios.length > 0) return false;

  if (activity.hobbies.trim() !== '') return false;
  if (activity.awards.trim() !== '') return false;
  if (activity.freeNote.trim() !== '') return false;

  return true;
}
