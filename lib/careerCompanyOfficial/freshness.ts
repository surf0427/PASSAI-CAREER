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
 *   news         : volatile。**保存より都度取得が正しい**ため保存対象にしない。
 *
 * ★ ir / recruiting / developments（`OPPORTUNISTIC_FACT_GROUPS`）は 90 日 ─────
 *   これらは自前の refresh cycle を持たず、**profile / navigation の cycle に便乗**して
 *   取り直される（`OPPORTUNISTIC_FACT_GROUPS` の doc 参照）。実現可能な再取得間隔は
 *   したがって profile TTL（90 日）と等しい。
 *   ここに 90 日より短い TTL を置くと、取り直せない期間ずっと `stale` になり
 *   ［要再確認］が常時点灯して **marker の意味が失われる**。
 *   逆に長くすると古い決算値を fresh と偽る。よって cycle と一致させる。
 *   （内容そのものの基準日は `fiscalPeriodLabel` / `asOf` が原文表記で持つ。）
 */
export const COMPANY_FACT_TTL_SECONDS: Readonly<Record<CompanyFactGroup, number>> = {
  identity: 180 * DAY_SECONDS,
  profile: 90 * DAY_SECONDS,
  navigation: 90 * DAY_SECONDS,
  ir: 90 * DAY_SECONDS,
  recruiting: 90 * DAY_SECONDS,
  developments: 90 * DAY_SECONDS,
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
 * schema 世代のズレを判定する（pure）。
 *
 * ★ なぜ必要か（本 slice の中核）:
 *   fact key の集合を増やしても、TTL 内の企業は freshness short-circuit で `fresh` と
 *   判定され外部取得が走らない。結果として **新 key が次の TTL 満了まで（最長 90 日）
 *   永久に欠ける**。そこで「最新 fact を書いた schema 版が現行版と違う」なら stale とし、
 *   schema 拡張が 1 企業あたり 1 回の再取得サイクルで行き渡るようにする。
 *
 *   一度取り直せば group の schemaRevision は現行版になり、以降は通常の TTL 判定へ戻る
 *   （＝ storm にならない。1 世代につき 1 回だけ余分に取得する）。
 *
 * 判定しないケース（安全側＝再取得を促さない）:
 *   - どちらかが未指定（旧 row の null / 呼び出し側が世代を渡さない読み出し経路）
 */
export function isSchemaRevisionStale(
  factSchemaRevision: string | null | undefined,
  currentSchemaRevision: string | null | undefined,
): boolean {
  if (typeof currentSchemaRevision !== 'string' || currentSchemaRevision === '') return false;
  if (typeof factSchemaRevision !== 'string' || factSchemaRevision === '') return false;
  return factSchemaRevision !== currentSchemaRevision;
}

/** `classifyGroupFreshness` の任意入力（省略時は従来と完全に同じ挙動）。 */
export type ClassifyFreshnessOptions = {
  /** その group の最新 fact が書かれた fact schema 版（DB の `schema_revision`）。 */
  factSchemaRevision?: string | null;
  /** 現行の fact schema 版（`COMPANY_FACT_SCHEMA_REVISION`）。 */
  currentSchemaRevision?: string | null;
};

/**
 * group 単位の鮮度を判定する（pure・never-throw）。
 *
 * @param fetchedAtIso その group で **最も新しい** fact の取得時刻。1 件も無ければ null。
 * @param nowIso 判定時刻（呼び出し側が渡す。関数内で now を読まない＝テスト可能）。
 * @param opts schema 世代の比較材料（省略可）。旧 schema 世代なら TTL 内でも `stale`。
 *
 * 未来日付の fetchedAt は信用せず `fresh` として扱う（負の age で stale 判定しない）。
 */
export function classifyGroupFreshness(
  group: CompanyFactGroup,
  fetchedAtIso: string | null,
  nowIso: string,
  opts: ClassifyFreshnessOptions = {},
): CompanyFactGroupFreshness {
  const fetched = toEpochMs(fetchedAtIso);
  const now = toEpochMs(nowIso);
  const schemaStale = isSchemaRevisionStale(opts.factSchemaRevision, opts.currentSchemaRevision);

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
  // ★ ただし schema 世代のズレは時刻に依存しないため、これだけは尊重する。
  if (now === null) {
    return {
      factGroup: group,
      freshness: schemaStale ? 'stale' : 'fresh',
      fetchedAt: fetchedAtIso,
      validUntil,
      ageSeconds: null,
    };
  }

  const ageSeconds = Math.floor((now - fetched) / 1000);
  const freshness: CompanyFactFreshness =
    !schemaStale && ageSeconds <= getFactGroupTtlSeconds(group) ? 'fresh' : 'stale';

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
