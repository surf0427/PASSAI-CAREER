// PASSAI CAREER — Personal Memory payload runtime validation（P16-A）。
//
// 目的:
//   career_personal_memory に書く / から読む payload を、TypeScript runtime で防御的に検証する
//   （DB は object 型までしか CHECK しない＝shape 検証は本モジュールが正）。
//
// 厳守:
//   - discriminated result を返す（never throw）。
//   - unknown section / unsupported version / invalid payload / oversized / forbidden key を区別する。
//   - forward-compatible: 未知 field は無視する（将来版 payload の追加 field で読取失敗させない）。
//   - forbidden key（PII 氏名/mail/tel・transcript/prompt・Event Signal 由来 key 等）を deep scan で拒否する。
//   - 完成 prompt 文字列 / raw 本文は payload 型（FeatureSummary 系）に構造上存在しないが、二重の安全弁として
//     key guard も持つ。

import {
  CAREER_PERSONAL_MEMORY_SCHEMA_VERSION,
  CAREER_PERSONAL_MEMORY_MAX_PAYLOAD_BYTES,
  CAREER_PERSONAL_MEMORY_SECTION_KEYS,
  type CareerPersonalMemorySection,
  type CareerPersonalMemorySectionKey,
} from './schema';

export type ValidateReason =
  | 'unknown_section'
  | 'unsupported_version'
  | 'invalid_payload'
  | 'oversized'
  | 'forbidden_key';

export type ValidateResult =
  | { ok: true; section: CareerPersonalMemorySection }
  | { ok: false; reason: ValidateReason };

// payload に **絶対に現れてはいけない** key（exact match・lowercase 比較）。
//   - PII: 氏名 / メール / 電話 / 住所（ProfileMemorySummary は構造上持たない）。
//   - raw / 完成文: transcript / turns / messages / prompt 系 / 生本文。
//   - Event Signal 由来: recentFeatures / featureUsage / latestBands / score band。
//   注: exact match（'companyName' 等の正当 field を substring 誤検知しない）。
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(
  [
    // PII
    'name',
    'email',
    'phone',
    'tel',
    'address',
    // raw text / 完成文
    'transcript',
    'turns',
    'messages',
    'rawtext',
    'verifiedresearchtext',
    'systemprompt',
    'userprompt',
    'prompt',
    // Event Signal 由来（Personal Memory へ入れない境界）
    'recentfeatures',
    'featureusage',
    'latestbands',
    'scoreband',
    'score_band',
    'eventsignals',
    'signals',
  ].map((k) => k.toLowerCase()),
);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// 再帰的に全 key を走査し、FORBIDDEN_KEYS に触れたら true。
function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 12) return false; // 異常な入れ子は打ち切り（安全側）
  if (Array.isArray(value)) return value.some((v) => hasForbiddenKey(v, depth + 1));
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) return true;
      if (hasForbiddenKey(value[key], depth + 1)) return true;
    }
  }
  return false;
}

// FeatureSummary 系 payload の判別 shape（meta + latest[]）。full field は forward-compat のため強制しない。
function hasFeatureSummaryShape(payload: Record<string, unknown>): boolean {
  const meta = payload.meta;
  if (!isPlainObject(meta)) return false;
  if (typeof meta.feature !== 'string') return false;
  if (typeof meta.sourceCount !== 'number' || !Number.isFinite(meta.sourceCount)) return false;
  if (!Array.isArray(payload.latest)) return false;
  return true;
}

// base(BaseMemorySummary) の判別 shape（profile/activity/values の object）。
function hasBaseShape(payload: Record<string, unknown>): boolean {
  return (
    isPlainObject(payload.profile) &&
    isPlainObject(payload.activity) &&
    isPlainObject(payload.values)
  );
}

// payload の byte size（deterministic serialize でなく単純 JSON で十分＝size 判定のみ）。
export function payloadByteSize(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
}

// section_key / schema_version / payload を検証し、typed section または reason を返す。
export function validateCareerPersonalMemorySection(
  sectionKey: unknown,
  schemaVersion: unknown,
  payload: unknown,
): ValidateResult {
  // 1) section_key
  if (
    typeof sectionKey !== 'string' ||
    !(CAREER_PERSONAL_MEMORY_SECTION_KEYS as readonly string[]).includes(sectionKey)
  ) {
    return { ok: false, reason: 'unknown_section' };
  }
  const key = sectionKey as CareerPersonalMemorySectionKey;

  // 2) schema_version（正の整数でなければ invalid、現行版と異なれば unsupported）
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion <= 0) {
    return { ok: false, reason: 'invalid_payload' };
  }
  if (schemaVersion !== CAREER_PERSONAL_MEMORY_SCHEMA_VERSION) {
    return { ok: false, reason: 'unsupported_version' };
  }

  // 3) payload は object（配列・スカラ・null を弾く）
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'invalid_payload' };
  }

  // 4) size 上限
  if (payloadByteSize(payload) > CAREER_PERSONAL_MEMORY_MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: 'oversized' };
  }

  // 5) forbidden key deep scan
  if (hasForbiddenKey(payload)) {
    return { ok: false, reason: 'forbidden_key' };
  }

  // 6) section 別 判別 shape
  const shapeOk = key === 'base' ? hasBaseShape(payload) : hasFeatureSummaryShape(payload);
  if (!shapeOk) {
    return { ok: false, reason: 'invalid_payload' };
  }

  // 検証済み。discriminated union へ narrow（構造検証済みのため安全にキャスト）。
  return {
    ok: true,
    section: {
      sectionKey: key,
      schemaVersion: CAREER_PERSONAL_MEMORY_SCHEMA_VERSION,
      payload,
    } as CareerPersonalMemorySection,
  };
}

// 決定的シリアライズ（key を再帰ソート）。revision 算出・round-trip 検証に使う。
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
