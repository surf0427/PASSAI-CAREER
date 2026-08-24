// PASSAI 就活版 — GD TURN ephemeral credential QA（STEP-GD-VOICE-TURN・登録済み・再実行可能）。
//
// 実行: npx tsx --tsconfig tsconfig.realtime-test.json scripts/gd-qa/turn.qa.ts
//       （npm run qa:careerGdTurn）
//
// 検証の種別（正直に区別する）:
//   [UNIT]   純関数の入出力（TTL クランプ / provider 応答の解釈 / ICE エントリ検証）
//            → provider の失敗系（401/403/429/5xx/壊れた JSON/iceServers 欠落 …）は
//              ここで **実際に実行して**確認している。
//   [STATIC] ソースの構造検査（secret を server-only に閉じ込めているか / gate 順序 /
//            client が server ICE を正本にしているか）
//
// ★ 本 QA が PASS しても「実際に Cloudflare から credential が取れる」ことの証明にはならない。
//   それは本番 env と実 API を要するため、operator の smoke（docs 参照）が担当する。

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  GD_TURN_DEFAULT_TTL_SEC,
  GD_TURN_MAX_TTL_SEC,
  GD_TURN_MIN_TTL_SEC,
  buildCloudflareIceEndpoint,
  clampGdTurnTtlSeconds,
  interpretCloudflareIceResponse,
  normalizeIssuedIceServer,
  normalizeIssuedIceServers,
} from '../../lib/careerGd/turnIce';

const ROOT = path.resolve(__dirname, '..', '..');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name);
  }
}

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

const PURE = 'lib/careerGd/turnIce.ts';
const SERVER = 'lib/careerGd/turnCredentials.server.ts';
const ROUTE = 'app/api/career/gd/voice/ice/route.ts';
const MESH_HOOK = 'hooks/useCareerGdVoiceMesh.ts';

// ══════════════════════════════════════════════════════════════
// [A] UNIT — TTL のクランプ（議論の途中で credential が切れない）
// ══════════════════════════════════════════════════════════════
console.log('\n[A] TTL クランプ');
{
  check('A1 未設定は既定 3600 秒', clampGdTurnTtlSeconds(undefined) === GD_TURN_DEFAULT_TTL_SEC);
  check('A2 空文字は既定', clampGdTurnTtlSeconds('') === GD_TURN_DEFAULT_TTL_SEC);
  check('A3 数値でない値は既定', clampGdTurnTtlSeconds('abc') === GD_TURN_DEFAULT_TTL_SEC);
  check('A4 通常値はそのまま', clampGdTurnTtlSeconds('7200') === 7200);
  check('A5 前後空白を許容', clampGdTurnTtlSeconds('  7200  ') === 7200);

  // ★ 本 QA の中核。GD の最大セッション長（1800 秒）より短い TTL を作れないこと。
  //   短い TTL を許すと、30 分 GD の途中で credential が失効して
  //   遅参者の接続や ICE 再試行が失敗する（実際に 600 秒案が検討された）。
  check('A6 下限は GD 最大セッション長（1800秒）', GD_TURN_MIN_TTL_SEC === 1800);
  check('A7 600 秒を指定しても 1800 へ引き上げる', clampGdTurnTtlSeconds('600') === 1800);
  check('A8 1 秒を指定しても 1800 へ引き上げる', clampGdTurnTtlSeconds('1') === 1800);
  check('A9 0 / 負値も 1800 へ', clampGdTurnTtlSeconds('0') === 1800 && clampGdTurnTtlSeconds('-99') === 1800);

  // 実質恒久 credential を作らせない。
  check('A10 上限を超える値は 21600 へ', clampGdTurnTtlSeconds('999999') === GD_TURN_MAX_TTL_SEC);
  check('A11 上限は 6 時間', GD_TURN_MAX_TTL_SEC === 21600);
  check(
    'A12 既定値は GD 最大セッション長を覆う',
    GD_TURN_DEFAULT_TTL_SEC >= 1800 && GD_TURN_DEFAULT_TTL_SEC === 3600,
  );
}

