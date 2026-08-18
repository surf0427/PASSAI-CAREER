/**
 * Company Data Spine — Official Facts の **読み出し**可否（server-only）。
 *
 * ★ なぜ ingest（prefetch）flag と分けるのか（本 module が存在する理由）:
 *   `CAREER_COMPANY_PREFETCH_ENABLED` は `lib/careerCompanyPrefetch/flags.server.ts` の
 *   docstring どおり **「intent 受付 / identity 解決 / Data Spine 書き込み」＝ ingest 側**の flag。
 *   ところが read repository までこの flag で閉じていたため、
 *     「DB には出典付き fact が入っているのに、ingest を止めた瞬間に
 *       面接 / ES / プレゼン / 企業研究の prompt から公式情報が消える」
 *   という状態になっていた（Production Readiness Audit P1-1）。
 *   取得を止めることと、既に取得済みの事実を読むことは別の判断なので flag を分ける。
 *
 * ★ read は「安い・外部 I/O ゼロ・冪等」:
 *   既存行への owner 非依存な SELECT のみ（RLS: authenticated へ `USING (true)`）。
 *   crawler・provider・job claim・書き込みは **一切起動しない**（read repository が I/O を持たない）。
 *   したがって既定を有効にしても、外部 fetch / prefetch pipeline の起動条件は変わらない。
 *
 * ★ それでも kill switch は残す:
 *   誤った fact が混入したとき、ingest を止めるのとは独立に
 *   「prompt への注入だけ即座に止める」手段が必要になる。
 *   そのため **opt-out**（既定 ON / 明示的に 'true' を入れたときだけ OFF）にする。
 *   新しい canary / allowlist 体系は作らない（read は非個人データで per-user 差が無いため）。
 */

import 'server-only';

/** 読み出しを止める kill switch（値が 'true' のときだけ read を無効化する）。 */
export const CAREER_COMPANY_OFFICIAL_READ_DISABLED_ENV =
  'CAREER_COMPANY_OFFICIAL_READ_DISABLED';

/**
 * 保存済み Company Official facts を prompt 用に読んでよいか。
 *
 * 既定 **有効**（未設定・空・その他の値はすべて有効）。
 * `CAREER_COMPANY_OFFICIAL_READ_DISABLED=true` のときだけ無効になり、
 * read repository は Supabase に触れず `disabled(flag_off)` を返す。
 */
export function isCompanyOfficialReadEnabled(): boolean {
  return process.env[CAREER_COMPANY_OFFICIAL_READ_DISABLED_ENV] !== 'true';
}
