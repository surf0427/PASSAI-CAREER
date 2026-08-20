// PASSAI CAREER — マイページの User Data Spine view model（純関数）。
//
// 責務:
//   Layer 1 Source bundle（CareerSourceBundle）を受け取り、**Data Spine と同一の決定的
//   projection**（lib/careerMemory/persistence/sourceProjection.ts:projectSectionFromSource）で
//   Layer 2 Personal Memory section を組み、それを人間が読める presentation model へ翻訳する。
//
// 設計原則（最重要）:
//   1. **マイページ専用の第 2 のデータ体系を作らない。** 本 module は store を持たず、
//      localStorage / Supabase / env / I/O に一切触れない。入力は Layer 1 bundle だけ。
//   2. 「PASSAI が理解しているあなた」に出す値は **すべて実 Layer 2 payload 由来**。
//      ダミー AI コメント・推測・LLM 生成文を作らない（本 module は AI を呼ばない）。
//   3. server が prompt に載せる projection と **同じ builder** を通すため、表示内容と
//      AI が受け取る内容が構造的にずれない（別 formatter を新設しない）。
//   4. raw prompt / system prompt / 内部 instruction / hidden metadata は出さない。
//      出すのは Layer 2 payload の **typed field**（PII は projection が構造上落としている）。
//   5. 決定的（deterministic）。同じ bundle からは常に同じ view が出る。%（充実度）も
//      canonical data の有無から決定論的に算出し、ダミー値を作らない。
//
// 境界:
//   - Company Data Spine（企業公式情報 / 共有ナレッジ）は扱わない。ここは User Data Spine 専用。
//   - Layer 3 Career Event Log は扱わない（D-L3: Layer 3 → Layer 2 は禁止辺）。
//     利用履歴は既存の CareerEventTimeline が別 read path で描画する。

import type { CareerSourceBundle } from '@/lib/careerSourceData/types';
import { projectSectionFromSource } from '@/lib/careerMemory/persistence/sourceProjection';
import type {
  BaseMemorySummary,
  SelfAnalysisMemorySummary,
  EsMemorySummary,
  InterviewMemorySummary,
} from '@/lib/careerMemory/types';
import type { CareerProfile } from '@/types/careerProfile';

// ── 公開型 ───────────────────────────────────────────────────────────

/** 「PASSAI が理解しているあなた」1 行分。values が空の行は生成しない。 */
export type SpineFact = {
  key: string;
  label: string;
  values: string[];
  /** この行がどの canonical source に由来するか（ユーザー向けの平易な語）。 */
  origin: string;
};

/** マイページで編集できる canonical 志望条件（Layer 1 profile の一部）。 */
export type CareerAspiration = {
  targetIndustries: string[];
  targetJobs: string[];
  targetCompanies: string[];
  jobHuntingStatus: string;
  preferredLocations: string[];
};

export const EMPTY_CAREER_ASPIRATION: CareerAspiration = {
  targetIndustries: [],
  targetJobs: [],
  targetCompanies: [],
  jobHuntingStatus: '',
  preferredLocations: [],
};

/** 自己分析の **現在の canonical 結果**（最新 revision 1 件のみ。過去 revision は並べない）。 */
export type SpineSelfAnalysisView = {
  createdAt: string;
  summary: string;
  careerDirection: string;
  strengths: string[];
  weaknesses: string[];
  nextActions: string[];
  /** canonical に残っている自己分析の件数（revision collapse 後）。 */
  totalCount: number;
};

export type SpineExperienceView = {
  /** 入力済み活動カテゴリのラベル（Layer 2 ActivityMemorySummary.presentSections）。 */
  sections: string[];
  /** ガクチカ等の代表タイトル（Layer 2 ActivityMemorySummary.highlights）。 */
  highlights: string[];
};

export type CompletenessKey =
  | 'basic'
  | 'aspiration'
  | 'values'
  | 'activity'
  | 'selfAnalysis'
  | 'es'
  | 'interview';

export type CompletenessItem = {
  key: CompletenessKey;
  label: string;
  filled: boolean;
  /** 未入力時に案内する既存 route（マイページ内で機能を再実装しない）。 */
  href: string;
  /** 充実済みのときに添える短い実データ由来の補足（件数など）。空文字なら出さない。 */
  detail: string;
};

