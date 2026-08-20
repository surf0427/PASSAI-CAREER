// PASSAI CAREER — Career AI route 共有: Layer 2 Personal Memory の解決（single seam）。
//
// 背景:
//   Personal Memory を prompt へ載せる route が増えるにつれ、
//   「sync signal を読む → loader を呼ぶ → 観測を打つ → bridge と dedupe する」
//   という同じ 4 手順が route ごとにコピーされていた（interview / company-research）。
//   本 module はその 4 手順を 1 箇所へ集約し、新しい route が同じ安全契約を
//   **書き写さずに** 満たせるようにする。新しい framework は作らない
//   （既存の loader / renderer / dedupe / observation をそのまま合成するだけ）。
//
// 経路:
//   route
//     → readSourceSyncSignal(req)                  … client canonical revision の申告（veto 専用）
//     → loadPersonalMemorySectionsForPrompt(...)   … gate / owner-scoped read / stale veto / rebuild
//     → recordCanaryObservation(...)               … enum のみの PII フリー観測
//     → dedupePersonalMemorySections(..., presence) … bridge wins / memory fills gaps
//     → orchestrator extras.personalMemory
//     → renderPersonalMemoryForPurpose             … purpose filter + injection 境界 + budget
//     → final prompt
//
// 厳守:
//   - **never-throw / fail-open**。どんな失敗でも空配列を返し、AI 本体を止めない。
//     Layer 2 は optional enhancement であって availability dependency ではない。
//   - userId を引数で受け取らない（route が申告した id を信用しない）。owner scope は
//     loader 内部の server auth + RLS が唯一の権威。
//   - req を渡すことで `D-S13` の request-local Layer 1 snapshot を共有する（重複 read しない）。
//   - Memory 本文 / PII / UUID を log しない（本 module は console を持たない）。
//   - presence は「body に field がある」ではなく **「その bridge block を実際に描画するか」** で
//     判定した値を呼び出し側が渡すこと（renderer の出力が空でないか）。

import 'server-only';

import type { CareerContextPurpose } from '@/lib/careerContext/purpose';
import type { CareerPersonalMemorySection } from '@/lib/careerMemory/persistence/schema';
import { loadPersonalMemorySectionsForPrompt } from '@/lib/careerMemory/persistence/personalMemoryReadServer.server';
import {
  dedupePersonalMemorySections,
  type BridgeContextPresence,
} from '@/lib/careerMemory/personalMemoryDedupe';
import { readSourceSyncSignal } from '@/lib/careerSourceSync/request.server';
import { EMPTY_SOURCE_SYNC_SIGNAL } from '@/lib/careerSourceSync/signal';
import { recordCanaryObservation } from '@/lib/careerDataSpineCanary/counters.server';
import {
  normalizeMemoryOutcome,
  normalizeSyncOutcome,
  type CanaryContextOutcome,
} from '@/lib/careerDataSpineCanary/observation';

export type ResolvePersonalMemoryParams = {
  /** Layer 2 を載せる purpose（renderer の allowlist と一致すること）。 */
  purpose: CareerContextPurpose;
  /**
   * 「その section に相当する bridge block を実際に prompt へ描画するか」。
   * true の section は memory を落とす（bridge wins / memory fills gaps）。
   */
  presence: BridgeContextPresence;
  /** 元 request（sync signal と request-local Layer 1 snapshot の共有に使う）。 */
  req?: Request;
  /**
   * 観測に載せる context outcome。
   * ★ 同じ request で context resolver が既に 1 件打っている route は `null` を渡す
   *   （purpose あたりの counter を二重計上しない）。
   */
  contextOutcome?: CanaryContextOutcome | null;
  /**
   * policy 上この呼び出しで Layer 2 を使わないとき false を渡す
   * （例: presentation の useCareerContext=false）。**I/O ゼロで空配列を返す**。
   */
  enabled?: boolean;
  /** DI（QA が fake を注入する）。 */
  loadSections?: typeof loadPersonalMemorySectionsForPrompt;
};

/**
 * purpose 別に prompt へ載せてよい Personal Memory section を返す（never-throw・fail-open）。
 *
 * 返り値が空配列なら `renderPersonalMemoryForPurpose` は '' を返すため、
 * prompt は Layer 2 導入前と byte 互換になる。
 */
export async function resolvePersonalMemoryForPurpose(
  params: ResolvePersonalMemoryParams,
): Promise<readonly CareerPersonalMemorySection[]> {
  const {
    purpose,
    presence,
    req,
    contextOutcome = null,
    enabled = true,
    loadSections = loadPersonalMemorySectionsForPrompt,
  } = params;
  try {
    // policy で OFF の呼び出しは I/O を一切行わない（gate 前の early-out）。
    if (!enabled) return [];

    // req が無い（QA / 直接呼び出し）なら claim なし ＝ 全 section veto（安全側の既定）。
    const syncSignal = req ? readSourceSyncSignal(req) : EMPTY_SOURCE_SYNC_SIGNAL;
    const outcome = await loadSections(purpose, syncSignal, undefined, req);

    recordCanaryObservation({
      purpose,
      sync: normalizeSyncOutcome(outcome.meta, Object.keys(syncSignal.revisions).length > 0),
      memory: normalizeMemoryOutcome(outcome.meta),
      context: contextOutcome,
      memorySectionCount: outcome.meta.sectionCount,
    });

    return dedupePersonalMemorySections(outcome.sections, presence).sections;
  } catch {
    // Memory の不調で AI route を止めない（Memory 無し＝従来 prompt）。
    return [];
  }
}