// ══════════════════════════════════════════════════════════════
// [B] UNIT — provider 応答の解釈（§16 の失敗系を実際に実行）
// ══════════════════════════════════════════════════════════════
console.log('\n[B] provider 応答の解釈');
{
  const validBody = JSON.stringify({
    iceServers: {
      urls: [
        'stun:stun.cloudflare.com:3478',
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
      ],
      username: 'ephemeral-user',
      credential: 'ephemeral-cred',
    },
  });

  // ① 正常系。
  {
    const r = interpretCloudflareIceResponse(200, validBody);
    check('B1 正常応答を受理する', r.kind === 'ok');
    if (r.kind === 'ok') {
      check('B2 iceServers を配列へ正規化する', Array.isArray(r.iceServers) && r.iceServers.length === 1);
      const urls = r.iceServers[0].urls;
      check('B3 provider の URL を組み替えず保持する', Array.isArray(urls) && urls.length === 4);
      check(
        'B4 restrictive network 向け turns:443 経路を落とさない',
        Array.isArray(urls) && urls.some((u) => u.startsWith('turns:')),
      );
      check(
        'B5 credential を保持する',
        r.iceServers[0].username === 'ephemeral-user' && r.iceServers[0].credential === 'ephemeral-cred',
      );
    }
  }

  // ② 認証失敗（key id / token 誤り）。
  {
    const r401 = interpretCloudflareIceResponse(401, '{"error":"bad token"}');
    const r403 = interpretCloudflareIceResponse(403, 'forbidden');
    check(
      'B6 401/403 は unauthorized',
      r401.kind === 'error' && r401.code === 'unauthorized' &&
        r403.kind === 'error' && r403.code === 'unauthorized',
    );
  }

  // ③ provider 側の絞り。
  {
    const r = interpretCloudflareIceResponse(429, 'slow down');
    check('B7 429 は rate-limited', r.kind === 'error' && r.code === 'rate-limited');
  }

  // ④ provider 障害。
  {
    const r500 = interpretCloudflareIceResponse(500, 'oops');
    const r503 = interpretCloudflareIceResponse(503, '');
    check(
      'B8 5xx は provider-error',
      r500.kind === 'error' && r500.code === 'provider-error' &&
        r503.kind === 'error' && r503.code === 'provider-error',
    );
  }

  // ⑤ 2xx だが中身が使えない各ケース。
  {
    check(
      'B9 壊れた JSON は invalid-response',
      (() => {
        const r = interpretCloudflareIceResponse(200, '{not json');
        return r.kind === 'error' && r.code === 'invalid-response';
      })(),
    );
    check(
      'B10 空文字本文は invalid-response',
      (() => {
        const r = interpretCloudflareIceResponse(200, '');
        return r.kind === 'error' && r.code === 'invalid-response';
      })(),
    );
    check(
      'B11 iceServers 欠落は invalid-response',
      (() => {
        const r = interpretCloudflareIceResponse(200, '{"ok":true}');
        return r.kind === 'error' && r.code === 'invalid-response';
      })(),
    );
    check(
      'B12 iceServers 空配列は invalid-response',
      (() => {
        const r = interpretCloudflareIceResponse(200, '{"iceServers":[]}');
        return r.kind === 'error' && r.code === 'invalid-response';
      })(),
    );
    check(
      'B13 JSON が配列/文字列でも壊れない',
      (() => {
        const a = interpretCloudflareIceResponse(200, '[]');
        const b = interpretCloudflareIceResponse(200, '"hello"');
        return a.kind === 'error' && b.kind === 'error';
      })(),
    );
    check(
      'B14 全エントリが不正なら invalid-response',
      (() => {
        const r = interpretCloudflareIceResponse(200, '{"iceServers":[{"nope":1},{"urls":""}]}');
        return r.kind === 'error' && r.code === 'invalid-response';
      })(),
    );
  }

  // ⑥ 配列形式の応答も受理する（provider の返し方の揺れに耐える）。
  {
    const arrayBody = JSON.stringify({
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c' },
      ],
    });
    const r = interpretCloudflareIceResponse(200, arrayBody);
    check('B15 配列形式の iceServers も受理する', r.kind === 'ok' && r.iceServers.length === 2);
  }
}

