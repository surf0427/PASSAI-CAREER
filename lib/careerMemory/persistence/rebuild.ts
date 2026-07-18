// PASSAI CAREER — Personal Memory deterministic section builders（P16-A Stage 3）。
//
// Source（domain 型）から P4-A canonical memory 型（FeatureSummary 系）を **決定的・pure・AI 非依存**に生成する。
// prompt 文字列 / transcript / ES 本文 / raw text / PII 氏名 は生成しない（型・projection で担保）。
//
// 注: 本層は「Source 原本を保存する」のではなく、canonical memory 型の全 field を決定的に生成する
//     （projection）。cap / latest 選択 / consumer 別整形は将来の read adapter（shadow read）側の責務。

import type { CareerProfileContext } from '@/lib/careerAi';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerEsLog } from '@/types/careerEs';
import type { CareerInterviewResult } from '@/types/careerInterview';
import type {
  BaseMemorySummary,
  SelfAnalysisMemorySummary,
  EsMemorySummary,
  InterviewMemorySummary,
  ProfileMemorySummary,
  ActivityMemorySummary,
  ValuesMemorySummary,
  FeatureSummaryMeta,
  CareerMemoryFeature,
} from '@/lib/careerMemory/types';
import {
  CAREER_PERSONAL_MEMORY_SCHEMA_VERSION,
  type CareerPersonalMemorySection,
} from './schema';
import {
  computeLogSectionLatestAt,
  computeContentRevision,
} from './revision';

const HISTORY_LIMIT = 3;

export type SectionRebuildResult = {
  section: CareerPersonalMemorySection;
  sourceRevision: string;
  sourceUpdatedAt: string | null;
};

// ── helpers（決定的・PII 非依存） ──
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function strList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x !== '').slice(0, max);
}
function meta(feature: CareerMemoryFeature, sourceCount: number, latestAt: string | null): FeatureSummaryMeta {
  return { feature, sourceCount, ...(latestAt ? { latestAt } : {}), warnings: [] };
}
function maxStr(a: string | null | undefined, b: string | null | undefined): string | null {
  const av = typeof a === 'string' && a !== '' ? a : null;
  const bv = typeof b === 'string' && b !== '' ? b : null;
  if (av === null) return bv;
  if (bv === null) return av;
  return av >= bv ? av : bv;
}

// ── base ──
function projectProfile(p: CareerProfileContext | null): ProfileMemorySummary {
  // 注: name / email 等 PII は載せない（ProfileMemorySummary が構造上持たない）。
  return {
    university: str(p?.university),
    faculty: str(p?.faculty),
    grade: str(p?.grade),
    graduationYear: str(p?.graduationYear),
    targetIndustries: strList(p?.targetIndustries, 20),
    targetJobs: strList(p?.targetJobs, 20),
    targetCompanies: strList(p?.targetCompanies, 20),
    jobHuntingStatus: str(p?.jobHuntingStatus),
    strengths: strList(p?.strengths, 20),
    weaknesses: strList(p?.weaknesses, 20),
    preferredLocations: strList(p?.preferredLocations, 20),
  };
}

// activity の 18 セクション（key, label）。presentSections は content ありのラベルのみ。
const ACTIVITY_SECTIONS: ReadonlyArray<{ key: keyof CareerActivity; label: string }> = [
  { key: 'personality', label: '人柄・自己PR' },
  { key: 'academics', label: '学業' },
  { key: 'focusedActivities', label: '力を入れたこと' },
  { key: 'partTimeJobs', label: 'アルバイト' },
  { key: 'internships', label: 'インターン' },
  { key: 'club', label: 'サークル・部活' },
  { key: 'projects', label: 'プロジェクト' },
  { key: 'leadership', label: 'リーダーシップ' },
  { key: 'volunteer', label: 'ボランティア' },
  { key: 'overseas', label: '海外経験' },
  { key: 'certifications', label: '資格' },
  { key: 'itSkills', label: 'ITスキル' },
  { key: 'languages', label: '語学' },
  { key: 'hobbies', label: '趣味・特技' },
  { key: 'awards', label: '表彰・実績' },
  { key: 'snsActivities', label: 'SNS・情報発信' },
  { key: 'portfolios', label: 'ポートフォリオ' },
  { key: 'lifeExperiences', label: 'ライフイベント' },
];

