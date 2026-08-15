// 自己分析まとめ生成 — completed result の finalize（保存）共有関数（Step3）。
//
// legacy 同期経路と job controller の両方が **同一の保存処理** を使い、重複させない。
// localStorage（key='careerSelfAnalysisLogs'）が canonical。member は best-effort mirror + event。
// navigation は呼び出し側（controller.navigate / legacy）で行う。
//
// 返り値: 保存したログ id（localStorage 保存に失敗したら null）。
//   ★ 「過去の結果を更新する」では **既存ログを書き換えず新しい revision を追記** する。
//     過去 revision は 1 件も削除・上書きされない（lib/careerSelfAnalysis/revisionLineage.ts）。
//     追記なので createdAt が最新になり、Data Spine / downstream の
//     「最新 = 先頭 / createdAt 降順」ロジックはそのままで最新版へ切り替わる。

import { appendSelfAnalysisLog, loadSelfAnalysisLogs } from './selfAnalysisStorage';
import { upsertCareerSelfAnalysisResultsToSupabase } from '@/lib/supabase/careerSelfAnalysis';
import { shadowWriteSelfAnalysisMemory } from '@/app/career/personalMemoryShadowWrite';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import {
  buildSelfAnalysisRevisionId,
  nextSelfAnalysisRevision,
} from '@/lib/careerSelfAnalysis/revisionLineage';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `csa-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** 更新（revision 追記）保存の指定。未指定なら新規 lineage として保存する。 */
export interface SaveRevisionTarget {
  /** 更新対象 lineage の起点ログ id。 */
  rootId: string;
  /** ユーザーが入力した「追加したいこと・修正したいこと」。 */
  note: string;
}

export interface SaveCompletedArgs {
  result: CareerSelfAnalysisResult;
  userId: string | null;
  turnCount: number;
  revision?: SaveRevisionTarget | null;
}

/**
 * completed 結果を保存する（canonical localStorage + member best-effort mirror/event）。
 * 保存したログ id を返す（失敗時 null）。
 */
export function saveCompletedSelfAnalysis(args: SaveCompletedArgs): string | null {
  try {
    // revision 番号は「保存直前の canonical」から採番する（別タブでの追記と衝突しにくい）。
    const revisionNumber = args.revision
      ? nextSelfAnalysisRevision(loadSelfAnalysisLogs(), args.revision.rootId)
      : 0;
    const log = {
      id: args.revision
        ? buildSelfAnalysisRevisionId(args.revision.rootId, revisionNumber)
        : newId(),
      createdAt: new Date().toISOString(),
      userInput: args.revision?.note ?? '',
      result: args.result,
    };
    appendSelfAnalysisLog(log);
    if (args.userId) {
      // best-effort（never throw / prompt 非利用）。保存成否には影響させない。
      // ★ natural key=(user_id, client_id) で client_id は revision ごとに異なるため、
      //   これは **新しい行の insert** であり、親 revision の行は書き換わらない。
      void upsertCareerSelfAnalysisResultsToSupabase(args.userId, [log]);
      void shadowWriteSelfAnalysisMemory();
      // 本文なし・fire-and-forget。深掘り回数のみ turnCount で記録。
      void recordCareerEvent(args.userId, {
        feature: 'self_analysis',
        eventType: 'ai_generated',
        completionStatus: 'completed',
        clientEventId: log.id,
        metadata: args.revision
          ? { turnCount: args.turnCount, revisionCount: revisionNumber }
          : { turnCount: args.turnCount },
      });
    }
    return log.id;
  } catch {
    return null;
  }
}
