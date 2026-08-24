/**
 * PASSAI 就活版 — GD 参加者間音声の TURN credential 発行（STEP-GD-VOICE-TURN）。
 *
 * ★ なぜ server 側で発行するのか（この STEP の根本原因）:
 *   以前は ICE 設定を `NEXT_PUBLIC_CAREER_GD_ICE_SERVERS` から取っていた。
 *   `NEXT_PUBLIC_*` は **build 時に client bundle へ inline** される静的配信物なので、
 *   そこへ TURN の username / credential を入れた瞬間、認証も rate limit も掛からない状態で
 *   誰でも取り出せる。TURN は任意の UDP/TCP を中継するため、これは
 *   「インターネットに開いたリレー」を配ることに等しい（帯域窃取 → quota 枯渇 →
 *   GD の音声が止まる、という可用性の問題にも直結する）。
 *
 *   そこで長期 secret は **server-only env** に置き、認証済み member にだけ
 *   短命 credential を発行する。browser へ渡るのは短命 credential だけになる。
 *
 * ★ provider は Cloudflare Realtime TURN のみ（薄い境界。過剰抽象化しない）。
 *   Cloudflare が返した `iceServers` を **そのまま**検証して使う。
 *   TURN URL を独自に組み立て直さない（restrictive network 向けの
 *   `turns:...:443?transport=tcp` 等を落とさないため）。
 *
 * ★ 秘密の扱い:
 *   - key id / API token は返り値にもログにも一切出さない。
 *   - provider の応答本文もログに出さない（credential が含まれるため）。
 *   - 例外は握って code だけに畳む（例外 message に本文が載る事故を防ぐ）。
 *
 * ★ TURN 未設定でも例外にしない。`turnConfigured=false` を返し、
 *   呼び出し側が「TURN 無しで動いている」ことを UI へ出せるようにする（無言の劣化を作らない）。
 */

import 'server-only';

import { devWarn } from '@/lib/devLog';
import { GD_DEFAULT_ICE_SERVERS, type GdIceServer } from './voice';
import {
  buildCloudflareIceEndpoint,
  clampGdTurnTtlSeconds,
  interpretCloudflareIceResponse,
  type GdTurnErrorCode,
} from './turnIce';

/** provider 呼び出しの打ち切り。ここを過ぎたら STUN のみで音声接続へ進む。 */
const PROVIDER_TIMEOUT_MS = 5_000;

export type GdIceIssue = {
  /** RTCPeerConnection へそのまま渡せる ICE サーバ設定。 */
  iceServers: GdIceServer[];
  /** credential の有効期間（秒）。TURN 未発行時は 0。 */
  ttlSec: number;
  /**
   * TURN が実際に載っているか。
   * false = 既定 STUN のみ ＝ 対称 NAT 配下の相手とは P2P を張れないことがある。
   */
  turnConfigured: boolean;
  /** 失敗理由（成功時・未設定時は null）。secret も応答本文も含まない。 */
  errorCode: GdTurnErrorCode | null;
};

function stunOnly(errorCode: GdTurnErrorCode | null): GdIceIssue {
  return {
    iceServers: [...GD_DEFAULT_ICE_SERVERS],
    ttlSec: 0,
    turnConfigured: false,
    errorCode,
  };
}

/** Cloudflare TURN が設定されているか（値は返さない）。 */
export function isGdTurnConfigured(): boolean {
  return (
    !!process.env.CLOUDFLARE_TURN_KEY_ID?.trim() &&
    !!process.env.CLOUDFLARE_TURN_KEY_API_TOKEN?.trim()
  );
}

/**
 * 認証済み member 1 人ぶんの ICE サーバ設定を発行する。
 *
 * ★ 呼び出し側（route）は **必ず認証・rate limit の後**で呼ぶこと。
 *   この関数自体は認可を行わない。
 *
 * 失敗時も throw しない。STUN のみ + errorCode を返し、
 * Solo GD（TURN 不要）や Multi の最低限の接続試行を止めない。
 */
export async function issueGdIceServers(): Promise<GdIceIssue> {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_TURN_KEY_API_TOKEN?.trim();
  if (!keyId || !apiToken) {
    // 未設定は「失敗」ではない（TURN 無しで運用している状態）。errorCode も付けない。
    return stunOnly(null);
  }

  const ttlSec = clampGdTurnTtlSeconds(process.env.CAREER_GD_TURN_TTL_SECONDS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  let status: number;
  let bodyText: string;
  const startedAt = Date.now();
  try {
    const res = await fetch(buildCloudflareIceEndpoint(keyId), {
      method: 'POST',
      headers: {
        // ★ この header は絶対にログへ出さない。
        Authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ttl: ttlSec }),
      signal: controller.signal,
      cache: 'no-store',
    });
    status = res.status;
    bodyText = await res.text();
  } catch {
    // タイムアウト / ネットワーク失敗。例外オブジェクトは URL を含みうるので中身を見ない。
    devWarn('[careerGd/turn] provider unreachable', {
      provider: 'cloudflare',
      durationMs: Date.now() - startedAt,
    });
    return stunOnly('provider-error');
  } finally {
    clearTimeout(timer);
  }

  const result = interpretCloudflareIceResponse(status, bodyText);
  if (result.kind === 'error') {
    // ★ status と code のみ。応答本文には credential が含まれるので絶対に出さない。
    devWarn('[careerGd/turn] provider rejected', {
      provider: 'cloudflare',
      status,
      code: result.code,
      durationMs: Date.now() - startedAt,
    });
    return stunOnly(result.code);
  }

  // Cloudflare の応答には STUN も TURN も含まれる。既定 STUN を足すと
  // ICE 探索先が二重になるだけなので、provider の応答をそのまま採用する。
  return {
    iceServers: result.iceServers,
    ttlSec,
    turnConfigured: true,
    errorCode: null,
  };
}
