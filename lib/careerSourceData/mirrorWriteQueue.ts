'use client';

/**
 * PASSAI CAREER — Layer 1 mirror write の直列化キュー（hardening 2026-08-14 / `D-S3`）。
 *
 * 解決する問題（W4: delayed network response）:
 *   単一端末でも mirror write は **fire-and-forget** で発行されるため、複数の write が同時に
 *   in-flight になりうる（例: activity の debounce autosave とアンマウント flush）。
 *   ネットワーク遅延で「古い payload の request が後から到着」すると、
 *   mirror が **より古い内容へ巻き戻る**（＝mirror regression）。
 *
 *   ```text
 *   rev10 送信 ─────────────────────────▶ 到着(遅) ← mirror が rev10 になる
 *   rev11 送信 ──────▶ 到着(早)
 *   ```
 *
 * 解決方法（clock 非依存・DDL 不要・server 契約変更なし）:
 *   同一 (table, user) の write を **client 側で直列化** する。前の write が settle するまで
 *   次を発行しないため、「後から発行した write が先に適用される」ことが起きない。
 *
 * ★ なぜ timestamp 比較にしないか:
 *   client の wall-clock は端末間・端末内（時刻同期）でずれうる。順序判定の権威にしてはいけない
 *   （DATA_SPINE_DECISIONS.md §7 / `D-S3`）。直列化は時刻を一切参照せず、
 *   「発行順 == 適用順」を構造的に保証する。
 *
 * ★ 本 module が解決 **しない** こと（過大主張しない）:
 *   - 別端末からの stale write（W2 / W5）。これは client 側直列化では防げない
 *     （server 側の compare-and-set が必要。`D-S3` の DDL draft を参照）。
 *   - read 安全性。これは `D-S1` source-sync veto が独立に担保する。
 *
 * 厳守: never-throw / 純粋な調停のみ（I/O は呼び出し側の run に閉じる）/ global state は
 *   同一 tab 内のみ（cross-tab 調停は行わない＝過大主張しない）。
 */

type QueueEntry = {
  /** 現在実行中（または直近完了）の write chain。 */
  chain: Promise<void>;
  /** chain 完了後に実行する最新 run（superseded な run は捨てる）。 */
  pending: (() => Promise<unknown>) | null;
  /** pending の解決を待っている呼び出し側へ返す promise の resolver。 */
  pendingResolvers: Array<() => void>;
};

const queues = new Map<string, QueueEntry>();

/** queue key。user をまたいで coalesce しないよう userId を必ず含める。 */
export function mirrorWriteKey(table: string, userId: string): string {
  return `${table}::${userId}`;
}

async function drain(key: string): Promise<void> {
  const entry = queues.get(key);
  if (!entry) return;
  while (entry.pending) {
    const run = entry.pending;
    const resolvers = entry.pendingResolvers;
    entry.pending = null;
    entry.pendingResolvers = [];
    try {
      await run();
    } catch {
      /* never-throw: mirror write は best-effort */
    }
    for (const r of resolvers) r();
  }
  queues.delete(key);
}

/**
 * 同一 key の write を直列化し、**待機中の write は最新のものだけを実行**する（coalescing）。
 *
 * ★ coalescing が安全なのは「1 回の write が全文書を送る」単一レコード系
 *   （career_profiles / career_activities / career_values）に限る。
 *   古い全文書 write は新しい全文書 write に完全に包含されるため、捨ててよい。
 *   履歴系（per-record upsert）へは使わないこと（レコードを取りこぼす）。
 *
 * 戻り値は「この write の意図が反映された時点」で解決する
 *   （superseded された場合は、それを置き換えたより新しい write の完了時）。
 */
export function enqueueLatestMirrorWrite(
  key: string,
  run: () => Promise<unknown>,
): Promise<void> {
  const existing = queues.get(key);
  if (existing) {
    // 実行中 → 待機中の run を最新で置き換える（古い全文書 write は捨てる）。
    existing.pending = run;
    return new Promise<void>((resolve) => {
      existing.pendingResolvers.push(resolve);
    });
  }
  const entry: QueueEntry = { chain: Promise.resolve(), pending: run, pendingResolvers: [] };
  queues.set(key, entry);
  const done = new Promise<void>((resolve) => {
    entry.pendingResolvers.push(resolve);
  });
  entry.chain = drain(key);
  return done;
}

/** テスト用: キューを空にする（production code からは呼ばない）。 */
export function __resetMirrorWriteQueueForTest(): void {
  queues.clear();
}
