// ★ 設計判断（本 guard 自体は 401 を返さない）:
//   PASSAI CAREER は **単一の有料プラン**で、AI 本実行は契約者だけが利用できる
//   （2026-08-21 商品決定。旧「guest 利用は許可」仕様は廃止）。契約の確認は本 module
//   ではなく `lib/careerBilling/aiAccess.ts` の requireCareerAiAccess が行う。
//   本 guard は identity を確定して **rate limit のキーを決める**ところまでを担当する:
//     member … user_id をキーに通常上限
//     guest  … IP をキーに厳しめ上限（fail-closed）
//   順序: request guard → 有料ゲート → Daily Quota → AI。

import 'server-only';

import {
  CAREER_PRESENTATION_RATE_LIMITS,
  checkRateLimits,
  rateLimitedResponse,
  type RateLimitRule,
} from '@/lib/rateLimit';
import {
  badRequestResponse,
  findPayloadViolation,
  payloadTooLargeResponse,
  readRawBodyWithinCap,
  resolveCareerRequestIdentity,
  resolveClientIp,
  type CareerRequestIdentity,
} from '@/lib/careerApi/requestGuard';

// ── identity ────────────────────────────────────────────────────────

/** プレゼン route が扱う identity（共通型のエイリアス）。 */
export type PresentationIdentity = CareerRequestIdentity;

/** Career（Project B）の server session から identity を確定する（never throw / 既定 guest）。 */
export async function resolvePresentationIdentity(): Promise<PresentationIdentity> {
  return resolveCareerRequestIdentity();
}

// ── rate limit ──────────────────────────────────────────────────────

export type PresentationOperation = 'theme' | 'evaluate' | 'qa';

const RULES: Readonly<
  Record<PresentationOperation, { member: RateLimitRule; guest: RateLimitRule }>
> = {
  theme: {
    member: CAREER_PRESENTATION_RATE_LIMITS.themeMember,
    guest: CAREER_PRESENTATION_RATE_LIMITS.themeGuest,
  },
  evaluate: {
    member: CAREER_PRESENTATION_RATE_LIMITS.evaluateMember,
    guest: CAREER_PRESENTATION_RATE_LIMITS.evaluateGuest,
  },
  qa: {
    member: CAREER_PRESENTATION_RATE_LIMITS.qaMember,
    guest: CAREER_PRESENTATION_RATE_LIMITS.qaGuest,
  },
};

/** identity と operation から rate limit のキー・ルールを決める（純関数・テスト可能）。 */
export function selectRateLimitTarget(
  identity: PresentationIdentity,
  operation: PresentationOperation,
  clientIp: string,
): { key: string; rule: RateLimitRule } {
  if (identity.kind === 'member') {
    return { key: `u:${identity.userId}`, rule: RULES[operation].member };
  }
  return { key: `i:${clientIp}`, rule: RULES[operation].guest };
}

// ── 統合 guard ──────────────────────────────────────────────────────

export type GuardResult =
  | { ok: true; body: unknown; identity: PresentationIdentity }
  | { ok: false; response: Response };

/**
 * プレゼン AI route の入口ガード。**AI・Supabase・prompt builder より前**に必ず通す。
 *
 * 順序（意図的）:
 *   1. Content-Length / 実バイト数の上限   … 最も安い判定を最初に（読むだけで弾く）
 *   2. Career identity 確定（Project B）    … client 申告値は使わない
 *   3. rate limit（member=user / guest=IP） … AI に到達させない
 *   4. JSON parse + 構造サイズ検査          … 無制限 payload を prompt へ通さない
 */
export async function guardPresentationRequest(
  req: Request,
  operation: PresentationOperation,
): Promise<GuardResult> {
  // 1) サイズ上限（宣言値 → 実測値の二段）。
  const rawResult = await readRawBodyWithinCap(req);
  if (!rawResult.ok) return { ok: false, response: rawResult.response };

  // 2) identity（never throw / guest へ倒す）。
  const identity = await resolvePresentationIdentity();

  // 3) rate limit。
  const { key, rule } = selectRateLimitTarget(identity, operation, resolveClientIp(req));
  const { allowed, result } = await checkRateLimits({ key, rule });
  if (!allowed) {
    // key の実値（user_id / IP）は出さない。namespace / limit / retryAfter のみ。
    console.warn(
      `career presentation rate limited: namespace=${rule.namespace} limit=${result.limit} retryAfterSec=${result.retryAfterSeconds}`,
    );
    return { ok: false, response: rateLimitedResponse(result) };
  }

  // 4) parse + 構造サイズ。
  let body: unknown;
  try {
    body = JSON.parse(rawResult.raw);
  } catch {
    return { ok: false, response: badRequestResponse() };
  }
  if (findPayloadViolation(body)) {
    return { ok: false, response: payloadTooLargeResponse() };
  }

  return { ok: true, body, identity };
}
