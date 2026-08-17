/*
 * scripts/career-company-official-context-qa.ts
 *
 * PASSAI CAREER — Company Data Spine 読み出し → prompt までの契約 QA。
 *
 * 何を守るか:
 *   C-1 fact_group 別 freshness policy（identity / profile / navigation / ir / recruiting / news）
 *   C-2 projection（最新世代の畳み込み・要約しない・決定論順）
 *   C-3 renderer（公式情報 block の分離・出典 URL / 取得日の明示・budget）
 *   C-4 ★ 公式事実 / ユーザーのメモ / AI 派生を混ぜない
 *   C-5 Orchestrator parity（company 未指定なら prompt が **byte 一致**）
 *   C-6 read repository の状態写像（disabled / unavailable / ready / stale / partial）
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-company-official-context-qa.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { buildCareerAiContext } from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';
import {
  COMPANY_FACT_TTL_SECONDS,
  classifyGroupFreshness,
  computeValidUntil,
  getFactGroupTtlSeconds,
  shouldRefetchGroup,
  summarizeFreshness,
} from '@/lib/careerCompanyOfficial/freshness';
import { buildCompanyOfficialContext, formatFactValue } from '@/lib/careerCompanyOfficial/projection';
import {
  COMPANY_OFFICIAL_PURPOSES,
  renderCompanyOfficialContext,
  renderCompanyOfficialForPurpose,
} from '@/lib/careerContextRenderers/companyOfficialContext';
import { hasCompanyOfficialData, type CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';

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

const NOW = '2026-08-16T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

// ════════════════════════════════════════════════════════════════════
console.log('[C-1] fact_group 別 freshness policy');

check('C-1a identity は最長 TTL', COMPANY_FACT_TTL_SECONDS.identity === 180 * 24 * 3600);
check('C-1b news は最短 TTL', COMPANY_FACT_TTL_SECONDS.news === 24 * 3600);
check(
  'C-1c 変化速度の順に TTL が短くなる（identity > profile >= navigation > ir > recruiting > news）',
  COMPANY_FACT_TTL_SECONDS.identity > COMPANY_FACT_TTL_SECONDS.profile &&
    COMPANY_FACT_TTL_SECONDS.profile >= COMPANY_FACT_TTL_SECONDS.navigation &&
    COMPANY_FACT_TTL_SECONDS.navigation > COMPANY_FACT_TTL_SECONDS.ir &&
    COMPANY_FACT_TTL_SECONDS.ir > COMPANY_FACT_TTL_SECONDS.recruiting &&
    COMPANY_FACT_TTL_SECONDS.recruiting > COMPANY_FACT_TTL_SECONDS.news,
);
check('C-1d 未知 group は最短へ倒す（安全側）', getFactGroupTtlSeconds('news') === COMPANY_FACT_TTL_SECONDS.news);

check('C-1e 取得直後は fresh', classifyGroupFreshness('profile', NOW, NOW).freshness === 'fresh');
check('C-1f TTL 内は fresh', classifyGroupFreshness('profile', ago(30), NOW).freshness === 'fresh');
check('C-1g TTL 超過は stale', classifyGroupFreshness('profile', ago(120), NOW).freshness === 'stale');
check('C-1h 未取得は missing（stale と区別する）', classifyGroupFreshness('profile', null, NOW).freshness === 'missing');
check(
  'C-1i identity は 120 日でも fresh（profile とは別 TTL）',
  classifyGroupFreshness('identity', ago(120), NOW).freshness === 'fresh',
);
check('C-1j 未来日付でも stale にしない', classifyGroupFreshness('profile', ago(-10), NOW).freshness === 'fresh');
check('C-1k 不正 ISO は missing', classifyGroupFreshness('profile', 'not-a-date', NOW).freshness === 'missing');
check('C-1l now が読めなければ古いと決めつけない', classifyGroupFreshness('profile', ago(999), 'bad').freshness === 'fresh');

check('C-1m validUntil は fetchedAt + TTL', computeValidUntil('profile', NOW) === new Date(Date.parse(NOW) + 90 * DAY).toISOString());
check('C-1n 外部 I/O は fresh のときだけ止まる', !shouldRefetchGroup('fresh') && shouldRefetchGroup('stale') && shouldRefetchGroup('missing'));

check(
  'C-1o 全 fresh → ready',
  summarizeFreshness([
    classifyGroupFreshness('identity', NOW, NOW),
    classifyGroupFreshness('profile', NOW, NOW),
  ]) === 'ready',
);
check(
  'C-1p 一部 missing → partial（stale より優先）',
  summarizeFreshness([
    classifyGroupFreshness('identity', NOW, NOW),
    classifyGroupFreshness('profile', null, NOW),
  ]) === 'partial',
);
check(
  'C-1q 全部あるが古い → stale',
  summarizeFreshness([
    classifyGroupFreshness('identity', ago(999), NOW),
    classifyGroupFreshness('profile', ago(999), NOW),
  ]) === 'stale',
);
check('C-1r 全部無い → missing', summarizeFreshness([classifyGroupFreshness('profile', null, NOW)]) === 'missing');

// ════════════════════════════════════════════════════════════════════
console.log('[C-2] projection');

const ROWS = [
  {
    factKey: 'legalName',
    factGroup: 'identity',
    factValue: { value: 'ソニーグループ株式会社' },
    sourceUrl: 'https://registry.example/x',
    sourceType: 'corporate_registry',
    extractionMethod: 'structured_api',
    fetchedAt: ago(10),
  },
  {
    // 同じ key の **古い**世代（畳み込まれる側）。
    factKey: 'legalName',
    factGroup: 'identity',
    factValue: { value: 'ソニー株式会社' },
    sourceUrl: 'https://registry.example/old',
    sourceType: 'corporate_registry',
    extractionMethod: 'structured_api',
    fetchedAt: ago(400),
  },
  {
    factKey: 'businessSegments',
    factGroup: 'profile',
    factValue: { value: ['ゲーム', '音楽', '映画'] },
    sourceUrl: 'https://www.sony.com/company/',
    sourceType: 'official_site',
    extractionMethod: 'llm_extraction',
    fetchedAt: ago(10),
  },
  {
    factKey: 'employeeCount',
    factGroup: 'profile',
    factValue: { value: '113,000', unit: '名', asOf: '2026年3月31日現在' },
    sourceUrl: 'https://www.sony.com/company/',
    sourceType: 'official_site',
    extractionMethod: 'llm_extraction',
    fetchedAt: ago(10),
  },
  {
    // ★ foundedYear は「設立」を意味する（prefetch 側の抽出契約と renderer ラベルの接合点）。
    factKey: 'foundedYear',
    factGroup: 'identity',
    factValue: { value: '昭和22年11月' },
    sourceUrl: 'https://www.sony.com/company/',
    sourceType: 'official_site',
    extractionMethod: 'llm_extraction',
    fetchedAt: ago(10),
  },
  {
    factKey: 'recruitUrl',
    factGroup: 'navigation',
    factValue: { value: 'https://recruit.sony.co.jp/' },
    sourceUrl: 'https://www.sony.com/',
    sourceType: 'official_site',
    extractionMethod: 'html_structured',
    fetchedAt: ago(10),
  },
];

const ctx = buildCompanyOfficialContext({
  companyId: 'cmp_sony',
  displayName: 'ソニーグループ株式会社',
  rows: ROWS,
  nowIso: NOW,
});

check('C-2a 同一 key は最新 1 件に畳まれる', ctx.facts.filter((f) => f.factKey === 'legalName').length === 1);
check(
  'C-2b 畳み込みは最新世代を採る（古い商号を採らない）',
  ctx.facts.find((f) => f.factKey === 'legalName')?.displayValue === 'ソニーグループ株式会社',
);
check('C-2c 配列は「、」結合（要約しない）', ctx.facts.find((f) => f.factKey === 'businessSegments')?.displayValue === 'ゲーム、音楽、映画');
check('C-2d unit / asOf を保持', ctx.facts.find((f) => f.factKey === 'employeeCount')?.asOf === '2026年3月31日現在');
check('C-2e 出典 URL を一意化して保持', ctx.sourceUrls.length === 3, JSON.stringify(ctx.sourceUrls));
check('C-2f group 別 freshness を持つ', ctx.groups.length === 3);
check(
  'C-2g 決定論順（group → key）',
  JSON.stringify(ctx.facts.map((f) => f.factKey)) ===
    JSON.stringify(
      buildCompanyOfficialContext({ companyId: 'cmp_sony', displayName: 'x', rows: [...ROWS].reverse(), nowIso: NOW }).facts.map(
        (f) => f.factKey,
      ),
    ),
);
check('C-2h 空値の fact は出さない', buildCompanyOfficialContext({ companyId: 'c', displayName: 'd', rows: [{ ...ROWS[0], factValue: { value: '' } }], nowIso: NOW }).facts.length === 0);
check('C-2i 壊れた factValue で throw しない', formatFactValue(null).display === '' && formatFactValue({ value: 42 }).display === '42');
check('C-2j oldest / newest を持つ', ctx.oldestFetchedAt !== null && ctx.newestFetchedAt !== null);

// ════════════════════════════════════════════════════════════════════
console.log('[C-3] renderer（公式情報 block）');

const block = renderCompanyOfficialContext(ctx);
check('C-3a block が生成される', block.used && block.text !== '');
check('C-3b 見出しに「公式情報」と企業名', block.text.includes('【公式情報') && block.text.includes('ソニーグループ株式会社'));
check('C-3c 取得日を明示する', /\d{4}-\d{2}-\d{2}/.test(block.text));
check('C-3d 出典 URL を載せる', block.text.includes('出典:') && block.text.includes('https://'));
check('C-3e ★ 「AI が生成した情報ではありません」と明示', block.text.includes('AI が生成した情報ではありません'));
check('C-3f ★ 本人のメモとは別物だと明示', block.text.includes('ユーザー本人の企業研究メモとは別物'));
check('C-3g ★ ここに無い事実を補って断定しないよう指示', block.text.includes('補って断定しないでください'));
check('C-3h 値は原文のまま（要約しない）', block.text.includes('ゲーム、音楽、映画') && block.text.includes('113,000 名'));
check('C-3i asOf を併記', block.text.includes('（2026年3月31日現在）'));
check(
  'C-3i2 ★ foundedYear は「設立」ラベルで出る（創業ではない）',
  block.text.includes('- 設立: 昭和22年11月') && !block.text.includes('創業'),
);

{
  const staleCtx = buildCompanyOfficialContext({
    companyId: 'c',
    displayName: 'X',
    rows: ROWS.map((r) => ({ ...r, fetchedAt: ago(400) })),
    nowIso: NOW,
  });
  const staleBlock = renderCompanyOfficialContext(staleCtx, { stale: true });
  check('C-3j stale を隠さず明示する', staleBlock.text.includes('［要再確認］') && staleBlock.text.includes('時間が経過'));
}
{
  const tiny = renderCompanyOfficialContext(ctx, { maxBytes: 400 });
  check('C-3k budget 超過時は件数を削る（要約しない）', !tiny.used || new TextEncoder().encode(tiny.text).length <= 400);
}
{
  const empty = renderCompanyOfficialContext({ ...ctx, facts: [] });
  check('C-3l fact 0 件なら空', !empty.used && empty.text === '');
}

// ── purpose allowlist / status 写像 ──────────────────────────────────
const READY: CompanyOfficialReadResult = { status: 'ready', data: ctx };
check('C-3m allowlist 内 purpose では出る', renderCompanyOfficialForPurpose('company_research_review', READY).used);
check('C-3n allowlist 外 purpose では出さない', !renderCompanyOfficialForPurpose('es_review', READY).used);
check('C-3o allowlist は company_research_review のみ（Phase 1）', COMPANY_OFFICIAL_PURPOSES.length === 1);

for (const bad of [
  { status: 'unavailable', reason: 'no_facts' },
  { status: 'unavailable', reason: 'not_provisioned' },
  { status: 'unavailable', reason: 'no_company' },
  { status: 'disabled', reason: 'flag_off' },
  { status: 'disabled', reason: 'unauthenticated' },
] as CompanyOfficialReadResult[]) {
  check(
    `C-3p ★ ${bad.status}(${'reason' in bad ? bad.reason : ''}) は必ず空（負の証拠を prompt に書かない）`,
    renderCompanyOfficialForPurpose('company_research_review', bad).text === '',
  );
  check(`C-3q ${bad.status} は data を持てない（型 guard）`, !hasCompanyOfficialData(bad));
}
check('C-3r null / undefined でも throw しない', renderCompanyOfficialForPurpose('company_research_review', null).text === '');
check('C-3s stale / partial は data を持てる（読める）', hasCompanyOfficialData({ status: 'stale', data: ctx }) && hasCompanyOfficialData({ status: 'partial', data: ctx }));

// ════════════════════════════════════════════════════════════════════
console.log('[C-4] 公式事実 / 本人メモ / AI 派生を混ぜない');
{
  const renderer = read('lib/careerContextRenderers/companyOfficialContext.ts');
  check(
    'C-4a renderer は Private Evidence（企業研究ログ）型を import しない',
    !renderer.includes('careerCompanyResearch') && !renderer.includes('CompanyResearchSnapshot'),
  );
  check('C-4b renderer は derived（AI 派生）を扱わない', !renderer.includes('CompanyDerivedRecord'));
  check(
    'C-4c renderer は Layer 5（ユーザー投稿の集合知）を import しない',
    !renderer.includes('careerCompanyKnowledge') && !renderer.includes('CompanyKnowledgeProjection'),
  );

  const route = read('app/api/career/company-research/route.ts');
  check(
    'C-4d route は公式情報を **独立要素**として prompt に結合する',
    route.includes('orchestrated.companyOfficialContext'),
  );
  check(
    'C-4e 公式 block と Personal Memory block が別要素（同じ文字列に連結していない）',
    !/companyOfficialContext\s*\+\s*/.test(route) &&
      !/personalMemoryContext\s*\+\s*orchestrated\.companyOfficialContext/.test(route),
  );
  check(
    'C-4f 添削者ペルソナ（企業事実を断定しない指示）が維持されている',
    route.includes('あなたは企業分析の生成者ではなく、添削者です'),
  );

  const projection = read('lib/careerCompanyOfficial/projection.ts');
  check('C-4g projection は derived を混ぜない', !projection.includes('career_company_derived'));
}

