/**
 * Company Prefetch — 検索 provider 応答の正規化（pure・決定論・never-throw・I/O ゼロ）。
 *
 * provider 非依存にする理由:
 *   検索 API（Brave / Google CSE / Bing / Tavily / 自社 proxy）は JSON の形が全部違うが、
 *   本機能が必要なのは `url` / `title` / `snippet` の 3 つだけ。
 *   provider ごとに parser を書くと差し替えのたびに job service まで波及するため、
 *   **「よくある形をすべて受ける 1 つの正規化器」**にして provider 差分を吸収する。
 *
 * ★ ここで順位に意味を与えない。返す配列は「候補の集合」であって「公式サイトの推定」ではない
 *   （公式判定は domainVerification.ts が実ページを取得して行う）。
 */

import type { SearchHit } from './types';

/** 候補配列が入っていそうな key（provider ごとの慣用名）。 */
const RESULT_ARRAY_KEYS: readonly string[] = [
  'results',
  'items',
  'webPages',
  'web',
  'organic',
  'organic_results',
  'data',
  'hits',
];

const URL_KEYS: readonly string[] = ['url', 'link', 'href', 'displayUrl', 'display_url'];
const TITLE_KEYS: readonly string[] = ['title', 'name', 'heading'];
const SNIPPET_KEYS: readonly string[] = [
  'snippet',
  'description',
  'content',
  'summary',
  'excerpt',
];

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

/** 応答 JSON から候補配列を探す（入れ子 1 段まで。深追いしない）。 */
function findResultArray(payload: unknown, depth = 0): unknown[] {
  if (depth > 3 || !payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object') return [];

  const obj = payload as Record<string, unknown>;
  for (const key of RESULT_ARRAY_KEYS) {
    const v = obj[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const nested = findResultArray(v, depth + 1);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

/**
 * 検索 provider の JSON 応答 → `SearchHit[]`（決定論・上限付き）。
 *
 * url が取れない要素は捨てる（title だけの行は候補にならない）。
 */
export function normalizeSearchHits(payload: unknown, maxHits = 10): SearchHit[] {
  const rows = findResultArray(payload);
  const out: SearchHit[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= maxHits) break;
    if (!row || typeof row !== 'object') continue;
    const obj = row as Record<string, unknown>;

    const url = pickString(obj, URL_KEYS);
    if (url === '' || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    out.push({
      url,
      title: pickString(obj, TITLE_KEYS),
      snippet: pickString(obj, SNIPPET_KEYS),
    });
  }

  return out;
}

/**
 * 公式サイト探索用の検索クエリを組む（pure・決定論）。
 *
 * ★ 「公式サイト」という語を足すだけに留める。業界名や推測語を混ぜると
 *   検索結果が別企業へ寄る（誤同定の入口になる）。
 */
export function buildOfficialSiteQuery(displayName: string, legalName: string | null): string {
  const name = (legalName ?? displayName ?? '').trim() || (displayName ?? '').trim();
  if (name === '') return '';
  return `${name} 公式サイト`;
}
