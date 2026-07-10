'use client';

/**
 * L2 Event Signal 用の owner-scoped source reader（P10-C）。
 *
 * 責務（薄い L3 reader のみ）:
 *   認証済み userId + now を受け取り、直近 30 日の **owner 自身の** career_user_events を
 *   「builder が必要とする最小 4 列だけ」取得して CareerEventSignalSourceRow[] へ mapping する。
 *
 *   career_user_events
 *     → owner-scoped reader（本ファイル・最小 4 列 SELECT）
 *     → CareerEventSignalSourceRow[]
 *     → buildCareerEventSignalSummary（lib/careerMemory/eventSignals.ts・別責務）
 *
 * 依存方向 / 分離:
 *   - 本 reader は L3 の最小 row を読むだけ。**L2 builder（buildCareerEventSignalSummary）を import・
 *     呼び出さない**（read→build 結合は QA 内でのみ確認する）。型 CareerEventSignalSourceRow は
 *     builder の入力契約なので type-only import する（runtime 依存なし・read.ts が timeline 型を
 *     type-only import するのと同じ house style）。
 *   - 値の妥当性検証（unknown feature / invalid band / invalid timestamp の drop）は builder の責務。
 *     reader は field を 4 列へ絞るだけで、値を勝手に補正しない。
 *
 * boundary（既存 read.ts / mirror helper と同方針）:
 *   - getBrowserSupabaseClient() 経由（anon key + user session、RLS で owner に閉じる）。
 *   - never throw。guest / userId 不正 / now 不正 / env 未設定 / client 失敗 / DB error / 例外は
 *     **undefined**（＝reader を利用できなかった）。正常取得だが 0 件なら **[]**（両者を区別する）。
 *   - userId / query payload / Event rows / metadata / PII / URL / key / token を log しない。
 *   - まだ snapshot / selector / renderer / prompt へは一切接続しない（body byte 不変を維持）。
 */

import { devWarn } from '@/lib/devLog';
import { getBrowserSupabaseClient } from '@/lib/supabase/browserClient';
import type { CareerEventSignalSourceRow } from '@/lib/careerMemory/eventSignals';

// builder と一致させる window / limit / 時刻列基準の contract（QA から参照して固定する）。
export const CAREER_EVENT_SIGNAL_WINDOW_DAYS = 30;
export const CAREER_EVENT_SIGNAL_ROW_LIMIT = 100;
// SELECT は 4 列のみ（'*' 禁止・metadata / id / user_id / company_id / client_event_id / created_at 非取得）。
export const CAREER_EVENT_SIGNAL_SELECT = 'feature, event_type, score_band, occurred_at';

const TABLE = 'career_user_events';
const DAY_MS = 24 * 60 * 60 * 1000;
// userId は認証 user の uuid のみ受け付ける（不正形式は no-op）。record.ts と同じ形。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DB へ owner-scoped で 4 列を問い合わせる adapter。既定は browser Supabase client。
 * QA では stub を注入して DB 非依存で reader を検査する。**table / select / owner filter は
 * production code 側で固定** し、外部 caller は userId 以外の filter や任意 SELECT を注入できない。
 */
export type CareerEventSignalRowsAdapter = (input: {
  userId: string;
  fromIso: string;
  toIso: string;
  limit: number;
}) => Promise<unknown>;

const defaultAdapter: CareerEventSignalRowsAdapter = async ({ userId, fromIso, toIso, limit }) => {
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return undefined; // env 未設定 = 利用不可
  const { data, error } = await supabase
    .from(TABLE)
    .select(CAREER_EVENT_SIGNAL_SELECT)
    .eq('user_id', userId) // RLS に加えた明示 owner filter（既存 list* と同方針）
    .gte('occurred_at', fromIso) // window 開始 inclusive
    .lte('occurred_at', toIso) // now inclusive（future event を query でも除外）
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (error) {
    devWarn('[eventSignals] read unavailable'); // payload / userId / rows は出さない
    return undefined;
  }
  return data;
};

function nowToEpochMs(now: unknown): number | null {
  if (now instanceof Date) {
    const t = now.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof now === 'number') return Number.isFinite(now) ? now : null;
  return null;
}

// 返却 row から **4 列だけ** を新 object へコピー（構造的 allowlist）。余分な field は残さない。
function toSourceRow(raw: unknown): CareerEventSignalSourceRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    feature: row.feature,
    event_type: row.event_type,
    score_band: row.score_band,
    occurred_at: row.occurred_at,
  };
}

/**
 * 直近 30 日の owner event を最小 4 列で取得する（member only / never throw）。
 *   - 正常取得: CareerEventSignalSourceRow[]（0 件なら []）。
 *   - 利用不可: undefined（guest / userId 不正 / now 不正 / env / client / DB error / 例外）。
 * 第 2 引数 adapter は QA 用の注入 seam（本番呼び出しは 1 引数で既定 adapter を使う）。
 */
export async function readCareerEventSignalSourceRows(
  input: { userId: string | null | undefined; now: number | Date },
  adapter: CareerEventSignalRowsAdapter = defaultAdapter,
): Promise<CareerEventSignalSourceRow[] | undefined> {
  try {
    const userId = input?.userId;
    if (typeof userId !== 'string' || !UUID_RE.test(userId.trim())) return undefined;

    const nowMs = nowToEpochMs(input?.now);
    if (nowMs === null) return undefined;

    const fromIso = new Date(nowMs - CAREER_EVENT_SIGNAL_WINDOW_DAYS * DAY_MS).toISOString();
    const toIso = new Date(nowMs).toISOString();

    const raw = await adapter({
      userId: userId.trim(),
      fromIso,
      toIso,
      limit: CAREER_EVENT_SIGNAL_ROW_LIMIT,
    });
    if (!Array.isArray(raw)) return undefined; // 想定外 shape / 非配列 = 利用不可

    return raw.map(toSourceRow);
  } catch {
    devWarn('[eventSignals] reader threw'); // error 本体 / payload は出さない
    return undefined;
  }
}
