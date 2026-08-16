'use client';

/**
 * Company Identity — client 側の API 呼び出し境界（Phase A / R2）。
 *
 * 契約（最重要）:
 *   - **never throw**。ネットワーク断・env 未設定・未ログイン・flag OFF のいずれでも
 *     `{ available:false }` を返し、呼び出し側（CompanyPicker / 企業ページ）は
 *     free-text 入力へ倒す。Company Spine の不調で既存機能を止めない。
 *   - server の envelope（`{available:true,data} | {available:false,reason}`）をそのまま扱う。
 */

import { touchCompanyInDirectory } from './companyDirectory';
import type {
  CompanyIdentityEnvelope,
  CompanyRegisterResult,
  CompanyResolveResult,
} from '@/types/careerCompanyIdentity';

type Envelope<T> = CompanyIdentityEnvelope<T>;

const UNAVAILABLE = { available: false, reason: 'lookup_error' } as const;

async function postJson<T>(url: string, body: unknown): Promise<Envelope<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return UNAVAILABLE;
    const json = (await res.json()) as Envelope<T>;
    if (!json || typeof json !== 'object') return UNAVAILABLE;
    return json;
  } catch {
    return UNAVAILABLE;
  }
}

/** 企業名を解決する。ambiguous / unresolved はそのまま返す（自動確定しない）。 */
export async function resolveCompanyByName(
  name: string,
): Promise<Envelope<CompanyResolveResult>> {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '') {
    return { available: true, data: { status: 'unresolved', suggestions: [] } };
  }
  return postJson<CompanyResolveResult>('/api/career/company/resolve', { name: trimmed });
}

/** 企業を登録する。既存企業があれば created:false で既存 ID が返る。 */
export async function registerCompanyByName(
  displayName: string,
  aliases: readonly string[] = [],
): Promise<Envelope<CompanyRegisterResult>> {
  const result = await postJson<CompanyRegisterResult>('/api/career/company/register', {
    displayName,
    aliases,
  });
  // 登録直後は必ず表示キャッシュへ反映（詳細ページで名前が出るように）。
  if (result.available && result.data) {
    touchCompanyInDirectory(result.data.companyId, result.data.displayName);
  }
  return result;
}

export type CompanyLookupData = { companyId: string; displayName: string } | null;

/** companyId から企業を引く（見つからなければ data:null）。 */
export async function lookupCompanyById(
  companyId: string,
): Promise<Envelope<CompanyLookupData>> {
  const id = typeof companyId === 'string' ? companyId.trim() : '';
  if (id === '') return { available: true, data: null };
  try {
    const res = await fetch(
      `/api/career/company/lookup?companyId=${encodeURIComponent(id)}`,
      { method: 'GET' },
    );
    if (!res.ok) return UNAVAILABLE;
    const json = (await res.json()) as Envelope<CompanyLookupData>;
    if (!json || typeof json !== 'object') return UNAVAILABLE;
    if (json.available && json.data) {
      touchCompanyInDirectory(json.data.companyId, json.data.displayName);
    }
    return json;
  } catch {
    return UNAVAILABLE;
  }
}