// 汎用 content 判定（配列は length>0・文字列は非空・object は浅い非空 string を持つ）。決定的。
function hasContent(v: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.some((x) => hasContent(x, depth + 1));
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some((x) => hasContent(x, depth + 1));
  return false;
}
// entry の代表文字列（決定的: 最初の非空 string prop）。PII 除去のため長さ 40 に truncate。
function representative(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim().slice(0, 40);
  if (entry && typeof entry === 'object') {
    for (const val of Object.values(entry as Record<string, unknown>)) {
      if (typeof val === 'string' && val.trim() !== '') return val.trim().slice(0, 40);
    }
  }
  return '';
}
function projectActivity(a: CareerActivity | null): ActivityMemorySummary {
  if (!a) return { presentSections: [], highlights: [] };
  const presentSections: string[] = [];
  for (const { key, label } of ACTIVITY_SECTIONS) {
    if (hasContent((a as Record<string, unknown>)[key as string])) presentSections.push(label);
  }
  const focused = Array.isArray(a.focusedActivities) ? a.focusedActivities : [];
  const highlights = focused.map((e) => representative(e)).filter((s) => s !== '').slice(0, 5);
  return { presentSections, highlights };
}

function projectValues(v: CareerValues | null): ValuesMemorySummary {
  const s = v?.selections;
  return {
    priorities: strList(s?.priorities, 20),
    avoidances: strList(s?.avoidances, 20),
    industries: strList(s?.industries, 20),
    jobTypes: strList(s?.jobTypes, 20),
    workStyles: strList(s?.workStyles, 20),
    companyTypes: strList(s?.companyTypes, 20),
    careerGoals: strList(s?.careerGoals, 20),
    culturePreferences: strList(s?.culturePreferences, 20),
  };
}

export function buildBaseMemorySection(
  profile: CareerProfileContext | null,
  activity: CareerActivity | null,
  values: CareerValues | null,
): SectionRebuildResult {
  const payload: BaseMemorySummary = {
    profile: projectProfile(profile),
    activity: projectActivity(activity),
    values: projectValues(values),
  };
  const sourceUpdatedAt = maxStr(activity?.updatedAt, values?.updatedAt);
  return {
    section: { sectionKey: 'base', schemaVersion: CAREER_PERSONAL_MEMORY_SCHEMA_VERSION, payload },
    sourceRevision: computeContentRevision(payload),
    sourceUpdatedAt,
  };
}

// ── log 系共通 ──
function sortByCreatedDesc<T extends { createdAt: string }>(logs: T[]): T[] {
  return [...logs].sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1));
}
// 複数 log で 2 回以上出た string を抽出（consistent 項目。決定的順序）。
function recurring(lists: string[][]): string[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const list of lists) {
    for (const item of new Set(list)) {
      if (!counts.has(item)) order.push(item);
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
  }
  return order.filter((k) => (counts.get(k) ?? 0) >= 2);
}

