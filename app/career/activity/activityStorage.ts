// 就活版（PASSAI CAREER）「活動整理」(/career/activity) の localStorage 保存層（canonical）。
//
// 役割:
//   受験版の活動整理（exam: ActivityData / key 'activityFormData'）を就活版向けに置き換えた、
//   就活専用の活動データベース（@/types/careerActivity の CareerActivity）の正本ストア。
//   他の career 機能（profileStorage / careerValuesStorage）と同じく localStorage を canonical
//   とする。MVP では Supabase ミラーは持たない（型は将来ミラーしやすい構造化 JSON）。
//
// キー分離:
//   - 受験版キー: 'activityFormData'
//   - 旧 就活版（exam 形状を流用）キー: 'careerActivityFormData'（廃止）
//   - 新 就活版キー: 'careerActivityData'（本ファイル。新 CareerActivity 形状）
//
// 防御的正規化:
//   - 旧スキーマ・部分データ・手書き JSON でも落ちないよう、空の CareerActivity を土台に
//     既知フィールドのみ取り込む。
//   - サークル/リーダー/ボランティアは「複数登録（配列）」へ移行済み。旧版の単発オブジェクト
//     形式が残っていても、内容があれば 1 要素の配列へ安全に変換する（空なら破棄）。
//   - 経験系の旧 `achievement`（成果）は、新 `quantitativeResult`（定量的な成果）が空のときに
//     フォールバックとして取り込む。

import {
  safeGetStorage,
  safeSetStorage,
  safeRemoveStorage,
} from '@/lib/storage/safeStorage';
import type {
  CareerActivity,
  CareerPeriod,
  ExperienceCommon,
  FocusedActivityEntry,
  OverseasEntry,
  PartTimeJobEntry,
  InternshipEntry,
  ClubEntry,
  ProjectEntry,
  LeadershipEntry,
  VolunteerEntry,
  CertificationEntry,
  ItSkillEntry,
  LanguageEntry,
  SnsEntry,
  PortfolioEntry,
  ItSkillLevel,
  LanguageLevel,
} from '@/types/careerActivity';
import {
  emptyCareerActivity,
  isCareerActivityEmpty,
  newActivityId,
} from '@/types/careerActivity';
import {
  IS_VALID_IT_SKILL_LEVEL,
  IS_VALID_LANGUAGE_LEVEL,
} from './careerActivityCategories';

const STORAGE_KEY = 'careerActivityData';

// Dedup gate — 同一内容の re-save を抑制（受験版と同設計）。canonical は localStorage。
let lastSavedJson: string | undefined;

// ── 正規化ヘルパー ───────────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 期間。オブジェクト {from,to} を基本とし、旧版の文字列形式（ボランティア期間など）は
// from に畳み込んで救済する。
function period(value: unknown): CareerPeriod {
  if (typeof value === 'string') return { from: value, to: '' };
  if (!isObj(value)) return { from: '', to: '' };
  return { from: str(value.from), to: str(value.to) };
}

function id(value: unknown): string {
  const s = str(value);
  return s !== '' ? s : newActivityId();
}

// 経験系共通フィールド。新 `quantitativeResult` が空なら旧 `achievement` を引き継ぐ。
function experienceCommon(raw: Record<string, unknown>): ExperienceCommon {
  return {
    period: period(raw.period),
    role: str(raw.role),
    scale: str(raw.scale),
    ingenuity: str(raw.ingenuity),
    quantitativeResult: str(raw.quantitativeResult) || str(raw.achievement),
    learning: str(raw.learning),
  };
}

// エントリに（id 以外の）中身があるか。旧単発オブジェクトの空データを破棄するために使う。
function entryHasContent(entry: Record<string, unknown>): boolean {
  return Object.entries(entry).some(([key, value]) => {
    if (key === 'id') return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (isObj(value)) {
      return Object.values(value).some(
        (v) => typeof v === 'string' && v.trim() !== '',
      );
    }
    return false;
  });
}

function objSection<T extends Record<string, string>>(
  raw: unknown,
  template: T,
): T {
  const out = { ...template };
  if (isObj(raw)) {
    for (const key of Object.keys(template) as (keyof T)[]) {
      const value = raw[key as string];
      if (typeof value === 'string') out[key] = value as T[keyof T];
    }
  }
  return out;
}

// 配列をマップする。各要素はオブジェクトのみ採用。
function list<T>(raw: unknown, mapItem: (item: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).map((it) => mapItem(it));
}

// 配列 or 旧単発オブジェクトを配列へ正規化する（サークル/リーダー/ボランティアの移行用）。
// 旧単発オブジェクトは内容があれば 1 要素配列へ、空なら破棄する。
function listOrSingle<T extends { id: string }>(
  raw: unknown,
  mapItem: (item: Record<string, unknown>) => T,
): T[] {
  if (Array.isArray(raw)) return raw.filter(isObj).map((it) => mapItem(it));
  if (isObj(raw)) {
    const mapped = mapItem(raw);
    return entryHasContent(mapped as unknown as Record<string, unknown>)
      ? [mapped]
      : [];
  }
  return [];
}

