// プロダクト名は将来的に変わりうるため 1 箇所に集約する。
// 表示名（ヘッダー / metadata / フッター / 通知文など）はここから import する。
export const BRAND_NAME = 'PASSAI';

/**
 * PASSAI CAREER 本番の **canonical origin**（独自ドメイン）。
 *
 * ── これは何で、何ではないか ────────────────────────────────────────────
 *   「この site の公開 URL を 1 つ挙げるならどれか」の唯一の定義。用途は
 *     - metadata の基準 origin（metadataBase）
 *     - 運用点検 script が「本番を指しているか」を説明するときの表示基準
 *   に限る。
 *
 *   ★ runtime の遷移先 origin をここから組んではいけない ★
 *   Stripe の success_url / cancel_url / return_url と auth の戻り先は
 *   **その request を実際に配信した host** から組む（lib/careerBilling/originPolicy.ts）。
 *   Supabase の auth cookie は host 単位で保存されるため、canonical へ寄せてしまうと
 *   preview deployment で認証したユーザーが本番 host に着地して session を失う。
 *
 * 旧 Vercel origin（https://passai-career.vercel.app）は Vercel の deployment URL として
 * 残っているが、**この定数へ 307 redirect される**。したがって「旧 host でも同じものが
 * 配信される」前提のコード・設定を書いてはいけない。
 * 特に Stripe webhook は redirect を追わず 3xx を配送失敗として扱うため、外部サービスの
 * 登録先は必ずこの canonical origin にすること（2026-08-24 に実際に踏んだ）。
 */
export const CAREER_PRODUCTION_ORIGIN = 'https://passaicareer.jp';

/** CAREER_PRODUCTION_ORIGIN の host 部分（`passaicareer.jp`）。 */
export const CAREER_PRODUCTION_HOST = 'passaicareer.jp';
