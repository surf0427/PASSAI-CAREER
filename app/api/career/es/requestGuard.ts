// PASSAI CAREER — ES AI route 共通の request guard（server-only・4 route 共有）。
//
// STEP-CAREER-ES-HARDENING-P0。
// materials / deep / organize / es-review は Anthropic 課金に直結する公開 endpoint で
// ありながら、認証 identity・rate limit・body サイズ上限・構造サイズ上限のいずれも
// 持っていなかった（ES Production Readiness Audit P0）。本 module がその 4 つを 1 箇所で担う。
//
// ★ 機能非依存の部分（identity 解決 / client IP / body 上限 / payload 構造検査 / 413 レスポンス）は
//   `lib/careerApi/requestGuard.ts` にある。本 module はその上に **ES 固有の adapter**
//   （operation の種類・rate limit ルール・ES 固有の入力上限・ES 既存の 400 契約）だけを載せる。
//   プレゼン（`app/api/career/presentation/requestGuard.ts`）/ 面接（同 interview）と同型。
//
// ★ 設計判断（guest を 401 で閉じない理由）:
//   ES は **guest 利用を正式に許可**している機能である。
//     - `/career/es` 配下は PlanGate の PROTECTED_PREFIXES に無い（課金・ログイン非ゲート）
//     - 各画面の mirror 呼び出しは一貫して `if (userId) void upsert...`（guest は素通し）
//     - draft ストアは ownerId=null（guest）を正規の owner として扱う
//   したがって本 guard は **401 を返さない**。代わりに identity を server 側で確定し、
//     member … user_id をキーに通常上限
//     guest  … IP をキーに厳しめ上限（fail-closed）
//   の 2 系統で「誰でも無制限に叩ける」状態だけを塞ぐ。
//
// ★ client が body に入れてくる userId 類は **認証として一切信用しない**
//   （そもそも ES の 4 route は userId を受け取らない）。
//
// ★ 既存 client のエラー契約を変えない:
//   ES の 4 client はすべて `data.detail ?? '<機能別の既定文言>'` を読む。
//   したがって拒否レスポンスは **必ず JSON**で、`detail` に日本語文言を載せる。
//   400（parse 失敗）は route ごとに既存の形が違うため、operation 別に元の形を維持する。
//
// 厳守: never-throw / PII・生 IP・user_id を log しない / AI 到達前に必ず判定する。

import 'server-only';

import {
  CAREER_ES_RATE_LIMITS,
  checkRateLimits,
  rateLimitedResponse,
  type RateLimitRule,
} from '@/lib/rateLimit';
import {
  findPayloadViolation,
  payloadTooLargeResponse,
  readRawBodyWithinCap,
  resolveCareerRequestIdentity,
  resolveClientIp,
  type CareerRequestIdentity,
} from '@/lib/careerApi/requestGuard';

// ── identity ────────────────────────────────────────────────────────

/** ES route が扱う identity（共通型のエイリアス）。 */
export type EsIdentity = CareerRequestIdentity;

/** Career（Project B）の server session から identity を確定する（never throw / 既定 guest）。 */
export async function resolveEsIdentity(): Promise<EsIdentity> {
  return resolveCareerRequestIdentity();
}

// ── rate limit ──────────────────────────────────────────────────────

export type EsOperation = 'materials' | 'deep' | 'organize' | 'review';

const RULES: Readonly<Record<EsOperation, { member: RateLimitRule; guest: RateLimitRule }>> = {
  materials: {
    member: CAREER_ES_RATE_LIMITS.materialsMember,
    guest: CAREER_ES_RATE_LIMITS.materialsGuest,
  },
  deep: {
    member: CAREER_ES_RATE_LIMITS.deepMember,
    guest: CAREER_ES_RATE_LIMITS.deepGuest,
  },
  organize: {
    member: CAREER_ES_RATE_LIMITS.organizeMember,
    guest: CAREER_ES_RATE_LIMITS.organizeGuest,
  },
  review: {
    member: CAREER_ES_RATE_LIMITS.reviewMember,
    guest: CAREER_ES_RATE_LIMITS.reviewGuest,
  },
};

/** identity と operation から rate limit のキー・ルールを決める（純関数・テスト可能）。 */
export function selectEsRateLimitTarget(
  identity: EsIdentity,
  operation: EsOperation,
  clientIp: string,
): { key: string; rule: RateLimitRule } {
  if (identity.kind === 'member') {
    return { key: `u:${identity.userId}`, rule: RULES[operation].member };
  }
  return { key: `i:${clientIp}`, rule: RULES[operation].guest };
}

