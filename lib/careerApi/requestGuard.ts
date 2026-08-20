// PASSAI CAREER — 公開 AI route 共通の request guard 基盤（server-only・機能非依存）。
//
// STEP-CAREER-API-HARDENING-SHARED。
// CAREER の AI route（プレゼン / 面接 …）は Anthropic 課金に直結する公開 endpoint であり、
// AI へ到達する前に「identity 確定 → rate limit → body サイズ上限」を必ず通す必要がある。
// そのうち **機能に依存しない部分だけ**を本 module に集約する。
//
// ★ 本 module に置くもの（generic）:
//     - Career（Project B）server session からの identity 解決
//     - client IP の抽出
//     - Content-Length / 実バイト数の上限つき raw body 読み出し
//     - parse 済み payload の構造サイズ検査（文字列長 / 配列長 / 深さ / ノード数）
//     - 413 / 400 の共通レスポンス
//
// ★ 本 module に置かないもの（feature 固有・各機能の adapter が持つ）:
//     - operation の種類（theme / evaluate / qa / start / turn / complete …）
//     - rate limit のルール値と namespace
//     - 機能固有の payload 上限（面接の turns 件数・transcript 合計文字数など）
//
// ★ 設計判断（guest を 401 で閉じない）:
//   CAREER は guest 利用を正式に許可した機能群（localStorage canonical / mirror は member のみ）。
//   したがって identity は「拒否するため」ではなく **rate limit のキーを決めるため**に使う。
//   member 必須なのは GD（マルチプレイで identity が構造的に必須）だけ。
//
// ★ client が body に入れてくる userId 類は認証として一切信用しない。
//
// 厳守: never-throw / PII・生 IP・user_id を log しない / AI 到達前に必ず判定する。

import 'server-only';

import { checkRateLimits, rateLimitedResponse, type RateLimitRule } from '@/lib/rateLimit';
import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';

// ── identity ────────────────────────────────────────────────────────

export type CareerRequestIdentity =
  | { kind: 'member'; userId: string }
  | { kind: 'guest' };

/**
 * Career（Project B）の server session から identity を確定する。
 *
 * ★ 未ログイン・匿名・env 未設定・auth 失敗は **すべて guest**（never throw）。
 *   guest は拒否ではなく「IP キーの厳しい上限へ回す」ための分類である。
 */
export async function resolveCareerRequestIdentity(): Promise<CareerRequestIdentity> {
  try {
    const client = await getCareerServerSupabaseClient();
    if (!client) return { kind: 'guest' };
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user || data.user.is_anonymous) return { kind: 'guest' };
    return { kind: 'member', userId: data.user.id };
  } catch {
    return { kind: 'guest' };
  }
}

/**
 * rate limit のキー元になる client IP を取り出す。
 *
 * ★ 取れない場合は `'unknown'` という **共有バケット**へ落とす（個別に緩めない）。
 *   身元も IP も分からない request をむしろ最も絞る、という保守的な既定。
 * ★ 生 IP は返り値としてのみ使い、log には出さない（checkRateLimits が hash 化する）。
 */
export function resolveClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    // 先頭 hop が client（Vercel は左端に実 client を置く）。
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  return 'unknown';
}

// ── body サイズ上限 ─────────────────────────────────────────────────

/**
 * request body 全体の上限（bytes）。
 *
 * 機能横断の既定値。長い transcript（20,000 字 ＝ UTF-8 日本語で最大 60KB 相当）＋
 * context payload（profile / activity / self-analysis / ES / interview / matching /
 * consultation）が収まる十分な余裕を取りつつ、無制限 payload が prompt へ到達する経路を塞ぐ。
 */
export const MAX_BODY_BYTES = 256 * 1024;

/** 単一文字列フィールドの上限。 */
export const MAX_STRING_CHARS = 40_000;
/** 単一配列の要素数上限（活動整理・ES ログ・会話 turns などの暴走を止める）。 */
export const MAX_ARRAY_ITEMS = 500;
/** ネスト深さの上限（深い入れ子による走査コスト・prompt 膨張を止める）。 */
export const MAX_DEPTH = 12;
/** ノード総数の上限（幅×深さの組合せ爆発を止める）。 */
export const MAX_NODES = 20_000;

