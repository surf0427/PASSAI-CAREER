// PASSAI 就活版 — ES 深掘りの「材料候補」生成（決定論・pure）。
//
// 役割:
//   ES 設問を起点に、Layer 1（localStorage canonical）の既存 Career Data から
//   「今回の設問に使えそうな材料」の候補を列挙する。
//     activity（活動整理）/ values（就活軸）/ profile（基本情報）/ 最新の自己分析結果
//   → 1 候補 = 1 行ラベル + 既知事実の行 + 情報種別（factKinds）+ 安定 ID。
//
// 設計方針:
//   - **純粋関数のみ**。DOM / localStorage / API / DB / AI に触れない（呼び出し側が load して渡す）。
//   - AI へ送るのは id + label（+ 判定用の factKinds）だけ。活動整理の全文は送らない。
//   - 実データの型（types/careerActivity.ts 等）を正本とし、存在しない field を作らない。
//   - 壊れたデータ・旧スキーマでも throw しない（未知形状は静かに捨てる）。
//   - 自己分析側の buildCoverageInventory とは目的が違う（あちらは breadth-first の棚卸し、
//     こちらは 1 設問への収束）。共通化はせず、思想だけ踏襲する。
//
// FULL / PARTIAL / NONE の判定は本ファイルの deriveEsMaterialCoverage が決定論で行う
// （AI に coverage を決めさせない。AI は関連度の順位付けまで）。

import {
  ES_SELF_ANALYSIS_FACT_PREFIX,
  esAxesForType,
  resolveEsAxisCoverage,
  type EsMaterialFactKind,
  type EsQuestionType,
} from './deepDivePrompt';
import { collapseSelfAnalysisRevisions } from '@/lib/careerSelfAnalysis/revisionLineage';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues, CareerValuesCategoryKey } from '@/types/careerValues';
import type { CareerProfile } from '@/types/careerProfile';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type {
  CareerEsMaterialCoverage,
  CareerEsMaterialSourceKind,
  CareerEsSelectedMaterial,
} from '@/types/careerEs';

// ── 上限（トークン肥大と UI 崩れの防止）──────────────────────────────

/** 1 行ラベルの最大文字数。 */
export const ES_MATERIAL_LABEL_MAX_CHARS = 60;
/** 既知事実 1 行の最大文字数。 */
export const ES_MATERIAL_FACT_MAX_CHARS = 120;
/** 1 候補あたりの既知事実の最大行数。 */
export const ES_MATERIAL_FACTS_PER_CANDIDATE = 8;
/** 1 セクション（活動整理のリスト等）から拾う最大エントリ数。 */
export const ES_MATERIAL_ENTRIES_PER_SECTION = 8;
/** AI へ渡す候補の最大件数（prefilter 後）。 */
export const ES_MATERIAL_CANDIDATE_LIMIT = 24;
/** 「関連あり」と見なす relevance の閾値。 */
export const ES_MATERIAL_RELEVANCE_THRESHOLD = 60;
/** coverage=full と見なす観点充足率。 */
export const ES_MATERIAL_FULL_COVERAGE_RATIO = 0.6;

// ── 候補の型 ─────────────────────────────────────────────────────────

// 候補の大分類（prefilter の重み付けに使う）。
export type EsMaterialGroup =
  | 'experience' // 経験系（ガクチカ・アルバイト・インターン・サークル・PJ 等）
  | 'academic' // 学業・ゼミ・研究
  | 'life' // 人生経験（挫折・転機 等）
  | 'persona' // 人柄・強み・価値観（活動整理の personality）
  | 'values' // 就活軸
  | 'selfAnalysis' // 過去の自己分析
  | 'skill' // 資格・IT スキル・語学・趣味・表彰
  | 'profile'; // 基本情報（大学・学部 等）

export type EsMaterialCandidate = {
  /** 安定 ID（例: 'activity:focusedActivities:<entryId>'）。 */
  id: string;
  sourceKind: CareerEsMaterialSourceKind;
  group: EsMaterialGroup;
  /** 表示用の分類ラベル（'学生時代に力を入れたこと' 等）。 */
  category: string;
  /** 1 行ラベル（UI とAI へ渡す唯一の内容）。 */
  label: string;
  /** 既知事実の行（'ラベル: 値'）。深掘りの knownFacts になる。 */
  facts: string[];
  /** この候補が埋める情報種別。 */
  factKinds: EsMaterialFactKind[];
  /**
   * coverage 判定に数えてよいか。
   * profile（大学・学部などの属性）は「材料がある」根拠にはならないため false。
   * 既知事実としては有用なので候補自体は残す（＝「どこの大学ですか」を防ぐ）。
   */
  countsTowardCoverage: boolean;
};

