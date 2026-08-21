/**
 * PASSAI CAREER — daily quota の **operation identity**（純関数）。
 *
 * 目的:
 *   「その 1 回の実行」を server 側だけで識別できるようにする。retry / 二重送信は
 *   同じ identity になり、ユーザーが明示的に実行し直したときは別の実行として扱われる。
 *
 * 設計の核（security）:
 *   operation id は **server が request 内容から計算する digest** であり、
 *   client が任意に指定できる id ではない。したがって
 *     - client が同じ id を送り続けて quota を無限に迂回する
 *     - client が毎回違う id を送って dedupe を壊す
 *   のどちらも成立しない。
 *
 * ★ digest が同一でも「永久に同じ operation」にはならない。
 *   同一性の判定には DB 側の **実行状態**（in_flight / settled）が組み合わさる:
 *     in_flight 中の同一 digest … retry / 二重送信 → +0
 *     settled 後の同一 digest   … 明示的な再実行   → +1
 *   （supabase/career_daily_quota_apply.sql §6.1）
 *   digest だけで dedupe を完結させないのが、この設計の要点。
 *
 * server-only を付けない理由: QA script（tsx 直実行）から unit test するため。
 * node:crypto しか使わず I/O は無い（client bundle からは import しない）。
 */

import { createHash } from 'node:crypto';

/**
 * 安定した JSON 直列化（object の key 順序に依存しない）。
 *
 * JSON.stringify は key の挿入順で結果が変わるため、そのままでは
 * 「同じ body なのに digest が違う」が起こりうる。key を辞書順に固定する。
 * undefined / function / symbol は JSON と同じく落とす。循環参照は '[circular]'。
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();

  function walk(v: unknown): string {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'number') return Number.isFinite(v as number) ? JSON.stringify(v) : 'null';
    if (t === 'boolean' || t === 'string') return JSON.stringify(v);
    if (t !== 'object') return 'null'; // undefined / function / symbol / bigint
    const obj = v as object;
    if (seen.has(obj)) return '"[circular]"';
    seen.add(obj);
    let out: string;
    if (Array.isArray(obj)) {
      out = `[${obj.map((item) => walk(item)).join(',')}]`;
    } else {
      const keys = Object.keys(obj as Record<string, unknown>).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const raw = (obj as Record<string, unknown>)[k];
        if (raw === undefined || typeof raw === 'function' || typeof raw === 'symbol') continue;
        parts.push(`${JSON.stringify(k)}:${walk(raw)}`);
      }
      out = `{${parts.join(',')}}`;
    }
    seen.delete(obj);
    return out;
  }

  return walk(value);
}

/** operation 入力の digest（SHA-256 の先頭 32 桁）。実値・PII は復元できない。 */
export function careerQuotaOperationDigest(source: unknown): string {
  return createHash('sha256').update(canonicalJson(source)).digest('hex').slice(0, 32);
}

/**
 * operation id を返す（feature で namespace 化した digest）。
 *
 * @param feature quota bucket。同一入力でも feature が違えば別 operation。
 * @param source  operation を決める素材（server 側の値のみ。通常は parse 済み body）。
 */
export function buildCareerQuotaOperationId(feature: string, source: unknown): string {
  return `${feature}:${careerQuotaOperationDigest(source)}`;
}
