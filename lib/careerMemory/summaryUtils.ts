// PASSAI CAREER — 横断 summary/snapshot 生成で共有する純関数 helper（P4-B）。
//
// 目的: historySnapshots / pastLogSummary / careerGd / careerMatching /
//   careerCompanyResearch / consultation route に各自再宣言されていた小さな helper を
//   1 箇所へ集約する。**出力は既存実装と byte 単位で同一**（P4-B の絶対条件）。
//
// 厳守:
//   - 純関数のみ（I/O / env / secret / DOM / Supabase なし）。副作用なし。
//   - 既存実装と出力が完全一致するもの **だけ** を集約する。
//   - 挙動差のある variant（truncate の suffix 差・strList の max=6 filter 版 等）は
//     ここに **入れない**（各 module の local 実装を維持する）。詳細は
//     docs/qa/p4a_memory_types_map.md §E / P4-B 完了報告を参照。

// 文字列を trim。string 以外は空文字。
// （historySnapshots / pastLogSummary / careerGd / careerMatching /
//   careerCompanyResearch / consultation route で完全一致していた実装）。
export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// value を str 正規化し、max 超過なら末尾を trim して '…' を付ける。
// （historySnapshots / pastLogSummary の truncate と完全一致。
//   careerGd の truncate(text:string,…) は入力型のみ差・出力同一だが P4-B では未統合。
//   careerCompanyResearch の truncate は suffix が '…（以下略）' で **異なる** ため未統合。）
export function truncate(value: unknown, max: number): string {
  const t = str(value);
  if (t.length <= max) return t;
  return `${t.slice(0, max).trim()}…`;
}

// 配列を各要素 truncate(itemMax) → 空除去 → 先頭 max 件。
// （historySnapshots(既定 itemMax=60) / pastLogSummary(既定 itemMax=40) と本体一致。
//   全呼び出しが itemMax を明示するため既定値は出力に影響しない。
//   careerGd / careerMatching の strList(max=6・per-item truncate 無し) は別実装のため未統合。）
export function strList(value: unknown, max = 3, itemMax = 40): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => truncate(v, itemMax))
    .filter((v) => v !== '')
    .slice(0, max);
}

// 複数リスト群で minCount 回以上出現する項目（同一リスト内の重複は 1 回）。
// （historySnapshots / pastLogSummary の repeatedItems と完全一致。history 側にあった
//   内部コメントは出力に影響しない。）
export function repeatedItems(lists: string[][], minCount = 2): string[] {
  const count = new Map<string, number>();
  for (const list of lists) {
    for (const item of new Set(list)) {
      count.set(item, (count.get(item) ?? 0) + 1);
    }
  }
  return [...count.entries()]
    .filter(([, c]) => c >= minCount)
    .map(([item]) => item);
}

// 数値を 0–100 に丸めてクランプ（非数は 0）。
// careerMatching の round100 と careerGd の clamp100 は **実装が完全一致** していたため
// 同一実装を 2 名で export し、各 module は既存の呼び出し名のまま import する（呼び出し byte 不変）。
function clampScore100(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(100, Math.max(0, n)));
}
export const round100 = clampScore100;
export const clamp100 = clampScore100;