// ── 小さなヘルパー（防御的・決定論）──────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObj).slice(0, ES_MATERIAL_ENTRIES_PER_SECTION);
}

function periodText(value: unknown): string {
  if (typeof value === 'string') return str(value);
  if (!isObj(value)) return '';
  const from = str(value.from);
  const to = str(value.to);
  if (!from && !to) return '';
  return `${from || '?'}〜${to || '?'}`;
}

// 1 field の宣言（ラベル・値・情報種別）。値が空なら捨てる。
type FieldSpec = [label: string, value: unknown, kind: EsMaterialFactKind];

function buildFacts(specs: FieldSpec[], prefix = ''): { facts: string[]; kinds: EsMaterialFactKind[] } {
  const facts: string[] = [];
  const kinds = new Set<EsMaterialFactKind>();
  for (const [label, raw, kind] of specs) {
    const value = str(raw);
    if (!value) continue;
    facts.push(`${prefix}${label}: ${truncate(value, ES_MATERIAL_FACT_MAX_CHARS)}`);
    kinds.add(kind);
    if (facts.length >= ES_MATERIAL_FACTS_PER_CANDIDATE) break;
  }
  return { facts, kinds: [...kinds] };
}

// ラベル用に「最初の非空の値」を拾う。
function firstValue(...values: unknown[]): string {
  for (const v of values) {
    const s = str(v);
    if (s) return s;
  }
  return '';
}

function makeLabel(head: string, detail: string): string {
  const d = detail.trim();
  const label = d ? `${head}｜${d}` : head;
  return truncate(label, ES_MATERIAL_LABEL_MAX_CHARS);
}

function pushCandidate(
  out: EsMaterialCandidate[],
  candidate: Omit<EsMaterialCandidate, 'countsTowardCoverage'> & { countsTowardCoverage?: boolean },
): void {
  // 事実が 1 行も無い候補は「材料」にならないので出さない。
  if (candidate.facts.length === 0) return;
  if (!candidate.label) return;
  out.push({ ...candidate, countsTowardCoverage: candidate.countsTowardCoverage ?? true });
}

// ── activity（活動整理）──────────────────────────────────────────────

// 経験系（ExperienceCommon を持つ）に共通の field。
function experienceFacts(e: Record<string, unknown>): FieldSpec[] {
  return [
    ['役割', e.role, 'context'],
    ['人数規模', e.scale, 'context'],
    ['期間', periodText(e.period), 'context'],
    ['工夫', e.ingenuity, 'action'],
    ['定量的な成果', e.quantitativeResult, 'result'],
    ['学び', e.learning, 'learning'],
  ];
}

type ListSectionSpec = {
  key: keyof CareerActivity & string;
  category: string;
  // ラベルに使う field（先頭から最初の非空）。
  labelKeys: string[];
  // そのセクション固有の field（共通 field の前に置く）。
  own: (e: Record<string, unknown>) => FieldSpec[];
};

