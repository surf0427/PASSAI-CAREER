/*
 * scripts/career-company-fetch-guard-qa.ts
 *
 * PASSAI CAREER — 企業 enrichment の outbound fetch guard（SSRF）QA。
 *
 * 背景: 本 repo にとって企業 enrichment は **初の outbound fetch**。
 *   取得先 URL は検索 provider 応答（＝ユーザー入力に由来する外部データ）なので、
 *   guard が無いと server が任意の内部エンドポイントへ到達しうる。
 *
 * 何を守るか:
 *   S-1 scheme / port / IP literal / 内部 host の拒否
 *   S-2 DNS 解決後アドレスの検証（公開ドメインに見えても内部を指すケース）
 *   S-3 redirect の手動追跡と **各 hop の再検証**
 *   S-4 timeout / size cap / content-type allowlist
 *   S-5 credential / cookie を送らない
 *   S-6 静的契約: 企業 enrichment code は safeFetch 以外の outbound を書かない
 *
 * 使い方: npx tsx scripts/career-company-fetch-guard-qa.ts
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  extractDomain,
  guardUrl,
  isAllowedContentType,
  isBlockedAddress,
  isBlockedHostname,
  isIpLiteral,
} from '../lib/careerCompanyFetch/urlGuard';
import { safeFetch } from '../lib/careerCompanyFetch/safeFetch.server';

const ROOT = process.cwd();

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** 常に public を返す DNS（guard の他の部分を検証するため）。 */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

// ════════════════════════════════════════════════════════════════════
console.log('[S-1] scheme / port / host の拒否（DNS 解決前）');

const REJECTED_URLS: readonly [string, string][] = [
  ['file:///etc/passwd', 'scheme_not_allowed'],
  ['ftp://example.com/x', 'scheme_not_allowed'],
  ['data:text/html,<h1>x', 'scheme_not_allowed'],
  ['gopher://example.com', 'scheme_not_allowed'],
  ['http://127.0.0.1/admin', 'host_is_ip_literal'],
  ['http://169.254.169.254/latest/meta-data/', 'host_is_ip_literal'],
  ['http://10.0.0.1/', 'host_is_ip_literal'],
  ['http://192.168.1.1/', 'host_is_ip_literal'],
  ['http://172.16.0.1/', 'host_is_ip_literal'],
  ['http://[::1]/', 'host_is_ip_literal'],
  ['http://localhost/', 'host_not_public'],
  ['http://metadata.google.internal/', 'host_not_public'],
  ['http://foo.internal/', 'host_not_public'],
  ['http://intranet-box/', 'host_not_public'],
  ['http://example.com:22/', 'port_not_allowed'],
  ['http://example.com:3306/', 'port_not_allowed'],
  ['http://user:pass@example.com/', 'credentials_in_url'],
  ['not-a-url', 'invalid_url'],
  ['', 'invalid_url'],
];

for (const [url, expected] of REJECTED_URLS) {
  const res = guardUrl(url);
  check(
    `S-1 拒否: ${url || '(空)'} → ${expected}`,
    !res.ok && res.reason === expected,
    res.ok ? 'accepted' : `got ${res.reason}`,
  );
}

const ACCEPTED_URLS: readonly string[] = [
  'https://www.sony.com/',
  'https://sony.co.jp/company/',
  'http://example.co.jp:8080/about',
  'https://api.houjin-bangou.nta.go.jp/4/name?name=x',
];
for (const url of ACCEPTED_URLS) {
  const res = guardUrl(url);
  check(`S-1 許可: ${url}`, res.ok, res.ok ? '' : `rejected ${res.reason}`);
}

check('S-1x isIpLiteral が IPv4/IPv6 を検出', isIpLiteral('1.2.3.4') && isIpLiteral('[::1]'));
check('S-1y 単一ラベル host は内部扱い', isBlockedHostname('router') && !isBlockedHostname('sony.com'));

// ════════════════════════════════════════════════════════════════════
console.log('[S-2] DNS 解決後アドレスの検証');

const BLOCKED_ADDRESSES: readonly [string, 4 | 6][] = [
  ['127.0.0.1', 4],
  ['0.0.0.0', 4],
  ['10.1.2.3', 4],
  ['172.20.0.5', 4],
  ['192.168.0.10', 4],
  ['169.254.169.254', 4], // cloud metadata
  ['100.64.0.1', 4], // CGNAT
  ['224.0.0.1', 4], // multicast
  ['255.255.255.255', 4],
  ['::1', 6],
  ['fe80::1', 6],
  ['fd00::1', 6],
  ['::ffff:127.0.0.1', 6],
];
for (const [addr, family] of BLOCKED_ADDRESSES) {
  check(`S-2 拒否アドレス: ${addr}`, isBlockedAddress(addr, family));
}
check('S-2 許可アドレス: 93.184.216.34', !isBlockedAddress('93.184.216.34', 4));
check('S-2 許可アドレス: 2606:2800::1', !isBlockedAddress('2606:2800::1', 6));
check('S-2 空アドレスは拒否', isBlockedAddress('', 4));