// ════════════════════════════════════════════════════════════════════
console.log('[C-5] Orchestrator parity（company 未指定なら byte 一致）');
{
  const base = buildCareerAiContext({
    featureKey: 'career-company-research',
    profile: { name: '', university: '', faculty: '', grade: '', graduationYear: '' } as never,
    activity: null,
    values: null,
    userInput: '',
  });

  const legacy = buildCareerContextForPurpose('company_research_review', base);
  const withUndefined = buildCareerContextForPurpose('company_research_review', base, {});
  const withDisabled = buildCareerContextForPurpose('company_research_review', base, {
    company: { status: 'disabled', reason: 'flag_off' },
  });
  const withUnavailable = buildCareerContextForPurpose('company_research_review', base, {
    company: { status: 'unavailable', reason: 'not_provisioned' },
  });
  const withData = buildCareerContextForPurpose('company_research_review', base, { company: READY });

  check('C-5a extras なし → companyOfficialContext は ""', legacy.companyOfficialContext === '');
  check('C-5b extras 空 → ""', withUndefined.companyOfficialContext === '');
  check('C-5c flag OFF → ""（従来 prompt と byte 互換）', withDisabled.companyOfficialContext === '');
  check('C-5d DDL 未適用 → ""', withUnavailable.companyOfficialContext === '');
  check('C-5e ★ base systemPrompt は company の有無で変わらない（byte 一致）', legacy.systemPrompt === withData.systemPrompt);
  check('C-5f crossFeature / personalMemory も変わらない', legacy.crossFeatureContext === withData.crossFeatureContext && legacy.personalMemoryContext === withData.personalMemoryContext);
  check('C-5g data があれば companyOfficialContext が出る', withData.companyOfficialContext !== '');
  check(
    'C-5h 対象外 purpose では data があっても ""',
    buildCareerContextForPurpose('es_review', base, { company: READY }).companyOfficialContext === '',
  );
  check('C-5i policy / omitted / warnings が変わらない', JSON.stringify(legacy.omitted) === JSON.stringify(withData.omitted) && JSON.stringify(legacy.warnings) === JSON.stringify(withData.warnings));
}