const LIST_SECTIONS: ListSectionSpec[] = [
  {
    key: 'focusedActivities',
    category: '学生時代に力を入れたこと',
    labelKeys: ['title', 'category', 'organization'],
    own: (e) => [
      ['カテゴリ', e.category, 'context'],
      ['所属・場面', e.organization, 'context'],
      ['期間', periodText(e.period), 'context'],
      ['役割', e.role, 'context'],
      ['目標・課題', e.goal, 'motive'],
      ['具体的な行動', e.action, 'action'],
      ['工夫', e.ingenuity, 'action'],
      ['困難', e.difficulty, 'difficulty'],
      ['成果・実績', e.result, 'result'],
      ['数字で表せる成果', e.quantitativeResult, 'result'],
      ['学び', e.learning, 'learning'],
    ],
  },
  {
    key: 'overseas',
    category: '留学・海外経験',
    labelKeys: ['title', 'country', 'program'],
    own: (e) => [
      ['国・地域', e.country, 'context'],
      ['都市', e.city, 'context'],
      ['種別', e.kind, 'context'],
      ['期間', periodText(e.period), 'context'],
      ['所属・プログラム', e.program, 'context'],
      ['目的', e.purpose, 'motive'],
      ['現地で取り組んだこと', e.activityContent, 'action'],
      ['困難', e.difficulty, 'difficulty'],
      ['乗り越え方', e.howOvercome, 'action'],
      ['得た価値観・学び', e.learning, 'learning'],
      ['語学面の変化', e.languageGrowth, 'result'],
      ['就活で使えそうな強み', e.strength, 'learning'],
    ],
  },
  {
    key: 'internships',
    category: 'インターン',
    labelKeys: ['companyName', 'jobContent'],
    own: (e) => [['業務内容', e.jobContent, 'action'], ...experienceFacts(e)],
  },
  {
    key: 'partTimeJobs',
    category: 'アルバイト',
    labelKeys: ['workplace', 'jobContent'],
    own: (e) => [['業務内容', e.jobContent, 'action'], ...experienceFacts(e)],
  },
  {
    key: 'club',
    category: 'サークル・部活動',
    labelKeys: ['organizationName', 'activityContent'],
    own: (e) => [['活動内容', e.activityContent, 'action'], ...experienceFacts(e)],
  },
  {
    key: 'projects',
    category: 'プロジェクト・個人開発',
    labelKeys: ['name', 'content'],
    own: (e) => [['内容', e.content, 'action'], ...experienceFacts(e)],
  },
  {
    key: 'leadership',
    category: 'リーダー経験',
    labelKeys: ['experience'],
    own: (e) => [['経験内容', e.experience, 'action'], ...experienceFacts(e)],
  },
  {
    key: 'volunteer',
    category: 'ボランティア・社会活動',
    labelKeys: ['activityContent'],
    own: (e) => [['活動内容', e.activityContent, 'action'], ...experienceFacts(e)],
  },
  {
    key: 'snsActivities',
    category: 'SNS・情報発信',
    labelKeys: ['platform', 'theme'],
    own: (e) => [
      ['プラットフォーム', e.platform, 'context'],
      ['内容・テーマ', e.theme, 'action'],
      ['運営期間', periodText(e.period), 'context'],
      ['フォロワー/登録者数', e.followers, 'result'],
      ['月間PV/再生数', e.monthlyViews, 'result'],
      ['一番力を入れたこと', e.focusedEffort, 'action'],
      ['学び', e.learning, 'learning'],
    ],
  },
  {
    key: 'portfolios',
    category: 'ポートフォリオ・制作物',
    labelKeys: ['name', 'kind'],
    own: (e) => [
      ['種類', e.kind, 'context'],
      ['使用技術', e.techStack, 'action'],
      ['担当', e.role, 'context'],
      ['制作期間', periodText(e.period), 'context'],
      ['概要', e.overview, 'action'],
      ['工夫', e.ingenuity, 'action'],
      ['成果', e.result, 'result'],
      ['学び', e.learning, 'learning'],
    ],
  },
];

// ⑰ 人生経験（1 field = 1 候補。設問に応じて 1 つだけ選べるようにする）。
const LIFE_FIELDS: Array<[key: string, label: string, kind: EsMaterialFactKind]> = [
  ['hardestEffort', '一番頑張った経験', 'action'],
  ['biggestFailure', '一番失敗した経験', 'difficulty'],
  ['happiest', '一番嬉しかった経験', 'values'],
  ['mostFrustrated', '一番悔しかった経験', 'difficulty'],
  ['setback', '挫折経験', 'difficulty'],
  ['turningPoint', '人生の転機', 'motive'],
  ['mostGrowth', '一番成長した経験', 'learning'],
];