// ══════════════════════════════════════════════════════════════
// [C] UNIT — ICE エントリの検証（壊れた TURN を RTCPeerConnection へ渡さない）
// ══════════════════════════════════════════════════════════════
console.log('\n[C] ICE エントリ検証');
{
  check('C1 urls 無しは棄却', normalizeIssuedIceServer({ username: 'u', credential: 'c' }) === null);
  check('C2 urls 空文字は棄却', normalizeIssuedIceServer({ urls: '   ' }) === null);
  check('C3 null / 非オブジェクトは棄却', normalizeIssuedIceServer(null) === null && normalizeIssuedIceServer('x') === null);
  check('C4 STUN は credential 無しで受理', normalizeIssuedIceServer({ urls: 'stun:a:3478' }) !== null);

  // ★ credential の無い TURN は接続できず、ICE 探索を遅らせるだけなので落とす。
  check('C5 credential 無しの TURN は棄却', normalizeIssuedIceServer({ urls: 'turn:a:3478' }) === null);
  check('C6 username だけの TURN は棄却', normalizeIssuedIceServer({ urls: 'turn:a:3478', username: 'u' }) === null);
  check('C7 turns: も同じ規則', normalizeIssuedIceServer({ urls: 'turns:a:443', credential: 'c' }) === null);
  check(
    'C8 username+credential 付き TURN は受理',
    normalizeIssuedIceServer({ urls: 'turn:a:3478', username: 'u', credential: 'c' }) !== null,
  );
  check(
    'C9 型が文字列でない credential は棄却',
    normalizeIssuedIceServer({ urls: 'turn:a:3478', username: 'u', credential: 123 }) === null,
  );
  check(
    'C10 混在配列（STUN+TURN）では credential 必須',
    normalizeIssuedIceServer({ urls: ['stun:a:3478', 'turn:b:3478'] }) === null,
  );
  check(
    'C11 不正エントリだけを落として残りは通す',
    normalizeIssuedIceServers([{ urls: 'stun:a:3478' }, { nope: 1 }]).length === 1,
  );
  check('C12 非配列・非オブジェクトは空配列', normalizeIssuedIceServers(undefined).length === 0);

  // endpoint 組み立て。
  check(
    'C13 endpoint は Cloudflare の公式パス',
    buildCloudflareIceEndpoint('KEY') ===
      'https://rtc.live.cloudflare.com/v1/turn/keys/KEY/credentials/generate-ice-servers',
  );
  check(
    'C14 key id はエスケープされる（別パスを叩きにいかない）',
    !buildCloudflareIceEndpoint('a/../../evil').includes('/../'),
  );
}