// ── ES 固有の入力サイズ上限 ─────────────────────────────────────────
//
// ★ 正常な ES 作成を 1 度も止めないことが最優先の制約。
//   各 route の既存 normalizer は「超過分を切り詰める」方式で、切り詰め後の値は
//   ここに置く上限よりはるかに小さい（例: knownFacts は 40 行 / 1 行 160 字へ truncate）。
//   したがって下の上限は **正規の client では絶対に発火せず**、異常な巨大 request だけを弾く。
// ★ 黙って truncate しない。意味が変わる縮小をせず「大きすぎる」と伝えて拒否する。

/** ES 設問文の上限（実際の設問は 200 字程度。10 倍の余裕）。 */
export const MAX_ES_QUESTION_CHARS = 2_000;
/**
 * 回答本文の上限。
 *
 * ★ 深掘り route の既存 `MAX_ANSWER_CHARS`（8,000）と同値に揃える。
 *   ES 添削の `answer` は **これまで完全に無制限**だった（Audit P0 の中核）。
 *   実際の ES 本文は 200〜1,000 字なので 8,000 字は 8 倍以上の余裕がある。
 */
export const MAX_ES_ANSWER_CHARS = 8_000;
/** 企業名 / 業界 / 職種など、短い応募メタ 1 件の上限。 */
export const MAX_ES_META_CHARS = 200;
/** deepTurns / turns 配列の要素数上限（ES の正常系は最大 15 前後）。 */
export const MAX_ES_TURN_ENTRIES = 60;
/** turn 1 件あたりの content 上限（回答本文と同値）。 */
export const MAX_ES_TURN_CONTENT_CHARS = 8_000;
/** turns 全体の合計文字数上限（＝ prompt へ載る transcript の上限）。 */
export const MAX_ES_TURNS_TOTAL_CHARS = 60_000;
/** knownFacts の件数上限（route は 40 行へ truncate する）。 */
export const MAX_ES_KNOWN_FACTS = 200;
/** knownFacts 1 行の上限（route は 160 字へ truncate する）。 */
export const MAX_ES_KNOWN_FACT_CHARS = 2_000;
/** missingAxes の件数上限（route は 16 件へ truncate する）。 */
export const MAX_ES_MISSING_AXES = 200;
/** 材料候補の件数上限（route は 24 件へ truncate する）。 */
export const MAX_ES_CANDIDATES = 200;
/** 材料候補 1 件の id / label 上限（route は label を 60 字へ truncate する）。 */
export const MAX_ES_CANDIDATE_FIELD_CHARS = 2_000;

export type EsPayloadViolation =
  | 'question_chars'
  | 'answer_chars'
  | 'meta_chars'
  | 'turns_count'
  | 'turn_content_chars'
  | 'turns_total_chars'
  | 'known_facts'
  | 'missing_axes'
  | 'candidates';

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 文字列 field が上限を超えていれば true（非文字列は各 route の normalizer が捨てる）。 */
function overCharLimit(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length > max;
}

/** turns（deep / organize 共有）の会話サイズ検査。 */
function findTurnsViolation(turns: unknown): EsPayloadViolation | null {
  if (!Array.isArray(turns)) return null;
  if (turns.length > MAX_ES_TURN_ENTRIES) return 'turns_count';

  let total = 0;
  for (const turn of turns) {
    if (!isObj(turn)) continue;
    const content = turn.content;
    if (typeof content !== 'string') continue;
    if (content.length > MAX_ES_TURN_CONTENT_CHARS) return 'turn_content_chars';
    total += content.length;
    if (total > MAX_ES_TURNS_TOTAL_CHARS) return 'turns_total_chars';
  }
  return null;
}

/** 文字列配列（knownFacts）の件数・各行長の検査。 */
function findStringListViolation(
  value: unknown,
  maxItems: number,
  maxChars: number,
  violation: EsPayloadViolation,
): EsPayloadViolation | null {
  if (!Array.isArray(value)) return null;
  if (value.length > maxItems) return violation;
  for (const item of value) {
    if (overCharLimit(item, maxChars)) return violation;
  }
  return null;
}

/**
 * ES 固有の入力サイズを operation 別に検査する（純関数・never throw）。
 *
 * ★ 値の **意味論**（role の妥当性・enum 判定・種別推定）は検査しない。
 *   それは各 route の既存 normalizer の責務であり、ここで二重に持たない。
 *   本関数が見るのは「大きすぎないか」だけである。
 */
