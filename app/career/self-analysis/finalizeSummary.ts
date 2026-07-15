// 自己分析まとめ生成 — completed result の finalize（保存）共有関数（Step3）。
//
// legacy 同期経路と job controller の両方が **同一の保存処理** を使い、重複させない。
// localStorage（key='careerSelfAnalysisLogs'）が canonical。member は best-effort mirror + event。
// navigation は呼び出し側（controller.navigate / legacy）で行う。
//
// 返り値 boolean: localStorage 保存に成功したか（false 時に呼び出し側は pending を残す）。

import { appendSelfAnalysisLog } from './selfAnalysisStorage';
import { upsertCareerSelfAnalysisResultsToSupabase } from '@/lib/supabase/careerSelfAnalysis';
import { shadowWriteSelfAnalysisMemory } from '@/app/career/personalMemoryShadowWrite';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `csa-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export interface SaveCompletedArgs {
  result: CareerSelfAnalysisResult;
  userId: string | null;
  turnCount: number;
}

/** completed 結果を保存する（canonical localStorage + member best-effort mirror/event）。 */
export function saveCompletedSelfAnalysis(args: SaveCompletedArgs): boolean {
  try {
    const log = {
      id: newId(),
      createdAt: new Date().toISOString(),
      userInput: '',
      result: args.result,
    };
    appendSelfAnalysisLog(log);
    if (args.userId) {
      // best-effort（never throw / prompt 非利用）。保存成否には影響させない。
      void upsertCareerSelfAnalysisResultsToSupabase(args.userId, [log]);
      void shadowWriteSelfAnalysisMemory();
      // 本文なし・fire-and-forget。深掘り回数のみ turnCount で記録。
      void recordCareerEvent(args.userId, {
        feature: 'self_analysis',
        eventType: 'ai_generated',
        completionStatus: 'completed',
        clientEventId: log.id,
        metadata: { turnCount: args.turnCount },
      });
    }
    return true;
  } catch {
    return false;
  }
}
