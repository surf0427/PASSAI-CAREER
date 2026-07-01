"use client";

/**
 * career_gd_room_results — マルチGD（ルームGD）結果の auth-scoped durable mirror **read**（STEP-GD-19）。
 *
 * 役割（lib/supabase/careerSelfAnalysis.ts と同形）:
 *   - localStorage（app/career/gd/gdRoomLogStorage.ts / key='careerGdRoomLogs'）が canonical。
 *     本 table はログイン済みユーザーの durable mirror。**Supabase canonical 化はしない**。
 *   - 別デバイス・別ブラウザでも履歴を見られるよう、GD履歴ページ表示時に自分の結果を取得して merge する。
 *
 * データ取得:
 *   - getBrowserSupabaseClient()（anon key + ユーザーセッション = authenticated ロール）で **RLS 経由**取得。
 *     service_role は使わない。user_id = auth.uid() の行だけが RLS で返る（deny-by-default 前提）。
 *   - ⚠ 前提: career_gd_room_results に「owner select」RLS policy（auth.uid() = user_id）が必要。
 *     未適用（deny-by-default のまま）だと 0 行が返るだけで、localStorage 表示は継続する（never throw / 破綻しない）。
 *   - select は必要列のみ（select * 禁止）。合計・ランク・企業コミュ適性・強み/改善等はすべて
 *     self_feedback(jsonb = CareerGdEvaluation) に含まれる。theme / format / 所要時間は本 table に無いため
 *     hydrate 行では既定値になる（local 行の方が richer なので merge では local を優先する）。
 *
 * never throw。失敗（未ログイン / env 未設定 / ネットワーク / RLS 拒否）時は [] を返す。
 */

import { devWarn } from "@/lib/devLog";
import { getBrowserSupabaseClient } from "./browserClient";
import { normalizeGdRoomLog } from "@/app/career/gd/gdRoomLogStorage";
import type { CareerGdRoomLog } from "@/types/careerGd";

const TABLE = "career_gd_room_results";

type ResultRow = {
  room_id: string;
  participant_id: string;
  self_feedback: unknown; // CareerGdEvaluation
  ranking: unknown; // CareerGdRankingEntry[]
  matching_hints: unknown; // { hints, summary }
  overall_summary: string; // generateCareerGdSummary の圧縮サマリー
  created_at: string;
};

// 結果行 → 部分 CareerGdRoomLog（theme/format/所要時間は不明なので既定値。normalize で防御）。
function rowToLog(row: ResultRow): CareerGdRoomLog | null {
  const rankingLen = Array.isArray(row.ranking) ? row.ranking.length : 0;
  return normalizeGdRoomLog({
    id: row.room_id,
    roomId: row.room_id,
    participantId: row.participant_id,
    createdAt: row.created_at,
    theme: {}, // 本 table に無い → 表示は「グループディスカッション」にフォールバック
    format: "free",
    participantCount: rankingLen, // ranking（採点済み人数）を近似値に
    humanCount: rankingLen,
    durationSec: 0, // 不明 → 「—」表示
    evaluation: row.self_feedback,
    ranking: row.ranking,
    matchingHints: row.matching_hints,
    consultationSummary: row.overall_summary,
  });
}

/** 自分のマルチGD結果を created_at 降順で返す（never throw / 失敗時は []）。 */
export async function listCareerGdRoomResultsFromSupabase(
  userId: string,
): Promise<CareerGdRoomLog[]> {
  if (!userId) return [];
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("room_id, participant_id, self_feedback, ranking, matching_hints, overall_summary, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      devWarn("[careerGdRoomResults] list error", error);
      return [];
    }
    return ((data ?? []) as ResultRow[])
      .map(rowToLog)
      .filter((l): l is CareerGdRoomLog => l !== null);
  } catch (err) {
    devWarn("[careerGdRoomResults] list threw", err);
    return [];
  }
}