// 配列 or 旧自由入力テキスト（単一 string）を配列へ正規化する（SNS / ポートフォリオの移行用）。
// 旧テキストは内容があれば legacy() で 1 要素へ変換、空なら破棄する。
function listOrLegacyString<T extends { id: string }>(
  raw: unknown,
  mapItem: (item: Record<string, unknown>) => T,
  legacy: (text: string) => T,
): T[] {
  if (Array.isArray(raw)) return raw.filter(isObj).map((it) => mapItem(it));
  if (typeof raw === 'string' && raw.trim() !== '') return [legacy(raw)];
  return [];
}

function itSkillLevel(value: unknown): ItSkillLevel {
  const s = str(value);
  return IS_VALID_IT_SKILL_LEVEL.has(s) ? (s as ItSkillLevel) : '';
}

function languageLevel(value: unknown): LanguageLevel {
  const s = str(value);
  return IS_VALID_LANGUAGE_LEVEL.has(s) ? (s as LanguageLevel) : '';
}

// ── エントリ別マッパー ───────────────────────────────────────────────

const mapPartTimeJob = (p: Record<string, unknown>): PartTimeJobEntry => ({
  id: id(p.id),
  workplace: str(p.workplace),
  jobContent: str(p.jobContent),
  ...experienceCommon(p),
});

const mapInternship = (i: Record<string, unknown>): InternshipEntry => ({
  id: id(i.id),
  companyName: str(i.companyName),
  jobContent: str(i.jobContent),
  ...experienceCommon(i),
});

const mapClub = (c: Record<string, unknown>): ClubEntry => ({
  id: id(c.id),
  organizationName: str(c.organizationName),
  activityContent: str(c.activityContent),
  ...experienceCommon(c),
});

const mapProject = (p: Record<string, unknown>): ProjectEntry => ({
  id: id(p.id),
  name: str(p.name),
  content: str(p.content),
  ...experienceCommon(p),
});

const mapLeadership = (l: Record<string, unknown>): LeadershipEntry => ({
  id: id(l.id),
  // 旧版は経験内容を `experience`、人数規模を `scale` で保持していたため流用できる。
  experience: str(l.experience),
  ...experienceCommon(l),
});

const mapVolunteer = (v: Record<string, unknown>): VolunteerEntry => ({
  id: id(v.id),
  activityContent: str(v.activityContent),
  ...experienceCommon(v),
});

const mapSns = (s: Record<string, unknown>): SnsEntry => ({
  id: id(s.id),
  platform: str(s.platform),
  url: str(s.url),
  accountName: str(s.accountName),
  theme: str(s.theme),
  period: period(s.period),
  followers: str(s.followers),
  monthlyViews: str(s.monthlyViews),
  focusedEffort: str(s.focusedEffort),
  learning: str(s.learning),
});

// ②' 学生時代に力を入れたこと（ガクチカカード）。
const mapFocusedActivity = (f: Record<string, unknown>): FocusedActivityEntry => ({
  id: id(f.id),
  title: str(f.title),
  category: str(f.category),
  period: period(f.period),
  organization: str(f.organization),
  role: str(f.role),
  goal: str(f.goal),
  action: str(f.action),
  ingenuity: str(f.ingenuity),
  difficulty: str(f.difficulty),
  result: str(f.result),
  // 旧経験系の `achievement`（成果）が紛れていてもフォールバックで拾う。
  quantitativeResult: str(f.quantitativeResult) || str(f.achievement),
  learning: str(f.learning),
  memo: str(f.memo),
});

// ⑨ 海外経験カード。旧単発オブジェクト形状（description / period=string / learning）も
// 同一マッパーで救済する（description は現地で取り組んだことへ、period 文字列は period() が畳み込む）。
const mapOverseas = (o: Record<string, unknown>): OverseasEntry => ({
  id: id(o.id),
  title: str(o.title),
  country: str(o.country),
  city: str(o.city),
  period: period(o.period),
  kind: str(o.kind),
  program: str(o.program),
  purpose: str(o.purpose),
  activityContent: str(o.activityContent) || str(o.description),
  difficulty: str(o.difficulty),
  howOvercome: str(o.howOvercome),
  learning: str(o.learning),
  languageGrowth: str(o.languageGrowth),
  strength: str(o.strength),
  memo: str(o.memo),
});

const mapPortfolio = (p: Record<string, unknown>): PortfolioEntry => ({
  id: id(p.id),
  name: str(p.name),
  url: str(p.url),
  kind: str(p.kind),
  period: period(p.period),
  techStack: str(p.techStack),
  role: str(p.role),
  overview: str(p.overview),
  ingenuity: str(p.ingenuity),
  result: str(p.result),
  learning: str(p.learning),
});

