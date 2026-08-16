/**
 * Company Fetch — 唯一の outbound fetch 境界（server-only・never-throw）。
 *
 * ★★ company enrichment のコードは `fetch(` を直接書かない ★★
 *   本 module 以外に outbound fetch を置くと SSRF guard を回避できてしまう。
 *   `scripts/career-company-fetch-guard-qa.ts` が静的にこれを固定する。
 *
 * 本 module が担保すること:
 *   - http / https のみ（scheme allowlist）
 *   - IP literal 拒否 / 内部専用 host 名拒否 / port allowlist
 *   - **DNS 解決後**の全アドレスを検証（private / loopback / link-local / metadata を拒否）
 *     → 公開ドメインに見えても A レコードが内部を指す DNS rebinding を塞ぐ
 *   - redirect を手動追跡し、**各 hop で同じ guard を再評価**（上限あり）
 *   - timeout（AbortSignal）
 *   - response size cap（stream を読みながら超過時点で中断。全部読んでから捨てない）
 *   - content-type allowlist（バイナリを取得しない）
 *   - credential / cookie を送らない・保存しない
 *
 * 返さないもの: raw な Response・redirect chain の全 URL。
 *   呼び出し側が扱うのは「最終 URL・status・本文テキスト・hash」だけ。
 */

import 'server-only';

import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';

import {
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  SINGLE_FETCH_TIMEOUT_MS,
} from '@/lib/careerCompanyPrefetch/constants';
import { devWarn } from '@/lib/devLog';
import {
  guardUrl,
  isAllowedContentType,
  isBlockedAddress,
  type UrlGuardRejection,
} from './urlGuard';

/** 失敗理由（固定 enum。provider の raw message は絶対に混ぜない）。 */
export type SafeFetchFailure =
  | UrlGuardRejection
  | 'redirect_limit'
  | 'redirect_missing_location'
  | 'dns_error'
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'content_type_not_allowed'
  | 'response_too_large'
  | 'empty_body';

export type SafeFetchOk = {
  ok: true;
  /** redirect 追跡後の最終 URL。 */
  finalUrl: string;
  status: number;
  contentType: string;
  /** 本文（テキスト）。size cap 済み。 */
  body: string;
  /** 本文の SHA-256 hex（同一性判定用。本文を保存しないための代替キー）。 */
  contentHash: string;
  /** 応答ヘッダ由来の公開日時（取得できたときだけ・推測しない）。 */
  publishedAt: string | null;
  bytes: number;
};

export type SafeFetchResult = SafeFetchOk | { ok: false; reason: SafeFetchFailure; status: number | null };

export type SafeFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** 送信する Accept ヘッダ（既定は HTML/テキスト）。 */
  accept?: string;
  /**
   * DI 用（QA がネットワーク無しで全分岐を検証するため）。
   * 未指定なら global fetch / node:dns を使う。
   */
  fetchImpl?: typeof fetch;
  lookupImpl?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
};

/**
 * 企業サイトに対して名乗る User-Agent。
 * 匿名化・偽装をしない（運用上の問い合わせ先を明示できる形にしておく）。
 */
const USER_AGENT = 'PASSAI-CAREER-CompanyPrefetch/1.0 (+https://passai.jp)';

const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8';

async function defaultLookup(
  hostname: string,
): Promise<readonly { address: string; family: number }[]> {
  const res = await lookup(hostname, { all: true, verbatim: true });
  return Array.isArray(res) ? res : [res];
}

/**
 * host の **全**解決アドレスが public かを検証する。
 * 1 つでも内部アドレスを含むなら fetch しない（一部が public でも許可しない）。
 */
async function assertPublicHost(
  host: string,
  lookupImpl: NonNullable<SafeFetchOptions['lookupImpl']>,
): Promise<'ok' | 'dns_error' | 'address_not_public'> {
  let records: readonly { address: string; family: number }[];
  try {
    records = await lookupImpl(host);
  } catch {
    return 'dns_error';
  }
  if (!Array.isArray(records) || records.length === 0) return 'dns_error';
  for (const rec of records) {
    const family = rec?.family === 6 ? 6 : 4;
    if (isBlockedAddress(rec?.address ?? '', family)) return 'address_not_public';
  }
  return 'ok';
}

