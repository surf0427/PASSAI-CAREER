'use client';

// PASSAI CAREER — Layer 1 canonical の「読み直しトリガ」だけを持つ極小 external store。
//
// ★ これは **データを持たない**。保持するのは version カウンタ 1 つだけで、
//   真実は常に Layer 1 canonical（localStorage + career_* mirror）にある。
//   マイページ専用のデータ体系を作らないという原則を守るための設計:
//     - store は値をキャッシュしない
//     - 読み出しは常に loadCanonicalSourceBundle() を叩き直す
//
// 役割:
//   1. SSR / hydration では server snapshot（-1）を返し、UI に「まだ読んでいない」を伝える。
//   2. canonical へ書き込んだ直後に notify して、購読中のマイページに再読込させる。
//      （setState を effect 内で呼ばずに済むため、react-hooks/set-state-in-effect に抵触しない。）

let version = 0;
const listeners = new Set<() => void>();

export function subscribeCanonicalSnapshot(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** client snapshot。mount 後は 0 以上。 */
export function getCanonicalSnapshotVersion(): number {
  return version;
}

/** server snapshot。**必ず負値**（＝「まだ localStorage を読んでいない」の印）。 */
export function getCanonicalSnapshotServerVersion(): number {
  return -1;
}

/** canonical を更新したあとに呼ぶ（購読中の view が読み直す）。 */
export function notifyCanonicalSnapshotChanged(): void {
  version += 1;
  for (const listener of listeners) listener();
}
