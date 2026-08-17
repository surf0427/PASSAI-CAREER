/**
 * Company Prefetch — 永続化層（server-only・薄い adapter・never-throw は呼び出し側で扱う）。
 *
 * 役割は 3 つだけ:
 *   1. company-scoped job の claim / terminal 更新（attempt fencing 付き）
 *   2. sources / facts の書き込み（★ source を先に書き、その id を fact に必ず載せる）
 *   3. fact_group 別の最終取得時刻の読み出し（freshness short-circuit 用）
 *
 * 判定ロジックは **一切書かない**（pure module 側の責務）。
 *
 * 権威区分: `global_shared_server_authoritative`
 *   - read : authenticated の RLS SELECT（sources / facts / derived）
 *   - write: service_role のみ（企業データを client から直接書かせない）
 *   - job 台帳は authenticated にも読ませない（service_role 専用）
 *
 * DDL 未適用（42P01）は **正常な状態として扱う**。呼び出し側は no-op へ倒し、
 * ユーザーの free-text フローには一切影響させない。
 */

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  CAREER_COMPANY_OFFICIAL_TABLES,
  type CompanyFactGroup,
  type DraftOfficialCompanyFact,
} from '@/types/careerCompanyOfficial';
import { computeValidUntil } from '@/lib/careerCompanyOfficial/freshness';
import { devWarn } from '@/lib/devLog';
import {
  FAILURE_COOLDOWN_SECONDS,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  NONRETRYABLE_ERROR_CODES,
  REFRESH_COOLDOWN_SECONDS,
  type CompanyEnrichmentErrorCode,
} from './constants';
import type { CompanyEnrichmentIdentity } from './idempotency';
import type { ProviderSourceRef } from './providers/types';

const SOURCES = CAREER_COMPANY_OFFICIAL_TABLES.sources;
const FACTS = CAREER_COMPANY_OFFICIAL_TABLES.facts;
const JOBS = CAREER_COMPANY_OFFICIAL_TABLES.jobs;
const CLAIM_FN = 'career_company_enrichment_job_claim';

// ── storage error ────────────────────────────────────────────────────
export type CompanyPrefetchStorageReason = 'UNDEFINED_TABLE' | 'DB_ERROR';

export class CompanyPrefetchStorageError extends Error {
  readonly reason: CompanyPrefetchStorageReason;
  constructor(reason: CompanyPrefetchStorageReason, message: string) {
    super(message);
    this.name = 'CompanyPrefetchStorageError';
    this.reason = reason;
  }
}

/** Postgres「テーブル/関数未作成」= migration 未適用の検出（既存 job 基盤と同形）。 */
export function isUndefinedObject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === '42P01' ||
    e.code === '42883' ||
    (typeof e.message === 'string' &&
      /relation .* does not exist|function .* does not exist/i.test(e.message))
  );
}

function toStorageError(err: unknown, ctx: string): CompanyPrefetchStorageError {
  if (isUndefinedObject(err)) {
    return new CompanyPrefetchStorageError(
      'UNDEFINED_TABLE',
      `${ctx}: company prefetch storage not provisioned`,
    );
  }
  // raw DB message は上位へ伝播させない。
  return new CompanyPrefetchStorageError('DB_ERROR', `${ctx}: storage error`);
}

// ── job claim / terminal ─────────────────────────────────────────────
export type CompanyEnrichmentClaimOutcome =
  | 'CLAIMED_NEW'
  | 'CLAIMED_RETRY'
  /** TTL 経過後の新しい取得サイクル（attempt 予算はリセットされる）。 */
  | 'CLAIMED_REFRESH'
  | 'ALREADY_RUNNING'
  | 'ALREADY_COMPLETED'
  | 'FAILED_NON_RETRYABLE'
  | 'RETRY_LIMIT_REACHED';

export type CompanyEnrichmentClaimResult = {
  outcome: CompanyEnrichmentClaimOutcome;
  jobId: string;
  /** CLAIMED_NEW / CLAIMED_RETRY / CLAIMED_REFRESH のみ非 null（terminal 更新時の fencing token）。 */
  attemptToken: string | null;
  status: string;
  attemptCount: number;
};

/**
 * enrichment job を atomic に claim する。
 *
 * ★ 取得を開始してよいのは `CLAIMED_NEW` / `CLAIMED_RETRY` / `CLAIMED_REFRESH` のときだけ。
 *   `ALREADY_RUNNING` は「別 request が同じ企業を取得中」＝ N 人同時入力の収束点。
 *
 * ★ cooldown 2 種を必ず渡す（`lib/careerCompanyPrefetch/refreshPolicy.ts` と同じ値）。
 *   渡さないと terminal 行が永久に再 claim 不能になり、TTL 切れ後の再取得が止まる。
 */
