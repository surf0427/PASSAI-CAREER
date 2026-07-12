// PASSAI CAREER — Personal Memory source revision（P16-A Stage 3）。
//
// Memory payload がどの Source Data から作られたかを追跡する **決定的** token を算出する。
// stale 判定（source change 検知）が目的で、security hash ではない。
//
// 厳守:
//   - Date.now() / random / object 挿入順依存 / locale 依存 / 架空 latestId / 生 PII / transcript 本文を含めない。
//   - 新規 package を追加しない（browser 兼用のため node:crypto ではなく決定的 string hash を使う）。
//   - 検知: add / update / delete / latest change / ordering change / empty / duplicate / restore 差。

import { stableStringify } from './validate';

// FNV-1a 32bit（決定的・依存なし・browser 兼用）。change 検知 token 用途（暗号強度は不要）。
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // 符号なし 32bit hex（8 桁固定）。
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── log 系（self_analysis / es / interview）の latest Source 時刻（sourceUpdatedAt 観測用） ──
//   最大 createdAt。無ければ null。revision 自体は builder が payload content から算出する
//   （computeContentRevision）＝add/update/delete/latest/order/empty を content ベースで検知する。
export function computeLogSectionLatestAt(
  entries: ReadonlyArray<{ createdAt: unknown }>,
): string | null {
  let max: string | null = null;
  for (const e of entries) {
    if (typeof e.createdAt === 'string' && e.createdAt !== '' && (max === null || e.createdAt > max)) {
      max = e.createdAt;
    }
  }
  return max;
}

// ── base 系（stable id なし・単一 object）: profile + activity + values ──
// revision = 生成済み payload（PII 除去済 projection）の stableStringify の hash。
//   内容変化（追加/更新/削除）を content ベースで検知する。生 PII は payload に無いため revision にも入らない。
export function computeContentRevision(projectedPayload: unknown): string {
  return 'v1:content:' + fnv1a(stableStringify(projectedPayload));
}
