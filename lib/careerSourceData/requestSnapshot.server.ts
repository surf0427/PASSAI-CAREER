// PASSAI CAREER — request-local Layer 1 snapshot（Closure Batch / `D-S13`）。
//
// 問題（Closure Batch の監査で実測した欠陥）:
//   `company_research_review` は 1 request で Layer 1 を **2 回**読んでいた。
//     1. Server Context resolver  → profile / activity / values / self_analysis / matching
//     2. Personal Memory resolver → base / self_analysis …（同じ table を再度 select）
//   同じ table を 2 回叩くだけでなく、2 回の read の間に write が入ると
//   **request 内で異なる snapshot** を見てしまう（cross-source skew）。
//
// 解決:
//   `Request` object を key にした WeakMap で、その request 中に読んだ kind を保持する。
//   2 番目の consumer は **不足している kind だけ**を読み、既読 kind は同じ値を再利用する。
//
// ★ 安全性のために崩さないもの:
//   - **authorize は毎回評価する**。cache hit でも `authorize(userId)` を通してから返す。
//     したがって「非 canary user に新しい table read が発生しない」も
//     「非 canary user が cache 経由でデータを受け取る」も、どちらも起こらない。
//   - userId は server auth 由来のみ。cache は request 単位で、request 間で共有されない
//     （WeakMap の key が Request instance なので、GC もされる）。
//   - never-throw。cache 機構が壊れても通常 read へ落ちる。
//   - PII / 識別子を log しない。
//
// ★ snapshot 意味論（過大主張しない）:
//   これは **単一 transaction snapshot ではない**。保証するのは
//   「1 request 内で同じ kind を 2 回読まない」＝ **read-once per kind per request** だけ。
//   異なる kind は別 select であり、その間の write は依然として観測されうる。
//   詳細は DATA_SPINE_ARCHITECTURE.md「Cross-source snapshot semantics」を参照。

import 'server-only';

import { loadCareerSourceData, type CareerSourceAuthorize } from './serverReader.server';
import {
  EMPTY_CAREER_SOURCE_BUNDLE,
  emptySourceStatuses,
  type CareerSourceBundle,
  type CareerSourceKind,
  type CareerSourceReadOutcome,
  type CareerSourceReadStatus,
} from './types';

type SnapshotEntry = {
  /** 既に read 済みの kind。 */
  loaded: Set<CareerSourceKind>;
  bundle: CareerSourceBundle;
  statuses: Record<CareerSourceKind, CareerSourceReadStatus>;
  /** server auth 由来の userId（authorize 再評価に使う。log には出さない）。 */
  userId: string | null;
  /** 直近 read の総合 outcome（unauthenticated 等を引き継ぐため）。 */
  lastOutcome: CareerSourceReadOutcome['meta']['outcome'];
};

const cache = new WeakMap<Request, SnapshotEntry>();

/** bundle の kind 別 field をコピーする（read した kind だけ上書き）。 */
function mergeBundle(
  target: CareerSourceBundle,
  src: CareerSourceBundle,
  kinds: readonly CareerSourceKind[],
): void {
  for (const k of kinds) {
    switch (k) {
      case 'profile': target.profile = src.profile; break;
      case 'activity': target.activity = src.activity; break;
      case 'values': target.values = src.values; break;
      case 'self_analysis': target.selfAnalysisLogs = src.selfAnalysisLogs; break;
      case 'es': target.esLogs = src.esLogs; break;
      case 'interview': target.interviewResults = src.interviewResults; break;
      case 'matching': target.matchingLogs = src.matchingLogs; break;
      case 'company_research': target.companyResearchLogs = src.companyResearchLogs; break;
      case 'presentation': target.presentationResults = src.presentationResults; break;
      case 'consultation': target.consultationThreads = src.consultationThreads; break;
      case 'gd_room': target.gdRoomLogs = src.gdRoomLogs; break;
    }
  }
}

/** 要求 kind に限定した bundle（未要求 kind は空のまま返す）。 */
function projectBundle(
  entry: SnapshotEntry,
  kinds: readonly CareerSourceKind[],
): CareerSourceBundle {
  const out: CareerSourceBundle = { ...EMPTY_CAREER_SOURCE_BUNDLE };
  mergeBundle(out, entry.bundle, kinds);
  return out;
}

