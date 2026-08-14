// PASSAI CAREER — request から source-sync signal を取り出す server helper（D-R2 closure）。
//
// 責務: route handler の `Request` から `x-career-source-sync` header を読み、
//   検証済み signal（純粋 parser 経由）を返すだけ。
//
// 厳守:
//   - header 以外（body / query / cookie）から signal を受け取らない（攻撃面を 1 箇所へ固定）。
//   - parse は純関数 parseSourceSyncSignal に委譲（default deny をここで再実装しない）。
//   - never-throw。取得できなければ空 signal（＝全 kind veto ＝安全側）。
//   - 値を log しない（revision token は PII ではないが、観測は verdict 側で行う）。

import 'server-only';

import {
  CAREER_SOURCE_SYNC_HEADER,
  EMPTY_SOURCE_SYNC_SIGNAL,
  parseSourceSyncSignal,
  type CareerSourceSyncSignal,
} from './signal';

/** route handler の Request から signal を取り出す（never-throw・default deny）。 */
export function readSourceSyncSignal(req: Request): CareerSourceSyncSignal {
  try {
    return parseSourceSyncSignal(req.headers.get(CAREER_SOURCE_SYNC_HEADER));
  } catch {
    return EMPTY_SOURCE_SYNC_SIGNAL;
  }
}