/** Last-Modified / Date から publishedAt を取り出す（無ければ null。推測しない）。 */
function readPublishedAt(headers: Headers): string | null {
  const lastModified = headers.get('last-modified');
  if (lastModified) {
    const ms = new Date(lastModified).getTime();
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/** size cap を守りながら本文を読む（超過時点で中断する）。 */
async function readCappedText(
  res: Response,
  maxBytes: number,
): Promise<{ ok: true; text: string; bytes: number } | { ok: false; reason: 'response_too_large' | 'network_error' }> {
  // Content-Length が既に上限超過なら本文を読まずに捨てる。
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      /* noop */
    }
    return { ok: false, reason: 'response_too_large' };
  }

  const body = res.body;
  if (!body) {
    // stream が無い環境向けの保守的な fallback。
    try {
      const text = await res.text();
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > maxBytes) return { ok: false, reason: 'response_too_large' };
      return { ok: true, text, bytes };
    } catch {
      return { ok: false, reason: 'network_error' };
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* noop */
        }
        return { ok: false, reason: 'response_too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'network_error' };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder('utf-8', { fatal: false }).decode(merged), bytes: total };
}

/**
 * 企業サイト / 公的 API を安全に GET する。
 *
 * never-throw。失敗は必ず `{ok:false, reason}` で返す（呼び出し側の分岐を型で強制する）。
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? SINGLE_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupImpl = options.lookupImpl ?? defaultLookup;

  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // ★ 各 hop で必ず guard を通す（初回だけ検証する実装は guard を無効化する）。
    const guarded = guardUrl(currentUrl);
    if (!guarded.ok) return { ok: false, reason: guarded.reason, status: null };

    const dns = await assertPublicHost(guarded.host, lookupImpl);
    if (dns !== 'ok') {
      return { ok: false, reason: dns === 'dns_error' ? 'dns_error' : 'address_not_public', status: null };
    }

    let res: Response;
    try {
      res = await fetchImpl(guarded.url.toString(), {
        method: 'GET',
        // ★ redirect は手動追跡する（自動追従は guard を素通りさせる）。
        redirect: 'manual',
        // cookie / credential を送らない・保存しない。
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: options.accept ?? DEFAULT_ACCEPT,
          'Accept-Language': 'ja,en;q=0.8',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      return {
        ok: false,
        reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error',
        status: null,
      };
    }

    // ── redirect ────────────────────────────────────────────────────
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      try {
        await res.body?.cancel();
      } catch {
        /* noop */
      }
      if (!location) return { ok: false, reason: 'redirect_missing_location', status: res.status };
      if (hop >= maxRedirects) return { ok: false, reason: 'redirect_limit', status: res.status };
      // 相対 Location を絶対化してから次 hop の guard へ渡す。
      try {
        currentUrl = new URL(location, guarded.url).toString();
      } catch {
        return { ok: false, reason: 'invalid_url', status: res.status };
      }
      continue;
    }

    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        /* noop */
      }
      return { ok: false, reason: 'http_error', status: res.status };
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!isAllowedContentType(contentType)) {
      try {
        await res.body?.cancel();
      } catch {
        /* noop */
      }
      return { ok: false, reason: 'content_type_not_allowed', status: res.status };
    }

    const read = await readCappedText(res, maxBytes);
    if (!read.ok) return { ok: false, reason: read.reason, status: res.status };
    if (read.text.trim() === '') return { ok: false, reason: 'empty_body', status: res.status };

    return {
      ok: true,
      finalUrl: guarded.url.toString(),
      status: res.status,
      contentType: contentType.split(';')[0]?.trim().toLowerCase() ?? '',
      body: read.text,
      contentHash: createHash('sha256').update(read.text, 'utf8').digest('hex'),
      publishedAt: readPublishedAt(res.headers),
      bytes: read.bytes,
    };
  }

  devWarn('[companyFetch] redirect limit exceeded');
  return { ok: false, reason: 'redirect_limit', status: null };
}