export type PayloadViolation =
  | 'body_bytes'
  | 'string_chars'
  | 'array_items'
  | 'depth'
  | 'nodes';

/**
 * parse 済み body の構造サイズを検査する（純関数・never throw）。
 *
 * ★ 黙って truncate しない。意味が変わる縮小をせず「大きすぎる」と伝えて拒否する。
 */
export function findPayloadViolation(value: unknown): PayloadViolation | null {
  let nodes = 0;

  function walk(v: unknown, depth: number): PayloadViolation | null {
    if (depth > MAX_DEPTH) return 'depth';
    nodes += 1;
    if (nodes > MAX_NODES) return 'nodes';

    if (typeof v === 'string') {
      return v.length > MAX_STRING_CHARS ? 'string_chars' : null;
    }
    if (Array.isArray(v)) {
      if (v.length > MAX_ARRAY_ITEMS) return 'array_items';
      for (const item of v) {
        const bad = walk(item, depth + 1);
        if (bad) return bad;
      }
      return null;
    }
    if (v && typeof v === 'object') {
      for (const item of Object.values(v as Record<string, unknown>)) {
        const bad = walk(item, depth + 1);
        if (bad) return bad;
      }
      return null;
    }
    return null;
  }

  return walk(value, 0);
}

// ── 共通レスポンス（既存 Career API の contract を変えない）──────────

export function payloadTooLargeResponse(): Response {
  return Response.json(
    {
      error: 'PAYLOAD_TOO_LARGE',
      detail: '入力データが大きすぎます。内容を減らしてもう一度お試しください。',
    },
    { status: 413 },
  );
}

/** 既存 route が返していた parse 失敗レスポンスと **同じ形**（client 契約を変えない）。 */
export function badRequestResponse(): Response {
  return Response.json({ error: 'リクエストボディが不正です。' }, { status: 400 });
}

// ── raw body の読み出し（上限つき）────────────────────────────────

export type RawBodyResult =
  | { ok: true; raw: string }
  | { ok: false; response: Response };

/**
 * body を **上限つき**で読み出す（宣言値 → 実測値の二段）。
 *
 * ★ Content-Length を偽装 / 省略されても、読み取った実バイト数で必ず弾く。
 * ★ AI・DB・prompt builder より前に呼ぶこと（最も安い判定を最初に置く）。
 */
export async function readRawBodyWithinCap(
  req: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<RawBodyResult> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: payloadTooLargeResponse() };
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, response: badRequestResponse() };
  }
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    return { ok: false, response: payloadTooLargeResponse() };
  }
  return { ok: true, raw };
}

// ── 統合 guard（ES / 面接 / プレゼン 以外の CAREER AI route 共通）──────
//
// STEP-CAREER-AI-HARDENING-P0。
//
// ★ なぜ機能ごとの adapter module を増やさないか:
//   ES（app/api/career/es/requestGuard.ts）・面接・プレゼンが専用 adapter を持つのは、
//   それらが **固有の入力上限を新規に定義する必要があった**ため（ES の answer は完全に
//   無制限だった等）。一方で本 guard の対象 9 route は、意味論的な入力上限を
//   **すでに route 内に持っている**（consultation の MAX_MESSAGE_LENGTH / gd の
//   MAX_UTTERANCE_CHARS・MAX_TRANSCRIPT / self-analysis/question の MAX_ANSWER_CHARS 等）。
//   欠けていたのは identity・rate limit・body サイズ上限の 3 つだけなので、
//   同型の adapter を 5 つ複製せず、汎用 guard を 1 つ置いて rule を渡す形にする。
//   （既存 3 機能の adapter は変更しない。判定の順序と思想は完全に同一。）
//
// ★ guest を 401 で閉じない — CAREER 全体の既定方針（ES / 面接 / プレゼンと同一）。
//   identity は「拒否するため」ではなく **rate limit のキーを決めるため**に使う。
//   したがって本 guard の導入で、正規ユーザーの挙動は 1 つも変わらない。


/** member / guest の 2 系統ルール。呼び出し側が CAREER_AI_RATE_LIMITS から渡す。 */
export type CareerAiRateLimitRules = {
  member: RateLimitRule;
  guest: RateLimitRule;
};

