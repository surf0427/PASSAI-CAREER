import type {
  CareerCompanyResearchLog,
  CareerCompanyResearchInput,
  CareerCompanyResearchFile,
  CareerCompanyResearchReview,
  CareerCompanyResearchBreakdown,
  CareerCompanyResearchFitAnalysis,
  CareerCompanyResearchRevision,
  CareerCompanyResearchExtractionStatus,
  CareerCompanyInterestLevel,
} from '@/types/careerCompanyResearch';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';

// 就活版（career）企業研究AIの結果ログ localStorage 保存層。
// 受験版とは別レーンの就活版専用キー: 'careerCompanyResearchLogs'。
const COMPANY_RESEARCH_LOG_KEY = 'careerCompanyResearchLogs';

// ── 防御的 normalize ヘルパー ───────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function interestLevel(value: unknown): CareerCompanyInterestLevel | null {
  return value === 'high' || value === 'mid' || value === 'low' || value === 'watch'
    ? value
    : null;
}

function extractionStatus(value: unknown): CareerCompanyResearchExtractionStatus {
  return value === 'pending' ||
    value === 'success' ||
    value === 'failed' ||
    value === 'manual_required'
    ? value
    : 'manual_required';
}

function normalizeFile(raw: unknown): CareerCompanyResearchFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const file: CareerCompanyResearchFile = {
    id: r.id,
    fileName: str(r.fileName),
    fileType: str(r.fileType),
    fileSize: num(r.fileSize),
    uploadedAt: str(r.uploadedAt),
    extractedText: str(r.extractedText),
    extractionStatus: extractionStatus(r.extractionStatus),
  };
  if (typeof r.storagePath === 'string') file.storagePath = r.storagePath;
  if (typeof r.extractionError === 'string') file.extractionError = r.extractionError;
  return file;
}

function normalizeFiles(value: unknown): CareerCompanyResearchFile[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeFile).filter((f): f is CareerCompanyResearchFile => f !== null);
}

// 旧スキーマ（業界・強み等の構造化フィールド）の input を新スキーマへ寄せる。
// 旧フィールドがあれば manualMemo に畳み込み、verifiedResearchText が空なら同値で埋める。
function migrateLegacyInputText(r: Record<string, unknown>): string {
  const legacyPairs: Array<[string, string]> = [
    ['事業内容', str(r.business)],
    ['強み', str(r.strengths)],
    ['弱み・課題', str(r.weaknesses)],
    ['競合比較', str(r.competitors)],
    ['求める人物像', str(r.idealCandidate)],
    ['気になった情報', str(r.interestingInfo)],
    ['自分との接点', str(r.personalConnection)],
    ['自由メモ', str(r.freeMemo)],
  ];
  return legacyPairs
    .filter(([, v]) => v.trim() !== '')
    .map(([label, v]) => `【${label}】\n${v}`)
    .join('\n\n');
}

function normalizeInput(raw: unknown): CareerCompanyResearchInput {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const legacyText = migrateLegacyInputText(r);
  const manualMemo = str(r.manualMemo) || legacyText;
  const verifiedResearchText = str(r.verifiedResearchText) || manualMemo;
  return {
    companyName: str(r.companyName),
    industry: str(r.industry),
    interestLevel: interestLevel(r.interestLevel),
    manualMemo,
    pastedText: str(r.pastedText),
    uploadedFiles: normalizeFiles(r.uploadedFiles),
    extractedText: str(r.extractedText),
    verifiedResearchText,
    sources: str(r.sources),
  };
}

function normalizeBreakdown(raw: unknown): CareerCompanyResearchBreakdown {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    companyUnderstanding: num(r.companyUnderstanding),
    industryUnderstanding: num(r.industryUnderstanding),
    competitorUnderstanding: num(r.competitorUnderstanding),
    evidenceQuality: num(r.evidenceQuality),
    depthOfThought: num(r.depthOfThought),
    motivationConnection: num(r.motivationConnection),
  };
}

function normalizeRank(value: unknown): CareerCompanyResearchReview['rank'] {
  return value === 'S' || value === 'A' || value === 'B' || value === 'C' || value === 'D'
    ? value
    : 'D';
}

