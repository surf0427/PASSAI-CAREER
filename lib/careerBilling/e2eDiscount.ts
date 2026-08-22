/**
 * PASSAI CAREER — 本番 LIVE E2E 用の **専用ユーザー限定**割引（server-only / 一時的な検証用）。
 *
 * ★ 目的:
 *   本番 ¥3,000/月 の Price / Product を **一切変更せず**、E2E 専用アカウント 1 名の
 *   初回請求だけを Coupon で引き下げ、実課金を伴う決済導線を安全に通しで検証する。
 *
 * ★ security 契約（ここが本 module の存在理由）:
 *   - 適用可否は **server session で確定した userId と email の両方一致**でのみ決まる。
 *     client が body / header / query で coupon / price / plan / email を送っても
 *     一切参照しない（checkout route は body を読まない）。
 *   - 設定は **server-only env**。`NEXT_PUBLIC_*` にしない（client bundle へ出さない）。
 *   - env が 1 つでも欠けていれば「E2E ユーザーは存在しない」= 通常フローのまま。
 *     したがって env 未設定の環境（通常の本番運用）では本 module は完全に no-op。
 *
 * ★ fail-closed:
 *   「E2E ユーザーとして識別できたのに割引を正しく適用できない」場合は、
 *   通常価格へ黙って fallback せず **Checkout を作らずに失敗**させる。
 *   ¥200 を意図した検証で誤って ¥3,000 の決済画面を出さないため。
 *
 * ★ 後片付け:
 *   E2E 完了後は env（CAREER_E2E_*）を外せば即座に無効化される。
 *   本 module 自体も検証が終わったら削除してよい（削除しても通常フローは不変）。
 */

import 'server-only';

import type Stripe from 'stripe';

/** 適用判定の結果。 */
export type CareerE2eDiscountDecision =
  /** 通常ユーザー。割引なし（＝ これまでどおり ¥3,000/月）。 */
  | { kind: 'none' }
  /** E2E 専用ユーザー。coupon を適用する。 */
  | { kind: 'apply'; couponId: string }
  /** E2E ユーザーだが設定が不完全。**Checkout を作ってはいけない**。 */
  | { kind: 'misconfigured'; reason: 'coupon-env-missing' };

/**
 * server session で確定した identity から、E2E 割引の適用可否を決める（純粋関数）。
 *
 * @param identity `authenticateCareerMember()` が返した server 側の値のみを渡すこと。
 * @param env      テストから注入できるよう明示的に受け取る。
 */
export function resolveCareerE2eDiscount(
  identity: { userId: string; email: string | null },
  env: {
    CAREER_E2E_USER_ID?: string | undefined;
    CAREER_E2E_USER_EMAIL?: string | undefined;
    CAREER_E2E_COUPON_ID?: string | undefined;
  },
): CareerE2eDiscountDecision {
  const expectedId = env.CAREER_E2E_USER_ID?.trim();
  const expectedEmail = env.CAREER_E2E_USER_EMAIL?.trim().toLowerCase();

  // E2E 対象が設定されていない環境では、誰も E2E ユーザーになれない（通常運用）。
  if (!expectedId || !expectedEmail) return { kind: 'none' };

  const actualEmail = identity.email?.trim().toLowerCase() ?? '';
  // ★ userId と email の **両方**一致を要求する。片方だけでは適用しない。
  const isDedicatedE2eUser = identity.userId === expectedId && actualEmail === expectedEmail;
  if (!isDedicatedE2eUser) return { kind: 'none' };

  const couponId = env.CAREER_E2E_COUPON_ID?.trim();
  // E2E ユーザーだと確定したのに coupon が無い → 通常価格へ倒さず失敗させる。
  if (!couponId) return { kind: 'misconfigured', reason: 'coupon-env-missing' };

  return { kind: 'apply', couponId };
}

/** process.env を読む薄いラッパ（実行時用）。 */
export function resolveCareerE2eDiscountFromEnv(identity: {
  userId: string;
  email: string | null;
}): CareerE2eDiscountDecision {
  return resolveCareerE2eDiscount(identity, {
    CAREER_E2E_USER_ID: process.env.CAREER_E2E_USER_ID,
    CAREER_E2E_USER_EMAIL: process.env.CAREER_E2E_USER_EMAIL,
    CAREER_E2E_COUPON_ID: process.env.CAREER_E2E_COUPON_ID,
  });
}

export type CareerE2eCouponCheck =
  | { kind: 'ok'; amountOff: number; expectedInitialAmount: number }
  | { kind: 'invalid'; reason: string };

/**
 * Coupon が「この Price に対して意図どおりの初回割引」かを Stripe から検証する（read-only）。
 *
 * 1 つでも噛み合わなければ invalid を返し、呼び出し側は Checkout を作らない。
 */
export function checkCareerE2eCoupon(
  coupon: Stripe.Coupon,
  price: Stripe.Price,
  expectedLivemode: boolean,
): CareerE2eCouponCheck {
  if (coupon.livemode !== expectedLivemode) return { kind: 'invalid', reason: 'livemode-mismatch' };
  if (coupon.valid !== true) return { kind: 'invalid', reason: 'not-valid' };
  if (coupon.duration !== 'once') return { kind: 'invalid', reason: 'duration-not-once' };
  if (typeof coupon.amount_off !== 'number' || coupon.amount_off <= 0) {
    return { kind: 'invalid', reason: 'amount-off-missing' };
  }
  const couponCurrency = coupon.currency?.toLowerCase() ?? '';
  if (couponCurrency !== price.currency.toLowerCase()) {
    return { kind: 'invalid', reason: 'currency-mismatch' };
  }
  if (typeof price.unit_amount !== 'number') return { kind: 'invalid', reason: 'price-amount-missing' };

  const expectedInitialAmount = price.unit_amount - coupon.amount_off;
  // 割引で 0 以下や負にならないこと（0 円 Checkout を作らない）。
  if (expectedInitialAmount <= 0) return { kind: 'invalid', reason: 'discount-exceeds-price' };

  return { kind: 'ok', amountOff: coupon.amount_off, expectedInitialAmount };
}
