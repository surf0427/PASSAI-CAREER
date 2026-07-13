// PASSAI CAREER — Personal Memory shadow-read adapter scaffold（P16-E）。
//
// 責務: persisted の career_personal_memory row（raw / unknown）を安全に read model へ変換し、
//   fresh / stale / invalid / unsupported_schema / missing / unusable を discriminated union で返す。
//   prompt 使用可否（usableForPrompt）も明示する。**未配線 scaffold**（prompt / Context Orchestrator /
//   app callsite / Supabase 実接続へは接続しない。呼び出しが無いこと自体が read rollout 無効）。
//
// ★ 再利用（別実装で重複させない）:
//   - payload / section の妥当性検証は validate.ts（validateCareerPersonalMemorySection）へ委譲。
//   - fresh/stale/failed/unsupported の状態判定は state.ts（deriveMemoryState / isUsableForPrompt）へ委譲。
//   - 型・定数は schema.ts、raw row 形は repository.ts を type-only 再利用。
//   本層は「validation → 状態判定 → read model」の **合成のみ**（新しい validator / 状態機械を作らない）。
//
// ★ 境界:
//   - Supabase client を生成しない（pure）。raw row の fetch は呼び出し側の責務（writer coordinator と同設計・
//     lib→app 依存や client 生成を本層へ持ち込まない）。
//   - never-throw: invalid / malformed 入力を app へ throw しない（typed result で返す）。
//   - result へ載せないもの: raw Supabase error / secret / env 値 / raw transcript / raw turns / PII。
//     section payload は validate.ts の forbidden-key guard を通過したもののみ（構造上 PII/本文を持たない）。
//   - section 単位で独立（1 row の破損が他 section を無効化しない）。
//   - freshness の権威は sourceRevision（state.ts と同一方針）。sourceUpdatedAt / generatedAt は権威にしない。

import {
  CAREER_PERSONAL_MEMORY_SCHEMA_VERSION,
  type CareerPersonalMemorySection,
  type CareerPersonalMemorySectionKey,
  type CareerPersonalMemoryPersistedStatus,
} from './schema';
import {
  validateCareerPersonalMemorySection,
  type ValidateReason,
} from './validate';
import {
  deriveMemoryState,
  type CurrentMemoryMeta,
  type ExpectedMemoryMeta,
} from './state';
import type { CareerPersonalMemoryRawRow } from './repository';

// read result が運ぶ最小メタ（raw payload 以外の観測情報。secret / error を含めない）。
export type PersonalMemoryReadMeta = {
  sourceRevision: string;
  sourceUpdatedAt: string | null;
  generatedAt: string;
  status: CareerPersonalMemoryPersistedStatus;
};

// invalid（validation 不通過 / row 形不正）の理由。
//   validate.ts の ValidateReason を再利用しつつ、unsupported_version は独立 status へ振り替えるため除外。
export type ReadInvalidReason =
  | Exclude<ValidateReason, 'unsupported_version'> // unknown_section | invalid_payload | oversized | forbidden_key
  | 'malformed_row' // object でない / 予期せぬ throw
  | 'section_mismatch' // 要求 section と row.section_key が食い違う
  | 'bad_status'; // status が fresh|stale|failed 以外

// 呼び出し側が switch で安全に分岐できる read model の discriminated union。
//   - section（read model 本体）は fresh / stale / unusable でのみ提供（validation 通過済み payload）。
//   - missing / invalid / unsupported_schema は payload を運ばない。
export type PersonalMemoryReadResult =
  | { status: 'missing'; sectionKey: CareerPersonalMemorySectionKey; usableForPrompt: false }
  | { status: 'invalid'; sectionKey: CareerPersonalMemorySectionKey; reason: ReadInvalidReason; usableForPrompt: false }
  | { status: 'unsupported_schema'; sectionKey: CareerPersonalMemorySectionKey; foundSchemaVersion: number | null; usableForPrompt: false }
  | { status: 'fresh'; sectionKey: CareerPersonalMemorySectionKey; section: CareerPersonalMemorySection; meta: PersonalMemoryReadMeta; usableForPrompt: true }
  | { status: 'stale'; sectionKey: CareerPersonalMemorySectionKey; section: CareerPersonalMemorySection; meta: PersonalMemoryReadMeta; usableForPrompt: false }
  | { status: 'unusable'; sectionKey: CareerPersonalMemorySectionKey; section: CareerPersonalMemorySection; meta: PersonalMemoryReadMeta; reason: 'db_status_failed'; usableForPrompt: false };

// ── helpers（決定的・total・throw しない） ──
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asStrOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asPersistedStatus(v: unknown): CareerPersonalMemoryPersistedStatus | null {
  return v === 'fresh' || v === 'stale' || v === 'failed' ? v : null;
}

