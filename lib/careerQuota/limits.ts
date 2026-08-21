/**
 * PASSAI CAREER — BASIC プランの **機能別 1 日利用上限**（正本 / pure constants）。
 *
 * ★ 本ファイルが上限値の唯一の正本。route 側で数値を再宣言してはいけない
 *   （`getCareerDailyLimit()` 経由でのみ参照する）。
 *
 * ★ dedupe は「実行中の operation への再送」だけに効く（lib/careerQuota/enforce.ts）。
 *   同じ入力でもユーザーが明示的に実行し直したら 1 回消費する。詳細は
 *   supabase/career_daily_quota_apply.sql §6.1 の意味論コメントを参照。
 *
 * ★ 「1 回」の定義は **AI call 数ではなく、ユーザーから見た top-level operation 数**。
 *   ES 1 本の作成は内部で materials / deep×N / organize / review と最大 10 call 走るが、
 *   利用回数としては 1 と数える。どの route を「1 回」の計上点にするかは
 *   `anchors.ts`（quota anchor 表）に一元化してある。
 *
 * ★ 1 日の境界は **日本時間（Asia/Tokyo）00:00**。client 時計は一切信用せず、
 *   実際の日付判定は DB（`career_daily_quota_consume`）が `now() AT TIME ZONE 'Asia/Tokyo'`
 *   で行う。本ファイルの JST helper は表示・QA 用の同一定義であり、権威ではない。
 *
 * server-only を付けない理由: QA script（tsx 直実行）から unit test するため
 *   （`lib/careerBilling/entitlementPolicy.ts` と同方針）。I/O を一切含まない。
 */

/** quota bucket の canonical な feature key。route ごとに別名を作らない。 */
export const CAREER_DAILY_QUOTA_FEATURES = [
  'self_analysis',
  'company_research',
  'es',
  'interview',
  'presentation',
  'gd',
  'matching',
] as const;

export type CareerDailyQuotaFeature = (typeof CAREER_DAILY_QUOTA_FEATURES)[number];

/**
 * PASSAI Career BASIC の 1 日あたり利用上限（**商品仕様・変更禁止**）。
 *
 * 原価都合で勝手に増減しない。変更するときは商品仕様そのものを変えるとき。
 */
export const CAREER_BASIC_DAILY_LIMITS: Readonly<Record<CareerDailyQuotaFeature, number>> = {
  self_analysis: 10,
  company_research: 10,
  es: 10,
  interview: 8,
  presentation: 5,
  gd: 5,
  matching: 5,
};

/** 上限到達メッセージ用の日本語ラベル（既存 CAREER_AI_FEATURE_LABELS と同語彙）。 */
export const CAREER_DAILY_QUOTA_LABELS: Readonly<Record<CareerDailyQuotaFeature, string>> = {
  self_analysis: '自己分析',
  company_research: '企業分析',
  es: 'ES',
  interview: '面接',
  presentation: 'プレゼン',
  gd: 'グループディスカッション',
  matching: '企業マッチング',
};

/**
 * in_flight な operation の lease（秒）。
 *
 * 実行が成功すると server が settle するので、通常はこの lease に到達しない。
 * lease は「settle できずに落ちた（crash / 強制中断）実行」を回収するための保険で、
 * これが無いと壊れた in_flight 行が残り、同一入力が永久に無料になってしまう。
 * 最長の AI route（自己分析 maxDuration 300s）に十分な余裕を足した値。
 */
export const CAREER_QUOTA_LEASE_SECONDS = 900;

/**
 * 1 つの in_flight operation が畳んでよい再送の回数（コスト増幅の上限）。
 *
 * ★ 値の決め方:
 *   正常な retry / 二重送信 / 多タブは十分に下回る値では**足りない**。
 *   「同一 operation への 20 並列は 1 消費」という受け入れ基準があるため、
 *   実利用でありうる同時再送を確実に飲み込める余裕を取る。
 *   一方で無制限にはしない — 実行中の 1 operation に無限に request を浴びせて
 *   「1 消費で AI 実行し放題」にする経路を、明示的な上限で塞いでおく。
 *
 * ★ 実効的な濫用防御は本値ではなく既存の burst rate limit（lib/rateLimit）である
 *   （例: ES 添削 member 6/分・40/時）。本値はその内側に置く保険。
 *   上限を超えた再送は畳まずに消費するので、静かに無料実行が続くことはない。
 */
export const CAREER_QUOTA_MAX_DEDUPE_HITS = 64;

/** feature の 1 日上限（BASIC 仕様値）。 */
export function getCareerDailyLimit(feature: CareerDailyQuotaFeature): number {
  return CAREER_BASIC_DAILY_LIMITS[feature];
}

export function isCareerDailyQuotaFeature(value: unknown): value is CareerDailyQuotaFeature {
  return (
    typeof value === 'string' &&
    (CAREER_DAILY_QUOTA_FEATURES as readonly string[]).includes(value)
  );
}

// ── JST（Asia/Tokyo）の 1 日境界 ─────────────────────────────────────
//
// 日本に DST は無いので固定 +09:00 で厳密に計算できる。

/** JST の UTC オフセット（分）。 */
export const CAREER_DAILY_QUOTA_UTC_OFFSET_MINUTES = 9 * 60;
const JST_OFFSET_MS = CAREER_DAILY_QUOTA_UTC_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** JST の暦日（'YYYY-MM-DD'）。DB 側の `(now() AT TIME ZONE 'Asia/Tokyo')::date` と同義。 */
export function careerQuotaJstDate(nowMs: number = Date.now()): string {
  return new Date(nowMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 次の JST 0:00 の epoch ms（＝ この bucket がリセットされる時刻）。 */
export function careerQuotaJstResetAtMs(nowMs: number = Date.now()): number {
  const shifted = nowMs + JST_OFFSET_MS;
  return Math.floor(shifted / DAY_MS) * DAY_MS + DAY_MS - JST_OFFSET_MS;
}
