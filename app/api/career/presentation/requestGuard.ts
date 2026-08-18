// PASSAI CAREER — プレゼン AI route 共通の request guard（server-only・3 route 共有）。
//
// STEP-CAREER-PRESENTATION-HARDENING-P0。
// theme / evaluate / qa は Anthropic 課金に直結する公開 endpoint でありながら、
// 認証・rate limit・body サイズ上限のいずれも持っていなかった（Production Readiness Audit P0-1）。
// 本 module がその 3 つを 1 箇所で担う。
//
// ★ 機能非依存の部分（identity 解決 / client IP / body 上限 / payload 構造検査 / 共通レスポンス）は
//   `lib/careerApi/requestGuard.ts` にある。本 module はその上に **プレゼン固有の adapter**
//   （operation の種類・rate limit ルール）だけを載せる。
//
// ★ 設計判断（guest を 401 で閉じない理由）:
//   CAREER のプレゼン機能は **guest 利用を正式に許可**している。
//     - `/career` は PlanGate の PROTECTED_PREFIXES に無い（課金・ログイン非ゲート）
//     - 各画面の mirror 呼び出しは一貫して `if (userId) void upsert...`（guest は素通し）
//     - CareerAuthProvider 自身が「env 未設定でも guest として扱い、既存機能は素通しさせる」
//   member 必須なのは GD（マルチプレイで identity が構造的に必須）だけである。
//   したがって本 guard は **401 を返さない**。代わりに identity を server 側で確定し、
//     member … user_id をキーに通常上限
//     guest  … IP をキーに厳しめ上限（fail-closed）
//   の 2 系統で「誰でも無制限に叩ける」状態だけを塞ぐ。
//
// ★ client が body に入れてくる userId 類は **認証として一切信用しない**。
//   identity は Career Supabase（Project B）の server session cookie からのみ導く。
//
// 厳守: never-throw / PII・生 IP・user_id を log しない / AI 到達前に必ず判定する。

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
