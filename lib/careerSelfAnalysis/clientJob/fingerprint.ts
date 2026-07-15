// 自己分析まとめ生成 — client-side submission fingerprint（Step3）。
//
// 用途は「UI 上の同一 submission 識別」のみ。**DB idempotency key ではない**。
// server-authoritative idempotency key を client で再現しようとしない
//   （正式 key は server が user ID + revision から算出する）。
//
// 決定論・同期・依存なし（reload 前後・タブ間で同一入力なら同一値）。

import type { SelfAnalysisRequestBody } from './types';

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value === undefined ? null : value;
  if (Array.isArray(value)) return value.map(canonical);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) out[k] = canonical(obj[k]);
  return out;
}

// 短い非暗号ハッシュ（djb2 xor）。衝突耐性は UI 識別に十分。
function djb2(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 入力から UI submission fingerprint を算出（conversation 含む）。 */
export function computeClientFingerprint(body: SelfAnalysisRequestBody): string {
  const shape = {
    profile: body.profile ?? null,
    activity: body.activity ?? null,
    values: body.values ?? null,
    conversation: body.conversation ?? [],
  };
  return `fp_${djb2(JSON.stringify(canonical(shape)))}`;
}