function projectStatuses(
  entry: SnapshotEntry,
  kinds: readonly CareerSourceKind[],
): Record<CareerSourceKind, CareerSourceReadStatus> {
  const out = emptySourceStatuses();
  for (const k of kinds) out[k] = entry.statuses[k];
  return out;
}

/**
 * request 内で Layer 1 を **kind あたり 1 回だけ**読む（never-throw）。
 *
 * `req` が無い場合（背景 job など Request を持たない経路）は cache せず通常 read。
 */
export async function loadRequestSourceSnapshot(
  kinds: readonly CareerSourceKind[],
  req: Request | undefined,
  authorize?: CareerSourceAuthorize,
  load: typeof loadCareerSourceData = loadCareerSourceData,
): Promise<CareerSourceReadOutcome> {
  if (!req) return load(kinds, undefined, authorize);
  try {
    const entry = cache.get(req);

    // reader は authorize hook へ **server auth 由来の userId** を渡す。
    // これを捕捉して cache に持ち、後続 consumer の authorize 再評価に使う
    // （userId は entry 内に留め、log にも meta にも出さない）。
    let capturedUserId: string | null = null;
    const capture: CareerSourceAuthorize = (userId) => {
      capturedUserId = userId;
      return authorize ? authorize(userId) : true;
    };

    // 初回: そのまま読んで cache する。
    if (!entry) {
      const outcome = await load(kinds, undefined, capture);
      // 認証・認可で弾かれた read は cache しない（後続 consumer の gate を汚さない）。
      if (outcome.meta.outcome === 'ok' || outcome.meta.outcome === 'error') {
        const fresh: SnapshotEntry = {
          loaded: new Set(kinds),
          bundle: { ...EMPTY_CAREER_SOURCE_BUNDLE },
          statuses: emptySourceStatuses(),
          userId: capturedUserId,
          lastOutcome: outcome.meta.outcome,
        };
        mergeBundle(fresh.bundle, outcome.bundle, kinds);
        for (const k of kinds) fresh.statuses[k] = outcome.meta.statuses[k];
        cache.set(req, fresh);
      }
      return outcome;
    }

    // ★ cache hit でも authorize は必ず再評価する。
    //   ここを飛ばすと「別 consumer の緩い gate で読まれた結果を、厳しい gate の
    //   consumer が受け取る」経路ができてしまう。
    if (authorize) {
      // userId を捕捉できていない entry は cache から返さない（fail-closed）。
      if (entry.userId === null) return load(kinds, undefined, capture);
      if (!authorize(entry.userId)) {
        return {
          bundle: EMPTY_CAREER_SOURCE_BUNDLE,
          meta: { outcome: 'unauthorized', statuses: emptySourceStatuses(), durationMs: null },
        };
      }
    }

    const missing = kinds.filter((k) => !entry.loaded.has(k));
    if (missing.length > 0) {
      const outcome = await load(missing, undefined, capture);
      if (outcome.meta.outcome === 'unauthorized' || outcome.meta.outcome === 'unauthenticated') {
        return outcome;
      }
      mergeBundle(entry.bundle, outcome.bundle, missing);
      for (const k of missing) entry.statuses[k] = outcome.meta.statuses[k];
      for (const k of missing) entry.loaded.add(k);
      if (outcome.meta.outcome === 'error') entry.lastOutcome = 'error';
    }

    const anyError = kinds.some((k) => entry.statuses[k] === 'error');
    return {
      bundle: projectBundle(entry, kinds),
      meta: {
        outcome: anyError ? 'error' : 'ok',
        statuses: projectStatuses(entry, kinds),
        // cache hit 分の所要時間は測れないため null（誤った速度主張をしない）。
        durationMs: null,
      },
    };
  } catch {
    // cache 機構の失敗は通常 read へ落とす（機能を壊さない）。
    return load(kinds, undefined, authorize);
  }
}

/** テスト用: request の snapshot を捨てる。 */
export function clearRequestSourceSnapshot(req: Request): void {
  cache.delete(req);
}

/** テスト用: その request で既に読まれた kind（観測用・PII なし）。 */
export function loadedKindsForRequest(req: Request): CareerSourceKind[] {
  return [...(cache.get(req)?.loaded ?? [])];
}
