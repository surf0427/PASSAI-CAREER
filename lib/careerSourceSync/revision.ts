// PASSAI CAREER — Layer 1 Source Sync Revision（D-R2 closure / H-1・H-2）。
//
// 目的:
//   「server が読めた Supabase mirror の中身が、**リクエストしている端末の canonical
//     localStorage の中身と一致しているか**」を、生データを一切送らずに検証するための
//   決定的 token を算出する。
//
// なぜ既存 computeContentRevision を使わないか:
//   computeContentRevision は Layer 2 payload（Memory）の revision であり、`createdAt` を
//   **文字列のまま** 含む。client は `new Date().toISOString()`（`2026-07-02T00:00:00.000Z`）、
//   Postgres の timestamptz は `2026-07-02T00:00:00+00:00` を返すため、同じ内容でも
//   文字列が異なり **永久に不一致** になる。sync 判定にはタイムスタンプ正規化が必須。
//
// 設計原則（安全側）:
//   1. 「同一 revision ⟹ 同一内容」でなければならない。逆（内容差 → revision 差）を取りこぼすと
//      stale を fresh と誤認する。よって sync view は **消費側が使うフィールドの superset** にする。
//   2. ただし **mirror を往復しないフィールドは含めない**（含めると永久不一致 → 機能が無効化される）。
//      往復しないフィールドの実例:
//        - career_values.updated_at は DB trigger が now() で上書きする（client 値と別物）
//        - career_es_logs は body / mode / groupId / version / deepDive を meta へ保存していない
//      → 各 kind の sync view で明示的に除外し、その根拠をコメントに残す。
//        往復性は scripts/career-source-sync-qa.ts [1] が fixture で回帰検証する。
//   3. 純関数 / deterministic / never-throw / browser 兼用（node:crypto を使わない）。
//   4. revision は **内容の同一性 token** であり security hash ではない。値から内容は復元できないが、
//      機密保護を主目的にはしない（送るのは 8 hex のみで PII / 本文は含まれない）。

import type {
  CareerSourceBundle,
  CareerSourceKind,
} from '@/lib/careerSourceData/types';
import { CAREER_SOURCE_KINDS } from '@/lib/careerSourceData/types';
import { stableStringify } from '@/lib/careerMemory/persistence/validate';

/** sync revision の schema 版。normalize / sync view を変えたら上げる（旧 client は不一致 → veto）。 */
export const CAREER_SOURCE_SYNC_VERSION = 'v1' as const;

