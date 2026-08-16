/**
 * Company Prefetch — 公的 registry provider（server-only・never-throw）。
 *
 * 既定の実装対象: 国税庁 法人番号システム Web-API（日本国内法人）。
 *   - 無料 / 構造化 / 法的に authoritative（登記の商号・所在地・変更履歴）
 *   - **AI を一切使わない**（identity 判定に LLM を使うと、hallucinate した canonical id が
 *     全ユーザー共有テーブルへ入る。ai_policy.md「入力にない事実の創作」の禁止に該当する）
 *
 * env（すべて未設定なら `isConfigured()=false` → 呼ばれず I/O ゼロ）:
 *   CAREER_CORPORATE_REGISTRY_APP_ID    アプリケーション ID（**secret**。値はログに出さない）
 *   CAREER_CORPORATE_REGISTRY_BASE_URL  endpoint（未設定なら既定値。差し替え・mock 用）
 *
 * ★ 列順に依存しない parser（registryParse.ts）を使う。応答が契約どおりに読めなければ
 *   `parse_error` を返して **何も保存しない**（誤読して global テーブルへ書かない）。
 *
 * 日本国外の法人はこの provider では解決できない。その場合 `unresolved` となり、
 * ユーザーは従来どおり free-text で全機能を使える（劣化しない）。
 */

import 'server-only';

import { safeFetch } from '@/lib/careerCompanyFetch/safeFetch.server';
import { extractDomain } from '@/lib/careerCompanyFetch/urlGuard';
import { normalizeCompanyName } from '@/lib/careerCompanyKnowledge/identity';
import { SINGLE_FETCH_TIMEOUT_MS } from '../constants';
import { isCompanyPrefetchExternalFetchEnabled } from '../flags.server';
import { parseRegistryCsv, selectExactCandidates } from './registryParse';
import type {
  CorporateRegistryProvider,
  ProviderSourceRef,
  RegistryLookupResult,
} from './types';

const DEFAULT_BASE_URL = 'https://api.houjin-bangou.nta.go.jp/4/name';

/** 応答形式: 02 = CSV / Unicode（Shift_JIS を避ける）。 */
const RESPONSE_TYPE = '02';

function getAppId(): string {
  const raw = process.env.CAREER_CORPORATE_REGISTRY_APP_ID;
  return typeof raw === 'string' ? raw.trim() : '';
}

function getBaseUrl(): string {
  const raw = process.env.CAREER_CORPORATE_REGISTRY_BASE_URL;
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value !== '' ? value : DEFAULT_BASE_URL;
}

/**
 * 問い合わせ URL を組む。
 * ★ secret（appId）は URL に載るため、**この URL を保存・ログしない**。
 *   出典として保存するのは secret を除いた表示用 URL（`buildProvenanceUrl`）。
 */
function buildRequestUrl(rawName: string): string | null {
  const appId = getAppId();
  if (appId === '') return null;
  try {
    const url = new URL(getBaseUrl());
    url.searchParams.set('id', appId);
    url.searchParams.set('name', rawName);
    url.searchParams.set('type', RESPONSE_TYPE);
    // 変更履歴を含める（旧商号 → alias(historical_name) の材料になる）。
    url.searchParams.set('history', '1');
    return url.toString();
  } catch {
    return null;
  }
}

/** 出典として保存する URL（**secret を含めない**）。 */
function buildProvenanceUrl(rawName: string): string {
  try {
    const url = new URL(getBaseUrl());
    url.searchParams.set('name', rawName);
    url.searchParams.set('type', RESPONSE_TYPE);
    url.searchParams.set('history', '1');
    return url.toString();
  } catch {
    return getBaseUrl();
  }
}

function buildSource(
  rawName: string,
  status: number | null,
  contentHash: string | null,
): ProviderSourceRef {
  const url = buildProvenanceUrl(rawName);
  return {
    sourceUrl: url,
    sourceType: 'corporate_registry',
    sourceDomain: extractDomain(url),
    httpStatus: status,
    contentHash,
    fetchedAt: new Date().toISOString(),
    // registry 応答に公開日時の概念は無い。推測で埋めない。
    publishedAt: null,
  };
}

export function createCorporateRegistryProvider(
  deps: { fetchImpl?: typeof fetch } = {},
): CorporateRegistryProvider {
  return {
    name: 'nta_corporate_number',

    isConfigured(): boolean {
      return getAppId() !== '';
    },

    async lookupByName(rawName: string): Promise<RegistryLookupResult> {
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      if (name === '') return { status: 'unresolved', source: null };

      // ★ flag OFF なら outbound I/O をしない（identity は内部 registry 照合のみで進む）。
      if (!isCompanyPrefetchExternalFetchEnabled()) {
        return { status: 'failed', reason: 'disabled' };
      }
      if (!this.isConfigured()) return { status: 'failed', reason: 'not_configured' };

      const requestUrl = buildRequestUrl(name);
      if (!requestUrl) return { status: 'failed', reason: 'not_configured' };

      const res = await safeFetch(requestUrl, {
        timeoutMs: SINGLE_FETCH_TIMEOUT_MS,
        accept: 'text/csv,text/plain;q=0.9',
        fetchImpl: deps.fetchImpl,
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
            // scheme / port / private address 等はすべて guard 由来。
            return { status: 'failed', reason: 'blocked_url' };
        }
      }

      const source = buildSource(name, res.status, res.contentHash);

      const parsed = parseRegistryCsv(res.body);
      if (parsed.length === 0) {
        // 応答は返ったが 1 行も同定できない = 該当なし or 契約不一致。
        // どちらも「保存しない」で同じ扱いにする（誤読して書くより安全）。
        return { status: 'unresolved', source };
      }

      // ★ 部分一致を resolved にしない。normalize 完全一致だけを候補に残す。
      const exact = selectExactCandidates(name, parsed, normalizeCompanyName);

      if (exact.length === 1) return { status: 'resolved', candidate: exact[0], source };
      if (exact.length > 1) return { status: 'ambiguous', candidates: exact, source };

      // 完全一致ゼロ = 部分一致しかない。ここで 1 社に決めると誤同定になるため決めない。
      return { status: 'unresolved', source };
    },
  };
}
