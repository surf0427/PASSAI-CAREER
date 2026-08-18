// PASSAI CAREER — GD route 共有: User Data Spine context の解決（STEP-GD-31・server-only）。
//
// 既存の es-review / interview / presentation の resolver と **同型**。GD 専用の
// 第 2 Data Spine は作らない（canonical は lib/careerServerContext/purposeContext.server）。
//
// ★ GD が他機能と決定的に違う点:
//   ES / 面接 / プレゼンは「client が request body に context を積んで送る（bridge）」経路を持つ。
//   一方 **マルチ GD の評価は server 起点**（room の transcript を server が読んで採点する）で、
//   request body に本人 context を積む経路が存在しない。
//   → GD では bridge が常に空であり、**server loader が唯一の供給源**になる。
//     つまり `loadPurposeServerContext` が null を返す環境（canary 未通電など）では
//     GD は従来どおり context 無しで評価する（＝現行と完全に同じ出力・非破壊）。
//
// 厳守: never-throw / fail-open（何が起きても context 無しへ倒す）/ PII・本文・UUID を log しない。

import 'server-only';

import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import { loadPurposeServerContext } from '@/lib/careerServerContext/purposeContext.server';
import type { CareerSourceKind } from '@/lib/careerSourceData/types';
import type { BaseContextDecisionReason } from '@/lib/careerServerContext/baseContextPolicy';
import { normalizeContextOutcome } from '@/lib/careerDataSpineCanary/observation';
import { recordCanaryObservation } from '@/lib/careerDataSpineCanary/counters.server';
import {
  pickSourceOrigins,
  pickSourceVerdicts,
  toPurposeCoverage,
} from '@/lib/careerDataSpineCanary/sourceObservation';
// ログ型は各機能の types が canonical（careerSourceData は再 export しない）。
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerGdRoomLog } from '@/types/careerGd';

/**
 * gd_feedback purpose が必要とする Source kind。
 *
 *   base 3（profile / activity / values） … 助言の宛先合わせ（志望業界・職種・価値観）
 *   self_analysis                        … 本人の自己認識と GD 中の振る舞いのギャップ指摘
 *   gd_room                              … 過去 GD からの伸び / 繰り返している課題
 *
 * ★ es / interview / matching / consultation は **要求しない**。
 *   GD 評価に必要な最小集合に絞る（read コストと prompt budget の両方を守る）。
 */
export const GD_SOURCE_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
  'self_analysis',
  'gd_room',
];

export type GdContextInputs = {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  /** 直近の自己分析ログ（新しい順・renderer 側で件数を絞る）。 */
  selfAnalysisLogs: readonly CareerSelfAnalysisLog[];
  /** 過去のマルチ GD 結果（server-authoritative source）。 */
  gdRoomLogs: readonly CareerGdRoomLog[];
  /** 観測用（route 挙動には影響しない）。 */
  source: BaseContextDecisionReason;
  /** base が実際に解決できたか（QA / observability 用）。 */
  hasBase: boolean;
};

const EMPTY: GdContextInputs = {
  profile: null,
  activity: null,
  values: null,
  selfAnalysisLogs: [],
  gdRoomLogs: [],
  source: 'flag_off',
  hasBase: false,
};

/**
 * GD 用の User Data Spine context を 1 回の Layer 1 read で解決する（never-throw・fail-open）。
 *
 * server context canary が無効な環境（既定）では I/O ゼロで EMPTY を返すため、
 * prompt は従来と byte 互換になる（＝ Spine 未通電環境で GD の出力が変わらない）。
 *
 * @param req    server auth を解決するための Request（route から素通しする）
 * @param loadContext DI（QA から差し替えるための seam。既定は実 loader）
 */
export async function resolveGdContextInputs(
  req?: Request,
  loadContext = loadPurposeServerContext,
): Promise<GdContextInputs> {
  try {
    const ctx = await loadContext('gd_feedback', GD_SOURCE_KINDS, req);

    // 既存 Data Spine canary と同じ観測を 1 件だけ記録する（GD 専用 counter を作らない）。
    recordCanaryObservation({
      purpose: 'gd_feedback',
      sync: null,
      memory: null,
      context: normalizeContextOutcome(ctx.baseReason),
      memorySectionCount: 0,
      sourceOrigins: pickSourceOrigins(ctx, GD_SOURCE_KINDS),
      sourceVerdicts: pickSourceVerdicts(ctx, GD_SOURCE_KINDS),
      coverage: toPurposeCoverage(ctx.status),
    });

    return {
      profile: ctx.base ? ctx.base.profile : null,
      activity: ctx.base ? ctx.base.activity : null,
      values: ctx.base ? ctx.base.values : null,
      // kind 単位で server が verified なものだけ実データが入っている（そうでなければ空配列）。
      selfAnalysisLogs: ctx.origin.self_analysis === 'server' ? ctx.sources.selfAnalysisLogs : [],
      gdRoomLogs: ctx.origin.gd_room === 'server' ? ctx.sources.gdRoomLogs : [],
      source: ctx.baseReason,
      hasBase: ctx.base !== null,
    };
  } catch {
    // loader は never-throw だが、import / 初期化の失敗でも GD 評価は止めない。
    return EMPTY;
  }
}

/** context が実質空か（prompt へ block を足すべきでないか）の判定。 */
export function isGdContextEmpty(ctx: GdContextInputs): boolean {
  return (
    !ctx.profile &&
    !ctx.activity &&
    !ctx.values &&
    ctx.selfAnalysisLogs.length === 0 &&
    ctx.gdRoomLogs.length === 0
  );
}
