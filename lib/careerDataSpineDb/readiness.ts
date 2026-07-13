/**
 * Data Spine DB boundary — never-throw / hard-fail 境界の明示（P17-C §3）。
 *
 * read 系は never-throw（typed error union へ倒す）。
 * 設定不備（port 未注入等）は「呼び出し側の bug」であり hard-fail してよい範囲を明示する。
 * pure。DB へ接続しない。
 */

import type { DataSpineReadPort, DataSpineWritePort } from './types';

/** read port が注入されているか（未注入は呼び出し側 bug → hard-fail 対象）。 */
export function assertReadPort(port: DataSpineReadPort | null | undefined): DataSpineReadPort {
  if (!port || typeof port.select !== 'function') {
    throw new Error('DataSpineReadPort not injected (caller misconfiguration)');
  }
  return port;
}

/** write port が注入されているか（未注入は hard-fail）。 */
export function assertWritePort(port: DataSpineWritePort | null | undefined): DataSpineWritePort {
  if (!port || typeof port.insert !== 'function' || typeof port.update !== 'function') {
    throw new Error('DataSpineWritePort not injected (caller misconfiguration)');
  }
  return port;
}

/**
 * never-throw 境界の宣言:
 *   - repository の read（select）由来の失敗は DataSpineDbError へ写像し throw しない。
 *   - domain 側は DataSpineDbError を ContextSourceResult の非 available へ写像する（fail-closed）。
 *   - port 未注入 / プログラミングエラーのみ hard-fail（上記 assert）。
 */
export const NEVER_THROW_ON_READ = true as const;