export function buildSelfAnalysisMemorySection(logs: CareerSelfAnalysisLog[]): SectionRebuildResult {
  const valid = (Array.isArray(logs) ? logs : []).filter((l) => l && l.result);
  const sorted = sortByCreatedDesc(valid);
  const latest = sorted.slice(0, HISTORY_LIMIT).map((log) => {
    const r = log.result;
    return {
      createdAt: str(log.createdAt),
      summary: str(r.summary),
      careerDirection: str(r.careerDirection),
      strengths: strList(r.strengths, 10),
      weaknesses: strList(r.weaknesses, 10),
      valueKeywords: strList(r.valueKeywords, 10),
      strengthKeywords: strList(r.strengthKeywords, 10),
      recommendedIndustries: strList(r.recommendedIndustries, 10),
      recommendedJobs: strList(r.recommendedJobs, 10),
      companySelectionCriteria: strList(r.companySelectionCriteria, 10),
      gakuchikaIdeas: strList(r.gakuchikaIdeas, 10),
      nextActions: strList(r.nextActions, 10),
    };
  });
  const payload: SelfAnalysisMemorySummary = {
    meta: meta('self_analysis', valid.length, computeLogSectionLatestAt(valid)),
    latest,
    longTerm: {
      consistentStrengths: recurring(latest.map((l) => l.strengths)),
      industryShift: [],
    },
  };
  return {
    section: { sectionKey: 'self_analysis', schemaVersion: CAREER_PERSONAL_MEMORY_SCHEMA_VERSION, payload },
    sourceRevision: computeContentRevision(payload),
    sourceUpdatedAt: computeLogSectionLatestAt(valid),
  };
}

export function buildEsMemorySection(logs: CareerEsLog[]): SectionRebuildResult {
  const valid = (Array.isArray(logs) ? logs : []).filter((l) => l && l.result);
  const sorted = sortByCreatedDesc(valid);
  // ★ P17-M1: ESトレーニング再設計対応。設問メタ（企業名・設問）は log レベル（本人入力）を正とし、
  //   旧 result.companyName / result.question へフォールバックする（旧ログ後方互換）。
  //   AI 生成文（headline / gakuchika / selfPr / motivation / appealPoints）・AI 添削（review）・
  //   本人本文（body / result.answer）は Personal Memory へ **載せない**（本人作成情報 ≠ AI 生成文、
  //   かつ生本文全文は保存しない方針）。
  const latest = sorted.slice(0, HISTORY_LIMIT).map((log) => {
    const r = log.result;
    return {
      createdAt: str(log.createdAt),
      companyName: str(log.companyName) || str(r.companyName),
      question: str(log.question) || str(r.question),
    };
  });
  const payload: EsMemorySummary = {
    meta: meta('es', valid.length, computeLogSectionLatestAt(valid)),
    latest,
    longTerm: {
      companies: [...new Set(latest.map((l) => l.companyName).filter((c) => c !== ''))],
    },
  };
  return {
    section: { sectionKey: 'es', schemaVersion: CAREER_PERSONAL_MEMORY_SCHEMA_VERSION, payload },
    sourceRevision: computeContentRevision(payload),
    sourceUpdatedAt: computeLogSectionLatestAt(valid),
  };
}

export function buildInterviewMemorySection(results: CareerInterviewResult[]): SectionRebuildResult {
  const valid = (Array.isArray(results) ? results : []).filter((l) => l && l.result);
  const sorted = sortByCreatedDesc(valid);
  const latest = sorted.slice(0, HISTORY_LIMIT).map((res) => {
    const r = res.result;
    return {
      createdAt: str(res.createdAt),
      mode: str(res.mode),
      overallComment: str(r.overallComment),
      strengths: strList(r.strengths, 10),
      improvements: strList(r.improvements, 10),
      deepDiveTopics: strList(r.deepDiveTopics, 10),
      nextActions: strList(r.nextActions, 10),
      companyFit: str(r.companyFit),
    };
  });
  const payload: InterviewMemorySummary = {
    meta: meta('interview', valid.length, computeLogSectionLatestAt(valid)),
    latest,
    longTerm: {
      recurringImprovements: recurring(latest.map((l) => l.improvements)),
      stableStrengths: recurring(latest.map((l) => l.strengths)),
    },
  };
  return {
    section: { sectionKey: 'interview', schemaVersion: CAREER_PERSONAL_MEMORY_SCHEMA_VERSION, payload },
    sourceRevision: computeContentRevision(payload),
    sourceUpdatedAt: computeLogSectionLatestAt(valid),
  };
}
