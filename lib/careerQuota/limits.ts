/**
 * PASSAI CAREER — BASIC プランの **機能別 1 日利用上限**（正本 / pure constants）。
 *
 * ★ 本ファイルが上限値の唯一の正本。route 側で数値を再宣言してはいけない
 *   （`getCareerDailyLimit()` 経由でのみ参照する）。
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
 * operation dedupe の窓（秒）。`null` = **その日いっぱい**（同一入力は 1 日 1 回だけ消費）。
 *
 * 設計:
 *   - operation identity は「server が request 内容から計算した digest」であり、
 *     client が自由に指定できる id ではない（同一 digest = 同一入力 = 同一成果物）。
 *   - したがって大半の機能は `null`（日単位）で良い。retry / 二重送信 / reload 後の
 *     再送はすべて同一 body ＝ 同一 digest になり、追加消費しない。
 *   - 例外は **面接 start** だけ。start の body には「その面接セッション固有の値」が
 *     一切含まれない（設定と context のみ）ため、日単位 dedupe にすると
 *     「同じ設定の面接を何度でも無料で開始できる」になってしまう。
 *     そこで面接だけ 30 分窓にする（連打 / 再読込は畳み、時間をおいた新セッションは
 *     新しい 1 回として数える）。窓の境界での取りこぼしは、直前窓の id も
 *     dedupe 対象として同時に渡すことで防ぐ。
 */
export const CAREER_DAILY_QUOTA_DEDUPE_WINDOW_SECONDS: Readonly<
  Record<CareerDailyQuotaFeature, number | null>
> = {
  self_analysis: null,
  company_research: null,
  es: null,
  interview: 1_800,
  presentation: null,
  gd: null,
  matching: null,
};

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
