/**
 * Company Prefetch — 公式サイト取得 provider（server-only・never-throw）。
 *
 * 責務は「安全に 1 ページ取得して、決定論で読める形に落とす」ことだけ。
 *   - fetch は必ず `safeFetch`（SSRF guard / timeout / size cap / content-type）
 *   - HTML → text / title / links / JSON-LD は pure module（htmlText.ts）へ委譲
 *   - **HTML 全文は返さない・保存しない**（上限を掛けた text だけ）
 *
 * 企業情報の解釈・推測はここでは一切しない（抽出は extraction.ts、判定は job service）。
 */

import 'server-only';

import { safeFetch } from '@/lib/careerCompanyFetch/safeFetch.server';
import { extractDomain } from '@/lib/careerCompanyFetch/urlGuard';
import { MAX_EXTRACTION_INPUT_CHARS, SINGLE_FETCH_TIMEOUT_MS } from '../constants';
import { isCompanyPrefetchExternalFetchEnabled } from '../flags.server';
import { extractLinks, extractTitle, htmlToText } from '../htmlText';
import type {
  OfficialSiteFetchResult,
  OfficialSiteProvider,
  ProviderSourceRef,
} from './types';

/** 生 HTML を保持したまま渡すための拡張（JSON-LD 抽出に必要）。 */
export type OfficialSiteRawDocument = {
  url: string;
  html: string;
  text: string;
  title: string;
  links: readonly { href: string; label: string }[];
  source: ProviderSourceRef;
};

/**
 * 生 HTML 込みで取得する（同一 process 内で JSON-LD 抽出まで行うため）。
 * ★ 呼び出し側は `html` を **保存しない**（source には contentHash のみ入れる）。
 */
export async function fetchOfficialSiteRaw(
  url: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<
  { status: 'ok'; document: OfficialSiteRawDocument } | { status: 'failed'; reason: OfficialSiteFailureReason }
> {
  if (typeof url !== 'string' || url.trim() === '') {
    return { status: 'failed', reason: 'parse_error' };
  }
  if (!isCompanyPrefetchExternalFetchEnabled()) {
    return { status: 'failed', reason: 'disabled' };
  }

  const res = await safeFetch(url, {
    timeoutMs: SINGLE_FETCH_TIMEOUT_MS,
    fetchImpl: deps.fetchImpl,
  });

  if (!res.ok) {
    switch (res.reason) {
      case 'timeout':
        return { status: 'failed', reason: 'timeout' };
      case 'http_error':
        return { status: 'failed', reason: res.status === 429 ? 'rate_limited' : 'provider_error' };
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

  const text = htmlToText(res.body, MAX_EXTRACTION_INPUT_CHARS);
  if (text.trim() === '') return { status: 'failed', reason: 'parse_error' };

  return {
    status: 'ok',
    document: {
      url: res.finalUrl,
      html: res.body,
      text,
      title: extractTitle(res.body),
      links: extractLinks(res.body, res.finalUrl),
      source: {
        sourceUrl: res.finalUrl,
        sourceType: 'official_site',
        sourceDomain: extractDomain(res.finalUrl),
        httpStatus: res.status,
        contentHash: res.contentHash,
        fetchedAt: new Date().toISOString(),
        publishedAt: res.publishedAt,
      },
    },
  };
}

type OfficialSiteFailureReason =
  | 'not_configured'
  | 'disabled'
  | 'timeout'
  | 'rate_limited'
  | 'provider_error'
  | 'blocked_url'
  | 'parse_error';

export function createOfficialSiteProvider(
  deps: { fetchImpl?: typeof fetch } = {},
): OfficialSiteProvider {
  return {
    name: 'safe_official_site',

    // 追加の env を必要としない（safeFetch と flag だけで完結する）。
    isConfigured(): boolean {
      return true;
    },

    async fetchDocument(url: string): Promise<OfficialSiteFetchResult> {
      const raw = await fetchOfficialSiteRaw(url, deps);
      if (raw.status === 'failed') return { status: 'failed', reason: raw.reason };
      const { html: _html, ...doc } = raw.document;
      void _html; // 生 HTML は境界の外へ出さない。
      return { status: 'ok', document: doc };
    },
  };
}
