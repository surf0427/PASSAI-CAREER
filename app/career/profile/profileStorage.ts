import type { BasicInfo, SchoolPreference } from '@/types/basicInfo';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';

// 就活版（career）基本情報の localStorage キー。
// 受験版（lib/basicInfoStorage.ts の 'basicFormData'）とは別キーにして、
// 就活データが受験版のストレージ／テーブルへ混入しないよう独立させる。
const STORAGE_KEY = 'careerBasicFormData';

// 受験版 lib/basicInfoStorage.ts をそのまま踏襲。
// ただし Phase1 では受験版テーブルへの書き込み（Supabase mirror / DB dualWrite）は
// 行わないため、canonical な localStorage 保存のみとする（DB 連携は後続フェーズ）。
export function saveBasicInfo(data: BasicInfo): void {
  safeSetStorage(STORAGE_KEY, data);
}

export function loadBasicInfo(): BasicInfo | null {
  const raw = safeGetStorage<BasicInfo | null>(STORAGE_KEY, null);
  if (!raw) return null;
  return normalizeBasicInfo(raw);
}

// 旧スキーマ（department / overallGpa 未保存）でも安全に読み込めるよう正規化する。
//
// subjectGrades は意図的に「未保存なら追加しない（undefined のまま）」設計。
// 空オブジェクトを差し込むと AI input hash（lib/aiInputHash.ts）が既存ユーザーで
// 一斉に変わり、5 ルート分の cache が miss するため。
// 値が既に存在するときだけ shape を保ったまま素通しする。
function normalizeBasicInfo(data: BasicInfo): BasicInfo {
  const normalized: BasicInfo = {
    ...data,
    overallGpa: data.overallGpa ?? '',
    examTypes: data.examTypes ?? [],
    preferences: (data.preferences ?? []).map(normalizePreference),
  };
  if (data.subjectGrades === undefined) {
    delete normalized.subjectGrades;
  }
  return normalized;
}

function normalizePreference(pref: SchoolPreference): SchoolPreference {
  return {
    university: pref.university ?? '',
    faculty: pref.faculty ?? '',
    department: pref.department ?? '',
  };
}