export async function claimCompanyEnrichmentJob(
  admin: SupabaseClient,
  identity: CompanyEnrichmentIdentity,
): Promise<CompanyEnrichmentClaimResult> {
  if (!identity.companyId) {
    throw new CompanyPrefetchStorageError('DB_ERROR', 'claim: missing companyId');
  }

  const { data, error } = await admin.rpc(CLAIM_FN, {
    p_company_id: identity.companyId,
    p_task: identity.task,
    p_idempotency_key: identity.idempotencyKey,
    p_fetcher_revision: identity.fetcherRevision,
    p_schema_revision: identity.schemaRevision,
    p_lease_seconds: LEASE_SECONDS,
    p_max_attempts: MAX_ATTEMPTS,
    p_nonretryable_codes: [...NONRETRYABLE_ERROR_CODES],
    p_refresh_after_seconds: REFRESH_COOLDOWN_SECONDS,
    p_failure_cooldown_seconds: FAILURE_COOLDOWN_SECONDS,
  });

  if (error) throw toStorageError(error, 'claim');

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new CompanyPrefetchStorageError('DB_ERROR', 'claim: empty result');

  return {
    outcome: row.outcome,
    jobId: row.job_id,
    attemptToken: row.attempt_token ?? null,
    status: typeof row.status === 'string' ? row.status : 'running',
    attemptCount: typeof row.attempt_count === 'number' ? row.attempt_count : 0,
  };
}

export type CompanyJobTerminalArgs = {
  jobId: string;
  attemptToken: string;
  factsWritten: number;
  sourcesWritten: number;
  /** partial のときだけ設定（何が欠けたかを固定 enum で残す）。 */
  errorCode?: CompanyEnrichmentErrorCode | null;
  providerDurationMs?: number | null;
  totalDurationMs?: number | null;
};

/**
 * completed / partial への **fenced** 更新。
 * status=running AND attempt_token 一致 のときだけ適用される
 * （lease を失った古い attempt の書き込みを弾く）。
 */
export async function finishCompanyEnrichmentJob(
  admin: SupabaseClient,
  args: CompanyJobTerminalArgs & { status: 'completed' | 'partial' },
): Promise<{ applied: boolean }> {
  const { data, error } = await admin
    .from(JOBS)
    .update({
      status: args.status,
      completed_at: new Date().toISOString(),
      failed_at: null,
      // partial は「一部は書けた」terminal なので error_code を残す。
      error_code: args.status === 'partial' ? (args.errorCode ?? 'PARTIAL_RESULT') : null,
      facts_written: args.factsWritten,
      sources_written: args.sourcesWritten,
      attempt_token: null,
      lease_expires_at: null,
      provider_duration_ms: args.providerDurationMs ?? null,
      total_duration_ms: args.totalDurationMs ?? null,
    })
    .eq('id', args.jobId)
    .eq('status', 'running')
    .eq('attempt_token', args.attemptToken)
    .select('id');

  if (error) throw toStorageError(error, 'finish');
  return { applied: Array.isArray(data) && data.length === 1 };
}

/** failed への fenced 更新。error_code は allowlist のみ。 */
export async function failCompanyEnrichmentJob(
  admin: SupabaseClient,
  args: {
    jobId: string;
    attemptToken: string;
    errorCode: CompanyEnrichmentErrorCode;
    totalDurationMs?: number | null;
  },
): Promise<{ applied: boolean }> {
  const { data, error } = await admin
    .from(JOBS)
    .update({
      status: 'failed',
      error_code: args.errorCode,
      failed_at: new Date().toISOString(),
      completed_at: null,
      attempt_token: null,
      lease_expires_at: null,
      total_duration_ms: args.totalDurationMs ?? null,
    })
    .eq('id', args.jobId)
    .eq('status', 'running')
    .eq('attempt_token', args.attemptToken)
    .select('id');

  if (error) throw toStorageError(error, 'fail');
  return { applied: Array.isArray(data) && data.length === 1 };
}

// ── freshness（外部 I/O の直前に呼ぶ short-circuit）─────────────────
/**
 * company の fact_group ごとの **最新取得時刻**を返す。
 * 1 件も無い group は Map に現れない（＝ missing）。
 */
export async function loadLatestFetchedAtByGroup(
  client: SupabaseClient,
  companyId: string,
): Promise<Map<CompanyFactGroup, string>> {
  const { data, error } = await client
    .from(FACTS)
    .select('fact_group, fetched_at')
    .eq('company_id', companyId)
    .order('fetched_at', { ascending: false })
    .limit(500);

  if (error) throw toStorageError(error, 'freshness');

  const out = new Map<CompanyFactGroup, string>();
  for (const row of (data ?? []) as Array<{ fact_group: string; fetched_at: string }>) {
    const group = row?.fact_group as CompanyFactGroup;
    if (!group || typeof row.fetched_at !== 'string') continue;
    // order 済みなので最初に現れたものが最新。
    if (!out.has(group)) out.set(group, row.fetched_at);
  }
  return out;
}

