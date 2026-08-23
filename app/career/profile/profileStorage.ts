import type { CareerProfile } from '@/types/careerProfile';
import type { SchoolPreference } from '@/types/basicInfo';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';
// 所有者名前空間（account switch 隔離）。guest は従来キーのまま、member は所有者 suffix 付き。
// ★ 定数ではなく **呼び出しのたびに** 解決する（module 読み込み時に固定すると、
//   後からログイン/ログアウトしても古い名前空間を掴み続けるため）。
import { careerStorageKey } from '@/lib/careerStorage/owner';

// 就活版（career）基本情報＝プロフィールの localStorage キー。
// 受験版（lib/basicInfoStorage.ts の 'basicFormData'）とは別キーにして、
// 就活データが受験版のストレージ／テーブルへ混入しないよう独立させる。
function STORAGE_KEY(): string {
  return careerStorageKey('careerBasicFormData');
}

// 関数名は loadBasicInfo / saveBasicInfo のまま維持する（career 配下の多数の消費側が
// この名前で import 済みのため、import churn を避ける）。扱う型のみ CareerProfile に変更。
// Phase1 同様、受験版テーブルへの書き込み（Supabase mirror / DB dualWrite）は行わず、
// canonical な localStorage 保存のみとする（DB 連携は後続フェーズ）。
export function saveBasicInfo(data: CareerProfile): void {
  safeSetStorage(STORAGE_KEY(), data);
}

export function loadBasicInfo(): CareerProfile | null {
  const raw = safeGetStorage<CareerProfile | null>(STORAGE_KEY(), null);
  if (!raw) return null;
  return normalizeCareerProfile(raw);
}

// 旧スキーマ（graduationYear 未保存・受験版コピー時代の値など）でも安全に読み込めるよう
// 正規化する。CareerProfile は BasicInfo 上位互換のため、受験版由来フィールドも欠損時は
// 既定値で埋め、消費側（home / activity / BasicInfoSummary）が落ちないようにする。
//
// subjectGrades は意図的に「未保存なら追加しない（undefined のまま）」設計。
// 空オブジェクトを差し込むと AI input hash（lib/aiInputHash.ts）が既存ユーザーで
// 一斉に変わり cache が miss するため。値が既に存在するときだけ shape を保って素通しする。
function normalizeCareerProfile(data: CareerProfile): CareerProfile {
  const normalized: CareerProfile = {
    ...data,
    track: data.track ?? '',
    overallGpa: data.overallGpa ?? '',
    examTypes: data.examTypes ?? [],
    graduationYear: data.graduationYear ?? '',
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