// ══════════════════════════════════════════════════════════════
// [D] STATIC — 長期 secret が server-only に閉じている
// ══════════════════════════════════════════════════════════════
console.log('\n[D] secret の閉じ込め');
{
  const server = read(SERVER);
  check('D1 server-only 境界', server.includes("import 'server-only'"));
  check(
    'D2 長期 secret は NEXT_PUBLIC_ ではない',
    server.includes('process.env.CLOUDFLARE_TURN_KEY_API_TOKEN') &&
      !server.includes('NEXT_PUBLIC_CLOUDFLARE'),
  );

  const serverCode = codeOnly(server);
  // 返り値に secret を載せない（型に username/credential は provider 由来の短命値のみ）。
  check('D3 key id / token を返り値へ載せない', !/return[\s\S]{0,200}apiToken/.test(serverCode));
  // ログに secret / 応答本文を出さない。
  check('D4 Authorization header をログへ出さない', !/devWarn[\s\S]{0,200}Authorization/.test(serverCode));
  check('D5 provider 応答本文をログへ出さない', !/devWarn[\s\S]{0,200}bodyText/.test(serverCode));
  check('D6 apiToken をログへ出さない', !/devWarn[\s\S]{0,200}apiToken/.test(serverCode));
  check(
    'D7 診断は provider/status/code/durationMs までに留める',
    serverCode.includes("provider: 'cloudflare'") && serverCode.includes('durationMs'),
  );
  // 例外オブジェクトをそのまま出さない（URL / token を含みうる）。
  check('D8 catch で例外オブジェクトをログへ渡さない', !/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]{0,200}devWarn\([^)]*,\s*\w+\s*\)/.test(serverCode));

  // 純関数側は secret も env も fetch も触らない。
  const pure = codeOnly(read(PURE));
  check('D9 純関数側は process.env を読まない', !pure.includes('process.env'));
  check('D10 純関数側は fetch しない', !pure.includes('fetch('));

  // タイムアウトがある（provider 無応答で GD が止まらない）。
  check('D11 provider 呼び出しにタイムアウトがある', serverCode.includes('AbortController') && serverCode.includes('PROVIDER_TIMEOUT_MS'));
  check('D12 provider 失敗でも throw しない（STUN へ倒す）', serverCode.includes('return stunOnly('));
}

// ══════════════════════════════════════════════════════════════
// [E] STATIC — ICE endpoint の認可・gate 順序・キャッシュ
// ══════════════════════════════════════════════════════════════
console.log('\n[E] ICE endpoint');
{
  const route = codeOnly(read(ROUTE));
  const gate = route.indexOf('requireCareerGdEnabled');
  const identity = route.indexOf('resolveCareerRequestIdentity');
  const rate = route.indexOf('enforceRateLimit');
  const issue = route.indexOf('issueGdIceServers');

  check('E1 kill switch が最初', gate > 0 && gate < identity);
  check('E2 identity 検証がある', identity > 0);
  check('E3 member 以外を拒否する', route.includes("identity.kind !== 'member'") && route.includes('loginRequiredResponse'));
  check('E4 rate limit が provider 呼び出しより前', rate > 0 && rate < issue);
  check('E5 rate limit は identity の後（user 単位で数える）', identity < rate);
  check('E6 専用 namespace の rule を使う', route.includes('CAREER_GD_RATE_LIMITS.ice'));

  // credential を CDN / browser に残さない。
  check('E7 private, no-store を返す', route.includes("'cache-control': 'private, no-store'"));
  check('E8 force-dynamic / no-store', route.includes("dynamic = 'force-dynamic'") && route.includes("fetchCache = 'force-no-store'"));
  check('E9 nodejs runtime', route.includes("runtime = 'nodejs'"));

  // 応答に余計なものを載せない。
  check('E10 応答は iceServers / ttlSec / turnConfigured のみ', route.includes('turnConfigured: issue.turnConfigured') && !route.includes('errorCode:'));
  check('E11 env 名・provider 名を応答へ出さない', !/Response\.json\([\s\S]{0,300}process\.env/.test(route));

  // rate limit rule が登録されている。
  const rl = codeOnly(read('lib/rateLimit/index.ts'));
  check('E12 ice rule が namespace 付きで登録されている', rl.includes("namespace: 'career_gd_ice'"));
  check('E13 ice rule は複数 window を持つ', /ice: \{[\s\S]{0,200}windowSeconds: 60[\s\S]{0,120}windowSeconds: 3600/.test(rl));
}

// ══════════════════════════════════════════════════════════════
// [F] STATIC — client 統合（server ICE が正本 / STUN fallback は残る）
// ══════════════════════════════════════════════════════════════
console.log('\n[F] client 統合');
{
  const hook = codeOnly(read(MESH_HOOK));
  check('F1 server endpoint から ICE を取得する', hook.includes("fetch('/api/career/gd/voice/ice'"));
  check('F2 no-store で取得する', hook.includes("cache: 'no-store'"));
  check('F3 取得完了まで mesh を起動しない', hook.includes('if (!ice.ready) return;'));
  check('F4 取得結果を RTCPeerConnection へ渡す', hook.includes('iceServers: ice.servers'));
  check('F5 応答を検証してから使う', hook.includes('normalizeIssuedIceServers(data.iceServers)'));
  // ★ 前案にあった JSON.stringify → 文字列パーサ再利用という不自然な経路を使わない。
  check('F6 stringify→再パースの不自然な実装をしない', !hook.includes('JSON.stringify'));
  check('F7 タイムアウトで打ち切って fallback へ進む', hook.includes('GD_ICE_FETCH_TIMEOUT_MS') && hook.includes('AbortController'));
  check('F8 失敗時は STUN fallback で続行する', hook.includes('servers: fallbackIceServers'));
  check('F9 fallback は NEXT_PUBLIC（STUN のみ）', hook.includes('parseGdIceServers(process.env.NEXT_PUBLIC_CAREER_GD_ICE_SERVERS)'));
  check('F10 unmount / room 変更で fetch を中断する', hook.includes('controller.abort()') && hook.includes('cancelled = true'));
  check('F11 room が変わったら ICE を取り直す', /\}, \[enabled, roomId, fallbackIceServers\]\);/.test(hook));
  check('F12 turnConfigured を呼び出し側へ返す', hook.includes('turnConfigured: ice.turnConfigured'));

  // 既存の participant 認可（c99480f）を壊していない。
  check('F13 signaling 認可の名簿受け渡しが残っている', hook.includes('isAllowedPeer:') && hook.includes('allowedRef'));

  // TURN 不在を UI で隠さない。
  const bar = codeOnly(read('app/career/gd/components/voice/GdVoiceBar.tsx'));
  check('F14 TURN 未設定を UI に出す', bar.includes('gd-voice-turn-missing'));
  check(
    'F15 実際の接続失敗表示より優先度が低い（予告扱い）',
    (() => {
      const failedAt = bar.indexOf('peerAudio.failedPeerNames.length > 0 ?');
      const turnAt = bar.indexOf('!peerAudio.turnConfigured &&');
      return failedAt > 0 && turnAt > 0 && failedAt < turnAt;
    })(),
  );

  const room = codeOnly(read('app/career/gd/room/[roomId]/page.tsx'));
  check('F16 room が turnConfigured を UI へ渡す', room.includes('turnConfigured: mesh.turnConfigured'));
}

