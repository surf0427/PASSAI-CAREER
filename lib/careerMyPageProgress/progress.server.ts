// PASSAI CAREER — マイページ進度の server aggregation（auth-scoped）。
//
//   auth session（cookie）
//        ↓ loadCareerSourceData（既存の Layer 1 server reader）
//   career_self_analysis_results / career_es_logs /
//   career_interview_results / career_presentation_results  ← 4 table を 1 回ずつ read
//        ↓ buildCareerMyPageProgress（client fallback と同じ純関数）
//   CareerMyPageProgress
//
// 厳守（既存の安全境界をそのまま踏襲する）:
//   - server-only。user ID は **必ず** server auth（auth.getUser）由来。
//     URL / request body / localStorage の userId を受け取らない・信用しない。
//   - RLS（auth.uid() = user_id）が最終権威。service role を使わない。
//   - 新しい table・新しい RLS ポリシー・新しい mirror を作らない（read only）。
//   - never-throw（表示用の付加情報であり、失敗してもマイページ本体を落とさない）。
//
// 注（§20 payload）: 既存 reader の select 列は Layer 1 共有のため transcript / turns も
//   含まれるが、それらは **server から出ない**。client へ返すのは下の compact な
//   CareerMyPageProgress（id / score / 軸 / 時刻）だけで、本文・AI 全文は一切含まれない。
//   グラフ専用の軽量 reader を別に作ると auth / RLS / timeout の実装が二重化するため、
//   検証済みの既存 reader を再利用する側を選んでいる。

import 'server-only';

import { loadCareerSourceData } from '@/lib/careerSourceData/serverReader.server';
import type { CareerSourceKind } from '@/lib/careerSourceData/types';
import { buildCareerMyPageProgress } from './progress';
import type { CareerMyPageProgress } from './types';

/** マイページ進度に必要な Source kind だけを読む（他 Source へ I/O しない）。 */
const MYPAGE_PROGRESS_KINDS: readonly CareerSourceKind[] = [
  'self_analysis',
  'es',
  'interview',
  'presentation',
];

export type CareerMyPageProgressOutcome =
  | { available: true; progress: CareerMyPageProgress }
  /**
   * 進度を server から確定できなかった。
   *   unauthenticated … 未ログイン（＝この端末の canonical を使う）
   *   unavailable     … env 未設定 / read 失敗 / soft timeout（同上）
   * どちらも「データが無い」ではないため、client は 0 件と断定してはいけない。
   */
  | { available: false; reason: 'unauthenticated' | 'unavailable' };

/**
 * ログイン中ユーザー自身の進度を返す（他ユーザーの結果は構造上取得できない）。
 * 引数を取らないのは意図的: userId を **呼び出し側から渡せないようにする**ため。
 */
export async function getCareerMyPageProgress(): Promise<CareerMyPageProgressOutcome> {
  const { bundle, meta } = await loadCareerSourceData(MYPAGE_PROGRESS_KINDS);

  if (meta.outcome === 'unauthenticated') return { available: false, reason: 'unauthenticated' };
  if (meta.outcome !== 'ok') return { available: false, reason: 'unavailable' };

  // 1 つでも read 失敗があれば「0 件」と誤表示しかねないため、部分データを採用しない。
  for (const kind of MYPAGE_PROGRESS_KINDS) {
    if (meta.statuses[kind] === 'error') return { available: false, reason: 'unavailable' };
  }

  return { available: true, progress: buildCareerMyPageProgress(bundle) };
}
