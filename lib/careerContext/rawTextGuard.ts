// PASSAI CAREER 横断 context の raw 本文混入ゼロ検証（P3-G で導入）。
//
// 目的: Memory 化・匿名集計へ進む前に、ES 本文 / 面接回答 / 相談本文 / GD transcript /
//   企業研究 verifiedText などの「raw 本文」が、他機能へ渡す横断 context / snapshot に
//   混入していないことを**静的に**保証する。
//
// 方針（「常に禁止」ではなく「横断 context では禁止」）:
//   - 横断 snapshot（deny context）では raw 本文キー・長文自由記述を検出する。
//   - ただし各機能の正当な「添削対象 / 評価対象」（company-research review の verifiedResearchText、
//     gd_feedback の transcript、es_review の essay 本文）は allowedRawKeys で明示的に許可する。
//
// 厳守: 純関数のみ（I/O / env / secret なし）。throw しない。本番 route から自動実行しない。

export type RawTextFindingReason = 'raw_text_like_key' | 'long_free_text';

export type RawTextFinding = {
  path: string;
  key: string;
  reason: RawTextFindingReason;
};

export type RawTextGuardResult = {
  ok: boolean;
  findings: RawTextFinding[];
};

export type RawTextGuardOptions = {
  // このコンテキストで正当な raw キー（添削/評価対象など）。小文字比較。
  allowedRawKeys?: string[];
  // 長文自由記述とみなす文字数の閾値（既定 500）。要約(≤280級)は下回るため誤検出しにくい。
  maxFreeTextLen?: number;
};

// raw 本文らしいキーの token（小文字・部分一致）。'answers'/'messages' は 'answer'/'message' で拾う。
const DANGER_KEY_TOKENS: readonly string[] = [
  'body',
  'content',
  'text',
  'raw',
  'verifiedtext',
  'verifiedresearchtext',
  'answer',
  'transcript',
  'message',
  'prompt',
  'response',
  'essay',
  'draft',
  'memo',
  'note',
  'description',
  'email',
  'name',
];

// danger token を含むが本文ではない正当な識別子（既定で除外）。
const DEFAULT_SAFE_KEYS: ReadonlySet<string> = new Set(['companyname', 'displayname']);

const DEFAULT_MAX_FREE_TEXT = 500;

function isDangerKey(key: string, allowed: ReadonlySet<string>): boolean {
  const lower = key.toLowerCase();
  if (allowed.has(lower) || DEFAULT_SAFE_KEYS.has(lower)) return false;
  return DANGER_KEY_TOKENS.some((token) => lower.includes(token));
}

/**
 * 横断 context / snapshot オブジェクトを再帰的に検査し、raw 本文らしいキー・長文値を findings で返す。
 * allowedRawKeys に入れたキーは「そのコンテキストで正当」として検出しない（value も検査しない）。
 */
export function guardRawText(value: unknown, options: RawTextGuardOptions = {}): RawTextGuardResult {
  const allowed = new Set((options.allowedRawKeys ?? []).map((k) => k.toLowerCase()));
  const maxFreeTextLen = options.maxFreeTextLen ?? DEFAULT_MAX_FREE_TEXT;
  const findings: RawTextFinding[] = [];

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }

    if (typeof node === 'object') {
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        const childPath = path ? `${path}.${key}` : key;
        const keyAllowed = allowed.has(key.toLowerCase()) || DEFAULT_SAFE_KEYS.has(key.toLowerCase());

        // 危険キー名の検出。
        if (isDangerKey(key, allowed)) {
          findings.push({ path: childPath, key, reason: 'raw_text_like_key' });
        }

        // 長文自由記述の検出（許可キー配下は本文が正当なので除外）。
        if (!keyAllowed && typeof val === 'string' && val.length > maxFreeTextLen) {
          findings.push({ path: childPath, key, reason: 'long_free_text' });
        }

        // 許可キー配下は value を再帰しない（正当な raw 本文なので中を検査しない）。
        if (!keyAllowed) walk(val, childPath);
      }
      return;
    }
    // primitive（許可キー外の string 長文は上の分岐で処理済み）。
  };

  walk(value, '');
  return { ok: findings.length === 0, findings };
}