// 1 section の persisted row（raw / unknown）を read model へ変換する（pure・never-throw）。
//   rawRow: repository が select した未検証 row（null/undefined = 行不在）。
//   expected: 要求端末の現 Source から算出した現行 revision（freshness の権威）。
export function readPersonalMemorySection(
  sectionKey: CareerPersonalMemorySectionKey,
  rawRow: unknown,
  expected: ExpectedMemoryMeta,
): PersonalMemoryReadResult {
  try {
    // 1) missing: 行が無い。
    if (rawRow === null || rawRow === undefined) {
      return { status: 'missing', sectionKey, usableForPrompt: false };
    }
    // 2) malformed: object でない（string / number / array / repository error 相当）。
    if (!isPlainObject(rawRow)) {
      return { status: 'invalid', sectionKey, reason: 'malformed_row', usableForPrompt: false };
    }
    const row = rawRow as Partial<CareerPersonalMemoryRawRow> & Record<string, unknown>;

    // 3) section_key 一致（要求 section と DB row が食い違えば mismatch。他 section の row を誤採用しない）。
    if (asStr(row.section_key) !== sectionKey) {
      return { status: 'invalid', sectionKey, reason: 'section_mismatch', usableForPrompt: false };
    }

    // 4) schema_version を先に確認し、正の整数で現行版と異なる場合は unsupported_schema（独立 status）。
    //    0 / 負 / 非整数は unsupported ではなく後段の validate が invalid_payload として扱う（validate と整合）。
    const rawVersion =
      typeof row.schema_version === 'number' && Number.isInteger(row.schema_version)
        ? row.schema_version
        : null;
    if (rawVersion !== null && rawVersion > 0 && rawVersion !== CAREER_PERSONAL_MEMORY_SCHEMA_VERSION) {
      return { status: 'unsupported_schema', sectionKey, foundSchemaVersion: rawVersion, usableForPrompt: false };
    }

    // 5) payload / section 妥当性は validate.ts に委譲（別実装しない）。
    const v = validateCareerPersonalMemorySection(row.section_key, row.schema_version, row.payload);
    if (!v.ok) {
      if (v.reason === 'unsupported_version') {
        return { status: 'unsupported_schema', sectionKey, foundSchemaVersion: rawVersion, usableForPrompt: false };
      }
      return { status: 'invalid', sectionKey, reason: v.reason, usableForPrompt: false };
    }

    // 6) status field（DB 保存 status は fresh|stale|failed のみ）。
    const status = asPersistedStatus(row.status);
    if (status === null) {
      return { status: 'invalid', sectionKey, reason: 'bad_status', usableForPrompt: false };
    }

    const meta: PersonalMemoryReadMeta = {
      sourceRevision: asStr(row.source_revision),
      sourceUpdatedAt: asStrOrNull(row.source_updated_at),
      generatedAt: asStr(row.generated_at),
      status,
    };

    // 7) 状態判定は state.ts に委譲（deriveMemoryState / isUsableForPrompt を再利用）。
    const current: CurrentMemoryMeta = {
      schemaVersion: v.section.schemaVersion,
      sourceRevision: meta.sourceRevision,
      status,
      sourceUpdatedAt: meta.sourceUpdatedAt,
      generatedAt: meta.generatedAt,
    };
    const derived = deriveMemoryState(current, expected);

    switch (derived) {
      case 'unsupported_version':
        return { status: 'unsupported_schema', sectionKey, foundSchemaVersion: rawVersion, usableForPrompt: false };
      case 'failed':
        return { status: 'unusable', sectionKey, section: v.section, meta, reason: 'db_status_failed', usableForPrompt: false };
      case 'stale':
        return { status: 'stale', sectionKey, section: v.section, meta, usableForPrompt: false };
      case 'fresh':
        // fresh のみ prompt 使用可（state.ts の isUsableForPrompt('fresh')===true と定義上一致。
        //   両者の結合は read-contract QA [16] が回帰検証する）。
        return { status: 'fresh', sectionKey, section: v.section, meta, usableForPrompt: true };
      // missing / rebuilding は current!=null かつ status 確定済みでは発生しない（防御）。
      default:
        return { status: 'invalid', sectionKey, reason: 'malformed_row', usableForPrompt: false };
    }
  } catch {
    // never-throw boundary: 予期せぬ失敗でも app へ throw せず invalid で返す。
    return { status: 'invalid', sectionKey, reason: 'malformed_row', usableForPrompt: false };
  }
}

// 要求 section と対応する expected revision の組（複数 section read の入力）。
export type PersonalMemoryReadRequest = {
  sectionKey: CareerPersonalMemorySectionKey;
  expected: ExpectedMemoryMeta;
};

// 複数 section を raw rows から独立に read する（pure・section 単位で分離）。
//   rawRows: 任意個の未検証 row（fetch は呼び出し側。順不同可。配列でなければ空扱い＝全て missing）。
//   1 row の破損は当該 section の invalid に留まり、他 section の read を妨げない。
export function readPersonalMemorySectionsFromRows(
  requests: readonly PersonalMemoryReadRequest[],
  rawRows: unknown,
): PersonalMemoryReadResult[] {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  // section_key → 最初の row（防御: UNIQUE 制約があるので通常単一。重複時は最初のみ採用）。
  const bySection = new Map<string, unknown>();
  for (const r of rows) {
    if (isPlainObject(r) && typeof r.section_key === 'string' && !bySection.has(r.section_key)) {
      bySection.set(r.section_key, r);
    }
  }
  return requests.map((req) =>
    readPersonalMemorySection(req.sectionKey, bySection.get(req.sectionKey) ?? null, req.expected),
  );
}
