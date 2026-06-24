import type { ActivityData } from '@/types/activity';
import { safeGetStorage, safeSetStorage, safeRemoveStorage } from '@/lib/storage/safeStorage';

// 就活版（career）活動整理フォームの localStorage 保存層。
// 受験版 lib/activityStorage.ts をそのまま踏襲しつつ、保存キーのみ career 専用に分離する。
//   - 受験版キー: 'activityFormData'
//   - 就活版キー: 'careerActivityFormData'
// これにより受験版と就活版のデータが相互に混入しない（独立した土台）。
//
// 【保存先】localStorage（ブラウザを閉じても残る）
// 【用途】活動整理フォームの入力途中データを保持する（再開可能にするため）
// 【注意】AI分析へ渡す「提出済みデータ」は sessionStorage に別キーで保存される（混同しないこと）
const STORAGE_KEY = 'careerActivityFormData';

// Dedup gate — same-content re-save 抑制（受験版と同設計）。
// module-local の optimization であり canonical は localStorage。
let lastSavedJson: string | undefined;

// canonical 同一性判定。caller が「save する価値があるか」を事前判断するための純粋関数。
export function shouldUpdateActivityData(
  prev: ActivityData | null,
  next: ActivityData,
): boolean {
  if (prev === null) return true;
  return JSON.stringify(prev) !== JSON.stringify(next);
}

export function saveActivityData(data: ActivityData): void {
  const json = JSON.stringify(data);
  if (json === lastSavedJson) return;
  lastSavedJson = json;
  safeSetStorage(STORAGE_KEY, data);
}

// 旧バージョンで保存された ActivityData に新規追加カテゴリ配列が欠落していても
// 下流が落ちないよう、全カテゴリ配列が必ず存在する形に正規化する。
function normalizeActivityData(value: ActivityData): ActivityData {
  return {
    clubActivities: value.clubActivities ?? [],
    volunteerActivities: value.volunteerActivities ?? [],
    studyAbroadActivities: value.studyAbroadActivities ?? [],
    researchActivities: value.researchActivities ?? [],
    partTimeJobActivities: value.partTimeJobActivities ?? [],
    certificationActivities: value.certificationActivities ?? [],
    contestActivities: value.contestActivities ?? [],
    readingActivities: value.readingActivities ?? [],
    hobbyActivities: value.hobbyActivities ?? [],
    otherActivities: value.otherActivities ?? [],
  };
}

export function loadActivityData(): ActivityData | null {
  const raw = safeGetStorage<ActivityData | null>(STORAGE_KEY, null);
  if (raw === null) return null;
  const value = normalizeActivityData(raw);
  // ロード直後の最初の autosave が「保存済 content と同一」なら no-op になるよう cache を同期。
  lastSavedJson = JSON.stringify(value);
  return value;
}

export function clearActivityData(): void {
  // canonical を消す以上、cache も無効化する。次の save は dedup を通過する。
  lastSavedJson = undefined;
  safeRemoveStorage(STORAGE_KEY);
}
