// PASSAI CAREER — 面接 AI route 共通の request guard（server-only・3 route 共有）。
//
// STEP-CAREER-INTERVIEW-HARDENING-P0-1（Production Readiness Audit P0-1）。
// start / turn / complete は Anthropic 課金に直結する公開 endpoint でありながら、
// 認証 identity・rate limit・body サイズ上限のいずれも持っていなかった。
// 本 module がその 3 つを 1 箇所で担う。
//
// ★ 実装方針（新しい仕組みを作らない）:
//   identity 解決 / client IP 抽出 / body 上限 / payload 構造検査 / 共通レスポンスは
//   機能非依存の共通基盤 `lib/careerApi/requestGuard.ts` にある。本 module はその上に
//   **面接固有の adapter**（rate limit ルール・turns 上限）だけを載せる。
//   ★ 他機能（プレゼン等）の module は参照しない（機能間の依存を作らない）。
//
// ★ 設計判断（guest を 401 で閉じない理由）— プレゼンと同一:
//   面接も **guest 利用を正式に許可**した機能（localStorage canonical・mirror は member のみ）。
//   したがって本 guard は 401 を返さない。identity は「拒否するため」ではなく
//   「rate limit のキーを決めるため」だけに使う。
//
// ★ client が body に入れてくる userId 類は認証として一切信用しない
//   （identity は Career Supabase（Project B）の server session cookie からのみ導く）。
//
// 厳守: never-throw / PII・生 IP・user_id を log しない / **AI 到達前に必ず判定する**。

import 'server-only';

import {
  CAREER_INTERVIEW_RATE_LIMITS,
  checkRateLimits,
  rateLimitedResponse,
  type RateLimitRule,
} from '@/lib/rateLimit';
// ★ 汎用部分は共通基盤から使う（duplicate implementation を作らない）。
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

/** 面接 route が扱う identity（共通型のエイリアス）。 */
export type InterviewIdentity = CareerRequestIdentity;

/** Career（Project B）の server session から identity を確定する（never throw / 既定 guest）。 */
export async function resolveInterviewIdentity(): Promise<InterviewIdentity> {
  return resolveCareerRequestIdentity();
}

// ── rate limit ──────────────────────────────────────────────────────

export type InterviewOperation = 'start' | 'turn' | 'complete';

const RULES: Readonly<
  Record<InterviewOperation, { member: RateLimitRule; guest: RateLimitRule }>
> = {
  start: {
    member: CAREER_INTERVIEW_RATE_LIMITS.startMember,
    guest: CAREER_INTERVIEW_RATE_LIMITS.startGuest,
  },
  turn: {
    member: CAREER_INTERVIEW_RATE_LIMITS.turnMember,
    guest: CAREER_INTERVIEW_RATE_LIMITS.turnGuest,
  },
  complete: {
    member: CAREER_INTERVIEW_RATE_LIMITS.completeMember,
    guest: CAREER_INTERVIEW_RATE_LIMITS.completeGuest,
  },
};

/** identity と operation から rate limit のキー・ルールを決める（純関数・テスト可能）。 */
export function selectInterviewRateLimitTarget(
  identity: InterviewIdentity,
  operation: InterviewOperation,
  clientIp: string,
): { key: string; rule: RateLimitRule } {
  if (identity.kind === 'member') {
    return { key: `u:${identity.userId}`, rule: RULES[operation].member };
  }
  return { key: `i:${clientIp}`, rule: RULES[operation].guest };
}

// ── 面接固有の会話サイズ上限 ────────────────────────────────────────
//
// ★ 正常な面接を 1 度も止めないことが最優先の制約。
//   正常系の最大は「回答 5 件 × 8,000 字（turn route の既存 MAX_ANSWER_CHARS）
//   ＋ 質問 5 件（AI 生成・max_tokens 500 ＝ 実測 200 字前後）」＝ おおよそ 42,000 字・10 要素。
//   下の上限はそのすべてに余裕を持って収まる値であり、異常な巨大 request だけを弾く。

