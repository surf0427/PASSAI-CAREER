'use client';

/**
 * L2 Event Signal の load composition helper（P10-D consultation pilot）。
 *
 *   career_user_events
 *     → readCareerEventSignalSourceRows（owner-scoped 4列 reader・P10-C）
 *     → buildCareerEventSignalSummary（pure builder・P10-B）
 *     → CareerEventSignalSummary
 *
 * 責務: reader と builder を **薄く結合するだけ**（再実装しない）。同じ now を両方へ渡す。
 *   consultation 送信時にのみ member で呼ばれる想定。Signal は完全に supplemental。
 *
 * 契約:
 *   - reader undefined（guest / userId 不正 / env / DB error）→ undefined
 *   - reader []（0件）→ builder null → undefined
 *   - reader rows → builder summary → summary（builder が null なら undefined）
 *   - soft timeout（既定 1000ms・外部から変更不可）超過 → undefined
 *   - 例外 → undefined（never throw）
 *   - userId / Event rows / Signal JSON を log しない。raw text を扱わない。
 */

import { devWarn } from '@/lib/devLog';
import {
  readCareerEventSignalSourceRows,
  type CareerEventSignalRowsAdapter,
} from '@/lib/careerEvents/readSignals';
import {
  buildCareerEventSignalSummary,
  type CareerEventSignalSummary,
} from '@/lib/careerMemory/eventSignals';

// Signal 取得が相談開始を長時間ブロックしないための soft timeout（固定・request body から変更不可）。
const SIGNAL_SOFT_TIMEOUT_MS = 1000;

/**
 * member の直近 Signal を取得する（never throw / 失敗・0件・timeout は undefined）。
 * @param now reader と builder で共有する現在時刻（epoch ms または Date）。
 */
export async function loadCareerEventSignalSummary(
  input: {
    userId: string | null | undefined;
    now: number | Date;
  },
  // QA 用の reader adapter 注入 seam（本番呼び出しは 1 引数で既定 reader を使う）。
  readerAdapter?: CareerEventSignalRowsAdapter,
): Promise<CareerEventSignalSummary | undefined> {
  try {
    const nowMs = input.now instanceof Date ? input.now.getTime() : input.now;

    const work = (async (): Promise<CareerEventSignalSummary | undefined> => {
      const rows = await readCareerEventSignalSourceRows({ userId: input.userId, now: nowMs }, readerAdapter);
      if (rows === undefined) return undefined; // reader 利用不可
      const summary = buildCareerEventSignalSummary({ events: rows, now: nowMs });
      return summary ?? undefined; // 0件 / 有効なし → null → undefined
    })();

    // soft timeout: 超過しても相談を止めず undefined を返す（work は放置・結果は捨てる）。
    const timeout = new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), SIGNAL_SOFT_TIMEOUT_MS);
    });

    return await Promise.race([work, timeout]);
  } catch {
    devWarn('[eventSignals] load skipped'); // userId / rows / summary は出さない
    return undefined;
  }
}
