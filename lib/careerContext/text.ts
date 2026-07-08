// PASSAI CAREER context 共通テキストフォーマッタ（P2-A で導入）。
//
// career prompt 向けの「安全な文字列整形」の共通入口。純粋関数のみ。
//   - I/O / env / localStorage / secret に一切触れない（client / server 両用）。
//   - null / undefined / 非文字列 / 空文字を安全に扱う。
//   - 長文は上限で切り、配列は件数で切る。object を無制限に stringify しない。
//
// 既存の各 route / lib に散在する str / strArray / truncate の「正本」を意図する。
// ただし P2-A では新規 formatter（activity.ts）と renderActivity の集約に留め、
// 既存コピーの置換は回帰リスク回避のため P2-B に送る（出力互換を最優先）。

const DEFAULT_ELLIPSIS = '…';

/** 非文字列は ''、文字列は trim して返す。 */
export function toSafeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** max 文字を超える場合だけ末尾を切って ellipsis を付ける。max 以下なら原文（trim 済み）を返す。 */
export function truncateText(
  value: unknown,
  max: number,
  ellipsis: string = DEFAULT_ELLIPSIS,
): string {
  const s = toSafeString(value);
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + ellipsis;
}

/** 空を除いて separator で連結する（値は trim 済み）。 */
export function joinNonEmpty(parts: Array<unknown>, separator: string = ' / '): string {
  return parts.map(toSafeString).filter((p) => p !== '').join(separator);
}

/** 空を除いた配列を最大 maxItems 件に切る。 */
export function compactList(values: Array<unknown>, maxItems: number): string[] {
  if (maxItems <= 0) return [];
  return values.map(toSafeString).filter((v) => v !== '').slice(0, maxItems);
}

/** 「label: value」を返す。label / value が空なら '' を返す。 */
export function formatKeyValue(label: string, value: unknown): string {
  const l = toSafeString(label);
  const v = toSafeString(value);
  if (l === '' || v === '') return '';
  return `${l}: ${v}`;
}

/** 箇条書き行に整形する（空除去 + 件数上限）。 */
export function formatBulletList(
  items: Array<unknown>,
  opts?: { bullet?: string; maxItems?: number },
): string {
  const bullet = opts?.bullet ?? '  - ';
  const maxItems = opts?.maxItems ?? items.length;
  return compactList(items, maxItems)
    .map((item) => `${bullet}${item}`)
    .join('\n');
}
