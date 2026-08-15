// PASSAI 就活版 — 自己分析の revision lineage（履歴を壊さない「更新」）。
//
// 目的:
//   「過去の結果を更新する」は既存ログの上書きではなく **新しいログの追記** で表現する。
//   これにより過去 revision は 1 件も失われず、同時に Data Spine / downstream の
//   「最新 = createdAt 降順の先頭」というロジックを **一切変えずに** 最新版が切り替わる。
//
// lineage の表現（schema 変更ゼロ）:
//   revision 1 … `<rootId>`           新規自己分析。従来どおり uuid（既存データもこれ）。
//   revision N … `<rootId>::r<N>`     N>=2。更新のたびに追記される。
//
//   ★ なぜ log id に埋めるか
//     lineage は client（localStorage canonical）と server（Layer 1 mirror read）の
//     **両方で同じ値が復元できる**必要がある。両者は同じ pure 関数
//     （buildSelfAnalysisPastSummaries 等）を通り、出力が byte 一致であることが
//     Data Spine の移行安全性の前提になっているため（DATA_SPINE_ARCHITECTURE Batch 2）。
//     career_self_analysis_results を往復するのは client_id / created_at / user_input /
//     result の 4 つだけ。そのうち「1 レコードを一意に指す」意味を持つのは client_id
//     （= CareerSelfAnalysisLog.id）なので、ここへ lineage を載せると
//     DDL・rowMapper・Source-Sync view のいずれも変更せずに往復する。
//   ★ 備考（ユーザーが入力した「追加・修正したいこと」）は userInput に入る
//     （user_input 列を往復する。既存の用途「実行時にユーザーが添えた補足」と同義）。
//   ★ 更新前の結果は parent revision のログとしてそのまま残る（= 履歴）。
//
// 純関数のみ。DOM / localStorage / API / DB には触れない。

import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

/** revision id の区切り。uuid（hex + '-'）には現れないため既存 id と衝突しない。 */
export const SELF_ANALYSIS_REVISION_SEPARATOR = '::r';

export type SelfAnalysisLineage = {
  /** 系列の起点となるログ id（revision 1 の id）。 */
  rootId: string;
  /** 1 始まりの revision 番号。 */
  revision: number;
};

/**
 * ログ id から lineage を復元する。
 * 区切りが無い / 数値でない / 2 未満 の場合は「revision 1 の起点」とみなす
 * （＝既存ログはすべて revision 1 として解釈され、挙動が変わらない）。
 */
export function parseSelfAnalysisLogId(id: unknown): SelfAnalysisLineage {
  const raw = typeof id === 'string' ? id : '';
  const at = raw.lastIndexOf(SELF_ANALYSIS_REVISION_SEPARATOR);
  if (at <= 0) return { rootId: raw, revision: 1 };
  const suffix = raw.slice(at + SELF_ANALYSIS_REVISION_SEPARATOR.length);
  if (!/^[0-9]{1,6}$/.test(suffix)) return { rootId: raw, revision: 1 };
  const revision = Number(suffix);
  if (!Number.isSafeInteger(revision) || revision < 2) return { rootId: raw, revision: 1 };
  return { rootId: raw.slice(0, at), revision };
}

/** revision N（N>=2）のログ id を組み立てる。 */
export function buildSelfAnalysisRevisionId(rootId: string, revision: number): string {
  return `${rootId}${SELF_ANALYSIS_REVISION_SEPARATOR}${revision}`;
}

/** 同一 lineage の現在の最大 revision（未存在なら 0）。 */
export function latestSelfAnalysisRevision(
  logs: readonly CareerSelfAnalysisLog[] | null | undefined,
  rootId: string,
): number {
  let max = 0;
  for (const log of Array.isArray(logs) ? logs : []) {
    const parsed = parseSelfAnalysisLogId(log?.id);
    if (parsed.rootId === rootId && parsed.revision > max) max = parsed.revision;
  }
  return max;
}

/** 次に追記すべき revision 番号（起点が見つからなければ 2 から始める）。 */
export function nextSelfAnalysisRevision(
  logs: readonly CareerSelfAnalysisLog[] | null | undefined,
  rootId: string,
): number {
  return Math.max(2, latestSelfAnalysisRevision(logs, rootId) + 1);
}

/**
 * 各 lineage の **最新 revision だけ** を残す（元の並び順は保持）。
 *
 * 「1 つの自己分析を更新した結果」が、AI から見て「別々の自己分析が複数ある」ように
 * 見えるのを防ぐための正規化。過去 revision を **削除するものではなく**、
 * 派生（prompt 用サマリ / Layer 2 projection）で数えないだけ。
 *
 * ★ revision を 1 件も持たないデータ（＝これまでの全ユーザー）では入力配列を
 *   そのまま返す。既存の派生出力は byte 一致のままになる。
 */
export function collapseSelfAnalysisRevisions<T extends { id?: unknown }>(
  logs: readonly T[] | null | undefined,
): T[] {
  const list = Array.isArray(logs) ? logs : [];
  const best = new Map<string, number>();
  for (const log of list) {
    const { rootId, revision } = parseSelfAnalysisLogId(log?.id);
    const current = best.get(rootId);
    if (current === undefined || revision > current) best.set(rootId, revision);
  }
  // lineage 数 == 件数 ⟹ 重複無し（既存データの通常系）。コピーせずそのまま返す。
  if (best.size === list.length) return list as T[];

  const taken = new Set<string>();
  const out: T[] = [];
  for (const log of list) {
    const { rootId, revision } = parseSelfAnalysisLogId(log?.id);
    if (revision !== best.get(rootId)) continue;
    if (taken.has(rootId)) continue; // 同 revision が重複する異常データは先頭のみ採用
    taken.add(rootId);
    out.push(log);
  }
  return out;
}

/** 指定 lineage のログを revision 降順（最新が先頭）で返す。履歴表示に使う。 */
export function selectSelfAnalysisLineage(
  logs: readonly CareerSelfAnalysisLog[] | null | undefined,
  rootId: string,
): CareerSelfAnalysisLog[] {
  return (Array.isArray(logs) ? logs : [])
    .filter((log) => parseSelfAnalysisLogId(log?.id).rootId === rootId)
    .sort(
      (a, b) =>
        parseSelfAnalysisLogId(b?.id).revision - parseSelfAnalysisLogId(a?.id).revision,
    );
}
