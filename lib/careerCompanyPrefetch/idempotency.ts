/**
 * Company Prefetch — company-scoped idempotency（server-authoritative）。
 *
 * ★ 既存 `lib/careerGenerationJob/idempotency.ts` の hash 関数を **そのまま再利用**する
 *   （同じ規約を 2 つ書かない）。違うのは key の材料だけ:
 *
 *     generation job : user_id + feature + operation + input/prompt/schema revision
 *     company prefetch: company_id + task + fetcher_revision + schema_revision
 *                       ★ **user_id を材料に含めない**
 *
 *   user_id を含めないことが Requirement C / Q7 の本体:
 *   100 人が「ソニー」を志望しても natural key が同一になり、外部取得は 1 回へ収束する。
 *
 * client 申告値は一切使わない（企業名すら key の材料にしない。canonical company id のみ）。
 */

import { sha256Hex, stableStringify } from '@/lib/careerGenerationJob/idempotency';
import {
  COMPANY_ENRICHMENT_TASK,
  COMPANY_FACT_SCHEMA_REVISION,
  COMPANY_FETCHER_REVISION,
} from './constants';

/** job の同一性を決める材料（hash 前）。 */
export type CompanyEnrichmentIdentity = {
  companyId: string;
  task: string;
  fetcherRevision: string;
  schemaRevision: string;
  idempotencyKey: string;
};

/**
 * canonical company id から idempotency key を算出する。
 *
 * ★ 純粋関数（同じ入力 → 同じ key）。QA が決定論を固定する。
 */
export function buildCompanyEnrichmentIdentity(params: {
  companyId: string;
  task?: string;
  fetcherRevision?: string;
  schemaRevision?: string;
}): CompanyEnrichmentIdentity {
  const companyId = typeof params.companyId === 'string' ? params.companyId.trim() : '';
  const task = params.task ?? COMPANY_ENRICHMENT_TASK;
  const fetcherRevision = params.fetcherRevision ?? COMPANY_FETCHER_REVISION;
  const schemaRevision = params.schemaRevision ?? COMPANY_FACT_SCHEMA_REVISION;

  const idempotencyKey = sha256Hex(
    stableStringify({
      // ★ user 情報は入れない（global work であることを key の形で表現する）。
      companyId,
      task,
      fetcherRevision,
      schemaRevision,
    }),
  );

  return { companyId, task, fetcherRevision, schemaRevision, idempotencyKey };
}