/** identity と rule 対から rate limit のキー・ルールを決める（純関数・テスト可能）。 */
export function selectCareerAiRateLimitTarget(
  identity: CareerRequestIdentity,
  rules: CareerAiRateLimitRules,
  clientIp: string,
): { key: string; rule: RateLimitRule } {
  if (identity.kind === 'member') {
    return { key: `u:${identity.userId}`, rule: rules.member };
  }
  return { key: `i:${clientIp}`, rule: rules.guest };
}

/**
 * identity 確定 → rate limit。**AI 到達前**に必ず通す共通部分。
 * 429 なら Response を返す（＝ Anthropic コールは 0 回）。許可なら identity を返す。
 */
async function passIdentityAndRateLimit(
  req: Request,
  rules: CareerAiRateLimitRules,
  label: string,
): Promise<{ ok: true; identity: CareerRequestIdentity } | { ok: false; response: Response }> {
  const identity = await resolveCareerRequestIdentity();
  const { key, rule } = selectCareerAiRateLimitTarget(identity, rules, resolveClientIp(req));
  const { allowed, result } = await checkRateLimits({ key, rule });
  if (!allowed) {
    // key の実値（user_id / IP）は出さない。namespace / limit / retryAfter のみ。
    console.warn(
      `career ${label} rate limited: namespace=${rule.namespace} limit=${result.limit} retryAfterSec=${result.retryAfterSeconds}`,
    );
    return { ok: false, response: rateLimitedResponse(result) };
  }
  return { ok: true, identity };
}

export type CareerAiGuardResult =
  | { ok: true; body: unknown; identity: CareerRequestIdentity }
  | { ok: false; response: Response };

/**
 * JSON body を取る CAREER AI route の入口ガード。
 *
 * 順序（ES / 面接 / プレゼンの guard と意図的に同一）:
 *   1. Content-Length / 実バイト数の上限   … 最も安い判定を最初に（読むだけで弾く）
 *   2. Career identity 確定（Project B）    … client 申告値は使わない
 *   3. rate limit（member=user / guest=IP） … ここで止まれば Anthropic コールは 0 回
 *   4. JSON parse + 汎用構造サイズ検査      … 無制限 payload を prompt へ通さない
 *
 * @param badRequest route ごとに異なる既存の 400 レスポンス（client 契約を変えない）。
 */
export async function guardCareerAiRequest(
  req: Request,
  options: {
    rules: CareerAiRateLimitRules;
    label: string;
    badRequest: () => Response;
    maxBodyBytes?: number;
  },
): Promise<CareerAiGuardResult> {
  // 1) サイズ上限（宣言値 → 実測値の二段）。
  const rawResult = await readRawBodyWithinCap(req, options.maxBodyBytes);
  if (!rawResult.ok) return { ok: false, response: rawResult.response };

  // 2) + 3) identity → rate limit。
  const passed = await passIdentityAndRateLimit(req, options.rules, options.label);
  if (!passed.ok) return { ok: false, response: passed.response };

  // 4) parse + 汎用構造サイズ。
  let body: unknown;
  try {
    body = JSON.parse(rawResult.raw);
  } catch {
    return { ok: false, response: options.badRequest() };
  }
  if (findPayloadViolation(body)) {
    return { ok: false, response: payloadTooLargeResponse() };
  }

  return { ok: true, body, identity: passed.identity };
}

export type CareerAiUploadGuardResult =
  | { ok: true; identity: CareerRequestIdentity }
  | { ok: false; response: Response };

/**
 * multipart/form-data を取る route（企業研究の資料 OCR）の入口ガード。
 *
 * ★ body は読まない。ファイルの MIME / サイズ検証は route 側の既存実装
 *   （ALLOWED_MIME / MAX_BYTES）が正本であり、ここで二重に持たない。
 *   本 guard の責務は「identity 確定 → rate limit を **formData() より前**に通す」ことだけ。
 *   10MB の multipart を parse する前に 429 を返せるので、濫用時のコストが最小になる。
 */
export async function guardCareerAiUpload(
  req: Request,
  options: { rules: CareerAiRateLimitRules; label: string },
): Promise<CareerAiUploadGuardResult> {
  const passed = await passIdentityAndRateLimit(req, options.rules, options.label);
  if (!passed.ok) return { ok: false, response: passed.response };
  return { ok: true, identity: passed.identity };
}