// ── sources / facts の書き込み ───────────────────────────────────────
/**
 * source を書いて `sourceUrl → sourceId` の対応表を返す。
 *
 * ★ **必ず fact より先に呼ぶ**。fact.source_id は NOT NULL であり、
 *   source が無い fact を作れない（DDL と型の両方で塞いである）。
 */
export async function insertSources(
  admin: SupabaseClient,
  companyId: string,
  sources: readonly ProviderSourceRef[],
): Promise<Map<string, string>> {
  const byUrl = new Map<string, string>();
  if (sources.length === 0) return byUrl;

  // 同一 URL の重複を落とす（同 job 内で同じページを 2 度書かない）。
  const unique = new Map<string, ProviderSourceRef>();
  for (const s of sources) {
    if (!s || typeof s.sourceUrl !== 'string' || s.sourceUrl.trim() === '') continue;
    if (!unique.has(s.sourceUrl)) unique.set(s.sourceUrl, s);
  }
  if (unique.size === 0) return byUrl;

  const rows = Array.from(unique.values()).map((s) => ({
    company_id: companyId,
    source_url: s.sourceUrl,
    source_type: s.sourceType,
    source_domain: s.sourceDomain,
    http_status: s.httpStatus,
    content_hash: s.contentHash,
    fetched_at: s.fetchedAt,
    published_at: s.publishedAt,
  }));

  const { data, error } = await admin.from(SOURCES).insert(rows).select('id, source_url');
  if (error) throw toStorageError(error, 'insertSources');

  for (const row of (data ?? []) as Array<{ id: string; source_url: string }>) {
    if (typeof row?.id === 'string' && typeof row.source_url === 'string') {
      byUrl.set(row.source_url, row.id);
    }
  }
  return byUrl;
}

/**
 * fact を書く。**source_id を解決できない fact は書かない**（黙って落とす）。
 *
 * @returns 実際に書けた件数
 */
export async function insertFacts(
  admin: SupabaseClient,
  facts: readonly DraftOfficialCompanyFact[],
  sourceIdByUrl: ReadonlyMap<string, string>,
): Promise<number> {
  if (facts.length === 0) return 0;

  const rows: Record<string, unknown>[] = [];
  for (const fact of facts) {
    const sourceId = sourceIdByUrl.get(fact.sourceUrl);
    if (!sourceId) {
      // ★ 出典が解決できない値は保存しない（provenance の無い fact を作らない）。
      devWarn('[companyPrefetch] fact dropped: source unresolved');
      continue;
    }
    rows.push({
      company_id: fact.companyId,
      fact_group: fact.factGroup,
      fact_key: fact.factKey,
      fact_value: fact.factValue,
      source_id: sourceId,
      extraction_method: fact.extractionMethod,
      confidence: fact.confidence,
      fetched_at: fact.fetchedAt,
      valid_until: computeValidUntil(fact.factGroup, fact.fetchedAt),
    });
  }

  if (rows.length === 0) return 0;

  const { data, error } = await admin.from(FACTS).insert(rows).select('id');
  if (error) throw toStorageError(error, 'insertFacts');
  return Array.isArray(data) ? data.length : 0;
}

// ── 企業マスタへの法人番号の付与 ─────────────────────────────────────
/**
 * 解決できた法人番号を `career_company_master.corporate_number` へ書く（best-effort）。
 *
 * ★ 既に **別の**法人番号が入っている行は上書きしない（誤同定で企業を書き換えない）。
 *   衝突（別企業が同じ法人番号を持つ）は UNIQUE index が弾く。弾かれても job は失敗させない。
 */
export async function attachCorporateNumber(
  admin: SupabaseClient,
  companyId: string,
  corporateNumber: string,
): Promise<boolean> {
  if (!companyId || !/^\d{13}$/.test(corporateNumber)) return false;
  try {
    const { data, error } = await admin
      .from('career_company_master')
      .update({ corporate_number: corporateNumber })
      .eq('company_id', companyId)
      .is('corporate_number', null)
      .select('company_id');
    if (error) {
      devWarn('[companyPrefetch] corporate_number update skipped');
      return false;
    }
    return Array.isArray(data) && data.length === 1;
  } catch {
    return false;
  }
}

// ── 履歴の扱いについて（Phase 1 の明示的な決定）─────────────────────
//
// `career_company_official_facts.superseded_by` 列は DDL に用意してあるが、
// Phase 1 では **書き込まない**。理由:
//   - 読み出しは「fact_key ごとに fetched_at が最新の行」を採る（readRepository）ため、
//     supersede を書かなくても現行値は一意に決まる。
//   - 誤った supersede は「古い値だけが残る」形の壊れ方をする。書ける根拠が固まるまで
//     列を空のままにしておく方が安全（履歴は insert された行としてすべて残っている）。
// 明示的な運用（企業の統合・社名変更の反映）を実装する段階で書き込みを足す。