function buildActivityCandidates(activity: CareerActivity | null | undefined): EsMaterialCandidate[] {
  const out: EsMaterialCandidate[] = [];
  const a = (activity ?? {}) as unknown as Record<string, unknown>;
  if (!isObj(a)) return out;

  // 複数登録リスト（経験系）。
  for (const section of LIST_SECTIONS) {
    for (const entry of list(a[section.key])) {
      const { facts, kinds } = buildFacts(section.own(entry));
      const head = firstValue(...section.labelKeys.map((k) => entry[k]));
      pushCandidate(out, {
        id: `activity:${section.key}:${str(entry.id) || head || String(out.length)}`,
        sourceKind: 'activity',
        group: 'experience',
        category: section.category,
        label: makeLabel(section.category, head),
        facts,
        factKinds: kinds,
      });
    }
  }

  // ② 学業・ゼミ・研究（単発）。
  if (isObj(a.academics)) {
    const ac = a.academics;
    const { facts, kinds } = buildFacts([
      ['ゼミ・研究', ac.seminar, 'action'],
      ['卒業研究・卒論', ac.thesis, 'action'],
      ['印象に残った授業', ac.memorableClass, 'context'],
      ['GPA', ac.gpa, 'result'],
      ['成績・受賞歴', ac.academicAwards, 'result'],
      // 旧スキーマの「学生時代に力を入れたこと」（読み取り互換）。
      ['学生時代に力を入れたこと', ac.focusedEffort, 'action'],
    ]);
    pushCandidate(out, {
      id: 'activity:academics',
      sourceKind: 'activity',
      group: 'academic',
      category: '学業・ゼミ・研究',
      label: makeLabel('学業・ゼミ・研究', firstValue(ac.seminar, ac.thesis, ac.memorableClass)),
      facts,
      factKinds: kinds,
    });
  }

  // ① 人柄・価値観（単発）。
  if (isObj(a.personality)) {
    const p = a.personality;
    const { facts, kinds } = buildFacts([
      ['MBTI', p.mbti, 'context'],
      ['自分で思う性格', p.selfView, 'values'],
      ['周囲から言われる性格', p.othersView, 'values'],
      ['強み', p.strengths, 'learning'],
      ['弱み', p.weaknesses, 'learning'],
      ['大切にしている価値観', p.values, 'values'],
      ['モチベーションが上がる環境', p.motivationUp, 'values'],
      ['モチベーションが下がる環境', p.motivationDown, 'values'],
    ]);
    pushCandidate(out, {
      id: 'activity:personality',
      sourceKind: 'activity',
      group: 'persona',
      category: '人柄・強み・価値観',
      label: makeLabel('人柄・強み・価値観', firstValue(p.values, p.strengths, p.selfView)),
      facts,
      factKinds: kinds,
    });
  }

  // ⑰ 人生経験（field ごと）。
  if (isObj(a.lifeExperiences)) {
    const le = a.lifeExperiences;
    for (const [key, label, kind] of LIFE_FIELDS) {
      const value = str(le[key]);
      if (!value) continue;
      pushCandidate(out, {
        id: `activity:lifeExperiences:${key}`,
        sourceKind: 'activity',
        group: 'life',
        category: '人生経験',
        label: makeLabel(label, value),
        facts: [`${label}: ${truncate(value, ES_MATERIAL_FACT_MAX_CHARS)}`],
        factKinds: [kind],
      });
    }
  }

  // ⑩⑪⑫⑬⑭ 資格・スキル・語学・趣味・表彰（まとめて 1 候補）。
  const skillFacts: string[] = [];
  const skillKinds = new Set<EsMaterialFactKind>();
  const certifications = list(a.certifications)
    .map((c) => [str(c.name), str(c.score)].filter(Boolean).join('・'))
    .filter(Boolean);
  if (certifications.length > 0) {
    skillFacts.push(`資格: ${truncate(certifications.join(' / '), ES_MATERIAL_FACT_MAX_CHARS)}`);
    skillKinds.add('result');
  }
  const itSkills = list(a.itSkills)
    .map((s) => (str(s.level) ? `${str(s.name)}（${str(s.level)}）` : str(s.name)))
    .filter((s) => s !== '' && s !== '（）');
  if (itSkills.length > 0) {
    skillFacts.push(`ITスキル: ${truncate(itSkills.join(' / '), ES_MATERIAL_FACT_MAX_CHARS)}`);
    skillKinds.add('context');
  }
  const languages = list(a.languages)
    .map((l) => (str(l.level) ? `${str(l.language)}（${str(l.level)}）` : str(l.language)))
    .filter((s) => s !== '' && s !== '（）');
  if (languages.length > 0) {
    skillFacts.push(`語学: ${truncate(languages.join(' / '), ES_MATERIAL_FACT_MAX_CHARS)}`);
    skillKinds.add('context');
  }
  const awards = singleFieldValues(a.awards, 'title');
  if (awards.length > 0) {
    skillFacts.push(`表彰・実績: ${truncate(awards.join(' / '), ES_MATERIAL_FACT_MAX_CHARS)}`);
    skillKinds.add('result');
  }
  const hobbies = singleFieldValues(a.hobbies, 'name');
  if (hobbies.length > 0) {
    skillFacts.push(`趣味・特技: ${truncate(hobbies.join(' / '), ES_MATERIAL_FACT_MAX_CHARS)}`);
    skillKinds.add('values');
  }
  if (skillFacts.length > 0) {
    pushCandidate(out, {
      id: 'activity:skills',
      sourceKind: 'activity',
      group: 'skill',
      category: '資格・スキル・表彰',
      label: makeLabel(
        '資格・スキル・表彰',
        firstValue(certifications[0], awards[0], itSkills[0], languages[0], hobbies[0]),
      ),
      facts: skillFacts.slice(0, ES_MATERIAL_FACTS_PER_CANDIDATE),
      factKinds: [...skillKinds],
    });
  }

  // ⑱ その他メモ。
  const freeNote = str(a.freeNote);
  if (freeNote) {
    pushCandidate(out, {
      id: 'activity:freeNote',
      sourceKind: 'activity',
      group: 'persona',
      category: 'その他メモ',
      label: makeLabel('その他メモ', freeNote),
      facts: [`その他メモ: ${truncate(freeNote, ES_MATERIAL_FACT_MAX_CHARS)}`],
      factKinds: ['context'],
    });
  }

  return out;
}

