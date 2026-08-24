/**
 * PASSAI 就活版 — Cloudflare Realtime TURN 応答の解釈（STEP-GD-VOICE-TURN）。
 *
 * ★ なぜ server-only モジュールから切り出すか:
 *   provider 応答の解釈と TTL の妥当性判定は、**失敗系こそ検証したい**部分である
 *   （401 / 403 / 429 / 5xx / タイムアウト / 壊れた JSON / iceServers 欠落 / TURN entry 不正）。
 *   secret と fetch を持つ server-only モジュールは QA から import できないため、
 *   純関数だけをここへ置いて実際に単体検証できるようにする。
 *   本ファイルは env も secret も fetch も触らない。
 *
 * ★ 対応する provider は現時点で Cloudflare のみ。薄い境界に留め、抽象化しない。
 */

import type { GdIceServer } from './voice';

// ── TTL ────────────────────────────────────────────────────────────

/**
 * 既定 TTL（秒）。
 *
 * GD の制限時間は DDL 上 `time_limit_sec BETWEEN 300 AND 1800`（最大 30 分）。
 * 1 時間なら最長セッションを 2 倍の余裕で覆えるため、途中で credential が切れて
 * 遅参者の接続や ICE 再試行が失敗する事故が起きない。
 */
export const GD_TURN_DEFAULT_TTL_SEC = 3600;

/**
 * TTL の下限（秒）= GD の最大セッション長。
 *
 * ★ ここを「最大セッション長」に固定するのが本質。これより短い TTL を設定できると、
 *   議論の途中で credential が失効する構成を運用者が作れてしまう
 *   （実際に既定 600 秒＝10 分という設定が検討され、30 分 GD を覆えなかった）。
 *   env に何を書いても、GD を完走できない TTL にはならないようにする。
 */
export const GD_TURN_MIN_TTL_SEC = 1800;

/**
 * TTL の上限（秒）。provider 側の最大値に引きずられて実質恒久 credential に
 * ならないよう、アプリ側で 6 時間に切る。
 */
export const GD_TURN_MAX_TTL_SEC = 21600;

/**
 * env 文字列 → 実際に使う TTL（秒）。
 * 未設定 / 数値でない / 範囲外は、すべて安全側へ丸める（例外にしない）。
 */
export function clampGdTurnTtlSeconds(raw: string | null | undefined): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return GD_TURN_DEFAULT_TTL_SEC;
  return Math.min(GD_TURN_MAX_TTL_SEC, Math.max(GD_TURN_MIN_TTL_SEC, n));
}

// ── provider 応答の検証 ─────────────────────────────────────────────

/** 呼び出し側が分岐に使う失敗理由。secret も provider 応答本文も含めない。 */
export type GdTurnErrorCode =
  | 'unauthorized' // 401 / 403（key id・token が誤っている）
  | 'rate-limited' // 429（provider 側の絞り）
  | 'provider-error' // 5xx / その他の非 2xx
  | 'invalid-response'; // 2xx だが JSON / 形状が期待どおりでない

export type GdTurnIssueResult =
  | { kind: 'ok'; iceServers: GdIceServer[] }
  | { kind: 'error'; code: GdTurnErrorCode };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 1 エントリを検証して正規化する。受理できないものは null。
 *
 * 判定規則:
 *   - urls は文字列 or 文字列配列で、空でないこと
 *   - username / credential は、あるなら文字列であること
 *   - **TURN（turn: / turns:）を含むなら username と credential が必須**
 *     （認証情報の無い TURN エントリは接続できず、あるだけ ICE 探索を遅らせる）
 */
export function normalizeIssuedIceServer(entry: unknown): GdIceServer | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;

  let urls: string | string[] | null = null;
  if (isNonEmptyString(e.urls)) {
    urls = e.urls.trim();
  } else if (Array.isArray(e.urls)) {
    const list = e.urls.filter(isNonEmptyString).map((u) => u.trim());
    if (list.length > 0) urls = list;
  }
  if (!urls) return null;

  const hasUsername = e.username !== undefined && e.username !== null;
  const hasCredential = e.credential !== undefined && e.credential !== null;
  if (hasUsername && typeof e.username !== 'string') return null;
  if (hasCredential && typeof e.credential !== 'string') return null;

  const urlList = typeof urls === 'string' ? [urls] : urls;
  const hasTurn = urlList.some((u) => /^turns?:/i.test(u));
  if (hasTurn && !(isNonEmptyString(e.username) && isNonEmptyString(e.credential))) {
    // 認証情報の無い TURN は機能しない。壊れたエントリを渡すより落とす。
    return null;
  }

  const out: GdIceServer = { urls };
  if (isNonEmptyString(e.username)) out.username = e.username;
  if (isNonEmptyString(e.credential)) out.credential = e.credential;
  return out;
}

/**
 * `iceServers` フィールドを配列へ正規化する。
 *
 * ★ Cloudflare は **単一オブジェクト**（urls 配列 + username + credential）で返す形と、
 *   配列で返す形の両方があり得るため、どちらも受け付けて配列へ揃える。
 *   provider の応答を独自に TURN URL へ組み直すことはしない（URL はそのまま使う）。
 */
export function normalizeIssuedIceServers(raw: unknown): GdIceServer[] {
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const out: GdIceServer[] = [];
  for (const entry of entries) {
    const normalized = normalizeIssuedIceServer(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * provider の HTTP 応答（status + 本文）を解釈する。
 *
 * ★ ここが失敗系の単一判断点。secret も本文も返り値に載せないので、
 *   呼び出し側がそのままログ・レスポンスへ流しても漏洩しない。
 *
 * @param status HTTP status
 * @param bodyText 応答本文（未パース。壊れていてもよい）
 */
export function interpretCloudflareIceResponse(
  status: number,
  bodyText: string,
): GdTurnIssueResult {
  if (status === 401 || status === 403) return { kind: 'error', code: 'unauthorized' };
  if (status === 429) return { kind: 'error', code: 'rate-limited' };
  if (status < 200 || status >= 300) return { kind: 'error', code: 'provider-error' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { kind: 'error', code: 'invalid-response' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'error', code: 'invalid-response' };
  }

  const iceServers = normalizeIssuedIceServers((parsed as Record<string, unknown>).iceServers);
  if (iceServers.length === 0) {
    // iceServers 欠落 / 空配列 / 全エントリが不正、のいずれも「使えない応答」。
    return { kind: 'error', code: 'invalid-response' };
  }
  return { kind: 'ok', iceServers };
}

/**
 * credential generation の endpoint URL を組み立てる。
 *
 * key id は URL パスに入るため、パス区切りや制御文字が混ざらないようにエンコードする
 * （env の書き間違いで別のパスを叩きにいかないようにする）。
 */
export function buildCloudflareIceEndpoint(keyId: string): string {
  return `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
    keyId.trim(),
  )}/credentials/generate-ice-servers`;
}