export function findEsPayloadViolation(
  body: unknown,
  operation: EsOperation,
): EsPayloadViolation | null {
  if (!isObj(body)) return null;

  // 全 operation 共通: ES 設問文。
  if (overCharLimit(body.question, MAX_ES_QUESTION_CHARS)) return 'question_chars';

  if (operation === 'materials') {
    const candidates = body.candidates;
    if (Array.isArray(candidates)) {
      if (candidates.length > MAX_ES_CANDIDATES) return 'candidates';
      for (const candidate of candidates) {
        if (!isObj(candidate)) continue;
        if (overCharLimit(candidate.id, MAX_ES_CANDIDATE_FIELD_CHARS)) return 'candidates';
        if (overCharLimit(candidate.label, MAX_ES_CANDIDATE_FIELD_CHARS)) return 'candidates';
      }
    }
    return null;
  }

  if (operation === 'deep') {
    if (overCharLimit(body.answer, MAX_ES_ANSWER_CHARS)) return 'answer_chars';
    if (overCharLimit(body.companyName, MAX_ES_META_CHARS)) return 'meta_chars';
    const turns = findTurnsViolation(body.turns);
    if (turns) return turns;
    const facts = findStringListViolation(
      body.knownFacts,
      MAX_ES_KNOWN_FACTS,
      MAX_ES_KNOWN_FACT_CHARS,
      'known_facts',
    );
    if (facts) return facts;
    if (Array.isArray(body.missingAxes) && body.missingAxes.length > MAX_ES_MISSING_AXES) {
      return 'missing_axes';
    }
    return null;
  }

  if (operation === 'organize') {
    const turns = findTurnsViolation(body.turns);
    if (turns) return turns;
    return findStringListViolation(
      body.knownFacts,
      MAX_ES_KNOWN_FACTS,
      MAX_ES_KNOWN_FACT_CHARS,
      'known_facts',
    );
  }

  // review: ES 添削。answer が無制限だった経路をここで塞ぐ。
  if (overCharLimit(body.answer, MAX_ES_ANSWER_CHARS)) return 'answer_chars';
  if (
    overCharLimit(body.companyName, MAX_ES_META_CHARS) ||
    overCharLimit(body.industry, MAX_ES_META_CHARS) ||
    overCharLimit(body.jobType, MAX_ES_META_CHARS)
  ) {
    return 'meta_chars';
  }
  return null;
}

// ── 400（parse 失敗）レスポンス ─────────────────────────────────────
//
// ★ route ごとに既存の形が違うため、**元の形をそのまま維持**する（client 契約を変えない）。
//   es-review    … `{ error: 'リクエストボディが不正です。' }`
//   deep/organize/materials … `{ error, code, detail }`（各 route の jsonError と同形）

function esBadRequestResponse(operation: EsOperation): Response {
  if (operation === 'review') {
    return Response.json({ error: 'リクエストボディが不正です。' }, { status: 400 });
  }
  return Response.json(
    { error: 'BAD_REQUEST', code: 'BAD_REQUEST', detail: 'リクエストの形式が不正です。' },
    { status: 400 },
  );
}

// ── 統合 guard ──────────────────────────────────────────────────────

export type EsGuardResult =
  | { ok: true; body: unknown; identity: EsIdentity }
  | { ok: false; response: Response };

/**
 * ES AI route の入口ガード。**AI・Supabase・prompt builder より前**に必ず通す。
 *
 * 順序（意図的）:
 *   1. Content-Length / 実バイト数の上限   … 最も安い判定を最初に（読むだけで弾く）
 *   2. Career identity 確定（Project B）    … client 申告値は使わない
 *   3. rate limit（member=user / guest=IP） … ここで止まれば Anthropic コールは 0 回
 *   4. JSON parse + 汎用構造サイズ検査      … 無制限 payload を prompt へ通さない
 *   5. ES 固有の入力上限                    … 設問 / 本文 / 会話 / 候補の膨張を止める
 */
export async function guardEsRequest(
  req: Request,
  operation: EsOperation,
): Promise<EsGuardResult> {
  // 1) サイズ上限（宣言値 → 実測値の二段）。
  const rawResult = await readRawBodyWithinCap(req);
  if (!rawResult.ok) return { ok: false, response: rawResult.response };

  // 2) identity（never throw / guest へ倒す）。
  const identity = await resolveEsIdentity();

  // 3) rate limit。
  const { key, rule } = selectEsRateLimitTarget(identity, operation, resolveClientIp(req));
  const { allowed, result } = await checkRateLimits({ key, rule });
  if (!allowed) {
    // key の実値（user_id / IP）は出さない。namespace / limit / retryAfter のみ。
    console.warn(
      `career es rate limited: namespace=${rule.namespace} limit=${result.limit} retryAfterSec=${result.retryAfterSeconds}`,
    );
    return { ok: false, response: rateLimitedResponse(result) };
  }

  // 4) parse + 汎用構造サイズ。
  let body: unknown;
  try {
    body = JSON.parse(rawResult.raw);
  } catch {
    return { ok: false, response: esBadRequestResponse(operation) };
  }
  if (findPayloadViolation(body)) {
    return { ok: false, response: payloadTooLargeResponse() };
  }

  // 5) ES 固有の入力上限。
  if (findEsPayloadViolation(body, operation)) {
    return { ok: false, response: payloadTooLargeResponse() };
  }

  return { ok: true, body, identity };
}
