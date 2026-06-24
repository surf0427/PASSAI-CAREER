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
  CareerAiContext,
  CareerAiContextMetadata,
  CareerAiFeatureKey,
  CareerProfileInput,
  CareerActivityInput,
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

// ActivityData の各カテゴリを、就活 AI 向けの可読な string[] に正規化する。
// - 受験版「探究(research)」「コンテスト(contest)」等もそのまま経験として活用する。
// - インターンは現行 ActivityData に専用カテゴリが無いため空配列（就活版で活動フォームに
//   追加されたら本関数を拡張する）。
// - 「読書(reading)」は就活コンテキストに専用枠が無いため others に畳み込む。
export function normalizeCareerActivityContext(
  input: CareerActivityInput | null | undefined,
): CareerActivityContext {
  const a = input ?? {};

  const studentActivities = (a.clubActivities ?? []).map((c) =>
    joinFields([
      ['部活/サークル', c.clubName],
      ['種目', c.sport],
      ['役割', c.role],
      ['活動内容', c.description],
      ['成果', c.achievement],
      ['期間', periodText(c.period)],
    ]),
  );

  const partTimeJobs = (a.partTimeJobActivities ?? []).map((p) =>
    joinFields([
      ['業種', p.industry],
      ['業務内容', p.jobContent],
      ['役割', p.role],
      ['成果', p.achievement],
      ['勤務頻度', p.workFrequency],
      ['期間', periodText(p.period)],
    ]),
  );

  // 現行 ActivityData にインターン専用カテゴリは無い。就活版フォーム拡張時に配線する。
  const internships: string[] = [];

  const studyAbroad = (a.studyAbroadActivities ?? []).map((s) =>
    joinFields([
      ['留学先', s.destination],
      ['プログラム', s.programContent],
      ['使用言語', s.language],
      ['学び', s.reflection],
      ['期間', periodText(s.period)],
    ]),
  );

  const research = (a.researchActivities ?? []).map((r) =>
    joinFields([
      ['テーマ', r.theme],
      ['きっかけ', r.trigger],
      ['調査方法', r.methodology],
      ['成果物', r.output],
      ['学び', r.reflection],
    ]),
  );

  const volunteer = (a.volunteerActivities ?? []).map((v) =>
    joinFields([
      ['活動', v.activityContent],
      ['対象', v.target],
      ['目的', v.purpose],
      ['成果', v.achievement],
      ['頻度', v.frequency],
    ]),
  );

  const certifications = (a.certificationActivities ?? []).map((c) =>
    joinFields([
      ['資格', c.certificationName],
      ['レベル/スコア', c.level],
      ['取得時期', c.acquiredDate],
      ['取得目的', c.purpose],
    ]),
  );

  const contests = (a.contestActivities ?? []).map((c) =>
    joinFields([
      ['コンテスト', c.contestName],
      ['分野', c.field],
      ['結果', c.result],
      ['活動内容', c.description],
    ]),
  );

  const hobbies = (a.hobbyActivities ?? []).map((h) =>
    joinFields([
      ['趣味', h.hobbyContent],
      ['頻度', h.frequency],
      ['続ける理由', h.reason],
      ['得たスキル', h.acquiredSkills],
    ]),
  );

  // others = その他活動 + 読書（専用枠が無いため畳み込み）。
  const others = [
    ...(a.otherActivities ?? []).map((o) =>
      joinFields([
        ['活動名', o.activityName],
        ['活動内容', o.description],
        ['役割', o.role],
        ['成果', o.achievement],
        ['期間', periodText(o.period)],
      ]),
    ),
    ...(a.readingActivities ?? []).map((r) =>
      joinFields([
        ['読書ジャンル', r.genre],
        ['印象に残った本', r.favoriteBook],
        ['選んだ理由', r.reason],
        ['思考の変化', r.mindChange],
      ]),
    ),
  ];

  // 全フィールド空の行は捨てる（活動枠だけ追加して未入力のケースを除去）。
  const dropEmpty = (lines: string[]) => lines.filter((line) => line.trim() !== '');

  return {
    studentActivities: dropEmpty(studentActivities),
    partTimeJobs: dropEmpty(partTimeJobs),
    internships: dropEmpty(internships),
    studyAbroad: dropEmpty(studyAbroad),
    research: dropEmpty(research),
    volunteer: dropEmpty(volunteer),
    certifications: dropEmpty(certifications),
    contests: dropEmpty(contests),
    hobbies: dropEmpty(hobbies),
    others: dropEmpty(others),
  };
}

// ── 統合コンテキスト構築 ──────────────────────────────────────────

// profile / activity（生データ）と featureKey / userInput から CareerAiContext を組む。
// metadata は既定値を与え、呼び出し側が一部上書きできる。純粋関数（副作用なし）。
export function buildCareerAiContext(params: {
  featureKey: CareerAiFeatureKey;
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
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
    featureKey: params.featureKey,
    userInput: str(params.userInput),
    metadata,
  };
}
