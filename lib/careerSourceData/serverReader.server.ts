// PASSAI CAREER — Layer 1 Source Data server reader（NEXT-2 / Data Spine）。
//
// 責務: 認証済み member の Layer 1 Source（career_* mirror）を **owner-scoped で server から読む**。
//   これまで server は Layer 1 を一切読めず、Personal Memory の expected revision を再算出できなかった
//   （＝D-R1 の「永続 status='fresh' を信じる」暫定緩和の原因）。本 module がその欠落を埋める。
//
// 厳守（安全境界）:
//   - server-only（`import 'server-only'`）。browser bundle へ入れない。
//   - user ID は **必ず server auth（getCareerServerSupabaseClient().auth.getUser）から取得**。
//     request body の userId を受け取らない・信用しない。RLS（auth.uid()=user_id）が最終権威。
//   - **service role を使わない**（D-L7）。anon client + cookie session のみ。
//   - never-throw / fail-open。env 未設定・未認証・table missing・network error でも throw しない。
//   - 本文 / UUID / env / raw Supabase error を log しない。global / cross-user cache を持たない。
//   - row → domain の変換は lib/careerSourceData/rowMappers（client mirror と共有の単一実装）へ委譲。
//   - 読むのは **要求された Source だけ**（purpose に不要な Source へ I/O しない）。
//
// 注: 本 module は Source を読むだけで、Personal Memory の freshness 判定・rebuild は行わない
//   （それは lib/careerMemory/persistence/serverMemory.server.ts の責務）。

import 'server-only';

import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import {
  rowToCareerProfile,
  rowToCareerActivity,
  rowToCareerValues,
  rowToCareerSelfAnalysisLog,
  rowToCareerEsLog,
  rowToCareerInterviewResult,
  CAREER_VALUES_SELECT_COLUMNS,
  CAREER_SELF_ANALYSIS_SELECT_COLUMNS,
  CAREER_ES_SELECT_COLUMNS,
  CAREER_INTERVIEW_RESULT_SELECT_COLUMNS,
  type CareerValuesRow,
  type CareerSelfAnalysisResultRow,
  type CareerEsLogRow,
  type CareerInterviewResultRow,
  type CareerJsonDataRow,
} from './rowMappers';
import {
  CAREER_SOURCE_LOG_MAX_ROWS,
  CAREER_SOURCE_TABLES,
  EMPTY_CAREER_SOURCE_BUNDLE,
  emptySourceStatuses,
  type CareerSourceBundle,
  type CareerSourceKind,
  type CareerSourceReadOutcome,
  type CareerSourceReadStatus,
} from './types';

// 1 table 分の select 結果（error は boolean へ潰す＝raw error を上位へ運ばない）。
export type SourceSelectResult = { rows: unknown[] | null; failed: boolean };

// server reader の注入可能依存（QA では fake を注入し、実 client / auth / DB を使わない）。
export type CareerSourceReader = {
  getUserId: () => Promise<string | null>;
  /** owner-scoped select。single=true は 1 行想定（profile/activity/values）。 */
  select: (
    table: string,
    columns: string,
    userId: string,
    options: { orderByCreatedDesc: boolean; limit: number },
  ) => Promise<SourceSelectResult>;
};

export type CareerSourceReaderDeps = {
  createReader: () => Promise<CareerSourceReader | null>;
  now: () => number;
};

/**
 * 呼び出し側の追加 gate（canary allowlist 等）。
 * server auth で確定した userId を受け取り、false を返すと **table read を 1 回も行わない**。
 * ★ client 申告値は渡さない（引数は必ず auth 由来の userId）。
 */
export type CareerSourceAuthorize = (userId: string) => boolean;

const SINGLE_ROW_LIMIT = 1;

function outcome(
  bundle: CareerSourceBundle,
  meta: CareerSourceReadOutcome['meta'],
): CareerSourceReadOutcome {
  return { bundle, meta };
}

