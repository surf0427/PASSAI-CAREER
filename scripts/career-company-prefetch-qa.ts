/*
 * scripts/career-company-prefetch-qa.ts
 *
 * PASSAI CAREER — Company Prefetch（identity → enrichment → Data Spine）の QA。
 *
 * 何を守るか:
 *   P-1 flag / gate（default OFF・fail-closed・flag OFF で I/O ゼロ）
 *   P-2 company-scoped idempotency（★ user_id を含まない＝ N 人 → 1 job）
 *   P-3 registry parser（列順に依存しない・部分一致を resolved にしない）
 *   P-4 検索応答の正規化（provider 非依存）
 *   P-5 official domain 検証（「1 位だから公式」にしない）
 *   P-6 LLM は抽出器のみ + **原文に無い値を捨てる**決定論検証
 *   P-7 fact mapping（出典必須 / method 優先順 / null を保存しない）
 *   P-8 job service の分岐（freshness short-circuit / dedupe / 部分成功 / ambiguous 停止）
 *   P-9 定数の不変条件（時間予算 / error allowlist）
 *
 * 実 DB / 実 network / 実 AI なし（全 deps を fake で注入）。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-company-prefetch-qa.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeCompanyName } from '../lib/careerCompanyKnowledge/identity';
import {
  ALL_ERROR_CODES,
  MAX_ATTEMPTS,
  ROUTE_MAX_DURATION_SECONDS,
  NONRETRYABLE_ERROR_CODES,
  RETRYABLE_ERROR_CODES,
  isKnownErrorCode,
  isRetryableErrorCode,
  timeBudgetIsConsistent,
} from '../lib/careerCompanyPrefetch/constants';
import { buildCompanyEnrichmentIdentity } from '../lib/careerCompanyPrefetch/idempotency';
import {
  parseCsv,
  parseRegistryCsv,
  parseRegistryRow,
  selectExactCandidates,
} from '../lib/careerCompanyPrefetch/providers/registryParse';
import {
  buildOfficialSiteQuery,
  normalizeSearchHits,
} from '../lib/careerCompanyPrefetch/providers/searchParse';
import {
  discoverPages,
  isNonOfficialHost,
  sameSite,
  verifyOfficialDomain,
} from '../lib/careerCompanyPrefetch/domainVerification';
import {
  COMPANY_EXTRACTION_SYSTEM,
  findRawExcerpt,
  isEmptyExtraction,
  isGroundedInSource,
  normalizeExtractedProfile,
  rejectUngroundedValues,
} from '../lib/careerCompanyPrefetch/extraction';
import {
  buildDomainFacts,
  buildExtractedProfileFacts,
  buildIdentityFacts,
  buildJsonLdFacts,
  buildNavigationFacts,
  mergeFacts,
} from '../lib/careerCompanyPrefetch/factMapping';
import { extractJsonLdOrganization, extractLinks, extractTitle, htmlToText } from '../lib/careerCompanyPrefetch/htmlText';
import { runCompanyPrefetch, type PrefetchDeps, type SiteDocument } from '../lib/careerCompanyPrefetch/prefetchJobService';
import type { RegistryCompanyCandidate } from '../lib/careerCompanyPrefetch/providers/types';

const ROOT = process.cwd();

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const read = (rel: string) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');

/** コメント行を落とした実コードだけを返す（説明文を静的検査に混ぜないため）。 */
function code(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** `CREATE TABLE ... (` 〜 対応する `);` を切り出す。 */
function tableBody(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`);
  if (start < 0) return '';
  const end = sql.indexOf('\n);', start);
  return end < 0 ? '' : sql.slice(start, end);
}

// ════════════════════════════════════════════════════════════════════
console.log('[P-1] flag / gate（default OFF・fail-closed）');
{
  const flags = read('lib/careerCompanyPrefetch/flags.server.ts');
  check('P-1a flags は server-only', /import ['"]server-only['"]/.test(flags));
  check(
    'P-1b code default OFF（明示 true のときだけ有効）',
    flags.includes("process.env.CAREER_COMPANY_PREFETCH_ENABLED === 'true'"),
  );
  check(
    'P-1c external fetch は独立 flag かつ prefetch flag との AND',
    flags.includes('CAREER_COMPANY_PREFETCH_EXTERNAL_FETCH_ENABLED') &&
      /isCompanyPrefetchEnabled\(\)\s*&&/.test(flags),
  );
  check(
    'P-1d canary targeting は既存 pure evaluator へ委譲（fail-closed 規約を再実装しない）',
    flags.includes("from '@/lib/careerGenerationJob/pilotTargeting'"),
  );
  check(
    'P-1e ★ Identity / Matching flag を実コードで参照しない（独立に ON/OFF できる）',
    !code(flags).includes('CAREER_COMPANY_IDENTITY_ENABLED') &&
      !code(flags).includes('CAREER_COMPANY_MATCHING_ENABLED'),
  );

  const gate = read('lib/careerCompanyPrefetch/gate.server.ts');
  check('P-1f gate は server-only', /import ['"]server-only['"]/.test(gate));
  {
    // import 節を除いた **関数本体**で順序を見る（import 順は判定順ではない）。
    const body = code(gate).split('export async function evaluateCompanyPrefetchGate')[1] ?? '';
    check(
      'P-1g ★ flag OFF なら Supabase にも触れない（判定順が flag → auth）',
      body.indexOf('isCompanyPrefetchEnabled()') >= 0 &&
        body.indexOf('isCompanyPrefetchEnabled()') < body.indexOf('getCareerServerSupabaseClient'),
    );
  }
  check('P-1h 匿名ユーザーを除外', gate.includes('is_anonymous'));
  check('P-1i rate limit を通す', gate.includes('checkServerRateLimit'));
  check(
    'P-1j gate 不成立でも HTTP 200（ユーザー機能を壊さない）',
    /accepted: false[\s\S]*status: 200/.test(gate),
  );
  check(
    'P-1k Identity の public gate を再利用していない（別 gate）',
    !gate.includes('evaluateCompanyIdentityGate'),
  );
}

// ════════════════════════════════════════════════════════════════════
console.log('[P-2] company-scoped idempotency（N 人 → 1 job）');
{
  const a = buildCompanyEnrichmentIdentity({ companyId: 'cmp_sony' });
  const b = buildCompanyEnrichmentIdentity({ companyId: 'cmp_sony' });
  const c = buildCompanyEnrichmentIdentity({ companyId: 'cmp_nintendo' });

  check('P-2a 同一 companyId → 同一 key（決定論）', a.idempotencyKey === b.idempotencyKey);
  check('P-2b 別 companyId → 別 key', a.idempotencyKey !== c.idempotencyKey);
  check('P-2c key は SHA-256 hex（64 桁）', /^[0-9a-f]{64}$/.test(a.idempotencyKey));
  check(
    'P-2d revision が変われば key も変わる（再取得できる）',
    buildCompanyEnrichmentIdentity({ companyId: 'cmp_sony', fetcherRevision: 'v2' }).idempotencyKey !==
      a.idempotencyKey,
  );

  const src = read('lib/careerCompanyPrefetch/idempotency.ts');
  check(
    'P-2e ★ key の材料に user_id / userId を含めない（global work であることの本体）',
    !/userId|user_id/.test(src.split('sha256Hex(')[1]?.slice(0, 400) ?? ''),
  );
  check(
    'P-2f 既存 generation job の hash 関数を再利用（規約を二重に書かない）',
    src.includes("from '@/lib/careerGenerationJob/idempotency'"),
  );

  const ddl = read('supabase/career_company_official_facts_apply.sql');
  {
    const jobs = tableBody(ddl, 'career_company_enrichment_jobs');
    check('P-2g0 job table の DDL が存在する', jobs !== '');
    check('P-2g ★ job table に user_id 列が無い', jobs !== '' && !jobs.includes('user_id'));
    check('P-2g2 ★ job table に auth.users への参照が無い', jobs !== '' && !jobs.includes('auth.users'));
  }
  check(
    'P-2h natural key が (company_id, task, idempotency_key)',
    ddl.includes('UNIQUE (company_id, task, idempotency_key)'),
  );
}

// ════════════════════════════════════════════════════════════════════
console.log('[P-3] registry parser（列順に依存しない）');
{
  // 実 API の列順に依存しないことを示すため、**わざと違う列順**の 2 パターンで同じ結果を得る。
  const csvA = [
    '1,7000012050002,01,0,2026-04-01,2026-04-01,ソニーグループ株式会社,,301,東京都,港区,港南1-7-1',
  ].join('\n');
  const csvB = [
    '1,01,0,2026-04-01,7000012050002,ソニーグループ株式会社,東京都,港区,港南1-7-1',
  ].join('\n');

  const a = parseRegistryCsv(csvA);
  const b = parseRegistryCsv(csvB);
  check('P-3a 列順 A で法人番号を同定', a[0]?.corporateNumber === '7000012050002', JSON.stringify(a[0]));
  check('P-3b 列順 B でも同じ法人番号', b[0]?.corporateNumber === '7000012050002');
  check('P-3c 商号を数値列・日付列と取り違えない', a[0]?.legalName === 'ソニーグループ株式会社', a[0]?.legalName);
  check('P-3d 都道府県を同定', a[0]?.prefecture === '東京都', String(a[0]?.prefecture));

  check('P-3e 法人番号が無い行は捨てる', parseRegistryRow(['1', 'abc', 'def']) === null);
  check('P-3f 空 CSV は空配列', parseRegistryCsv('').length === 0);
  check('P-3g 壊れた入力でも throw しない', parseRegistryCsv('%%%\n,,,\n').length === 0);

  // quoted field / 改行入り。
  const quoted = parseCsv('1,"A,B",2\n3,"C\nD",4\n');
  check('P-3h CSV の quoted field を扱える', quoted[0]?.[1] === 'A,B' && quoted[1]?.[1] === 'C\nD');

  // history: 同一法人番号の複数行 → 最後が現商号・それ以外は formerNames。
  const history = parseRegistryCsv(
    [
      '1,7000012050002,01,0,2018-01-01,,ソニー株式会社,東京都,港区',
      '2,7000012050002,01,0,2026-04-01,,ソニーグループ株式会社,東京都,港区',
    ].join('\n'),
  );
  check('P-3i 同一法人番号は 1 件へ畳む', history.length === 1);
  check('P-3j 最新行が現商号', history[0]?.legalName === 'ソニーグループ株式会社');
  check(
    'P-3k 旧商号を formerNames に保持（alias historical_name の材料）',
    history[0]?.formerNames.includes('ソニー株式会社'),
    JSON.stringify(history[0]?.formerNames),
  );

  // ★ 部分一致を resolved にしない。
  const candidates: RegistryCompanyCandidate[] = [
    { corporateNumber: '1', legalName: 'ソニーグループ株式会社', legalNameKana: null, legalNameEn: null, prefecture: null, address: null, registrationStatus: null, formerNames: [] },
    { corporateNumber: '2', legalName: 'ソニー損害保険株式会社', legalNameKana: null, legalNameEn: null, prefecture: null, address: null, registrationStatus: null, formerNames: [] },
    { corporateNumber: '3', legalName: 'ソニー銀行株式会社', legalNameKana: null, legalNameEn: null, prefecture: null, address: null, registrationStatus: null, formerNames: [] },
  ];
  check(
    'P-3l 「ソニー」は部分一致だけ → 完全一致ゼロ（自動確定しない）',
    selectExactCandidates('ソニー', candidates, normalizeCompanyName).length === 0,
  );
  check(
    'P-3m 「ソニーグループ株式会社」は 1 社に確定',
    selectExactCandidates('ソニーグループ', candidates, normalizeCompanyName).length === 1,
  );
  check(
    'P-3n 旧商号でも一致する（alias 経路）',
    selectExactCandidates(
      'ソニー株式会社',
      [{ ...candidates[0], formerNames: ['ソニー株式会社'] }],
      normalizeCompanyName,
    ).length === 1,
  );

  const provider = read('lib/careerCompanyPrefetch/providers/corporateRegistry.server.ts');
  check('P-3o ★ registry provider は AI を使わない', !/anthropic|messages\.create/.test(provider));
  {
    // 出典 URL を組む関数の **本体**に、secret（appId）を載せる行が無いこと。
    const provenanceBody = provider.split('function buildProvenanceUrl')[1]?.split('\n}')[0] ?? '';
    check('P-3p0 buildProvenanceUrl が存在する', provenanceBody !== '');
    check(
      'P-3p ★ secret（appId）を出典 URL に載せない',
      provenanceBody !== '' && !provenanceBody.includes('getAppId') && !provenanceBody.includes("'id'"),
    );
    // 逆に、実リクエスト側には appId が載ること（機能として成立していること）。
    const requestBody = provider.split('function buildRequestUrl')[1]?.split('\n}')[0] ?? '';
    check('P-3p2 実リクエスト側には appId が載る', requestBody.includes('getAppId') && requestBody.includes("'id'"));
  }
  check(
    'P-3q flag OFF なら outbound しない',
    provider.indexOf('isCompanyPrefetchExternalFetchEnabled()') < provider.indexOf('safeFetch('),
  );
}

// ════════════════════════════════════════════════════════════════════
console.log('[P-4] 検索応答の正規化（provider 非依存）');
{
  const brave = { web: { results: [{ url: 'https://a.com', title: 'A', description: 'da' }] } };
  const cse = { items: [{ link: 'https://b.com', title: 'B', snippet: 'db' }] };
  const tavily = { results: [{ url: 'https://c.com', title: 'C', content: 'dc' }] };
  const plain = [{ url: 'https://d.com', name: 'D', summary: 'dd' }];

  check('P-4a Brave 形を読める', normalizeSearchHits(brave)[0]?.url === 'https://a.com');
  check('P-4b Google CSE 形を読める', normalizeSearchHits(cse)[0]?.url === 'https://b.com');
  check('P-4c Tavily 形を読める', normalizeSearchHits(tavily)[0]?.url === 'https://c.com');
  check('P-4d 素の配列を読める', normalizeSearchHits(plain)[0]?.title === 'D');
  check('P-4e url の無い要素は捨てる', normalizeSearchHits([{ title: 'x' }]).length === 0);
  check('P-4f 非 http は捨てる', normalizeSearchHits([{ url: 'ftp://x' }]).length === 0);
  check('P-4g 重複 URL を畳む', normalizeSearchHits([{ url: 'https://a.com' }, { url: 'https://a.com' }]).length === 1);
  check('P-4h 壊れた入力で throw しない', normalizeSearchHits(null).length === 0);
  check('P-4i クエリは推測語を混ぜない', buildOfficialSiteQuery('ソニー', null) === 'ソニー 公式サイト');
  check('P-4j 登記名があればそれを使う', buildOfficialSiteQuery('ソニー', 'ソニーグループ株式会社') === 'ソニーグループ株式会社 公式サイト');
}

// ════════════════════════════════════════════════════════════════════
console.log('[P-5] official domain 検証（「1 位だから公式」にしない）');
{
  const names = {
    displayName: 'ソニーグループ株式会社',
    legalName: 'ソニーグループ株式会社',
    legalNameEn: 'Sony Group Corporation',
    formerNames: ['ソニー株式会社'],
  };

  check('P-5a 就活媒体は非公式', isNonOfficialHost('job.rikunabi.com'));
  check('P-5b Wikipedia は非公式', isNonOfficialHost('ja.wikipedia.org'));
  check('P-5c まとめ/与信サイトは非公式', isNonOfficialHost('baseconnect.in'));
  check('P-5d SNS は非公式', isNonOfficialHost('www.facebook.com'));
  check('P-5e 通常の企業ドメインは許可', !isNonOfficialHost('www.sony.com'));

  {
    const v = verifyOfficialDomain({
      host: 'job.rikunabi.com',
      title: 'ソニーグループ株式会社の採用情報',
      bodyText: 'ソニーグループ株式会社',
      jsonLdNames: [],
      names,
    });
    check('P-5f ★ 企業名が載っていても媒体サイトは採用しない', !v.verified && v.reason === 'non_official_host');
  }
  {
    const v = verifyOfficialDomain({
      host: 'www.sony.com',
      title: '無関係なページ',
      bodyText: '別会社の説明',
      jsonLdNames: [],
      names,
    });
    check('P-5g ★ 企業名がページに無ければ採用しない（順位を根拠にしない）', !v.verified && v.reason === 'name_not_found');
  }
  {
    const v = verifyOfficialDomain({
      host: 'www.sony.com',
      title: 'ソニーグループ株式会社',
      bodyText: '',
      jsonLdNames: [],
      names,
    });
    check('P-5h title 一致で採用', v.verified && v.reason === 'name_in_title');
  }
  {
    const v = verifyOfficialDomain({
      host: 'www.sony.com',
      title: 'Home',
      bodyText: 'x',
      jsonLdNames: ['Sony Group Corporation'],
      names,
    });
    check('P-5i JSON-LD 一致が最も強い', v.verified && v.reason === 'name_in_jsonld' && v.score > 0.9);
  }
  {
    const v = verifyOfficialDomain({
      host: 'www.sony.com',
      title: 'Home',
      bodyText: 'このサイトはソニーグループ株式会社が運営しています',
      jsonLdNames: [],
      names,
    });
    check('P-5j 本文一致は採用するが confidence を下げる', v.verified && v.score < 0.7);
  }
  {
    const v = verifyOfficialDomain({
      host: 'www.example.com',
      title: 'ABC',
      bodyText: 'ABC',
      jsonLdNames: [],
      names: { displayName: 'AB', legalName: null, legalNameEn: null, formerNames: [] },
    });
    check('P-5k 2 文字以下の名前では本文一致判定をしない（誤検出防止）', !v.verified);
  }

  // 入口ページ検出は同一登録ドメインのみ。
  const links = [
    { href: 'https://www.sony.com/ja/company/', label: '会社概要' },
    { href: 'https://www.sony.com/ja/ir/', label: 'IR情報' },
    { href: 'https://recruit.sony.co.jp/', label: '採用情報' },
    { href: 'https://job.rikunabi.com/sony', label: '採用情報' },
    { href: 'https://www.sony.com/ja/news/', label: 'ニュースリリース' },
  ];
  const pages = discoverPages(links, 'www.sony.com');
  check('P-5l 会社概要ページを検出', pages.about === 'https://www.sony.com/ja/company/');
  check('P-5m IR ページを検出', pages.ir === 'https://www.sony.com/ja/ir/');
  check('P-5n ★ 外部媒体の採用ページを採用しない', pages.recruit !== 'https://job.rikunabi.com/sony');
  check('P-5o サブドメインは同一サイトとして許容', sameSite('https://recruit.sony.co.jp/', 'sony.co.jp'));
  check('P-5p 別ドメインは弾く', !sameSite('https://job.rikunabi.com/', 'sony.com'));
}

// ════════════════════════════════════════════════════════════════════
console.log('[P-6] LLM は抽出器のみ + 原文に無い値を捨てる');
{
  check(
    'P-6a 抽出 prompt が生成・推測・要約を禁止している',
    COMPANY_EXTRACTION_SYSTEM.includes('あなたの知識を一切使わないでください') &&
      COMPANY_EXTRACTION_SYSTEM.includes('推測・補完・要約・言い換えをしないでください') &&
      COMPANY_EXTRACTION_SYSTEM.includes('必ず null'),
  );
  check(
    'P-6b 抽出 prompt が分析・評価を禁止している',
    COMPANY_EXTRACTION_SYSTEM.includes('あなたは抽出器であり、分析者ではありません'),
  );

  const sourceText = [
    '会社概要',
    '商号 ソニーグループ株式会社',
    '設立 1946年5月7日',
    '資本金 880,214百万円（2026年3月31日現在）',
    '従業員数 連結 113,000名',
    '事業内容 ゲーム＆ネットワークサービス、音楽、映画、エンタテインメント・テクノロジー＆サービス',
  ].join('\n');

  check('P-6c 原文にある値は grounded', isGroundedInSource('1946年5月7日', sourceText));
  check('P-6d 表記ゆれ（空白・記号）を吸収する', isGroundedInSource('880,214 百万円', sourceText));
  check('P-6e ★ 原文に無い値は grounded ではない', !isGroundedInSource('1955年3月1日', sourceText));
  check('P-6f 1 文字の値は採用しない', !isGroundedInSource('1', sourceText));
  check('P-6g 空入力で throw しない', !isGroundedInSource('', sourceText) && !isGroundedInSource('x', ''));

  // ★ 幻覚した値を捨て、正しい値は残す（部分成功）。
  const hallucinated = normalizeExtractedProfile({
    legalName: 'ソニーグループ株式会社',
    foundedYear: '1946年5月7日',
    // 本文に存在しない（LLM が知識から補った想定）。
    capital: '1兆円',
    listingStatus: '東証プライム',
    businessSegments: ['ゲーム＆ネットワークサービス', '半導体事業'],
  });
  const { profile, report } = rejectUngroundedValues(hallucinated, sourceText);

  check('P-6h ★ 幻覚した capital を捨てる', profile.capital === null);
  check('P-6i ★ 本文に無い listingStatus を捨てる', profile.listingStatus === null);
  check('P-6j 原文にある foundedYear は残す', profile.foundedYear === '1946年5月7日');
  check('P-6k 配列は要素単位で検証する', profile.businessSegments.length === 1 && profile.businessSegments[0] === 'ゲーム＆ネットワークサービス');
  check('P-6l 捨てた key を観測に残す（値は残さない）', report.rejectedKeys.includes('capital') && report.rejectedKeys.includes('listingStatus'));
  check('P-6m 残った件数を数える', report.kept > 0);

  check('P-6n 全部捨てられたら空判定', isEmptyExtraction(rejectUngroundedValues(normalizeExtractedProfile({ capital: '嘘' }), sourceText).profile));
  check('P-6o 未知 key は捨てる', !('unknownKey' in normalizeExtractedProfile({ unknownKey: 'x' })));
  check('P-6p "null" 文字列を値にしない', normalizeExtractedProfile({ capital: 'null' }).capital === null);
  check('P-6q rawExcerpt は原文から切り出す（作文しない）', (findRawExcerpt('1946年5月7日', sourceText) ?? '').includes('1946年5月7日'));
  check('P-6r 原文に無い値の excerpt は null', findRawExcerpt('1955年', sourceText) === null);

  const runtime = read('lib/careerCompanyPrefetch/runtime.server.ts');
  check('P-6s 抽出は temperature 0（決定論）', /temperature:\s*0\b/.test(runtime));
  check('P-6t 抽出 model は安価な抽出器', runtime.includes('COMPANY_EXTRACTION_MODEL'));
  check('P-6u API key 未設定でも落ちない', runtime.includes('ANTHROPIC_API_KEY'));
}

// ════════════════════════════════════════════════════════════════════
console.log('[P-7] fact mapping（出典必須 / 優先順 / null を保存しない）');
{
  const candidate: RegistryCompanyCandidate = {
    corporateNumber: '7000012050002',
    legalName: 'ソニーグループ株式会社',
    legalNameKana: 'ソニーグループ',
    legalNameEn: null,
    prefecture: '東京都',
    address: '東京都港区港南1-7-1',
    registrationStatus: null,
    formerNames: [],
  };
  const identityFacts = buildIdentityFacts(candidate, 'https://registry.example/x', '2026-08-16T00:00:00.000Z');

  check('P-7a identity facts が生成される', identityFacts.length >= 5);
  check('P-7b すべて sourceUrl を持つ', identityFacts.every((f) => f.sourceUrl !== ''));
  check('P-7c registry 由来は structured_api', identityFacts.every((f) => f.extractionMethod === 'structured_api'));
  check('P-7d ★ null の項目は fact を作らない', !identityFacts.some((f) => f.factKey === 'registrationStatus'));
  check('P-7e fact_group が identity', identityFacts.every((f) => f.factGroup === 'identity'));

  const navFacts = buildNavigationFacts(
    { about: null, recruit: 'https://x.com/recruit', ir: null, news: null, midTermPlan: null },
    'https://x.com/',
    '2026-08-16T00:00:00.000Z',
  );
  check('P-7f navigation は見つかったものだけ', navFacts.length === 1 && navFacts[0].factKey === 'recruitUrl');

  const jsonLdFacts = buildJsonLdFacts(
    { name: 'Sony', legalName: 'ソニーグループ株式会社', url: null, foundingDate: '1946', numberOfEmployees: '113000', addressLocality: null, addressRegion: null, streetAddress: null, description: null },
    'https://x.com/',
    '2026-08-16T00:00:00.000Z',
  );
  check('P-7g JSON-LD は html_structured', jsonLdFacts.every((f) => f.extractionMethod === 'html_structured'));

  const src = 'ソニーグループ株式会社 設立 1946年';
  const llmFacts = buildExtractedProfileFacts(
    normalizeExtractedProfile({ legalName: 'ソニーグループ株式会社', foundedYear: '1946年' }),
    src,
    'https://x.com/company/',
    '2026-08-16T00:00:00.000Z',
  );
  check('P-7h LLM 由来は llm_extraction', llmFacts.every((f) => f.extractionMethod === 'llm_extraction'));

  // ★ 優先順: structured_api > html_structured > llm_extraction
  const merged = mergeFacts('cmp_1', [llmFacts, jsonLdFacts, identityFacts]);
  const legalName = merged.find((f) => f.factKey === 'legalName');
  check(
    'P-7i ★ 同一 key は structured_api（公的 registry）が勝つ',
    legalName?.extractionMethod === 'structured_api',
    String(legalName?.extractionMethod),
  );
  const founded = merged.find((f) => f.factKey === 'foundedYear');
  check(
    'P-7j registry に無い key は html_structured が llm より勝つ',
    founded?.extractionMethod === 'html_structured',
    String(founded?.extractionMethod),
  );
  check('P-7k companyId が全 fact に入る', merged.every((f) => f.companyId === 'cmp_1'));
  check('P-7l 同一 key は 1 件に畳まれる', new Set(merged.map((f) => f.factKey)).size === merged.length);
  check(
    'P-7m 決定論順（group → key）',
    JSON.stringify(merged.map((f) => f.factKey)) ===
      JSON.stringify(mergeFacts('cmp_1', [llmFacts, jsonLdFacts, identityFacts]).map((f) => f.factKey)),
  );

  const domainFacts = buildDomainFacts('www.sony.com', 'https://www.sony.com/', null, 'https://www.sony.com/', '2026-08-16T00:00:00.000Z');
  check('P-7n officialDomain / officialUrl は必ず作られる', domainFacts.length === 2);
  check('P-7o aboutPageUrl が null なら作らない', !domainFacts.some((f) => f.factKey === 'aboutPageUrl'));

  const repo = read('lib/careerCompanyPrefetch/repository.server.ts');
  check(
    'P-7p ★ source_id を解決できない fact は書かない',
    repo.includes('if (!sourceId)') && repo.includes('fact dropped'),
  );
  check('P-7q source を先に書く関数がある', repo.includes('export async function insertSources'));
  check('P-7r 未適用 table を検出して no-op へ倒す', repo.includes('UNDEFINED_TABLE') && repo.includes('42P01'));
}

// ════════════════════════════════════════════════════════════════════
console.log('[P-8] job service の分岐（fake deps）');

const ISO = '2026-08-16T12:00:00.000Z';
const REGISTRY_SOURCE = {
  sourceUrl: 'https://registry.example/name?name=x',
  sourceType: 'corporate_registry' as const,
  sourceDomain: 'registry.example',
  httpStatus: 200,
  contentHash: 'h',
  fetchedAt: ISO,
  publishedAt: null,
};
const SONY: RegistryCompanyCandidate = {
  corporateNumber: '7000012050002',
  legalName: 'ソニーグループ株式会社',
  legalNameKana: 'ソニーグループ',
  legalNameEn: 'Sony Group Corporation',
  prefecture: '東京都',
  address: '東京都港区港南1-7-1',
  registrationStatus: null,
  formerNames: ['ソニー株式会社'],
};

const SITE_HTML_TEXT = [
  '会社概要',
  '商号 ソニーグループ株式会社',
  '設立 1946年5月7日',
  '事業内容 ゲーム＆ネットワークサービス',
].join('\n');

type FakeState = {
  claims: number;
  claimOutcome: string;
  facts: number;
  sources: number;
  finished: { status: string; errorCode: string | null } | null;
  failed: string | null;
  freshness: Map<string, string>;
  registered: string[];
};

function makeDeps(over: Partial<PrefetchDeps> = {}, state?: FakeState): PrefetchDeps {
  const s: FakeState = state ?? {
    claims: 0,
    claimOutcome: 'CLAIMED_NEW',
    facts: 0,
    sources: 0,
    finished: null,
    failed: null,
    freshness: new Map(),
    registered: [],
  };

  const siteDoc: SiteDocument = {
    url: 'https://www.sony.com/',
    text: SITE_HTML_TEXT,
    title: 'ソニーグループ株式会社',
    links: [{ href: 'https://www.sony.com/company/', label: '会社概要' }],
    jsonLd: null,
    source: {
      sourceUrl: 'https://www.sony.com/',
      sourceType: 'official_site',
      sourceDomain: 'www.sony.com',
      httpStatus: 200,
      contentHash: 'h2',
      fetchedAt: ISO,
      publishedAt: null,
    },
  };

  return {
    now: () => ISO,
    externalFetchEnabled: () => true,
    registry: {
      name: 'fake',
      isConfigured: () => true,
      lookupByName: async () => ({ status: 'resolved', candidate: SONY, source: REGISTRY_SOURCE }),
    },
    search: {
      name: 'fake',
      isConfigured: () => true,
      searchOfficialSite: async () => ({
        status: 'ok',
        hits: [{ url: 'https://www.sony.com/', title: 'Sony', snippet: '' }],
        source: { ...REGISTRY_SOURCE, sourceType: 'search_result', sourceUrl: 'https://search.example/?q=x' },
      }),
    },
    fetchSite: async () => ({ ok: true, document: siteDoc }),
    extractProfile: async () =>
      normalizeExtractedProfile({ legalName: 'ソニーグループ株式会社', foundedYear: '1946年5月7日' }),
    registerCompany: async (displayName) => {
      s.registered.push(displayName);
      return { status: 'registered', companyId: 'cmp_sony', displayName, created: true };
    },
    resolveExistingCompany: async () => null,
    loadFreshness: async () => s.freshness as Map<never, string>,
    claimJob: async () => {
      s.claims += 1;
      return {
        outcome: s.claimOutcome,
        jobId: 'job_1',
        attemptToken: s.claimOutcome.startsWith('CLAIMED') ? 'tok_1' : null,
      };
    },
    insertSources: async (_c, sources) => {
      s.sources = sources.length;
      return new Map(sources.map((x) => [x.sourceUrl, `src_${x.sourceUrl}`]));
    },
    insertFacts: async (facts) => {
      s.facts = facts.length;
      return facts.length;
    },
    finishJob: async (args) => {
      s.finished = { status: args.status, errorCode: args.errorCode };
      return { applied: true };
    },
    failJob: async (args) => {
      s.failed = args.errorCode;
      return { applied: true };
    },
    buildIdentity: (companyId) => buildCompanyEnrichmentIdentity({ companyId }),
    ...over,
  };
}

void (async () => {
  {
    const s: FakeState = { claims: 0, claimOutcome: 'CLAIMED_NEW', facts: 0, sources: 0, finished: null, failed: null, freshness: new Map(), registered: [] };
    const out = await runCompanyPrefetch(makeDeps({}, s), 'ソニー');
    check('P-8a 正常系: written', out.kind === 'written', JSON.stringify(out));
    check('P-8b companyId が確定する', out.kind === 'written' && out.companyId === 'cmp_sony');
    check('P-8c facts が書かれる', s.facts > 0);
    check('P-8d sources が書かれる', s.sources > 0);
    check('P-8e ★ 登記名で登録される（入力名ではなく canonical 名）', s.registered[0] === 'ソニーグループ株式会社');
  }

  {
    // 全 group が fresh → **claim すらしない**（cost 0）。
    const s: FakeState = { claims: 0, claimOutcome: 'CLAIMED_NEW', facts: 0, sources: 0, finished: null, failed: null, freshness: new Map([['identity', ISO], ['profile', ISO], ['navigation', ISO]]), registered: [] };
    const out = await runCompanyPrefetch(makeDeps({}, s), 'ソニー');
    check('P-8f ★ fresh なら fresh を返す', out.kind === 'fresh', JSON.stringify(out));
    check('P-8g ★ fresh なら claim しない（外部 I/O ゼロ）', s.claims === 0);
    check('P-8h fresh なら fact も書かない', s.facts === 0);
  }

  {
    // 別 request が実行中 → 何もしない（N 人 → 1 job の収束点）。
    const s: FakeState = { claims: 0, claimOutcome: 'ALREADY_RUNNING', facts: 0, sources: 0, finished: null, failed: null, freshness: new Map(), registered: [] };
    const out = await runCompanyPrefetch(makeDeps({}, s), 'ソニー');
    check('P-8i ★ ALREADY_RUNNING は deduped（取得しない）', out.kind === 'deduped');
    check('P-8j deduped なら fact を書かない', s.facts === 0);
  }

  {
    // ambiguous → profile enrichment へ進まない。
    const out = await runCompanyPrefetch(
      makeDeps({
        registry: {
          name: 'fake',
          isConfigured: () => true,
          lookupByName: async () => ({ status: 'ambiguous', candidates: [SONY, SONY], source: REGISTRY_SOURCE }),
        },
      }),
      'ソニー',
    );
    check('P-8k ★ ambiguous は identity_blocked（facts を取りに行かない）', out.kind === 'identity_blocked' && out.reason === 'ambiguous');
  }

  {
    // unresolved かつ既存企業も無い → 何も作らない（free-text で global table を汚さない）。
    const out = await runCompanyPrefetch(
      makeDeps({
        registry: {
          name: 'fake',
          isConfigured: () => true,
          lookupByName: async () => ({ status: 'unresolved', source: null }),
        },
      }),
      'よくわからない会社',
    );
    check('P-8l ★ unresolved は identity_blocked（新規作成しない）', out.kind === 'identity_blocked' && out.reason === 'unresolved');
  }

  {
    // registry 無効（外部 flag OFF 相当）でも既存企業には紐付く。
    const s: FakeState = { claims: 0, claimOutcome: 'CLAIMED_NEW', facts: 0, sources: 0, finished: null, failed: null, freshness: new Map(), registered: [] };
    const out = await runCompanyPrefetch(
      makeDeps(
        {
          externalFetchEnabled: () => false,
          registry: {
            name: 'fake',
            isConfigured: () => false,
            lookupByName: async () => ({ status: 'failed', reason: 'disabled' }),
          },
          resolveExistingCompany: async () => ({ companyId: 'cmp_existing', displayName: '既存企業' }),
        },
        s,
      ),
      'ソニー',
    );
    check(
      'P-8m external OFF: 既存企業へ紐付くが外部取得はしない → failed(EXTERNAL_FETCH_DISABLED)',
      out.kind === 'failed' && out.errorCode === 'EXTERNAL_FETCH_DISABLED',
      JSON.stringify(out),
    );
    check('P-8n external OFF なら fact を書かない', s.facts === 0);
  }

  {
    // 公式サイトが検証を通らない → identity facts は残る（部分成功）。
    const s: FakeState = { claims: 0, claimOutcome: 'CLAIMED_NEW', facts: 0, sources: 0, finished: null, failed: null, freshness: new Map(), registered: [] };
    const out = await runCompanyPrefetch(
      makeDeps(
        {
          search: {
            name: 'fake',
            isConfigured: () => true,
            searchOfficialSite: async () => ({ status: 'empty', source: null }),
          },
        },
        s,
      ),
      'ソニー',
    );
    check('P-8o ★ 公式サイト不明でも identity facts は残る（部分成功）', out.kind === 'written' && out.status === 'partial', JSON.stringify(out));
    check('P-8p partial の error_code が残る', s.finished?.status === 'partial' && s.finished?.errorCode === 'DOMAIN_UNVERIFIED');
    check('P-8q identity fact は書かれている', s.facts > 0);
  }

  {
    // LLM 抽出が失敗しても identity / navigation は残る。
    const s: FakeState = { claims: 0, claimOutcome: 'CLAIMED_NEW', facts: 0, sources: 0, finished: null, failed: null, freshness: new Map(), registered: [] };
    const out = await runCompanyPrefetch(makeDeps({ extractProfile: async () => null }, s), 'ソニー');
    check('P-8r ★ AI 失敗でも identity/profile(domain) facts は残る', out.kind === 'written' && s.facts > 0);
  }

  {
    // storage が undefined table → skipped（ユーザー機能に影響させない）。
    const out = await runCompanyPrefetch(
      makeDeps({
        loadFreshness: async () => {
          const err = new Error('relation "career_company_official_facts" does not exist') as Error & { reason?: string };
          err.reason = 'UNDEFINED_TABLE';
          throw err;
        },
      }),
      'ソニー',
    );
    check('P-8s ★ DDL 未適用は skipped（throw しない）', out.kind === 'skipped' && out.reason === 'not_provisioned', JSON.stringify(out));
  }

  {
    // provider が throw しても never-throw。
    const out = await runCompanyPrefetch(
      makeDeps({
        registry: {
          name: 'fake',
          isConfigured: () => true,
          lookupByName: async () => {
            throw new Error('boom');
          },
        },
      }),
      'ソニー',
    );
    check('P-8t provider の例外でも throw しない', out.kind === 'skipped');
  }

  {
    const out = await runCompanyPrefetch(makeDeps(), '');
    check('P-8u 空入力は identity_blocked', out.kind === 'identity_blocked');
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[P-9] 定数の不変条件');

  check('P-9a 時間予算が整合（deadline + prep + finalize <= maxDuration, lease > maxDuration）', timeBudgetIsConsistent());
  check('P-9b MAX_ATTEMPTS は 3', MAX_ATTEMPTS === 3);
  check(
    'P-9c error code の retryable / non-retryable が重複しない',
    !RETRYABLE_ERROR_CODES.some((c) => (NONRETRYABLE_ERROR_CODES as readonly string[]).includes(c)),
  );
  check('P-9d 未知 code を弾く', !isKnownErrorCode('SOMETHING_ELSE') && isKnownErrorCode('PROVIDER_TIMEOUT'));
  check('P-9e retryable 判定', isRetryableErrorCode('PROVIDER_TIMEOUT') && !isRetryableErrorCode('IDENTITY_AMBIGUOUS'));
  check('P-9f allowlist は固定 enum（自由文字列を許さない）', ALL_ERROR_CODES.length === RETRYABLE_ERROR_CODES.length + NONRETRYABLE_ERROR_CODES.length);
  {
    // Next.js の segment config は静的リテラル必須のため route 側にハードコードされる。
    // 定数との drift を静的に固定する（ズレると lease/予算の前提が崩れる）。
    const routeSrc = read('app/api/career/company/intent/route.ts');
    const m = /export const maxDuration = (\d+);/.exec(routeSrc);
    check(
      'P-9g intent route の maxDuration が ROUTE_MAX_DURATION_SECONDS と一致',
      m !== null && Number(m[1]) === ROUTE_MAX_DURATION_SECONDS,
      `route=${m?.[1]} const=${ROUTE_MAX_DURATION_SECONDS}`,
    );
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[P-10] HTML 解析（pure）');
  {
    const html = `<html><head><title>ソニー | 会社概要</title>
      <script type="application/ld+json">{"@type":"Organization","name":"Sony Group","foundingDate":"1946"}</script>
      </head><body><script>var x=1;</script><style>.a{}</style>
      <p>商号</p><p>ソニーグループ株式会社</p>
      <a href="/company/">会社概要</a><a href="javascript:void(0)">x</a></body></html>`;
    check('P-10a title を取れる', extractTitle(html) === 'ソニー | 会社概要');
    const text = htmlToText(html);
    check('P-10b script / style を落とす', !text.includes('var x=1') && !text.includes('.a{}'));
    check('P-10c ブロック境界で改行する（値が連結しない）', text.includes('商号\nソニーグループ株式会社'));
    const links = extractLinks(html, 'https://www.sony.com/');
    check('P-10d 相対 URL を絶対化', links.some((l) => l.href === 'https://www.sony.com/company/'));
    check('P-10e javascript: を除外', !links.some((l) => l.href.startsWith('javascript:')));
    const org = extractJsonLdOrganization(html);
    check('P-10f JSON-LD Organization を取れる', org?.name === 'Sony Group' && org?.foundingDate === '1946');
    check('P-10g 壊れた HTML で throw しない', htmlToText('<<<>>>') !== undefined && extractJsonLdOrganization('{bad') === null);
  }

  console.log('');
  if (failures > 0) {
    console.error(`company prefetch QA: ${failures} FAILED`);
    process.exit(1);
  }
  console.log('company prefetch QA: ALL PASS');
})();