function normalizeReview(raw: unknown): CareerCompanyResearchReview {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    overallScore: num(r.overallScore),
    rank: normalizeRank(r.rank),
    overallComment: str(r.overallComment),
    breakdown: normalizeBreakdown(r.breakdown),
    goodPoints: strArray(r.goodPoints),
    missingInfo: strArray(r.missingInfo),
    // 旧キー（assumptions / nextResearch）からの後方互換フォールバック。
    weakAssumptions: strArray(r.weakAssumptions ?? r.assumptions),
    nextResearchActions: strArray(r.nextResearchActions ?? r.nextResearch),
  };
}

function normalizeFitAnalysis(raw: unknown): CareerCompanyResearchFitAnalysis {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    selfAnalysisFit: str(r.selfAnalysisFit),
    valuesFit: str(r.valuesFit),
    activityFit: str(r.activityFit),
    matchingFit: str(r.matchingFit),
    // 旧キー（consistencies / usableStrengths）からの後方互換フォールバック。
    gaps: strArray(r.gaps),
    strengthsToUse: strArray(r.strengthsToUse ?? r.usableStrengths),
  };
}

function normalizeRevision(raw: unknown): CareerCompanyResearchRevision | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    revisionId: typeof r.revisionId === 'string' ? r.revisionId : '',
    verifiedResearchText: str(r.verifiedResearchText),
    review: normalizeReview(r.review),
    fitAnalysis: normalizeFitAnalysis(r.fitAnalysis),
    interviewContextSummary: str(r.interviewContextSummary),
    createdAt: str(r.createdAt),
  };
}

function normalizeRevisionHistory(value: unknown): CareerCompanyResearchRevision[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeRevision)
    .filter((v): v is CareerCompanyResearchRevision => v !== null);
}

// 壊れた / 旧スキーマのログを防御的に正規化する。id が無いものは捨てる。
function normalizeLog(raw: unknown): CareerCompanyResearchLog | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;

  const input = normalizeInput(r.input);
  const log: CareerCompanyResearchLog = {
    id: r.id,
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt) || str(r.createdAt),
    companyName: str(r.companyName) || input.companyName,
    industry: str(r.industry) || input.industry,
    interestLevel: interestLevel(r.interestLevel) ?? input.interestLevel,
    input,
    review: normalizeReview(r.review),
    fitAnalysis: normalizeFitAnalysis(r.fitAnalysis),
    interviewContextSummary: str(r.interviewContextSummary),
    revisionHistory: normalizeRevisionHistory(r.revisionHistory),
  };
  if (typeof r.favorite === 'boolean') log.favorite = r.favorite;
  return log;
}

// ── 公開 API ──────────────────────────────────────────────────────

export function loadCompanyResearchLogs(): CareerCompanyResearchLog[] {
  const raw = safeGetStorage<unknown[]>(COMPANY_RESEARCH_LOG_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeLog)
    .filter((l): l is CareerCompanyResearchLog => l !== null);
}

export function loadCompanyResearchLog(id: string): CareerCompanyResearchLog | null {
  if (!id) return null;
  return loadCompanyResearchLogs().find((l) => l.id === id) ?? null;
}

export function saveCompanyResearchLogs(logs: CareerCompanyResearchLog[]): void {
  safeSetStorage(COMPANY_RESEARCH_LOG_KEY, logs);
}

// 1 件を先頭に追記して保存する（最新が先頭）。do 画面の新規保存から利用する。
export function appendCompanyResearchLog(log: CareerCompanyResearchLog): void {
  saveCompanyResearchLogs([log, ...loadCompanyResearchLogs()]);
}

// 指定 ID の 1 件に部分更新を適用して保存する（再添削・お気に入りトグル等）。
// 該当が無ければ何もしない。id は不変。
export function updateCompanyResearchLog(
  id: string,
  patch: Partial<CareerCompanyResearchLog>,
): void {
  const logs = loadCompanyResearchLogs();
  let changed = false;
  const next = logs.map((log) => {
    if (log.id !== id) return log;
    changed = true;
    return { ...log, ...patch, id: log.id };
  });
  if (changed) saveCompanyResearchLogs(next);
}
