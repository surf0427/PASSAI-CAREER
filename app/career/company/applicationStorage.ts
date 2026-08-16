/**
 * Application Context の localStorage 保存層（Phase A / R6）。
 *
 * canonical ownership: **localStorage canonical**（既存 Data Spine house rule `D-S1` に準拠。
 *   Supabase は best-effort mirror）。企業マスタ / Official Facts と違い、これは
 *   user × company の **個人データ**なので device canonical 側に置く。
 *
 * localStorage key: 'careerCompanyApplications'（Record<companyId, CareerCompanyApplication>）
 *
 * ★ 既存機能フィールドの置換ではない。ここは「次に ES / 面接 / プレゼンを開いたときの初期値」
 *   の供給元にすぎず、各機能は従来どおり自分のログへ保存する。
 */

import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';
import type {
  CareerCompanyApplication,
  CareerCompanyApplicationDefaults,
} from '@/types/careerCompanyApplication';

const APPLICATION_KEY = 'careerCompanyApplications';

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function interestLevel(value: unknown): CareerCompanyApplication['interestLevel'] {
  return value === 'high' || value === 'mid' || value === 'low' || value === 'watch'
    ? value
    : undefined;
}

function selectionType(value: unknown): CareerCompanyApplication['selectionType'] {
  return value === 'main' || value === 'internship' ? value : undefined;
}

function selectionPhase(value: unknown): CareerCompanyApplication['selectionPhase'] {
  return value === 'first' ||
    value === 'second' ||
    value === 'final' ||
    value === 'internship' ||
    value === 'casual'
    ? value
    : undefined;
}

/** 壊れた / 未知形状の entry を安全に正規化する（未知は捨てる・throw しない）。 */
function normalizeApplication(raw: unknown): CareerCompanyApplication | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const companyId = str(r.companyId);
  if (companyId === '') return null;

  const app: CareerCompanyApplication = {
    companyId,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
  };
  const level = interestLevel(r.interestLevel);
  if (level) app.interestLevel = level;
  const jobType = str(r.jobType);
  if (jobType) app.jobType = jobType;
  const sType = selectionType(r.selectionType);
  if (sType) app.selectionType = sType;
  const sPhase = selectionPhase(r.selectionPhase);
  if (sPhase) app.selectionPhase = sPhase;
  const year = str(r.selectionYear);
  if (year) app.selectionYear = year;
  return app;
}

function loadAll(): Record<string, CareerCompanyApplication> {
  const raw = safeGetStorage<unknown>(APPLICATION_KEY, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, CareerCompanyApplication> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const app = normalizeApplication(value);
    if (app && app.companyId === key) out[key] = app;
  }
  return out;
}

/** 全件（企業ごとの応募文脈）。 */
export function loadCompanyApplications(): CareerCompanyApplication[] {
  return Object.values(loadAll());
}

/** companyId の応募文脈を 1 件返す（無ければ null）。 */
export function loadCompanyApplication(companyId: string): CareerCompanyApplication | null {
  const id = str(companyId);
  if (id === '') return null;
  return loadAll()[id] ?? null;
}

/**
 * 各機能のフォーム初期値として使う部分ビュー。
 * companyId が無い / 未保存なら空オブジェクト（＝初期値なし＝従来どおりの空フォーム）。
 */
export function loadCompanyApplicationDefaults(
  companyId: string | undefined | null,
): CareerCompanyApplicationDefaults {
  const app = loadCompanyApplication(typeof companyId === 'string' ? companyId : '');
  if (!app) return {};
  const defaults: CareerCompanyApplicationDefaults = {};
  if (app.interestLevel) defaults.interestLevel = app.interestLevel;
  if (app.jobType) defaults.jobType = app.jobType;
  if (app.selectionType) defaults.selectionType = app.selectionType;
  if (app.selectionPhase) defaults.selectionPhase = app.selectionPhase;
  if (app.selectionYear) defaults.selectionYear = app.selectionYear;
  return defaults;
}

/**
 * 応募文脈を保存する（部分更新）。companyId 必須。
 *
 * ★ 明示保存のみ。各機能のフォームから **自動で上書きしない**
 *   （「今回だけ別職種で練習する」を壊さないため。R6 の設計判断）。
 */
export function saveCompanyApplication(
  companyId: string,
  patch: CareerCompanyApplicationDefaults,
): void {
  const id = str(companyId);
  if (id === '') return;
  const all = loadAll();
  const previous = all[id];
  const next: CareerCompanyApplication = {
    ...(previous ?? { companyId: id, updatedAt: '' }),
    ...patch,
    companyId: id,
    updatedAt: new Date().toISOString(),
  };
  // 空文字で来た項目は「未指定へ戻す」として除去する（''を保存しない）。
  for (const key of ['jobType', 'selectionYear'] as const) {
    if (typeof next[key] === 'string' && next[key]!.trim() === '') delete next[key];
  }
  all[id] = next;
  safeSetStorage(APPLICATION_KEY, all);
}

/** 応募文脈を削除する。 */
export function deleteCompanyApplication(companyId: string): void {
  const id = str(companyId);
  if (id === '') return;
  const all = loadAll();
  if (!(id in all)) return;
  delete all[id];
  safeSetStorage(APPLICATION_KEY, all);
}
