/**
 * Contribution bounding — heavy user / duplicate / retry を潰し user-level boolean 化（P14-B / P14-A Contribution）。
 *
 * 契約（first insight）:
 *   1 user x 1 time bucket x 1 feature = 1 boolean contribution。
 *   - 同一 user の同一 (month, feature) は最大 1。利用回数は寄与に反映しない。
 *   - duplicate / retry（同一 __dedupEventKey）を二重計上しない。
 *   - event count を user count へ変換しない（unique-user のみ）。
 *   - heavy user が cohort を支配しない（100 event -> boolean 1）。
 *   - sequence metric は扱わない（今回未実装）。
 *
 * pure function。DB / reader 非依存。dedup 鍵は JSON.stringify([...]) で構成し、区切り文字の
 * 曖昧さ（userKey に区切り文字が含まれる等）を避ける。
 */

import type { BoundedContribution, InternalProjectedContribution } from '@/types/careerAggregate';

/**
 * projected contribution 群を bounded な user-level boolean 集合へ変換する（pure）。
 *
 * 手順:
 *   1. duplicate / retry 除去: 同一 __dedupUserKey 内で同一 __dedupEventKey（非 null）は 1 件のみ。
 *   2. user-level boolean: 同一 (__dedupUserKey, monthBucket, feature) を 1 contribution へ畳む。
 *
 * 入力配列は mutation しない。出力順は (userKey, monthBucket, feature) の辞書順で決定論。
 */
export function boundContributions(
  projected: readonly InternalProjectedContribution[],
): BoundedContribution[] {
  if (!Array.isArray(projected) || projected.length === 0) return [];

  // 1. duplicate / retry 除去（同一 user x 同一 eventKey は 1 回）。
  const seenEventKeyByUser = new Map<string, Set<string>>();
  const deduped: InternalProjectedContribution[] = [];
  for (const c of projected) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.__dedupUserKey !== 'string' || c.__dedupUserKey === '') continue;
    if (c.__dedupEventKey !== null && c.__dedupEventKey !== undefined) {
      let set = seenEventKeyByUser.get(c.__dedupUserKey);
      if (!set) {
        set = new Set<string>();
        seenEventKeyByUser.set(c.__dedupUserKey, set);
      }
      if (set.has(c.__dedupEventKey)) continue; // retry / duplicate -> skip
      set.add(c.__dedupEventKey);
    }
    deduped.push(c);
  }

  // 2. user-level boolean（同一 user x month x feature は 1）。
  const uniqueTuples = new Map<string, BoundedContribution>();
  for (const c of deduped) {
    const key = JSON.stringify([c.__dedupUserKey, c.monthBucket, c.feature]);
    if (!uniqueTuples.has(key)) {
      uniqueTuples.set(key, {
        __dedupUserKey: c.__dedupUserKey,
        monthBucket: c.monthBucket,
        feature: c.feature,
      });
    }
  }

  const out = Array.from(uniqueTuples.values());
  // 決定論的順序（入力順・Map 反復順に依存しない）。
  out.sort((a, b) => {
    if (a.__dedupUserKey !== b.__dedupUserKey) return a.__dedupUserKey < b.__dedupUserKey ? -1 : 1;
    if (a.monthBucket !== b.monthBucket) return a.monthBucket < b.monthBucket ? -1 : 1;
    return a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0;
  });
  return out;
}

/**
 * bounded contribution から (monthBucket, feature) セルの unique-user 数を数える（pure）。
 * event 数ではなく user 数。
 */
export function countUniqueUsersForFeature(
  bounded: readonly BoundedContribution[],
  feature: string,
  monthBucket: string,
): number {
  const users = new Set<string>();
  for (const b of bounded) {
    if (b.feature === feature && b.monthBucket === monthBucket) users.add(b.__dedupUserKey);
  }
  return users.size;
}

/**
 * bounded contribution から month セルに現れる eligible unique-user 総数（denominator 基礎）。
 * = 何らかの許可 event を持つ eligible unique user 数（active eligible population）。
 * 注: 真の母集団（cohort 全 eligible user）ではなく「観測された active eligible」。母集団定義は
 *     P14-C / 法務での確定事項。
 */
export function countUniqueUsersInMonth(
  bounded: readonly BoundedContribution[],
  monthBucket: string,
): number {
  const users = new Set<string>();
  for (const b of bounded) {
    if (b.monthBucket === monthBucket) users.add(b.__dedupUserKey);
  }
  return users.size;
}