// 実依存: career server client（anon + cookie/token・RLS 権威）。service role は使わない。
const realDeps: CareerSourceReaderDeps = {
  now: () => Date.now(),
  createReader: async () => {
    const client = await getCareerServerSupabaseClient();
    if (!client) return null;
    return {
      async getUserId() {
        try {
          const { data, error } = await client.auth.getUser();
          if (error || !data?.user) return null;
          if (data.user.is_anonymous) return null; // member（非 anonymous）のみ
          return data.user.id;
        } catch {
          return null;
        }
      },
      async select(table, columns, userId, options) {
        try {
          let query = client.from(table).select(columns).eq('user_id', userId);
          if (options.orderByCreatedDesc) {
            query = query.order('created_at', { ascending: false });
          }
          const { data, error } = await query.limit(options.limit);
          if (error) return { rows: null, failed: true };
          return { rows: (data as unknown[] | null) ?? [], failed: false };
        } catch {
          return { rows: null, failed: true };
        }
      },
    };
  },
};

// 履歴系 1 kind の読み出し（never-throw）。上限到達は truncated（revision を権威にしない）。
async function readLogSource<TRow, TDomain>(
  reader: CareerSourceReader,
  userId: string,
  table: string,
  columns: string,
  map: (row: TRow) => TDomain,
): Promise<{ items: TDomain[]; status: CareerSourceReadStatus }> {
  const res = await reader.select(table, columns, userId, {
    orderByCreatedDesc: true,
    limit: CAREER_SOURCE_LOG_MAX_ROWS,
  });
  if (res.failed || !Array.isArray(res.rows)) return { items: [], status: 'error' };
  const items: TDomain[] = [];
  for (const raw of res.rows) {
    if (!raw || typeof raw !== 'object') continue;
    items.push(map(raw as TRow));
  }
  return {
    items,
    status: res.rows.length >= CAREER_SOURCE_LOG_MAX_ROWS ? 'truncated' : 'ok',
  };
}

// 単一行 Source の読み出し（never-throw）。行が無い場合も ok（＝「空である」という確定情報）。
async function readSingleSource<TRow, TDomain>(
  reader: CareerSourceReader,
  userId: string,
  table: string,
  columns: string,
  map: (row: TRow) => TDomain | null,
): Promise<{ value: TDomain | null; status: CareerSourceReadStatus }> {
  const res = await reader.select(table, columns, userId, {
    orderByCreatedDesc: false,
    limit: SINGLE_ROW_LIMIT,
  });
  if (res.failed || !Array.isArray(res.rows)) return { value: null, status: 'error' };
  const raw = res.rows[0];
  if (!raw || typeof raw !== 'object') return { value: null, status: 'ok' };
  return { value: map(raw as TRow), status: 'ok' };
}

/**
 * 要求された Layer 1 Source を owner-scoped で読む（never-throw・fail-open）。
 *
 * - `kinds` が空 → I/O ゼロ（client 生成もしない）。
 * - env 未設定 / 未認証 / anonymous → I/O ゼロ、空 bundle。
 * - 個々の Source の失敗は他 Source を巻き込まない（status で個別に表す）。
 * - 返す bundle は **domain 原本**（PII を含みうる）。prompt へ直接載せず、必ず Layer 2 projection を通す。
 */
