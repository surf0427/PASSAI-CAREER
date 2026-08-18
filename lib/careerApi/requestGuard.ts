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