// 旧スキーマ・部分データ・手書き JSON でも落ちないように、空の CareerActivity を土台に
// 既知フィールドだけ取り込む防御的正規化。
export function normalizeCareerActivity(raw: unknown): CareerActivity {
  const base = emptyCareerActivity();
  if (!isObj(raw)) return base;
  const obj = raw;

  const certifications = list<CertificationEntry>(obj.certifications, (c) => ({
    id: id(c.id),
    name: str(c.name),
    score: str(c.score),
    acquiredDate: str(c.acquiredDate),
  }));

  const itSkills = list<ItSkillEntry>(obj.itSkills, (s) => ({
    id: id(s.id),
    name: str(s.name),
    level: itSkillLevel(s.level),
  }));

  const languages = list<LanguageEntry>(obj.languages, (l) => ({
    id: id(l.id),
    language: str(l.language),
    level: languageLevel(l.level),
  }));

  // ② 学業。旧「学生時代に力を入れたこと」(focusedEffort) は ②' カードへ分離するため、
  //    ここでは読み取るだけにして academics 側からはクリアする（下で focusedActivities に移行）。
  const academics = objSection(obj.academics, base.academics);
  const legacyFocusedEffort = academics.focusedEffort.trim();
  academics.focusedEffort = '';

  // ②' 学生時代に力を入れたこと（複数カード）。
  const focusedActivities = list<FocusedActivityEntry>(
    obj.focusedActivities,
    mapFocusedActivity,
  );
  // 旧 academics.focusedEffort に中身があり、まだ移行カードが無ければ 1 枚目として救済する。
  // （自由記述の本文は「具体的な行動」へ畳み込む。ユーザーが後から項目を整理できる形にする。）
  if (
    legacyFocusedEffort !== '' &&
    !focusedActivities.some((f) => f.action === legacyFocusedEffort)
  ) {
    focusedActivities.unshift(mapFocusedActivity({ action: legacyFocusedEffort }));
  }

  return {
    personality: objSection(obj.personality, base.personality),
    academics,
    focusedActivities,
    partTimeJobs: list<PartTimeJobEntry>(obj.partTimeJobs, mapPartTimeJob),
    internships: list<InternshipEntry>(obj.internships, mapInternship),
    club: listOrSingle<ClubEntry>(obj.club, mapClub),
    projects: list<ProjectEntry>(obj.projects, mapProject),
    leadership: listOrSingle<LeadershipEntry>(obj.leadership, mapLeadership),
    volunteer: listOrSingle<VolunteerEntry>(obj.volunteer, mapVolunteer),
    // 配列なら各カードを、旧単発オブジェクト（内容あり）なら 1 枚目のカードへ正規化する。
    overseas: listOrSingle<OverseasEntry>(obj.overseas, mapOverseas),
    certifications,
    itSkills,
    languages,
    hobbies: str(obj.hobbies),
    awards: str(obj.awards),
    // 旧自由入力テキストは theme / overview に畳み込んで 1 件へ移行する。
    snsActivities: listOrLegacyString<SnsEntry>(obj.snsActivities, mapSns, (text) =>
      mapSns({ theme: text }),
    ),
    portfolios: listOrLegacyString<PortfolioEntry>(
      obj.portfolios,
      mapPortfolio,
      (text) => mapPortfolio({ overview: text }),
    ),
    lifeExperiences: objSection(obj.lifeExperiences, base.lifeExperiences),
    freeNote: str(obj.freeNote),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined,
  };
}

// ── 公開 API ─────────────────────────────────────────────────────────

// localStorage から読む。未保存 / 壊れていれば null（呼び出し側で空フォームを出す）。
export function loadActivityData(): CareerActivity | null {
  const raw = safeGetStorage<unknown>(STORAGE_KEY, null);
  if (raw == null) return null;
  const value = normalizeCareerActivity(raw);
  // ロード直後の最初の autosave が同一内容なら no-op になるよう cache を同期する。
  lastSavedJson = JSON.stringify(value);
  return value;
}

// localStorage へ保存する。保存前に正規化し、同一内容なら no-op。
export function saveActivityData(data: CareerActivity): void {
  const normalized = normalizeCareerActivity(data);
  const json = JSON.stringify(normalized);
  if (json === lastSavedJson) return;
  lastSavedJson = json;
  safeSetStorage(STORAGE_KEY, normalized);
}

export function clearActivityData(): void {
  lastSavedJson = undefined;
  safeRemoveStorage(STORAGE_KEY);
}

// readiness 判定。null / 全カテゴリ未入力なら false。
// 受験版形状の Object.values(...).some(isArray) では拾えなかった
// 単発オブジェクト（性格・人生経験 等）・自由記述も正しく判定する。
export function hasAnyActivity(activity: CareerActivity | null): boolean {
  if (!activity) return false;
  return !isCareerActivityEmpty(activity);
}
