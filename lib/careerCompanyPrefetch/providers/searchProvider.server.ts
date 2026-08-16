/**
 * Company Prefetch — 検索 provider（server-only・never-throw・provider 非依存）。
 *
 * 用途は **official domain discovery の候補出し 1 点のみ**。
 *   企業研究の本文をここから作らない（検索スニペットは出典として弱く、
 *   `ai_policy.md` の「入力にない事実の創作」に最も近い経路になる）。
 *
 * env（未設定なら `isConfigured()=false` → 呼ばれず I/O ゼロ）:
 *   CAREER_COMPANY_SEARCH_ENDPOINT   検索 API の URL（`{query}` を含めると置換される）
 *   CAREER_COMPANY_SEARCH_API_KEY    API key（**secret**。値はログにも出典 URL にも出さない）
 *   CAREER_COMPANY_SEARCH_AUTH_HEADER  key を載せるヘッダ名（既定 'X-Subscription-Token'）
 *   CAREER_COMPANY_SEARCH_QUERY_PARAM  query の param 名（既定 'q'）
 *
 * ★ 特定 provider に強く依存しない: 応答は `normalizeSearchHits` が
 *   「よくある形」をすべて受ける（Brave / Google CSE / Bing / Tavily / 自社 proxy）。
 *   差し替えは env だけで済み、job service には影響しない。
 */

import 'server-only';

import { safeFetch } from '@/lib/careerCompanyFetch/safeFetch.server';
import { extractDomain } from '@/lib/careerCompanyFetch/urlGuard';
import { SINGLE_FETCH_TIMEOUT_MS } from '../constants';
import { isCompanyPrefetchExternalFetchEnabled } from '../flags.server';
import { normalizeSearchHits } from './searchParse';
import type { CompanySearchProvider, ProviderSourceRef, SearchResult } from './types';

function env(name: string): string {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

function getEndpoint(): string {
  return env('CAREER_COMPANY_SEARCH_ENDPOINT');
}

function getApiKey(): string {
  return env('CAREER_COMPANY_SEARCH_API_KEY');
}

function getAuthHeader(): string {
  return env('CAREER_COMPANY_SEARCH_AUTH_HEADER') || 'X-Subscription-Token';
}

function getQueryParam(): string {
  return env('CAREER_COMPANY_SEARCH_QUERY_PARAM') || 'q';
}

/**
 * 検索 URL を組む。
 * endpoint に `{query}` があればそこへ埋め、無ければ query param として付ける。
 */
function buildSearchUrl(query: string): string | null {
  const endpoint = getEndpoint();
  if (endpoint === '') return null;
  try {
    if (endpoint.includes('{query}')) {
      return endpoint.replace('{query}', encodeURIComponent(query));
    }
    const url = new URL(endpoint);
    url.searchParams.set(getQueryParam(), query);
    return url.toString();
  } catch {
    return null;
  }
}

/** 出典として保存する URL（**secret を含めない**。query は残す）。 */
function buildProvenanceUrl(query: string): string {
  const built = buildSearchUrl(query);
  if (!built) return '';
  try {
    const url = new URL(built);
    // key が query string に載る provider 構成でも、保存側には残さない。
    for (const key of ['key', 'apikey', 'api_key', 'token', 'subscription-key']) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return '';
  }
}

function buildSource(query: string, status: number | null, hash: string | null): ProviderSourceRef {
  const url = buildProvenanceUrl(query);
  return {
    sourceUrl: url,
    sourceType: 'search_result',
    sourceDomain: extractDomain(url),
    httpStatus: status,
    contentHash: hash,
    fetchedAt: new Date().toISOString(),
    publishedAt: null,
  };
}

export function createCompanySearchProvider(
  deps: { fetchImpl?: typeof fetch } = {},
): CompanySearchProvider {
  return {
    name: 'configurable_search',

    isConfigured(): boolean {
      return getEndpoint() !== '';
    },

    async searchOfficialSite(query: string): Promise<SearchResult> {
      const q = typeof query === 'string' ? query.trim() : '';
      if (q === '') return { status: 'empty', source: null };

      if (!isCompanyPrefetchExternalFetchEnabled()) {
        return { status: 'failed', reason: 'disabled' };
      }
      if (!this.isConfigured()) return { status: 'failed', reason: 'not_configured' };

      const url = buildSearchUrl(q);
      if (!url) return { status: 'failed', reason: 'not_configured' };

      const apiKey = getApiKey();
      // safeFetch は固定ヘッダしか送らないため、認証が必要な provider 用に
      // fetchImpl をラップして header を足す（guard は safeFetch 側で維持される）。
      const fetchImpl: typeof fetch = apiKey
        ? (input, init) => {
            const headers = new Headers(init?.headers);
            headers.set(getAuthHeader(), apiKey);
            headers.set('Accept', 'application/json');
            return (deps.fetchImpl ?? fetch)(input, { ...init, headers });
          }
        : (deps.fetchImpl ?? fetch);

      const res = await safeFetch(url, {
        timeoutMs: SINGLE_FETCH_TIMEOUT_MS,
        accept: 'application/json',
        fetchImpl,
      });

      if (!res.ok) {
        switch (res.reason) {
          case 'timeout':
            return { status: 'failed', reason: 'timeout' };
          case 'http_error':
            return {
              status: 'failed',
              reason: res.status === 429 ? 'rate_limited' : 'provider_error',
            };
          case 'content_type_not_allowed':
          case 'response_too_large':
          case 'empty_body':
            return { status: 'failed', reason: 'parse_error' };
          case 'network_error':
          case 'dns_error':
            return { status: 'failed', reason: 'provider_error' };
          default:
            return { status: 'failed', reason: 'blocked_url' };
        }
      }

      const source = buildSource(q, res.status, res.contentHash);

      let payload: unknown;
      try {
        payload = JSON.parse(res.body);
      } catch {
        return { status: 'failed', reason: 'parse_error' };
      }

      const hits = normalizeSearchHits(payload);
      if (hits.length === 0) return { status: 'empty', source };
      return { status: 'ok', hits, source };
    },
  };
}