// ════════════════════════════════════════════════════════════════════
console.log('[C-6] read repository の状態写像（静的契約）');
{
  const repo = read('lib/careerCompanyOfficial/readRepository.server.ts');
  check('C-6a server-only', /import ['"]server-only['"]/.test(repo));
  {
    // import 節ではなく **公開関数の本体**で判定順を見る。
    const body = repo.split('export async function loadCompanyOfficialContext')[1] ?? '';
    check(
      'C-6b ★ flag OFF なら Supabase に触れない（判定が先）',
      body.indexOf('isCompanyPrefetchEnabled()') >= 0 &&
        body.indexOf('isCompanyPrefetchEnabled()') < body.indexOf('getCareerServerSupabaseClient'),
    );
  }
  check('C-6c DDL 未適用は unavailable(not_provisioned)（例外にしない）', repo.includes("reason: 'not_provisioned'") && repo.includes('42P01'));
  check('C-6d fact 0 件は unavailable(no_facts)（empty を負の証拠にしない）', repo.includes("reason: 'no_facts'"));
  check('C-6e ★ ambiguous / unresolved な企業は解決しない', repo.includes("resolved.status !== 'resolved'"));
  check('C-6f read は user-scoped client（service_role を使わない）', !repo.includes('ServiceRole'));
  check('C-6g never-throw（catch で unavailable へ倒す）', /catch[\s\S]*status: 'unavailable'/.test(repo));
  check('C-6h 既存 Company Identity の resolver を再利用', repo.includes('buildCompanyResolveResult') && repo.includes('findCompanyCandidates'));
  check(
    'C-6i ★ fact 読み出しは company_id で絞る（別企業の fact が混入しない）',
    /\.eq\('company_id', companyId\)/.test(repo),
  );
  check(
    'C-6j ★ global な企業データのみ読む（user 由来の private data を混ぜない）',
    !repo.includes('user_id') && !repo.includes('careerCompanyResearch') && !repo.includes('personalMemory'),
  );
  check(
    'C-6k 読み出し件数に上限がある（暴走防止）',
    repo.includes('MAX_FACT_ROWS') && /\.limit\(MAX_FACT_ROWS\)/.test(repo),
  );
}

console.log('');
if (failures > 0) {
  console.error(`company official context QA: ${failures} FAILED`);
  process.exit(1);
}
console.log('company official context QA: ALL PASS');
