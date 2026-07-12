// PASSAI CAREER — Personal Memory persistence schema（P16-A / Data Spine Layer 2）。
//
// 位置づけ:
//   career_personal_memory table（supabase/career_personal_memory_apply.sql）に保存する
//   section 別 payload の **型と定数のみ**。processing scope = personal_service_processing。
//   payload 型は P4-A canonical memory 型（lib/careerMemory/types.ts の FeatureSummary 系）を再利用する。
//
// 厳守:
//   - section_key と payload 型を discriminated union で連動させる（任意 Record<string, unknown> を公開しない）。
//   - MVP は base / self_analysis / es / interview の 4 section のみ（SQL の CHECK と一致）。
//   - Event Signal / prompt 文字列 / raw transcript / ES 本文 / company raw text は payload 型に含めない
//     （P4-A の各 MemorySummary が構造上それらを持たない＝型で担保）。
//   - runtime 値は反復・検証用の const のみ（validate.ts が実際の検証を行う）。

import type {
  BaseMemorySummary,
  SelfAnalysisMemorySummary,
  EsMemorySummary,
  InterviewMemorySummary,
} from '@/lib/careerMemory/types';

// MVP section_key（SQL CHECK と 1:1 で一致させる）。
export type CareerPersonalMemorySectionKey = 'base' | 'self_analysis' | 'es' | 'interview';

export const CAREER_PERSONAL_MEMORY_SECTION_KEYS = [
  'base',
  'self_analysis',
  'es',
  'interview',
] as const satisfies readonly CareerPersonalMemorySectionKey[];

// DB に保存する status（SQL CHECK と 1:1）。missing/rebuilding/unsupported_version は read 時に導出する。
export type CareerPersonalMemoryPersistedStatus = 'fresh' | 'stale' | 'failed';

export const CAREER_PERSONAL_MEMORY_PERSISTED_STATUSES = [
  'fresh',
  'stale',
  'failed',
] as const satisfies readonly CareerPersonalMemoryPersistedStatus[];

// read 時に導出する状態を含めた完全な状態モデル（DB 非保存分を含む）。
export type CareerPersonalMemoryDerivedState =
  | CareerPersonalMemoryPersistedStatus
  | 'missing'
  | 'rebuilding'
  | 'unsupported_version';

// 現行 payload schema version（section 共通。将来 section 別に分ける余地はあるが MVP は一律 1）。
export const CAREER_PERSONAL_MEMORY_SCHEMA_VERSION = 1 as const;
export type CareerPersonalMemorySchemaVersion = typeof CAREER_PERSONAL_MEMORY_SCHEMA_VERSION;

// payload の byte 上限（application validation が正。SQL には持たせない）。
export const CAREER_PERSONAL_MEMORY_MAX_PAYLOAD_BYTES = 32 * 1024; // 32KB

// ── section_key ↔ payload 型 の discriminated union ──────────────────────────
//   sectionKey を確定すると payload 型が一意に定まる（誤った組合せを型で弾く）。
export type CareerPersonalMemorySection =
  | {
      sectionKey: 'base';
      schemaVersion: CareerPersonalMemorySchemaVersion;
      payload: BaseMemorySummary;
    }
  | {
      sectionKey: 'self_analysis';
      schemaVersion: CareerPersonalMemorySchemaVersion;
      payload: SelfAnalysisMemorySummary;
    }
  | {
      sectionKey: 'es';
      schemaVersion: CareerPersonalMemorySchemaVersion;
      payload: EsMemorySummary;
    }
  | {
      sectionKey: 'interview';
      schemaVersion: CareerPersonalMemorySchemaVersion;
      payload: InterviewMemorySummary;
    };

// section_key → payload 型のマップ（validate / builder が参照する補助型）。
export type CareerPersonalMemoryPayloadFor<K extends CareerPersonalMemorySectionKey> =
  Extract<CareerPersonalMemorySection, { sectionKey: K }>['payload'];

// 保存行の非 payload メタ（repository / writer が扱う）。
export type CareerPersonalMemoryRowMeta = {
  sectionKey: CareerPersonalMemorySectionKey;
  schemaVersion: number;
  sourceRevision: string;
  sourceUpdatedAt: string | null;
  generatedAt: string;
  status: CareerPersonalMemoryPersistedStatus;
};
