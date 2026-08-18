// PASSAI 就活版 — CareerEsLog の sub-shape 正規化（純関数・I/O ゼロ）。
//
// 背景（ES Production Readiness Audit P1-A）:
//   `career_es_logs` の mirror は `body / review / groupId / version / mode / deepDive` を
//   meta へ保存しておらず、別端末から restore すると添削結果・版履歴・深掘りが失われ、
//   現行 ES が LegacyView（旧 AI 代筆ログ用の read-only 表示）へ誤降格していた。
//   これらを往復させるにあたり、**client canonical（esStorage.normalizeEsLog）と
//   mirror（rowMappers.rowToCareerEsLog）が同一形状を作る**ことが必須になる。
//
// なぜ 1 実装に寄せるか（Source Sync が壊れないため）:
//   `computeSourceSyncRevision('es', …)` は「client の localStorage 内容 == server が読んだ
//   mirror 内容」を token 比較で判定する。両者の正規化が非対称だと revision が永久に一致せず、
//   Personal Memory / server context が恒久 veto される
//   （その回帰は scripts/career-source-sync-qa.ts [1] が固定している）。
//   → deepDive のように「捨てる / 埋める」判断を伴う形は、必ず本 module を共有する。
//
// 厳守: 純関数 / deterministic / never-throw / 値を捏造しない（欠損は欠損のまま落とす）。

import { normalizeSelectedMaterials } from './materialCandidates';
import type { CareerEsLog } from '@/types/careerEs';

type CareerEsDeepDive = NonNullable<CareerEsLog['deepDive']>;
type CareerEsDeepDiveTurn = CareerEsDeepDive['turns'][number];

/** Q&A turn の防御的正規化（role / content が揃った要素だけを残す）。 */
function normalizeTurns(raw: unknown): CareerEsDeepDiveTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: CareerEsDeepDiveTurn[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const role = (t as { role?: unknown }).role;
    const content = (t as { content?: unknown }).content;
    if ((role === 'question' || role === 'answer') && typeof content === 'string') {
      out.push({ role, content });
    }
  }
  return out;
}

/**
 * `CareerEsLog.deepDive` を canonical shape へ正規化する（never-throw）。
 *
 * - object でない / null → `undefined`（＝ deepDive を持たないログ。欠損のまま残す）。
 * - `turns` は role / content が妥当な要素だけを残す。
 * - `memo` / `materials` は **存在するときだけ** field を作る（旧ログと同じ形を保つ）。
 *
 * ★ 本関数の出力形は `app/career/es/esStorage.ts` の read boundary と
 *   `lib/careerSourceData/rowMappers.ts` の mirror boundary で完全に一致する必要がある。
 */
export function normalizeCareerEsDeepDive(raw: unknown): CareerEsDeepDive | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const d = raw as Record<string, unknown>;
  const turns = normalizeTurns(d.turns);
  const memo = Array.isArray(d.memo)
    ? d.memo.filter((m): m is string => typeof m === 'string')
    : undefined;
  const materials = normalizeSelectedMaterials(d.materials);
  return {
    turns,
    ...(memo ? { memo } : {}),
    ...(materials.length > 0 ? { materials } : {}),
  };
}
