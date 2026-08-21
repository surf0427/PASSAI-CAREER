/**
 * PASSAI CAREER — daily quota の **operation identity**（純関数）。
 *
 * 目的（Phase 4 / retry・二重送信・reload 対策）:
 *   「同じ操作」を何度 request しても利用回数を 1 しか消費しないための識別子を作る。
 *
 * 設計の核（security）:
 *   operation id は **server が request 内容から計算する digest** であり、
 *   client が任意に指定できる id ではない。
 *     - client が同じ id を送り続けて quota を無限に迂回する、という攻撃が成立しない。
 *     - 同一 digest = 同一入力 = 同一の成果物なので、消費しないのが正しい
 *       （AI の再実行が起きても得られる価値は増えない）。
 *   逆に入力が 1 文字でも変われば別 operation として 1 消費する。
 *
 * dedupe の粒度:
 *   - 既定は「その JST 日のあいだ同一 digest は 1 回」。
 *   - `windowSeconds` を渡した機能（面接 start）は digest に時間 bucket を混ぜる。
 *     境界で取りこぼさないよう、直前 bucket の id も候補として返す。
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

export type CareerQuotaOperationIdInput = {
  feature: string;
  /** request 内容など、operation を一意に決める素材（server 側の値のみ）。 */
  source: unknown;
  /** 時間 bucket 幅（秒）。null / undefined なら bucket を混ぜない（＝ 日単位 dedupe）。 */
  windowSeconds?: number | null;
  nowMs?: number;
};

/**
 * dedupe 候補の operation id 列を返す。
 *
 * `[0]` が **canonical**（実際に記録する id）。以降は「同一操作とみなす別名」で、
 * 時間 bucket の境界をまたいだ retry を取りこぼさないための直前 bucket。
 */
export function buildCareerQuotaOperationIds(input: CareerQuotaOperationIdInput): string[] {
  const digest = careerQuotaOperationDigest(input.source);
  const base = `${input.feature}:${digest}`;
  const windowSeconds = input.windowSeconds ?? null;
  if (!windowSeconds || windowSeconds <= 0) return [base];

  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const bucket = Math.floor(nowSec / windowSeconds);
  return [`${base}:${bucket}`, `${base}:${bucket - 1}`];
}