// FNV-1a 32bit（careerMemory/persistence/revision.ts と同方式・browser 兼用）。
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── タイムスタンプ正規化 ────────────────────────────────────────────
// **時刻成分を持つ** ISO-8601 風文字列だけを epoch ms へ正規化する。
//   - `2026-07-02T00:00:00.000Z`（client の toISOString）と
//     `2026-07-02T00:00:00+00:00`（Postgres timestamptz）を同一化するのが目的。
//   - 日付のみ（`2026-07`, `2026-07-02`）は活動期間などの **ユーザー入力文字列** の可能性があるため
//     触らない（jsonb は完全往復するので正規化は不要）。
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function normalizeForSync(value: unknown, depth = 0): unknown {
  if (depth > 12) return null; // 防御的な深さ上限（循環・異常データ）
  if (typeof value === 'string') {
    if (ISO_DATETIME.test(value)) {
      const t = Date.parse(value);
      if (!Number.isNaN(t)) return t; // epoch ms（表記揺れを吸収）
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => normalizeForSync(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue; // undefined と欠損を同一視（JSON 往復と整合）
      out[k] = normalizeForSync(v, depth + 1);
    }
    return out;
  }
  return value ?? null;
}

// ── kind 別 sync view ──────────────────────────────────────────────
// 各 view は「mirror を往復し、かつ消費側（Layer 2 projection / base context）が使う内容の superset」。

// log 系の 1 件を「往復する field だけ」に落とす共通ヘルパ。
//   id / createdAt / result は全 log 系で往復する（client_id / created_at / result jsonb）。
function logCore(entry: unknown): Record<string, unknown> {
  const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
  return { id: e.id ?? null, createdAt: e.createdAt ?? null, result: e.result ?? null };
}

function syncViewForKind(kind: CareerSourceKind, bundle: CareerSourceBundle): unknown {
  switch (kind) {
    // career_profiles.data / career_activities.data は domain 全体を jsonb で保持するため完全往復する。
    case 'profile':
      return bundle.profile ?? null;
    case 'activity':
      return bundle.activity ?? null;

    // career_values は 8 カテゴリ + notes + overall_note が往復する。
    //   updatedAt は **除外**（DB trigger set_updated_at が now() で上書きするため client 値と一致しない）。
    case 'values': {
      const v = bundle.values;
      if (!v) return null;
      return { selections: v.selections ?? null, notes: v.notes ?? null, overallNote: v.overallNote ?? '' };
    }

    // career_self_analysis_results: client_id / user_input / result / created_at が往復する。
    case 'self_analysis':
      return (bundle.selfAnalysisLogs ?? []).map((l) => ({
        ...logCore(l),
        userInput: (l as { userInput?: unknown }).userInput ?? '',
      }));

    // career_es_logs: 昇格列 + meta の field のみ往復する。
    //   body / mode / groupId / version / deepDive は meta へ保存されない（toMeta 参照）ため **除外**。
    //   Layer 2 の ES projection は createdAt / companyName / question / result しか使わないため、
    //   この view はそれらの superset になっている。
    case 'es':
      return (bundle.esLogs ?? []).map((l) => {
        const e = l as unknown as Record<string, unknown>;
        return {
          ...logCore(l),
          companyName: e.companyName ?? null,
          question: e.question ?? null,
          charLimit: e.charLimit ?? null,
          selectionType: e.selectionType ?? null,
          industry: e.industry ?? null,
          jobType: e.jobType ?? null,
          favorite: !!e.favorite,
          submitted: !!e.submitted,
          editedResult: e.editedResult ?? null,
        };
      });

    // career_interview_results: mode / interview_type / turns / result / company research 連携が往復する。
    case 'interview':
      return (bundle.interviewResults ?? []).map((l) => {
        const e = l as unknown as Record<string, unknown>;
        return {
          ...logCore(l),
          mode: e.mode ?? null,
          interviewType: e.interviewType ?? null,
          turns: e.turns ?? [],
          companyResearchLogId: e.companyResearchLogId ?? null,
          companyResearchSnapshot: e.companyResearchSnapshot ?? null,
        };
      });

    // ── Batch 2 ────────────────────────────────────────────────────
    // career_matching_results: client_id / user_input / result / created_at が往復する。
    case 'matching':
      return (bundle.matchingLogs ?? []).map((l) => ({
        ...logCore(l),
        userInput: (l as { userInput?: unknown }).userInput ?? '',
      }));

    // career_company_research_logs: 昇格列 + jsonb がすべて往復する。
    //   ★ updatedAt は **除外**。DB trigger `set_updated_at` が now() で上書きするため
    //     client 値と一致しない（values.updatedAt と同じ理由）。
    case 'company_research':
      return (bundle.companyResearchLogs ?? []).map((l) => {
        const e = l as unknown as Record<string, unknown>;
        return {
          id: e.id ?? null,
          createdAt: e.createdAt ?? null,
          companyName: e.companyName ?? '',
          industry: e.industry ?? '',
          interestLevel: e.interestLevel ?? null,
          input: e.input ?? null,
          review: e.review ?? null,
          fitAnalysis: e.fitAnalysis ?? null,
          interviewContextSummary: e.interviewContextSummary ?? '',
          revisionHistory: e.revisionHistory ?? [],
          favorite: !!e.favorite,
        };
      });

    // career_presentation_results: 昇格列 + result/qa jsonb が往復する。
    case 'presentation':
      return (bundle.presentationResults ?? []).map((l) => {
        const e = l as unknown as Record<string, unknown>;
        return {
          id: e.id ?? null,
          createdAt: e.createdAt ?? null,
          presentationType: e.presentationType ?? null,
          mode: e.mode ?? null,
          theme: e.theme ?? '',
          timeLimitSec: e.timeLimitSec ?? 0,
          durationSec: e.durationSec ?? 0,
          transcript: e.transcript ?? '',
          result: e.result ?? null,
          qa: e.qa ?? null,
        };
      });

    // career_consultation_threads: client_id / title / messages / created_at が往復する。
    //   ★ updatedAt は **除外**（DB trigger 上書き）。
    case 'consultation':
      return (bundle.consultationThreads ?? []).map((l) => {
        const e = l as unknown as Record<string, unknown>;
        return {
          id: e.id ?? null,
          createdAt: e.createdAt ?? null,
          title: e.title ?? '',
          messages: e.messages ?? [],
        };
      });

    default:
      return null;
  }
}

/**
 * 1 Source kind の sync revision（純関数・never-throw）。
 * 同一 revision ⟹ 同一 sync view ⟹ 消費側が使う内容も同一。
 */
export function computeSourceSyncRevision(
  kind: CareerSourceKind,
  bundle: CareerSourceBundle,
): string {
  try {
    return `${CAREER_SOURCE_SYNC_VERSION}:${fnv1a(stableStringify(normalizeForSync(syncViewForKind(kind, bundle))))}`;
  } catch {
    // 算出できない場合は「一致しない値」を返す（＝veto 側に倒す。空文字は一致とみなさない）。
    return `${CAREER_SOURCE_SYNC_VERSION}:invalid`;
  }
}

/** 指定 kind（既定は全 kind）の sync revision map。 */
export function computeSourceSyncRevisions(
  bundle: CareerSourceBundle,
  kinds: readonly CareerSourceKind[] = CAREER_SOURCE_KINDS,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kind of kinds) out[kind] = computeSourceSyncRevision(kind, bundle);
  return out;
}