// 1 field だけのカード配列（趣味・表彰）。旧スキーマの単一文字列も読む。
function singleFieldValues(value: unknown, key: string): string[] {
  if (typeof value === 'string') return str(value) ? [str(value)] : [];
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, ES_MATERIAL_ENTRIES_PER_SECTION)
    .map((item) => (isObj(item) ? str(item[key]) : str(item)))
    .filter((s) => s !== '');
}

// ── values（就活軸）─────────────────────────────────────────────────

const VALUES_AXES: Array<[key: CareerValuesCategoryKey, label: string, kind: EsMaterialFactKind]> = [
  ['priorities', '重視する条件', 'values'],
  ['avoidances', '避けたい条件', 'values'],
  ['industries', '興味のある業界', 'future'],
  ['jobTypes', '興味のある職種', 'future'],
  ['workStyles', '働き方の希望', 'values'],
  ['companyTypes', '会社タイプ', 'values'],
  ['careerGoals', 'キャリア志向', 'future'],
  ['culturePreferences', '人間関係・社風', 'values'],
];

function buildValuesCandidates(values: CareerValues | null | undefined): EsMaterialCandidate[] {
  const out: EsMaterialCandidate[] = [];
  const v = (values ?? {}) as unknown as Record<string, unknown>;
  if (!isObj(v)) return out;
  const selections = isObj(v.selections) ? v.selections : {};
  const notes = isObj(v.notes) ? v.notes : {};

  for (const [key, label, kind] of VALUES_AXES) {
    const selected = Array.isArray(selections[key])
      ? (selections[key] as unknown[]).map((s) => str(s)).filter(Boolean)
      : [];
    const note = str(notes[key]);
    if (selected.length === 0 && !note) continue;
    const facts: string[] = [];
    if (selected.length > 0) {
      facts.push(`${label}: ${truncate(selected.join('・'), ES_MATERIAL_FACT_MAX_CHARS)}`);
    }
    if (note) facts.push(`${label}（メモ）: ${truncate(note, ES_MATERIAL_FACT_MAX_CHARS)}`);
    pushCandidate(out, {
      id: `values:${key}`,
      sourceKind: 'values',
      group: 'values',
      category: '就活軸',
      label: makeLabel(label, selected.join('・') || note),
      facts,
      factKinds: [kind],
    });
  }

  const overall = str(v.overallNote);
  if (overall) {
    pushCandidate(out, {
      id: 'values:overallNote',
      sourceKind: 'values',
      group: 'values',
      category: '就活軸',
      label: makeLabel('就活軸の総合メモ', overall),
      facts: [`就活軸の総合メモ: ${truncate(overall, ES_MATERIAL_FACT_MAX_CHARS)}`],
      factKinds: ['values'],
    });
  }
  return out;
}

// ── profile（基本情報）──────────────────────────────────────────────
// 大学・学部などの属性。「どこの大学ですか？」を防ぐための既知事実であり、
// これ自体は「材料がある」根拠にはしない（countsTowardCoverage: false）。

