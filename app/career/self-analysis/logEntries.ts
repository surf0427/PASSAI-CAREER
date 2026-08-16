// PASSAI 就活版 — 自己分析の「ユーザーから見える履歴単位」= 自己分析ログ。
//
// ユーザー向けモデル:
//   自己分析ログ 1 件 = 1 つの lineage。更新（revision 追記）は **件数に数えない**。
//   表示するのはその lineage の canonical/current result（= 最新 revision）のみ。
//
//   Self Analysis Log A: initial → rev2 → rev3 ← current（これ1件だけ見せる）
//   Self Analysis Log B: initial                ← current
//
// ★ 内部の revision lineage（lib/careerSelfAnalysis/revisionLineage.ts）は不変。
//   ここはその上に「表示用の 1 レイヤ」を被せるだけで、保存・削除・DB には触れない。
//   過去 revision は監査 / rollback 用にそのまま残る（collapse は削除ではない）。
//
// 純関数のみ。DOM / localStorage / API / DB には触れない。

import {
  collapseSelfAnalysisRevisions,
  parseSelfAnalysisLogId,
  selectSelfAnalysisLineage,
} from '@/lib/careerSelfAnalysis/revisionLineage';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

/** ユーザーに見せる自己分析ログ 1 件。 */
export type SelfAnalysisEntry = {
  /** 系列の起点ログ id。一覧 → 結果画面の受け渡しキーに使う。 */
  rootId: string;
  /** 現在有効な結果（= 最新 revision のログ）。 */
  current: CareerSelfAnalysisLog;
  /** 初回生成日時（revision 1 の createdAt）。 */
  createdAt: string;
  /** 最終更新日時。1 度も更新していなければ null。 */
  updatedAt: string | null;
};

/**
 * canonical なログ配列（先頭が最新）から、ユーザー向けの自己分析ログ一覧を作る。
 * 並び順は入力どおり（最新の自己分析が先頭）。
 */
export function buildSelfAnalysisEntries(
  logs: readonly CareerSelfAnalysisLog[] | null | undefined,
): SelfAnalysisEntry[] {
  const list = Array.isArray(logs) ? logs : [];
  return collapseSelfAnalysisRevisions(list).map((current) => {
    const { rootId } = parseSelfAnalysisLogId(current.id);
    const lineage = selectSelfAnalysisLineage(list, rootId);
    // lineage は revision 降順。末尾が初回（revision 1）。
    const first = lineage[lineage.length - 1] ?? current;
    return {
      rootId,
      current,
      createdAt: first.createdAt,
      updatedAt: lineage.length > 1 ? current.createdAt : null,
    };
  });
}

/** rootId で 1 件選ぶ（見つからなければ null）。 */
export function findSelfAnalysisEntry(
  entries: readonly SelfAnalysisEntry[],
  rootId: string | null | undefined,
): SelfAnalysisEntry | null {
  if (!rootId) return null;
  return entries.find((entry) => entry.rootId === rootId) ?? null;
}

/** 一覧カードで結果を見分けるための短い要約（本文は結果画面で見る）。 */
export function entrySummaryLabel(entry: SelfAnalysisEntry): string {
  const summary = entry.current?.result?.summary;
  return typeof summary === 'string' && summary.trim() !== ''
    ? summary.trim()
    : '（要約なし）';
}