export async function loadCareerSourceData(
  kinds: readonly CareerSourceKind[],
  deps: CareerSourceReaderDeps = realDeps,
  authorize?: CareerSourceAuthorize,
): Promise<CareerSourceReadOutcome> {
  const statuses = emptySourceStatuses();
  try {
    const wanted = new Set<CareerSourceKind>(kinds);
    if (wanted.size === 0) {
      return outcome(EMPTY_CAREER_SOURCE_BUNDLE, {
        outcome: 'skipped',
        statuses,
        durationMs: null,
      });
    }

    const reader = await deps.createReader();
    if (!reader) {
      return outcome(EMPTY_CAREER_SOURCE_BUNDLE, {
        outcome: 'skipped',
        statuses,
        durationMs: null,
      });
    }

    const userId = await reader.getUserId();
    if (!userId) {
      return outcome(EMPTY_CAREER_SOURCE_BUNDLE, {
        outcome: 'unauthenticated',
        statuses,
        durationMs: null,
      });
    }

    // ★ 呼び出し側 gate（canary allowlist 等）。deny なら **table read ゼロ**で返す。
    //   userId は server auth 由来のみ（client 申告値をここへ渡す経路は存在しない）。
    if (authorize && !authorize(userId)) {
      return outcome(EMPTY_CAREER_SOURCE_BUNDLE, {
        outcome: 'unauthorized',
        statuses,
        durationMs: null,
      });
    }

    const started = deps.now();
    const bundle: CareerSourceBundle = {
      profile: null,
      activity: null,
      values: null,
      selfAnalysisLogs: [],
      esLogs: [],
      interviewResults: [],
    };

    // 要求された Source のみ並列に読む（不要 Source への I/O ゼロ）。
    const jobs: Array<Promise<void>> = [];

    if (wanted.has('profile')) {
      jobs.push(
        readSingleSource<CareerJsonDataRow, ReturnType<typeof rowToCareerProfile>>(
          reader,
          userId,
          CAREER_SOURCE_TABLES.profile,
          'data, updated_at',
          (row) => rowToCareerProfile(row),
        ).then((r) => {
          bundle.profile = r.value ?? null;
          statuses.profile = r.status;
        }),
      );
    }
    if (wanted.has('activity')) {
      jobs.push(
        readSingleSource<CareerJsonDataRow, ReturnType<typeof rowToCareerActivity>>(
          reader,
          userId,
          CAREER_SOURCE_TABLES.activity,
          'data, updated_at',
          (row) => rowToCareerActivity(row),
        ).then((r) => {
          bundle.activity = r.value ?? null;
          statuses.activity = r.status;
        }),
      );
    }
    if (wanted.has('values')) {
      jobs.push(
        readSingleSource<CareerValuesRow, ReturnType<typeof rowToCareerValues>>(
          reader,
          userId,
          CAREER_SOURCE_TABLES.values,
          CAREER_VALUES_SELECT_COLUMNS,
          (row) => rowToCareerValues(row),
        ).then((r) => {
          bundle.values = r.value ?? null;
          statuses.values = r.status;
        }),
      );
    }
    if (wanted.has('self_analysis')) {
      jobs.push(
        readLogSource<CareerSelfAnalysisResultRow, ReturnType<typeof rowToCareerSelfAnalysisLog>>(
          reader,
          userId,
          CAREER_SOURCE_TABLES.self_analysis,
          CAREER_SELF_ANALYSIS_SELECT_COLUMNS,
          rowToCareerSelfAnalysisLog,
        ).then((r) => {
          bundle.selfAnalysisLogs = r.items;
          statuses.self_analysis = r.status;
        }),
      );
    }
    if (wanted.has('es')) {
      jobs.push(
        readLogSource<CareerEsLogRow, ReturnType<typeof rowToCareerEsLog>>(
          reader,
          userId,
          CAREER_SOURCE_TABLES.es,
          CAREER_ES_SELECT_COLUMNS,
          rowToCareerEsLog,
        ).then((r) => {
          bundle.esLogs = r.items;
          statuses.es = r.status;
        }),
      );
    }
    if (wanted.has('interview')) {
      jobs.push(
        readLogSource<CareerInterviewResultRow, ReturnType<typeof rowToCareerInterviewResult>>(
          reader,
          userId,
          CAREER_SOURCE_TABLES.interview,
          CAREER_INTERVIEW_RESULT_SELECT_COLUMNS,
          rowToCareerInterviewResult,
        ).then((r) => {
          bundle.interviewResults = r.items;
          statuses.interview = r.status;
        }),
      );
    }

    await Promise.all(jobs);
    const durationMs = deps.now() - started;

    const anyError = (Object.keys(statuses) as CareerSourceKind[]).some(
      (k) => statuses[k] === 'error',
    );
    return outcome(bundle, {
      outcome: anyError ? 'error' : 'ok',
      statuses,
      durationMs,
    });
  } catch {
    // never-throw boundary: 何が起きても呼び出し側（AI route）を壊さない。
    return outcome(EMPTY_CAREER_SOURCE_BUNDLE, {
      outcome: 'error',
      statuses,
      durationMs: null,
    });
  }
}