function buildProfileCandidates(profile: CareerProfile | null | undefined): EsMaterialCandidate[] {
  const out: EsMaterialCandidate[] = [];
  const p = (profile ?? {}) as unknown as Record<string, unknown>;
  if (!isObj(p)) return out;
  const preference = Array.isArray(p.preferences) && isObj(p.preferences[0]) ? p.preferences[0] : {};
  const { facts, kinds } = buildFacts([
    ['大学', preference.university, 'context'],
    ['学部', preference.faculty, 'context'],
    ['学科', preference.department, 'context'],
    ['学年', p.grade, 'context'],
    ['卒業予定年', p.graduationYear, 'context'],
  ]);
  pushCandidate(out, {
    id: 'profile:education',
    sourceKind: 'profile',
    group: 'profile',
    category: '基本情報',
    label: makeLabel('現在の大学・学部', firstValue(preference.university, preference.faculty)),
    facts,
    factKinds: kinds,
    countsTowardCoverage: false,
  });
  return out;
}

// ── selfAnalysis（最新の有効な自己分析結果）──────────────────────────
// 自己分析結果は AI との対話から得た本人の整理メモ。事実の細部までは確認できていないため、
// prefix を付けて「項目は既知／細部は掘ってよい」と prompt 側で扱いを分ける。

type SelfAnalysisListField = {
  field: 'esAngles' | 'gakuchikaIdeas' | 'valueKeywords';
  label: string;
  kind: EsMaterialFactKind;
  max: number;
};

const SELF_ANALYSIS_LIST_FIELDS: SelfAnalysisListField[] = [
  { field: 'esAngles', label: 'ESで使える切り口', kind: 'action', max: 5 },
  { field: 'gakuchikaIdeas', label: 'ガクチカ候補', kind: 'action', max: 5 },
  { field: 'valueKeywords', label: '価値観キーワード', kind: 'values', max: 5 },
];

/** 最新の「有効な」自己分析ログ（revision lineage を畳んだうえで createdAt 降順の先頭）。 */
export function latestEffectiveSelfAnalysisLog(
  logs: readonly CareerSelfAnalysisLog[] | null | undefined,
): CareerSelfAnalysisLog | null {
  const valid = (Array.isArray(logs) ? logs : []).filter((l) => l && isObj(l.result));
  if (valid.length === 0) return null;
  const collapsed = collapseSelfAnalysisRevisions(valid);
  return (
    [...collapsed].sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)))[0] ?? null
  );
}

function buildSelfAnalysisCandidates(
  logs: readonly CareerSelfAnalysisLog[] | null | undefined,
): EsMaterialCandidate[] {
  const out: EsMaterialCandidate[] = [];
  const log = latestEffectiveSelfAnalysisLog(logs);
  if (!log) return out;
  const logId = str(log.id) || 'latest';
  const result = log.result as unknown as Record<string, unknown>;

  const direction = str(result.careerDirection);
  if (direction) {
    pushCandidate(out, {
      id: `selfAnalysis:${logId}:careerDirection`,
      sourceKind: 'selfAnalysis',
      group: 'selfAnalysis',
      category: '過去の自己分析',
      label: makeLabel('キャリアの方向性', direction),
      facts: [
        `${ES_SELF_ANALYSIS_FACT_PREFIX}キャリアの方向性: ${truncate(direction, ES_MATERIAL_FACT_MAX_CHARS)}`,
      ],
      factKinds: ['values', 'future'],
    });
  }

  for (const spec of SELF_ANALYSIS_LIST_FIELDS) {
    const raw = result[spec.field];
    if (!Array.isArray(raw)) continue;
    const items = raw.map((x) => str(x)).filter(Boolean).slice(0, spec.max);
    items.forEach((item, index) => {
      pushCandidate(out, {
        id: `selfAnalysis:${logId}:${spec.field}:${index}`,
        sourceKind: 'selfAnalysis',
        group: 'selfAnalysis',
        category: '過去の自己分析',
        label: makeLabel(spec.label, item),
        facts: [
          `${ES_SELF_ANALYSIS_FACT_PREFIX}${spec.label}: ${truncate(item, ES_MATERIAL_FACT_MAX_CHARS)}`,
        ],
        factKinds: [spec.kind],
      });
    });
  }
  return out;
}