// ══════════════════════════════════════════════════════════════
// [G] STATIC — Solo は TURN から独立している
// ══════════════════════════════════════════════════════════════
console.log('\n[G] Solo の独立性');
{
  const solo = codeOnly(read('app/career/gd/session/page.tsx'));
  check('G1 solo は mesh を使わない', !solo.includes('useCareerGdVoiceMesh'));
  check('G2 solo は ICE endpoint を叩かない', !solo.includes('/voice/ice'));

  // capabilities（GD 開始可否）に TURN を混ぜていない。
  //   混ぜると TURN provider 障害で Solo GD まで開始できなくなる。
  const cap = codeOnly(read('lib/careerGd/voice.server.ts'));
  //   ★ 素の 'turn' は "return" に部分一致するため、field 名で判定する。
  check(
    'G3 capabilities は stt / tts のみ（turn を混ぜない）',
    !/\bturn\s*:/.test(cap) && cap.includes('stt:') && cap.includes('tts:'),
  );
  const capHook = codeOnly(read('hooks/useCareerGdVoiceCapabilities.ts'));
  check(
    'G4 開始ゲートは stt のみを必須にする',
    capHook.includes('data.stt !== true') && !capHook.includes('data.turn'),
  );

  // ICE endpoint は TURN 未設定でも 200（Solo/Multi を止めない）。
  const route = codeOnly(read(ROUTE));
  check('G5 TURN 未設定でも 5xx にしない', !route.includes('status: 500') && !route.includes('status: 503'));
}

console.log(`\nGD TURN QA: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
