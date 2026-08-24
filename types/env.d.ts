/**
 * STEP-BILLING-02: process.env のアンビエント型宣言。
 *
 * - すべての key を optional (`string | undefined`) として宣言する。
 *   ランタイムの実態（未設定 = undefined）を型に反映する。
 * - 各 consumer は必ず presence チェック / バリデータを噛ます:
 *     - Stripe key:        `lib/stripe/server.ts:readStripeSecretKey`
 *     - Stripe Price ID:   `lib/stripe/server.ts:getStripePriceId`
 *     - Supabase URL/key:  `lib/supabase/env.ts`
 *     - Service role:      `lib/supabase/serviceRoleClient.ts`
 *     - Anthropic key:     使用箇所で個別チェック
 * - 本ファイルは型のみ。実行時 import なし。`export {}` で global module 化
 *   して既存の `NodeJS.ProcessEnv` 宣言を augment する。
 */

// NodeJS.ProcessEnv の augment 専用宣言。namespace 名は型拡張のためのもので
// 直接参照しないため no-unused-vars の対象外とする（実行時 import なし）。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare namespace NodeJS {
  interface ProcessEnv {
    // Anthropic
    readonly ANTHROPIC_API_KEY?: string;

    // Supabase
    readonly NEXT_PUBLIC_SUPABASE_URL?: string;
    readonly NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
    /** server-only secret. NEXT_PUBLIC_ prefix なし → browser bundle に inline されない。 */
    readonly SUPABASE_SERVICE_ROLE_KEY?: string;

    // Supabase mirror / observability kill-switches
    readonly NEXT_PUBLIC_SUPABASE_MIRROR_DISABLED?: string;
    readonly NEXT_PUBLIC_SUPABASE_OBSERVABILITY_DISABLED?: string;

    // CAREER (就活版) Supabase — 受験版とは別プロジェクト（Project B）。
    //   boundary: `lib/careerSupabase/env.ts`（受験版 env へは fallback しない）。
    //   career runtime（identity / mirror / server / service role）は必ずこの系統を使う。
    readonly NEXT_PUBLIC_CAREER_SUPABASE_URL?: string;
    readonly NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY?: string;
    /** server-only secret. NEXT_PUBLIC_ prefix なし → browser bundle に inline されない。 */
    readonly CAREER_SUPABASE_SERVICE_ROLE_KEY?: string;
    /**
     * server-only secret. マルチGD の join code HMAC pepper
     * （`app/api/career/gd/room/roomCode.ts`）。**明示設定を推奨**。
     * 未設定時の fallback は CAREER_SUPABASE_SERVICE_ROLE_KEY のみ。
     */
    readonly CAREER_GD_JOIN_CODE_PEPPER?: string;

    // Stripe (test mode only — sk_live_* は lib/stripe/server.ts で runtime refuse)
    readonly STRIPE_SECRET_KEY?: string;
    readonly NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?: string;
    readonly STRIPE_PRICE_ID_BASIC?: string;
    readonly STRIPE_PRICE_ID_PREMIUM?: string;
    /** STEP-BILLING-03 で webhook 実装時に追加予定。 */
    readonly STRIPE_WEBHOOK_SECRET?: string;

    // App / observability
    readonly NEXT_PUBLIC_APP_URL?: string;
    readonly NEXT_PUBLIC_APP_COMMIT?: string;
    readonly NEXT_PUBLIC_VERCEL_ENV?: string;

    // OpenAI (STT/TTS provider 境界。リアルタイム面接でも流用)
    readonly OPENAI_API_KEY?: string;

    // ── STT / TTS provider 切替（lib/interviewAi/{stt,tts}.ts の唯一の入口が読む）──
    //   STEP-GD-VOICE で GD も同じ境界を共有するため、暗黙 env を明示宣言する。
    //   'openai' 以外 / 未設定 = provider 無効（Unavailable エラー → 呼び出し側がフォールバック）。
    readonly INTERVIEW_AI_STT_PROVIDER?: string;
    readonly INTERVIEW_AI_TTS_PROVIDER?: string;
    /** TTS の全体上書き（ops 制御）。GD が persona 別 voice を明示指定した場合はそちらが優先。 */
    readonly INTERVIEW_AI_TTS_VOICE?: string;
    readonly INTERVIEW_AI_TTS_MODEL?: string;
    readonly INTERVIEW_AI_TTS_SPEED?: string;

    // ── GD 完全音声型（STEP-GD-VOICE）──
    //   ★ 音声専用の kill switch は **意図的に作らない**。GD は音声でしか進行できない仕様なので
    //     「GD は ON だが音声だけ OFF」は壊れた商品状態であり、運用上その状態を作れてはいけない。
    //     停止したいときは CAREER_GD_ENABLED を落とす（GD ごと止まる）。音声の可否は
    //     provider env（INTERVIEW_AI_STT_PROVIDER + OPENAI_API_KEY）の有無だけで決まる。
    /**
     * WebRTC mesh の ICE サーバ設定（JSON 配列文字列）。
     * 例: '[{"urls":"turn:turn.example.com:3478","username":"u","credential":"c"}]'
     * 未設定なら公開 STUN のみ（対称 NAT 環境で P2P が張れないユーザーが出る）。
     * NEXT_PUBLIC_ なのでブラウザに露出する = **長期の固定 credential を入れないこと**。
     */
    readonly NEXT_PUBLIC_CAREER_GD_ICE_SERVERS?: string;

    // Interview AI — リアルタイム音声面接 (STEP-INTERVIEW-AI-REALTIME-PR1)
    /**
     * server-only 最終ゲート。'true' のときだけ token route が client_secret を発行する。
     * NEXT_PUBLIC_ prefix なし = browser bundle に出ない。本番 passai.jp は未設定運用。
     */
    readonly REALTIME_INTERVIEW_ENABLED?: string;
    /** client UI 表示 flag（'true'/'1'/'yes'）。表示と発行は別軸（発行は server flag が最終）。 */
    readonly NEXT_PUBLIC_ENABLE_REALTIME_INTERVIEW?: string;
    /** 開発者 allowlist（カンマ区切り user id）。非空なら対象 user のみ発行可。未設定=skip。 */
    readonly REALTIME_DEV_USER_IDS?: string;
    /** realtime モデル ID。既定 'gpt-realtime-mini'（コスト優先）。 */
    readonly INTERVIEW_AI_REALTIME_MODEL?: string;
    /** realtime 音声。既定 'alloy'。 */
    readonly INTERVIEW_AI_REALTIME_VOICE?: string;
    /** OpenAI-Safety-Identifier ハッシュ用 salt（sha256(userId+salt)）。本番必須。 */
    readonly REALTIME_SAFETY_ID_SALT?: string;
  }
}

export {};