// ── 候補生成（entry point）───────────────────────────────────────────

export type EsMaterialSourceInput = {
  activity?: CareerActivity | null;
  values?: CareerValues | null;
  profile?: CareerProfile | null;
  selfAnalysisLogs?: readonly CareerSelfAnalysisLog[] | null;
};

// 重複抑制のための正規化キー（空白・記号を落とした label）。
function dedupeKey(candidate: EsMaterialCandidate): string {
  return `${candidate.label.replace(/[\s・／/｜|,、。．.]/g, '').toLowerCase()}`;
}

/**
 * Layer 1 canonical から材料候補を列挙する（決定論・never-throw）。
 * データが空・壊れている場合は空配列を返す。
 */
export function buildEsMaterialCandidates(input: EsMaterialSourceInput): EsMaterialCandidate[] {
  let raw: EsMaterialCandidate[] = [];
  try {
    raw = [
      ...buildActivityCandidates(input.activity),
      ...buildSelfAnalysisCandidates(input.selfAnalysisLogs),
      ...buildValuesCandidates(input.values),
      ...buildProfileCandidates(input.profile),
    ];
  } catch {
    return [];
  }
  // 同一ラベルの重複を抑制する（活動整理と自己分析に同じ内容が入っているケース）。
  const seenLabel = new Set<string>();
  const seenId = new Set<string>();
  const out: EsMaterialCandidate[] = [];
  for (const candidate of raw) {
    const key = dedupeKey(candidate);
    if (!key || seenLabel.has(key) || seenId.has(candidate.id)) continue;
    seenLabel.add(key);
    seenId.add(candidate.id);
    out.push(candidate);
  }
  return out;
}

// ── prefilter（設問種別で重み付けし、AI へ渡す件数を絞る）────────────

const GROUP_WEIGHT: Record<EsQuestionType, Record<EsMaterialGroup, number>> = {
  gakuchika: { experience: 100, academic: 70, life: 65, persona: 45, selfAnalysis: 55, values: 25, skill: 30, profile: 10 },
  motivation: { experience: 60, academic: 40, life: 55, persona: 65, selfAnalysis: 85, values: 90, skill: 20, profile: 35 },
  selfPr: { experience: 90, academic: 50, life: 65, persona: 85, selfAnalysis: 70, values: 30, skill: 40, profile: 10 },
  research: { experience: 55, academic: 100, life: 30, persona: 35, selfAnalysis: 40, values: 20, skill: 45, profile: 45 },
  other: { experience: 70, academic: 65, life: 65, persona: 65, selfAnalysis: 60, values: 60, skill: 45, profile: 40 },
};

/**
 * 設問種別で候補を並べ替え、上限件数まで絞る（決定論・安定ソート）。
 * 大量の Career Data 全文を AI へ送らないための境界。
 */
export function prefilterEsMaterialCandidates(
  candidates: readonly EsMaterialCandidate[],
  questionType: EsQuestionType,
  limit = ES_MATERIAL_CANDIDATE_LIMIT,
): EsMaterialCandidate[] {
  const weights = GROUP_WEIGHT[questionType] ?? GROUP_WEIGHT.other;
  const source: readonly EsMaterialCandidate[] = candidates ?? [];
  return [...source]
    .map((candidate, index) => ({ candidate, index, weight: weights[candidate.group] ?? 0 }))
    .sort((a, b) => (b.weight - a.weight) || (a.index - b.index))
    .slice(0, Math.max(0, limit))
    .map((x) => x.candidate);
}

// ── 関連度（AI 出力）と coverage 判定 ────────────────────────────────

export type EsMaterialSelection = {
  id: string;
  /** 0〜100。AI が返した関連度（route 側で clamp 済み）。 */
  relevance: number;
  /** 関連する理由（1 文）。UI 表示用。 */
  reason: string;
};

/** relevance 閾値以上の候補（＝「関連あり」と見なすもの）。 */
export function filterRelevantMaterials(
  candidates: readonly EsMaterialCandidate[],
  selections: readonly EsMaterialSelection[],
  threshold = ES_MATERIAL_RELEVANCE_THRESHOLD,
): EsMaterialCandidate[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return selections
    .filter((s) => s.relevance >= threshold)
    .map((s) => byId.get(s.id))
    .filter((c): c is EsMaterialCandidate => !!c);
}