/** turns 配列の要素数上限（正常系は 10 前後。旧セッション互換のため厚めに取る）。 */
export const MAX_TURN_ENTRIES = 60;
/** turn 1 件あたりの content 文字数上限（turn route の MAX_ANSWER_CHARS と同値に揃える）。 */
export const MAX_TURN_CONTENT_CHARS = 8_000;
/** turns 全体の合計文字数上限（＝ prompt へ載る transcript の上限）。 */
export const MAX_TURNS_TOTAL_CHARS = 60_000;

export type InterviewTurnsViolation =
  | 'turns_count'
  | 'turn_content_chars'
  | 'turns_total_chars';

/**
 * body.turns の会話サイズを検査する（純関数・never throw）。
 *
 * ★ 黙って truncate しない（会話の意味が変わるため）。大きすぎるなら拒否して伝える。
 * ★ turns の **形（role / content の妥当性）は検査しない**。それは各 route の既存
 *   normalizeTurns の責務であり、ここで二重に意味論を持たない。
 */
export function findInterviewTurnsViolation(
  body: unknown,
): InterviewTurnsViolation | null {
  if (!body || typeof body !== 'object') return null;
  const turns = (body as { turns?: unknown }).turns;
  if (!Array.isArray(turns)) return null;

  if (turns.length > MAX_TURN_ENTRIES) return 'turns_count';

  let total = 0;
  for (const turn of turns) {
    if (!turn || typeof turn !== 'object') continue;
    const content = (turn as { content?: unknown }).content;
    if (typeof content !== 'string') continue;
    if (content.length > MAX_TURN_CONTENT_CHARS) return 'turn_content_chars';
    total += content.length;
    if (total > MAX_TURNS_TOTAL_CHARS) return 'turns_total_chars';
  }
  return null;
}

// ── 統合 guard ──────────────────────────────────────────────────────

export type InterviewGuardResult =
  | { ok: true; body: unknown; identity: InterviewIdentity }
  | { ok: false; response: Response };

/**
 * 面接 AI route の入口ガード。**AI・Supabase・prompt builder より前**に必ず通す。
 *
 * 順序（意図的）:
 *   1. Content-Length / 実バイト数の上限       … 最も安い判定を最初に
 *   2. Career identity 確定（Project B）        … client 申告値は使わない
 *   3. rate limit（member=user / guest=IP）     … ここで止まれば AI コールは 0 回
 *   4. JSON parse + 構造サイズ検査              … 無制限 payload を prompt へ通さない
 *   5. 面接固有の turns 上限                    … transcript 経由の prompt 膨張を止める
 */
export async function guardInterviewRequest(
  req: Request,
  operation: InterviewOperation,
): Promise<InterviewGuardResult> {
  // 1) サイズ上限（宣言値 → 実測値の二段）。
  const rawResult = await readRawBodyWithinCap(req);
  if (!rawResult.ok) return { ok: false, response: rawResult.response };

  // 2) identity（never throw / guest へ倒す）。
  const identity = await resolveInterviewIdentity();

  // 3) rate limit。
  const { key, rule } = selectInterviewRateLimitTarget(
    identity,
    operation,
    resolveClientIp(req),
  );
  const { allowed, result } = await checkRateLimits({ key, rule });
  if (!allowed) {
    // key の実値（user_id / IP）は出さない。namespace / limit / retryAfter のみ。
    console.warn(
      `career interview rate limited: namespace=${rule.namespace} limit=${result.limit} retryAfterSec=${result.retryAfterSeconds}`,
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

  // 5) 面接固有（会話履歴）の上限。
  if (findInterviewTurnsViolation(body)) {
    return { ok: false, response: payloadTooLargeResponse() };
  }

  return { ok: true, body, identity };
}
