import type {
  CareerValues,
  CareerValuesCategoryKey,
  CareerValuesNotes,
  CareerValuesSelections,
} from '@/types/careerValues';
import {
  CAREER_VALUES_CATEGORY_KEYS,
  emptyCareerValues,
} from '@/types/careerValues';
import { CAREER_VALUES_OPTION_SETS } from './careerValuesCategories';
import { safeGetStorage, safeSetStorage, safeRemoveStorage } from '@/lib/storage/safeStorage';

// 就活版（career）「就活軸整理」の localStorage 保存層（canonical）。
//
// 他の career 機能（profileStorage / selfAnalysisStorage / activityStorage）と同じく
// localStorage を正本（canonical）とし、ログイン済みユーザーのみ Supabase 永続ミラー
// （lib/supabase/careerValues.ts）へ best-effort で同期する。受験版キーとは別キーで
// 分離し、受験版データへ混入させない。
const STORAGE_KEY = 'careerValues';

// 不明・壊れた値を捨てて、型・選択肢を正規化する。
//   - selections: 各カテゴリで「正規な選択肢集合に含まれる文字列」だけを残す（重複も除去）。
//   - notes: 各カテゴリの string のみ採用。
//   - overallNote: string のみ。
// 旧スキーマ・部分データ・手書き JSON でも落ちずに読めるようにするための防御。
export function normalizeCareerValues(raw: unknown): CareerValues {
  const base = emptyCareerValues();
  if (!raw || typeof raw !== 'object') return base;

  const obj = raw as Partial<CareerValues>;
  const selections = normalizeSelections(obj.selections);
  const notes = normalizeNotes(obj.notes);
  const overallNote =
    typeof obj.overallNote === 'string' ? obj.overallNote : '';
  const updatedAt =
    typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined;

  return { selections, notes, overallNote, updatedAt };
}

function normalizeSelections(raw: unknown): CareerValuesSelections {
  const out = emptyCareerValues().selections;
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;

  for (const key of CAREER_VALUES_CATEGORY_KEYS) {
    const value = src[key];
    if (!Array.isArray(value)) continue;
    const allowed = CAREER_VALUES_OPTION_SETS[key];
    const seen = new Set<string>();
    out[key] = value.filter(
      (v): v is string =>
        typeof v === 'string' &&
        allowed.has(v) &&
        !seen.has(v) &&
        (seen.add(v), true),
    );
  }
  return out;
}

function normalizeNotes(raw: unknown): CareerValuesNotes {
  const out = emptyCareerValues().notes;
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;

  for (const key of CAREER_VALUES_CATEGORY_KEYS) {
    const value = src[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

// localStorage から読む。未保存 / 壊れている場合は null を返す（呼び出し側で空フォームを出す）。
export function loadCareerValues(): CareerValues | null {
  const raw = safeGetStorage<unknown>(STORAGE_KEY, null);
  if (raw == null) return null;
  return normalizeCareerValues(raw);
}

// localStorage へ保存する。保存前に正規化し、updatedAt を引数で受け取った値に揃える
// （Supabase ミラーと同一タイムスタンプを共有できるよう、呼び出し側から渡す）。
export function saveCareerValues(values: CareerValues): CareerValues {
  const normalized = normalizeCareerValues(values);
  safeSetStorage(STORAGE_KEY, normalized);
  return normalized;
}

export function clearCareerValues(): void {
  safeRemoveStorage(STORAGE_KEY);
}

// 「すべて空か」を判定する（未入力保存の許可とは別に、表示・同期判断に使えるユーティリティ）。
export function isCareerValuesEmpty(values: CareerValues): boolean {
  const noSelections = CAREER_VALUES_CATEGORY_KEYS.every(
    (key: CareerValuesCategoryKey) => values.selections[key].length === 0,
  );
  const noNotes = CAREER_VALUES_CATEGORY_KEYS.every(
    (key: CareerValuesCategoryKey) => values.notes[key].trim() === '',
  );
  return noSelections && noNotes && values.overallNote.trim() === '';
}