/**
 * FULL / PARTIAL / NONE を **決定論** で導出する（AI には決めさせない）。
 *   none    … coverage に数えられる関連候補が 0 件
 *   full    … 設問種別の観点のうち ES_MATERIAL_FULL_COVERAGE_RATIO 以上が既存データで埋まる
 *   partial … 関連はあるが不足観点が多い
 */
export function deriveEsMaterialCoverage(
  candidates: readonly EsMaterialCandidate[],
  selections: readonly EsMaterialSelection[],
  questionType: EsQuestionType,
): CareerEsMaterialCoverage {
  const relevant = filterRelevantMaterials(candidates, selections).filter((c) => c.countsTowardCoverage);
  if (relevant.length === 0) return 'none';
  const axes = esAxesForType(questionType);
  if (axes.length === 0) return 'partial';
  const { known } = resolveEsAxisCoverage(
    questionType,
    relevant.flatMap((c) => c.factKinds),
  );
  return known.length / axes.length >= ES_MATERIAL_FULL_COVERAGE_RATIO ? 'full' : 'partial';
}

// ── 選択結果 → 保存形 / 深掘り入力 ───────────────────────────────────

/** 候補を draft 保存用のスナップショットへ変換する（候補元が変わっても壊れない形）。 */
export function toSelectedMaterial(candidate: EsMaterialCandidate): CareerEsSelectedMaterial {
  return {
    id: candidate.id,
    sourceKind: candidate.sourceKind,
    label: candidate.label,
    facts: candidate.facts.slice(0, ES_MATERIAL_FACTS_PER_CANDIDATE),
    factKinds: [...candidate.factKinds],
  };
}

/**
 * 保存済み（localStorage / 旧データ）の選択材料を防御的に正規化する。
 * storage 層（esDraftStorage / esStorage）が共有する唯一の実装。
 * 壊れた要素は捨て、欠損は空で埋める（throw しない）。
 */
export function normalizeSelectedMaterials(raw: unknown, maxItems = 12): CareerEsSelectedMaterial[] {
  if (!Array.isArray(raw)) return [];
  const out: CareerEsSelectedMaterial[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    const sourceKind =
      r.sourceKind === 'activity' ||
      r.sourceKind === 'values' ||
      r.sourceKind === 'profile' ||
      r.sourceKind === 'selfAnalysis'
        ? (r.sourceKind as CareerEsMaterialSourceKind)
        : null;
    if (!sourceKind) continue;
    out.push({
      id,
      sourceKind,
      label: str(r.label),
      facts: Array.isArray(r.facts)
        ? r.facts.filter((f): f is string => typeof f === 'string').slice(0, ES_MATERIAL_FACTS_PER_CANDIDATE)
        : [],
      factKinds: Array.isArray(r.factKinds)
        ? r.factKinds.filter((k): k is string => typeof k === 'string').slice(0, 16)
        : [],
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * 選択材料から深掘りの knownFacts（既知事実の行）を作る。
 * ★ 選択されていない候補は 1 行も含まれない（選択したものだけが prompt へ行く）。
 */
export function buildEsKnownFacts(
  selected: readonly CareerEsSelectedMaterial[] | null | undefined,
): string[] {
  if (!Array.isArray(selected)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const material of selected) {
    if (!material || typeof material !== 'object') continue;
    const label = str(material.label);
    const facts = Array.isArray(material.facts) ? material.facts : [];
    for (const fact of facts) {
      const line = str(fact);
      if (!line) continue;
      // 見出し（どの材料の事実か）を付けて、AI が材料単位で扱えるようにする。
      const rendered = label ? `【${label}】${line}` : line;
      if (seen.has(rendered)) continue;
      seen.add(rendered);
      out.push(rendered);
    }
  }
  return out;
}

/** 選択材料から不足観点（missingAxes の key 配列）を決定論で導出する。 */
export function buildEsMissingAxisKeys(
  questionType: EsQuestionType,
  selected: readonly CareerEsSelectedMaterial[] | null | undefined,
): string[] {
  const source: readonly CareerEsSelectedMaterial[] = selected ?? [];
  const kinds = source.flatMap((m) =>
    m && Array.isArray(m.factKinds)
      ? m.factKinds.filter((k): k is string => typeof k === 'string')
      : [],
  );
  return resolveEsAxisCoverage(questionType, kinds).missing.map((a) => a.key);
}
