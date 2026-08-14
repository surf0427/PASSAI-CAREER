// PASSAI CAREER — Client source-sync signal（D-R2 closure / Option A veto model）。
//
// 責務: client が「自分の canonical localStorage の Layer 1 内容」を表す revision token を
//   server へ伝えるための **wire format と検証**、および server 側の照合（veto 判定）。
//
// ★★ trust model（最重要・過大主張しないこと）★★
//
//   この signal は **client-provided consistency claim** であり、**negative safety gate** である。
//   独立した source authority でも、cryptographic proof でもない。
//
//   正確な言い方:
//     「first-party client の flow において、server は *client が申告した現在の source revision* が
//       *server から見える mirror の revision* と一致することを **検証する**。」
//     ✅ verified: client claim == server-recomputed mirror revision
//     ❌ NOT proven: その claim が本当に localStorage から生成されたこと
//        （client-provided である以上、cryptographic には証明できない）
//
//   したがって「server proved that mirror == device canonical」とは書かない。
//   保証しているのは「**申告と server 可視状態が一致しない限り使わない**」という一方向の制約。
//
//   使ってよい用途 / 使ってはいけない用途:
//   - ❌ 内容の権威にしない（この値から content を生成しない）
//   - ❌ DB selector にしない（この値で行を選ばない・絞らない）
//   - ❌ user_id / 権限の根拠にしない（owner は常に server auth + RLS）
//   - ✅ server 側データを「使わない」方向へ倒す veto 入力としてのみ使う
//
//   偽造した client に何ができるか（= 何ができないか）:
//     できる  : 自分自身の request で veto を回避し、**自分自身の** mirror 由来 Memory を使わせる。
//               これは veto 導入前の既定挙動と同一であり、新たな露出は増えない。
//               実質的には「自分で自分の stale own-data 使用を許可する」だけ。
//     できない: 他人のデータ参照 / user identity の変更 / 任意 source の選択 /
//               server 権限の拡大 / RLS 迂回 / Layer 4・5 への到達。
//               owner scoping は signal と無関係に server auth + RLS が決めるため。
//     → 偽造の被害者は攻撃者自身に限定され、cross-user の脅威にならない。
//
//   first-party client での担保:
//     revision は server と **同一の純関数**（revision.ts）で localStorage から算出され、
//     header にのみ載る。改竄には custom client が必要で、その利得は上記のとおりゼロ。
//
// wire format（bounded / 厳格 allowlist）:
//   `v1:profile=1a2b3c4d,activity=...,values=...,self_analysis=...,es=...,interview=...`
//   - 先頭は version。未知 version は **全 kind unknown**（＝veto）。
//   - kind は CAREER_SOURCE_KINDS の exact match のみ。未知 kind は無視。
//   - revision 値は `[0-9a-f]{8}` または `invalid` のみ許可（それ以外は無視＝veto）。
//   - 全長・件数に上限。超過は破棄（veto）。
//
// 純関数のみ（I/O / env / Supabase 非依存・never-throw）。

import {
  CAREER_SOURCE_KINDS,
  type CareerSourceKind,
  type CareerSourceReadStatus,
} from '@/lib/careerSourceData/types';
import { CAREER_SOURCE_SYNC_VERSION } from './revision';

/** HTTP header 名（小文字固定）。body contract を変えずに全 route へ横断適用できる。 */
export const CAREER_SOURCE_SYNC_HEADER = 'x-career-source-sync';

/** header 値の最大長（6 kind × ~25 byte + version + 余裕）。超過は破棄。 */
export const CAREER_SOURCE_SYNC_MAX_LENGTH = 512;

const REVISION_VALUE = /^([0-9a-f]{8}|invalid)$/;
const KIND_SET: ReadonlySet<string> = new Set(CAREER_SOURCE_KINDS);

/** parse 済み signal（kind → revision 文字列。未提示の kind は欠損）。 */
export type CareerSourceSyncSignal = {
  version: string;
  revisions: Readonly<Partial<Record<CareerSourceKind, string>>>;
};

export const EMPTY_SOURCE_SYNC_SIGNAL: CareerSourceSyncSignal = {
  version: '',
  revisions: {},
};

/** kind → revision map を wire 文字列へ（client 側で使う）。 */
export function serializeSourceSyncSignal(revisions: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  for (const kind of CAREER_SOURCE_KINDS) {
    const full = revisions[kind];
    if (typeof full !== 'string') continue;
    // `v1:1a2b3c4d` → `1a2b3c4d`（version は先頭に 1 回だけ載せる）。
    const value = full.startsWith(`${CAREER_SOURCE_SYNC_VERSION}:`)
      ? full.slice(CAREER_SOURCE_SYNC_VERSION.length + 1)
      : full;
    if (!REVISION_VALUE.test(value)) continue;
    parts.push(`${kind}=${value}`);
  }
  if (parts.length === 0) return '';
  return `${CAREER_SOURCE_SYNC_VERSION}:${parts.join(',')}`;
}

/**
 * header 生値 → 検証済み signal（never-throw・default deny）。
 * 未設定 / 長すぎ / 未知 version / 形式不正はすべて空 signal（＝全 kind unknown ＝veto）。
 */