void (async () => {
  {
    // 公開ドメインに見えるが A レコードが loopback（DNS rebinding）。
    const res = await safeFetch('https://evil-but-public.com/', {
      lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      fetchImpl: async () => new Response('should not reach', { status: 200 }),
    });
    check(
      'S-2a DNS が内部アドレスを返したら fetch しない（rebinding 対策）',
      !res.ok && res.reason === 'address_not_public',
      res.ok ? 'fetched!' : `got ${res.reason}`,
    );
  }
  {
    // 複数レコードのうち 1 つでも内部なら拒否する。
    const res = await safeFetch('https://mixed.example.com/', {
      lookupImpl: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
      fetchImpl: async () => new Response('should not reach', { status: 200 }),
    });
    check(
      'S-2b 一部が内部アドレスでも拒否（部分 public を許可しない）',
      !res.ok && res.reason === 'address_not_public',
    );
  }
  {
    const res = await safeFetch('https://nodns.example.com/', {
      lookupImpl: async () => {
        throw new Error('ENOTFOUND');
      },
      fetchImpl: async () => new Response('x', { status: 200 }),
    });
    check('S-2c DNS 解決失敗は dns_error（never-throw）', !res.ok && res.reason === 'dns_error');
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[S-3] redirect の手動追跡と各 hop の再検証');
  {
    let calls = 0;
    const res = await safeFetch('https://public.example.com/', {
      lookupImpl: publicLookup,
      fetchImpl: async () => {
        calls += 1;
        // 公開 URL → 内部 IP へ redirect（guard を素通りさせない）。
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      },
    });
    check(
      'S-3a redirect 先も guard で再検証される',
      !res.ok && res.reason === 'host_is_ip_literal',
      res.ok ? 'fetched!' : `got ${res.reason}`,
    );
    check('S-3b redirect 先は fetch されない（1 hop だけ実行）', calls === 1, `calls=${calls}`);
  }
  {
    const res = await safeFetch('https://loop.example.com/a', {
      lookupImpl: publicLookup,
      maxRedirects: 2,
      fetchImpl: async () =>
        new Response(null, { status: 301, headers: { location: 'https://loop.example.com/b' } }),
    });
    check('S-3c redirect 上限で停止する', !res.ok && res.reason === 'redirect_limit');
  }
  {
    const res = await safeFetch('https://public.example.com/', {
      lookupImpl: publicLookup,
      fetchImpl: async () => new Response(null, { status: 302 }),
    });
    check('S-3d Location 欠落は redirect_missing_location', !res.ok && res.reason === 'redirect_missing_location');
  }
  {
    // 相対 Location も絶対化して guard を通す。
    let seen = '';
    const res = await safeFetch('https://public.example.com/a/b', {
      lookupImpl: publicLookup,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/a/b')) {
          return new Response(null, { status: 302, headers: { location: '/company/' } });
        }
        seen = url;
        return new Response('<html><title>ok</title>body</html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    });
    check(
      'S-3e 相対 Location を絶対化して追跡する',
      res.ok && seen === 'https://public.example.com/company/',
      `seen=${seen}`,
    );
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[S-4] content-type / size cap / http error');

  check('S-4a text/html 許可', isAllowedContentType('text/html; charset=utf-8'));
  check('S-4b application/json 許可', isAllowedContentType('application/json'));
  check('S-4c text/csv 許可（公的 registry）', isAllowedContentType('text/csv'));
  check('S-4d application/pdf 拒否', !isAllowedContentType('application/pdf'));
  check('S-4e image/png 拒否', !isAllowedContentType('image/png'));
  check('S-4f octet-stream 拒否', !isAllowedContentType('application/octet-stream'));
  check('S-4g 空ヘッダ拒否', !isAllowedContentType(null) && !isAllowedContentType(''));

  {
    const res = await safeFetch('https://public.example.com/', {
      lookupImpl: publicLookup,
      fetchImpl: async () =>
        new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    });
    check('S-4h バイナリ content-type は取得しない', !res.ok && res.reason === 'content_type_not_allowed');
  }
  {
    const big = 'a'.repeat(5000);
    const res = await safeFetch('https://public.example.com/', {
      lookupImpl: publicLookup,
      maxBytes: 1000,
      fetchImpl: async () =>
        new Response(big, { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    check('S-4i size cap 超過で中断', !res.ok && res.reason === 'response_too_large');
  }
  {
    const res = await safeFetch('https://public.example.com/', {
      lookupImpl: publicLookup,
      maxBytes: 1000,
      fetchImpl: async () =>
        new Response('x', {
          status: 200,
          headers: { 'content-type': 'text/html', 'content-length': '999999' },
        }),
    });
    check('S-4j Content-Length で先に弾く（本文を読まない）', !res.ok && res.reason === 'response_too_large');
  }
  {
    const res = await safeFetch('https://public.example.com/', {
      lookupImpl: publicLookup,
      fetchImpl: async () => new Response('nope', { status: 500 }),
    });
    check('S-4k 5xx は http_error（status を保持）', !res.ok && res.reason === 'http_error' && res.status === 500);
  }
  {
    const res = await safeFetch('https://public.example.com/', {
      lookupImpl: publicLookup,
      fetchImpl: async () => {
        const err = new Error('timeout');
        err.name = 'TimeoutError';
        throw err;
      },
    });
    check('S-4l timeout は timeout（never-throw）', !res.ok && res.reason === 'timeout');
  }
  {
    const res = await safeFetch('https://public.example.com/', {
      lookupImpl: publicLookup,
      fetchImpl: async () =>
        new Response('   ', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    check('S-4m 空 body は empty_body', !res.ok && res.reason === 'empty_body');
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[S-5] 送信ヘッダ / credential');
  {
    let init: RequestInit | undefined;
    const res = await safeFetch('https://public.example.com/', {
      lookupImpl: publicLookup,
      fetchImpl: async (_input, i) => {
        init = i;
        return new Response('<html><title>t</title>body</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
    });
    check('S-5a 取得成功時に contentHash と finalUrl を返す', res.ok && res.contentHash.length === 64);
    check('S-5b credentials は omit', init?.credentials === 'omit');
    check('S-5c redirect は manual', init?.redirect === 'manual');
    check('S-5d referrer を送らない', init?.referrerPolicy === 'no-referrer');
    check('S-5e AbortSignal が付く', !!init?.signal);
    {
      const headers = new Headers(init?.headers);
      check('S-5f User-Agent を明示（匿名化・偽装しない）', (headers.get('user-agent') ?? '').includes('PASSAI-CAREER'));
      check('S-5g Cookie ヘッダを送らない', headers.get('cookie') === null);
    }
  }

  check('S-5h extractDomain が host を返す', extractDomain('https://www.Sony.CO.JP/x') === 'www.sony.co.jp');
  check('S-5i extractDomain は不正 URL で空', extractDomain('http://127.0.0.1/') === '');

  // ══════════════════════════════════════════════════════════════════
  console.log('[S-6] 静的契約: safeFetch 以外の outbound を書かない');
  {
    const guardFile = join(ROOT, 'lib/careerCompanyFetch/safeFetch.server.ts');
    const files = [
      ...walk(join(ROOT, 'lib/careerCompanyPrefetch')),
      ...walk(join(ROOT, 'lib/careerCompanyOfficial')),
      ...walk(join(ROOT, 'lib/careerCompanyFetch')),
      ...walk(join(ROOT, 'app/api/career/company')),
    ].filter((f) => f.endsWith('.ts') && f !== guardFile);

    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.includes('typeof fetch'))
        .join('\n');
      return /(^|[^.\w])fetch\s*\(/.test(src);
    });
    check(
      'S-6a 企業 enrichment code に素の fetch( が無い',
      offenders.length === 0,
      offenders.map((f) => f.replace(ROOT + '/', '')).join(', '),
    );

    // guard 本体が pure 判定部を必ず経由すること。
    const guardSrc = readFileSync(guardFile, 'utf8');
    check('S-6b safeFetch は urlGuard を経由する', guardSrc.includes("from './urlGuard'"));
    check(
      'S-6c safeFetch は hop ごとに guardUrl を呼ぶ（loop 内）',
      /for \(let hop[\s\S]*guardUrl\(currentUrl\)/.test(guardSrc),
    );
  }

  console.log('');
  if (failures > 0) {
    console.error(`company fetch guard QA: ${failures} FAILED`);
    process.exit(1);
  }
  console.log('company fetch guard QA: ALL PASS');
})();
