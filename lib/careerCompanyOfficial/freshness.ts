/**
 * Company Data Spine — Official Facts の fact_group 別 freshness policy（pure・決定論）。
 *
 * なぜ既存 policy を使わないか:
 *   `lib/careerCompanyKnowledge/policy.ts` の `FRESHNESS_POLICY`（fresh ≤12ヶ月 / aging ≤30ヶ月）は
 *   **Layer 5（ユーザー投稿の体験談）** の observedPeriod を分類するためのもので、粒度が「月」であり
 *   企業の公開事実には粗すぎる。企業事実は group ごとに変化速度が桁違いに違う:
 *     会社概要はほぼ変わらない / IR は四半期 / ニュースは日単位。
 *   よって **既存 policy には一切触れず**、本 module に独立の TTL 表を持つ。
 *
 * 使い方（cost 制御の中核）:
 *   外部 I/O の **直前**に `classifyGroupFreshness` を呼び、`fresh` なら job を claim せず打ち切る。
 *   これが「Sony を何度入力しても外部検索が走らない」ための最大の関門。
 *
 * `stale` は「読めない」ではなく「読めるが更新したい」（stale-while-revalidate）。
 * `missing` は「まだ一度も取得していない」であり、stale と混同しない。
 */

import type {
  CompanyFactFreshness,
  CompanyFactGroup,
  CompanyFactGroupFreshness,
} from '@/types/careerCompanyOfficial';

const DAY_SECONDS = 24 * 60 * 60;

/**
 * fact_group 別 TTL（秒）。
 *
 * ★ 値の根拠（すべて PROVISIONAL・運用で調整する）:
 *   identity   : 商号変更・登記変更は稀。法人番号は不変。
 *   profile    : 事業内容・従業員数・資本金は年次更新が中心。
 *   navigation : 公式サイトの URL 構造変更はたまに起きる（404 検出時は即時再取得する）。
 *   ir         : 四半期決算。Phase 1 では取得しないが契約は先に固定する。
 *   recruiting : 選考年度・締切が動く。
 *   news       : volatile。**保存より都度取得が正しい**ため実質 prefetch 対象外。
 */
export const COMPANY_FACT_TTL_SECONDS: Readonly<Record<CompanyFactGroup, number>> = {
  identity: 180 * DAY_SECONDS,
  profile: 90 * DAY_SECONDS,
  navigation: 90 * DAY_SECONDS,
  ir: 30 * DAY_SECONDS,
  recruiting: 14 * DAY_SECONDS,
  news: 1 * DAY_SECONDS,
};

/** policy 値の確定状態（法務・実データ未確認のため PROVISIONAL）。 */
export const COMPANY_FACT_TTL_STATUS = 'PROVISIONAL' as const;

/** ISO 文字列を epoch ms へ（不正なら null）。never-throw。 */
function toEpochMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** group の TTL（秒）。未知 group は最も短い news 相当へ倒す（安全側）。 */
export function getFactGroupTtlSeconds(group: CompanyFactGroup): number {
  return COMPANY_FACT_TTL_SECONDS[group] ?? COMPANY_FACT_TTL_SECONDS.news;
}

/**
 * `fetchedAt` の TTL 満了時刻（ISO）。fetchedAt が不正なら null。
 * 永続化時に `valid_until` 列へ入れる値もこれで導く（DB と判定ロジックを一致させる）。
 */
export function computeValidUntil(
  group: CompanyFactGroup,
  fetchedAtIso: string,
): string | null {
  const base = toEpochMs(fetchedAtIso);
  if (base === null) return null;
  return new Date(base + getFactGroupTtlSeconds(group) * 1000).toISOString();
}

/**
 * group 単位の鮮度を判定する（pure・never-throw）。
 *
 * @param fetchedAtIso その group で **最も新しい** fact の取得時刻。1 件も無ければ null。
 * @param nowIso 判定時刻（呼び出し側が渡す。関数内で now を読まない＝テスト可能）。
 *
 * 未来日付の fetchedAt は信用せず `fresh` として扱う（負の age で stale 判定しない）。
 */
export function classifyGroupFreshness(
  group: CompanyFactGroup,
  fetchedAtIso: string | null,
  nowIso: string,
): CompanyFactGroupFreshness {
  const fetched = toEpochMs(fetchedAtIso);
  const now = toEpochMs(nowIso);

  if (fetched === null) {
    return {
      factGroup: group,
      freshness: 'missing',
      fetchedAt: null,
      validUntil: null,
      ageSeconds: null,
    };
  }

  const validUntil = computeValidUntil(group, fetchedAtIso as string);

  // now が読めないときは「古いと決めつけない」（無用な再取得でコストを出さない）。
  if (now === null) {
    return {
      factGroup: group,
      freshness: 'fresh',
      fetchedAt: fetchedAtIso,
      validUntil,
      ageSeconds: null,
    };
  }

  const ageSeconds = Math.floor((now - fetched) / 1000);
  const freshness: CompanyFactFreshness =
    ageSeconds <= getFactGroupTtlSeconds(group) ? 'fresh' : 'stale';

  return {
    factGroup: group,
    freshness,
    fetchedAt: fetchedAtIso,
    validUntil,
    ageSeconds: ageSeconds < 0 ? 0 : ageSeconds,
  };
}

/**
 * 「この group を今取りに行くべきか」（外部 I/O の直前に呼ぶ唯一の判定）。
 * fresh のときだけ false。missing / stale は true。
 */
export function shouldRefetchGroup(freshness: CompanyFactFreshness): boolean {
  return freshness !== 'fresh';
}

/**
 * 複数 group の鮮度から、読み出し全体の status を決める（pure）。
 *
 *   - 1 件も無い                        → 'missing'
 *   - 対象 group が全て fresh           → 'ready'
 *   - 一部 group が missing（データ有り）→ 'partial'
 *   - それ以外（stale を含む）           → 'stale'
 *
 * ★ partial を stale より優先する: 「一部しか無い」ことは「古い」ことより
 *   consumer にとって重要な情報（欠けている group を追加取得する判断に使う）。
 */
export function summarizeFreshness(
  groups: readonly CompanyFactGroupFreshness[],
): 'ready' | 'stale' | 'partial' | 'missing' {
  const present = groups.filter((g) => g.freshness !== 'missing');
  if (present.length === 0) return 'missing';
  if (present.length < groups.length) return 'partial';
  return present.every((g) => g.freshness === 'fresh') ? 'ready' : 'stale';
}