export function parseSourceSyncSignal(raw: unknown): CareerSourceSyncSignal {
  if (typeof raw !== 'string') return EMPTY_SOURCE_SYNC_SIGNAL;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > CAREER_SOURCE_SYNC_MAX_LENGTH) {
    return EMPTY_SOURCE_SYNC_SIGNAL;
  }
  const sep = trimmed.indexOf(':');
  if (sep <= 0) return EMPTY_SOURCE_SYNC_SIGNAL;
  const version = trimmed.slice(0, sep);
  // 未知 version は互換性を仮定せず全 veto（schema 変更時に古い client が誤一致しない）。
  if (version !== CAREER_SOURCE_SYNC_VERSION) return EMPTY_SOURCE_SYNC_SIGNAL;

  const revisions: Partial<Record<CareerSourceKind, string>> = {};
  const entries = trimmed.slice(sep + 1).split(',');
  // 件数上限（既知 kind 数を超える入力は異常）。
  if (entries.length > CAREER_SOURCE_KINDS.length) return EMPTY_SOURCE_SYNC_SIGNAL;
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const kind = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (!KIND_SET.has(kind)) continue; // 未知 kind は無視（allowlist）
    if (!REVISION_VALUE.test(value)) continue; // 形式不正は無視（＝その kind は unknown）
    if (revisions[kind as CareerSourceKind] !== undefined) continue; // 重複は最初のみ
    revisions[kind as CareerSourceKind] = `${CAREER_SOURCE_SYNC_VERSION}:${value}`;
  }
  return { version, revisions };
}

// ── 照合（veto 判定） ──────────────────────────────────────────────

/**
 * kind ごとの同期検証結果。
 *   verified   : client 申告 revision と server 再算出 mirror revision が **一致した**
 *                （＝申告と server 可視状態に矛盾が無い。localStorage 由来であることの証明ではない）
 *   mismatch   : 一致しない（mirror が古い / 新しい / 削除未反映）→ 使ってはいけない
 *   unclaimed  : client が当該 kind の revision を提示していない → 検証不能 → 使ってはいけない
 *   unreadable : server が Source を権威的に読めなかった（error / truncated）→ 使ってはいけない
 */
export type SourceSyncVerdict = 'verified' | 'mismatch' | 'unclaimed' | 'unreadable';

/** verdict の全列挙（観測 counter の key 空間を有界にするために使う）。 */
export const SOURCE_SYNC_VERDICTS: readonly SourceSyncVerdict[] = [
  'verified', 'mismatch', 'unclaimed', 'unreadable',
];

export type SourceSyncVerification = Readonly<Record<CareerSourceKind, SourceSyncVerdict>>;

/** verified 以外はすべて「使わない」。判定を 1 箇所に閉じる。 */
export function isSourceUsable(verdict: SourceSyncVerdict): boolean {
  return verdict === 'verified';
}

/**
 * client signal・server 再算出 revision・Source read status から kind 別 verdict を導く（純関数）。
 *
 * ★ 優先順位: unreadable > unclaimed > mismatch > verified。
 *   「読めていない」ことを最優先で表面化し、検証不能を verified に落とさない。
 */
export function verifySourceSync(
  signal: CareerSourceSyncSignal,
  serverRevisions: Readonly<Partial<Record<CareerSourceKind, string>>>,
  statuses: Readonly<Record<CareerSourceKind, CareerSourceReadStatus>>,
): SourceSyncVerification {
  const out = {} as Record<CareerSourceKind, SourceSyncVerdict>;
  for (const kind of CAREER_SOURCE_KINDS) {
    const status = statuses[kind];
    if (status !== 'ok') {
      out[kind] = 'unreadable';
      continue;
    }
    const claimed = signal.revisions[kind];
    if (typeof claimed !== 'string' || claimed === '') {
      out[kind] = 'unclaimed';
      continue;
    }
    const actual = serverRevisions[kind];
    out[kind] = typeof actual === 'string' && actual !== '' && actual === claimed
      ? 'verified'
      : 'mismatch';
  }
  return out;
}

/** 指定 kind すべてが verified か（1 つでも欠ければ false ＝ veto）。 */
export function allSourcesVerified(
  verification: SourceSyncVerification,
  kinds: readonly CareerSourceKind[],
): boolean {
  return kinds.length > 0 && kinds.every((k) => isSourceUsable(verification[k]));
}

/** 観測用に「なぜ使えなかったか」を 1 つに畳む（PII を含まない enum）。 */
export function summarizeVetoReason(
  verification: SourceSyncVerification,
  kinds: readonly CareerSourceKind[],
): Exclude<SourceSyncVerdict, 'verified'> | null {
  let seen: Exclude<SourceSyncVerdict, 'verified'> | null = null;
  for (const k of kinds) {
    const v = verification[k];
    if (v === 'verified') continue;
    // 優先順位: unreadable > unclaimed > mismatch
    if (v === 'unreadable') return 'unreadable';
    if (v === 'unclaimed') seen = 'unclaimed';
    else if (seen === null) seen = 'mismatch';
  }
  return seen;
}