export type MypageSpineView = {
  /** Section A: 本人が明示的に設定する基本プロフィール（Layer 1 raw の identity 部分）。 */
  profile: CareerProfile | null;
  /** Section A': 編集可能な canonical 志望条件。 */
  aspiration: CareerAspiration;
  /** Section B: Data Spine から集約した「PASSAI が理解しているあなた」。 */
  understanding: SpineFact[];
  /** Section C: 経験・活動（Layer 2 activity projection）。 */
  experience: SpineExperienceView;
  /** Section D: 自己分析の現在の canonical 結果。 */
  selfAnalysis: SpineSelfAnalysisView | null;
  /** データの充実度（決定論・実データ由来）。 */
  completeness: CompletenessItem[];
  /** 充実済み項目数 / 全項目数。 */
  completenessDone: number;
  /**
   * Layer 2 section の内容 revision（8 hex）。表示用ではなく、
   * 「マイページが見ている projection と server が再算出する projection が同一か」を
   * QA / 障害調査で突き合わせるための決定的 token（PII / 本文を含まない）。
   */
  sectionRevisions: Readonly<Record<'base' | 'self_analysis' | 'es' | 'interview', string>>;
};

// ── helpers（決定的・never-throw） ───────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 空要素を落として順序を保ったまま重複除去する（決定的）。 */
function dedupe(...lists: Array<readonly unknown[] | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const t = str(item);
      if (t !== '' && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

function fact(key: string, label: string, origin: string, values: string[]): SpineFact | null {
  return values.length > 0 ? { key, label, values, origin } : null;
}

// ── 志望条件の抽出 / 正規化 ──────────────────────────────────────────

/**
 * Layer 1 profile から canonical 志望条件を読み出す（純関数・never-throw）。
 * 未設定キーは空配列 / 空文字に落ちる（保存側は空をキーごと省く規約）。
 */
export function readCareerAspiration(profile: CareerProfile | null): CareerAspiration {
  if (!profile) return EMPTY_CAREER_ASPIRATION;
  return {
    targetIndustries: dedupe(profile.targetIndustries),
    targetJobs: dedupe(profile.targetJobs),
    targetCompanies: dedupe(profile.targetCompanies),
    jobHuntingStatus: str(profile.jobHuntingStatus),
    preferredLocations: dedupe(profile.preferredLocations),
  };
}

export function isCareerAspirationEmpty(a: CareerAspiration): boolean {
  return (
    a.targetIndustries.length === 0 &&
    a.targetJobs.length === 0 &&
    a.targetCompanies.length === 0 &&
    a.jobHuntingStatus === '' &&
    a.preferredLocations.length === 0
  );
}

/**
 * 志望条件を Layer 1 profile へ **マージ**して次の canonical profile を作る（純関数）。
 *
 * ★ 空の項目は **キーごと削除**する（空配列 / 空文字を差し込まない）。
 *   理由: 既存ユーザーの AI input hash（lib/aiInputHash.ts）と
 *   source sync revision（lib/careerSourceSync/revision.ts）が一斉に変わって
 *   cache 無効化・不要な veto を起こすため。types/careerProfile.ts の保存規約と一致させる。
 */
export function applyCareerAspiration(
  base: CareerProfile,
  next: CareerAspiration,
): CareerProfile {
  const out: CareerProfile = { ...base };
  const setList = (key: 'targetIndustries' | 'targetJobs' | 'targetCompanies' | 'preferredLocations', values: string[]) => {
    const clean = dedupe(values);
    if (clean.length > 0) out[key] = clean;
    else delete out[key];
  };
  setList('targetIndustries', next.targetIndustries);
  setList('targetJobs', next.targetJobs);
  setList('targetCompanies', next.targetCompanies);
  setList('preferredLocations', next.preferredLocations);
  const status = str(next.jobHuntingStatus);
  if (status !== '') out.jobHuntingStatus = status;
  else delete out.jobHuntingStatus;
  return out;
}

// ── Layer 2 section projection（Data Spine と同一 builder） ───────────

type ProjectedSections = {
  base: BaseMemorySummary | null;
  selfAnalysis: SelfAnalysisMemorySummary | null;
  es: EsMemorySummary | null;
  interview: InterviewMemorySummary | null;
  revisions: Record<'base' | 'self_analysis' | 'es' | 'interview', string>;
};

function projectSections(bundle: CareerSourceBundle): ProjectedSections {
  const revisions: Record<'base' | 'self_analysis' | 'es' | 'interview', string> = {
    base: '',
    self_analysis: '',
    es: '',
    interview: '',
  };
  const base = projectSectionFromSource('base', bundle);
  const selfAnalysis = projectSectionFromSource('self_analysis', bundle);
  const es = projectSectionFromSource('es', bundle);
  const interview = projectSectionFromSource('interview', bundle);
  if (base) revisions.base = base.sourceRevision;
  if (selfAnalysis) revisions.self_analysis = selfAnalysis.sourceRevision;
  if (es) revisions.es = es.sourceRevision;
  if (interview) revisions.interview = interview.sourceRevision;
  return {
    base: base?.section.sectionKey === 'base' ? base.section.payload : null,
    selfAnalysis:
      selfAnalysis?.section.sectionKey === 'self_analysis' ? selfAnalysis.section.payload : null,
    es: es?.section.sectionKey === 'es' ? es.section.payload : null,
    interview: interview?.section.sectionKey === 'interview' ? interview.section.payload : null,
    revisions,
  };
}

// ── Section B: PASSAI が理解しているあなた ───────────────────────────

/**
 * Layer 2 payload から「AI が実際に受け取っている理解」を人間可読な行へ翻訳する。
 *
 * ★ すべての行は実 payload の typed field 由来。値が無い行は **生成しない**
 *   （＝空欄の水増しをしない）。prompt 文字列・system prompt は一切出さない。
 */
function buildUnderstanding(p: ProjectedSections): SpineFact[] {
  const prof = p.base?.profile;
  const vals = p.base?.values;
  const latestSelf = p.selfAnalysis?.latest?.[0];
  const selfLong = p.selfAnalysis?.longTerm;
  const interviewLong = p.interview?.longTerm;

  const facts: Array<SpineFact | null> = [
    fact(
      'strengths',
      '強み',
      '自己分析・面接練習・プロフィール',
      dedupe(selfLong?.consistentStrengths, latestSelf?.strengths, interviewLong?.stableStrengths, prof?.strengths),
    ),
    fact(
      'weaknesses',
      '課題・伸びしろ',
      '自己分析・面接練習',
      dedupe(latestSelf?.weaknesses, interviewLong?.recurringImprovements, prof?.weaknesses),
    ),
    fact('values', '大切にしている価値観', '自己分析', dedupe(latestSelf?.valueKeywords)),
    fact('careerGoals', 'キャリア志向', '就活軸整理', dedupe(vals?.careerGoals)),
    fact(
      'direction',
      '向かおうとしている方向',
      '自己分析',
      dedupe(latestSelf?.careerDirection ? [latestSelf.careerDirection] : []),
    ),
    fact('priorities', '仕事選びで重視すること', '就活軸整理', dedupe(vals?.priorities)),
    fact('avoidances', '避けたいこと', '就活軸整理', dedupe(vals?.avoidances)),
    fact(
      'workStyles',
      '望ましい働き方・環境',
      '就活軸整理',
      dedupe(vals?.workStyles, vals?.culturePreferences, vals?.companyTypes),
    ),
    fact(
      'industries',
      '関心のある業界',
      '志望条件・就活軸整理・自己分析',
      dedupe(prof?.targetIndustries, vals?.industries, latestSelf?.recommendedIndustries),
    ),
    fact(
      'jobs',
      '関心のある職種',
      '志望条件・就活軸整理・自己分析',
      dedupe(prof?.targetJobs, vals?.jobTypes, latestSelf?.recommendedJobs),
    ),
    fact(
      'companyCriteria',
      '企業選びの基準',
      '自己分析',
      dedupe(latestSelf?.companySelectionCriteria),
    ),
    fact('targetCompanies', '意識している企業', '志望条件・ES作成', dedupe(prof?.targetCompanies, p.es?.longTerm?.companies)),
    fact('locations', '希望勤務地', '志望条件', dedupe(prof?.preferredLocations)),
    fact(
      'status',
      '就活の状況',
      '志望条件',
      dedupe(prof?.jobHuntingStatus ? [prof.jobHuntingStatus] : []),
    ),
  ];

  return facts.filter((f): f is SpineFact => f !== null);
}

// ── Section D: 自己分析の現在の canonical 結果 ───────────────────────

function buildSelfAnalysisView(p: ProjectedSections): SpineSelfAnalysisView | null {
  const summary = p.selfAnalysis;
  const latest = summary?.latest?.[0];
  if (!summary || !latest) return null;
  return {
    createdAt: str(latest.createdAt),
    summary: str(latest.summary),
    careerDirection: str(latest.careerDirection),
    strengths: dedupe(latest.strengths),
    weaknesses: dedupe(latest.weaknesses),
    nextActions: dedupe(latest.nextActions),
    totalCount: summary.meta?.sourceCount ?? 0,
  };
}

// ── 充実度（決定論・実 canonical data 由来） ─────────────────────────

function buildCompleteness(
  bundle: CareerSourceBundle,
  p: ProjectedSections,
  aspiration: CareerAspiration,
): CompletenessItem[] {
  const prof = p.base?.profile;
  const vals = p.base?.values;
  const act = p.base?.activity;
  const valuesCount = dedupe(
    vals?.priorities,
    vals?.avoidances,
    vals?.industries,
    vals?.jobTypes,
    vals?.workStyles,
    vals?.companyTypes,
    vals?.careerGoals,
    vals?.culturePreferences,
  ).length;
  const selfCount = p.selfAnalysis?.meta?.sourceCount ?? 0;
  const esCount = p.es?.meta?.sourceCount ?? 0;
  const interviewCount = p.interview?.meta?.sourceCount ?? 0;
  const activityCount = act?.presentSections?.length ?? 0;
  const basicFilled =
    bundle.profile !== null &&
    (str(prof?.university) !== '' || str(prof?.faculty) !== '' || str(prof?.grade) !== '');

  return [
    {
      key: 'basic',
      label: '基本情報',
      filled: basicFilled,
      href: '/career/profile',
      detail: basicFilled ? str(prof?.university) : '',
    },
    {
      key: 'aspiration',
      label: '志望条件',
      filled: !isCareerAspirationEmpty(aspiration),
      href: '/career/mypage',
      detail: '',
    },
    {
      key: 'values',
      label: '就活軸整理',
      filled: valuesCount > 0,
      href: '/career/values',
      detail: valuesCount > 0 ? `${valuesCount}項目` : '',
    },
    {
      key: 'activity',
      label: '活動整理',
      filled: activityCount > 0,
      href: '/career/activity',
      detail: activityCount > 0 ? `${activityCount}カテゴリ` : '',
    },
    {
      key: 'selfAnalysis',
      label: '自己分析',
      filled: selfCount > 0,
      href: '/career/self-analysis',
      detail: selfCount > 0 ? `${selfCount}件` : '',
    },
    {
      key: 'es',
      label: 'ES作成',
      filled: esCount > 0,
      href: '/career/es',
      detail: esCount > 0 ? `${esCount}件` : '',
    },
    {
      key: 'interview',
      label: '面接練習',
      filled: interviewCount > 0,
      href: '/career/interview',
      detail: interviewCount > 0 ? `${interviewCount}件` : '',
    },
  ];
}

// ── entry point ──────────────────────────────────────────────────────

/**
 * Layer 1 bundle → マイページ view model（純関数・never-throw・決定的）。
 *
 * ★ ここが「マイページ = User Data Spine の presentation / editing layer」の中核。
 *   store も cache も持たないため、マイページ用の第 2 の真実が構造的に生まれない。
 */
export function buildMypageSpineView(bundle: CareerSourceBundle): MypageSpineView {
  const projected = projectSections(bundle);
  const aspiration = readCareerAspiration(bundle.profile);
  const completeness = buildCompleteness(bundle, projected, aspiration);
  return {
    profile: bundle.profile,
    aspiration,
    understanding: buildUnderstanding(projected),
    experience: {
      sections: dedupe(projected.base?.activity?.presentSections),
      highlights: dedupe(projected.base?.activity?.highlights),
    },
    selfAnalysis: buildSelfAnalysisView(projected),
    completeness,
    completenessDone: completeness.filter((c) => c.filled).length,
    sectionRevisions: projected.revisions,
  };
}
