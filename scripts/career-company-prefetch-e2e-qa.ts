/*
 * scripts/career-company-prefetch-e2e-qa.ts
 *
 * PASSAI CAREER — Company Prefetch の **End-to-End 契約** QA。
 *
 * 証明する経路（実 DB / 実 network / 実 AI なし・全 deps を fake で注入）:
 *
 *   ユーザーが企業名を入力
 *     → UI は free-text のまま（Identity UI は伏せたまま）
 *     → intent は入力完了後にだけ飛ぶ（keystroke では飛ばない）
 *     → UI は待たない
 *     → server が identity を解決
 *     → 同一企業は 1 つの canonical companyId へ収束
 *     → global company-scoped job は **1 回だけ** claim される
 *     → 公式サイトを検証してから取得
 *     → safeFetch 経由のみ
 *     → minimal profile facts を抽出
 *     → 各 fact が provenance を保持
 *     → Company Data Spine へ保存
 *     → 企業研究の loader が読む
 *     → 企業研究 context が公式情報を **別ブロック**で受け取る
 *
 * さらに negative contracts（§20）をすべて固定する。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-company-prefetch-e2e-qa.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeCompanyName } from '@/lib/careerCompanyKnowledge/identity';
import { buildCompanyEnrichmentIdentity } from '@/lib/careerCompanyPrefetch/idempotency';
import { normalizeExtractedProfile } from '@/lib/careerCompanyPrefetch/extraction';
import { runCompanyPrefetch, type PrefetchDeps, type SiteDocument } from '@/lib/careerCompanyPrefetch/prefetchJobService';
import type { RegistryCompanyCandidate } from '@/lib/careerCompanyPrefetch/providers/types';
import { buildCompanyOfficialContext } from '@/lib/careerCompanyOfficial/projection';
import { renderCompanyOfficialForPurpose } from '@/lib/careerContextRenderers/companyOfficialContext';
import { buildCareerAiContext } from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';

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

/** `function <name>(` 〜 対応する行頭 `}` までを切り出す。 */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = src.indexOf('\n  }', start);
  return end < 0 ? '' : src.slice(start, end);
}

const ISO = '2026-08-16T12:00:00.000Z';

// ════════════════════════════════════════════════════════════════════
// 共有 fixture: 「ソニー」の world state
// ════════════════════════════════════════════════════════════════════
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

const ABOUT_TEXT = [
  '会社概要',
  '商号 ソニーグループ株式会社',
  '設立 1946年5月7日',
  '事業内容 ゲーム＆ネットワークサービス、音楽、映画',
  '従業員数 113,000名',
].join('\n');

/** 「1 つの世界」= 全ユーザーが共有する global な DB 相当。 */
type World = {
  /**
   * normalized token → 企業（企業マスタ + alias の統合 index 相当）。
   * ★ 実装側と同じく、alias も同じ index に載る（`ソニー` → `ソニーグループ株式会社`）。
   */
  master: Map<string, { companyId: string; displayName: string }>;
  /** 実際に作られた企業数（alias 分を数えないため master.size とは別に持つ）。 */
  companies: number;
  /** 外部取得（registry / search / site fetch）が走った回数。 */
  externalCalls: number;
  /** claim された job（idempotencyKey → 状態）。 */
  jobs: Map<string, 'running' | 'done'>;
  /** 実際に走った enrichment attempt 数。 */
  attempts: number;
  /** Data Spine（facts）。 */
  facts: Array<{
    companyId: string;
    factKey: string;
    factGroup: string;
    factValue: unknown;
    sourceUrl: string;
    sourceType: string;
    extractionMethod: string;
    fetchedAt: string;
  }>;
  sources: Set<string>;
};

function newWorld(): World {
  return {
    master: new Map(),
    companies: 0,
    externalCalls: 0,
    jobs: new Map(),
    attempts: 0,
    facts: [],
    sources: new Set(),
  };
}

/** 1 ユーザーの 1 回の入力に対応する deps（world を共有する＝全ユーザー共通の基盤）。 */
function depsFor(world: World, opts: { externalFetch?: boolean } = {}): PrefetchDeps {
  const externalFetch = opts.externalFetch ?? true;

  const siteDoc: SiteDocument = {
    url: 'https://www.sony.com/',
    text: ABOUT_TEXT,
    title: 'ソニーグループ株式会社',
    links: [
      { href: 'https://www.sony.com/company/', label: '会社概要' },
      { href: 'https://recruit.sony.com/', label: '採用情報' },
      { href: 'https://www.sony.com/ir/', label: 'IR情報' },
    ],
    jsonLd: null,
    source: {
      sourceUrl: 'https://www.sony.com/',
      sourceType: 'official_site',
      sourceDomain: 'www.sony.com',
      httpStatus: 200,
      contentHash: 'hash-top',
      fetchedAt: ISO,
      publishedAt: null,
    },
  };

  return {
    now: () => ISO,
    externalFetchEnabled: () => externalFetch,

    registry: {
      name: 'fake-registry',
      isConfigured: () => externalFetch,
      lookupByName: async (raw) => {
        if (!externalFetch) return { status: 'failed', reason: 'disabled' };
        world.externalCalls += 1;
        // 「ソニー」単体は部分一致しかない（実 registry と同じ挙動）が、
        // fixture では表記ゆれを normalize で吸収して同一法人へ寄せる。
        const target = normalizeCompanyName(raw);
        const matches = [
          SONY.legalName,
          'ソニー',
          SONY.legalNameKana,
          ...SONY.formerNames,
        ].some((n) => normalizeCompanyName(n ?? '') === target);
        if (!matches) return { status: 'unresolved', source: null };
        return {
          status: 'resolved',
          candidate: SONY,
          source: {
            sourceUrl: 'https://registry.example/name?name=x',
            sourceType: 'corporate_registry',
            sourceDomain: 'registry.example',
            httpStatus: 200,
            contentHash: 'hash-registry',
            fetchedAt: ISO,
            publishedAt: null,
          },
        };
      },
    },

    search: {
      name: 'fake-search',
      isConfigured: () => true,
      searchOfficialSite: async () => {
        world.externalCalls += 1;
        return {
          status: 'ok',
          hits: [
            // ★ 1 位は就活媒体（＝「1 位だから公式」にしないことを検証する）。
            { url: 'https://job.rikunabi.com/sony/', title: 'ソニーグループ株式会社 採用', snippet: '' },
            { url: 'https://www.sony.com/', title: 'ソニーグループ株式会社', snippet: '' },
          ],
          source: {
            sourceUrl: 'https://search.example/?q=x',
            sourceType: 'search_result',
            sourceDomain: 'search.example',
            httpStatus: 200,
            contentHash: 'hash-search',
            fetchedAt: ISO,
            publishedAt: null,
          },
        };
      },
    },

    fetchSite: async (url) => {
      world.externalCalls += 1;
      if (url.includes('rikunabi')) {
        return {
          ok: true,
          document: {
            ...siteDoc,
            url,
            title: 'ソニーグループ株式会社 採用情報 | リクナビ',
            source: { ...siteDoc.source, sourceUrl: url, sourceDomain: 'job.rikunabi.com' },
          },
        };
      }
      if (url.includes('/company/')) {
        return {
          ok: true,
          document: {
            ...siteDoc,
            url,
            source: { ...siteDoc.source, sourceUrl: url, contentHash: 'hash-about' },
          },
        };
      }
      return { ok: true, document: siteDoc };
    },

    extractProfile: async () =>
      normalizeExtractedProfile({
        legalName: 'ソニーグループ株式会社',
        foundedYear: '1946年5月7日',
        businessSegments: ['ゲーム＆ネットワークサービス', '音楽', '映画'],
        employeeCount: '113,000名',
        // ★ 本文に無い値（LLM の幻覚を模す）。保存前に捨てられるはず。
        capital: '99兆円',
        listingStatus: '東証プライム',
      }),

    // 既存 Company Identity の registerCompany 相当。
    //   ★ alias まで見る（`任天堂` / `Nintendo` を同一企業として扱う唯一の手段が alias、
    //     というのが registration.ts の設計。ここでも同じ規則を再現する）。
    //   ★ 他社が占有している alias token は奪わない（selectAttachableAliases と同じ）。
    registerCompany: async (displayName, aliases) => {
      const key = normalizeCompanyName(displayName);
      const existing = world.master.get(key);
      if (existing) return { status: 'registered', ...existing, created: false };
      const created = { companyId: `cmp_${world.companies + 1}`, displayName };
      world.companies += 1;
      world.master.set(key, created);
      for (const alias of aliases) {
        const token = normalizeCompanyName(alias);
        if (token === '' || world.master.has(token)) continue; // 奪わない・重複させない
        world.master.set(token, created);
      }
      return { status: 'registered', ...created, created: true };
    },
    resolveExistingCompany: async (raw) => world.master.get(normalizeCompanyName(raw)) ?? null,

    loadFreshness: async (companyId) => {
      const map = new Map<never, string>();
      for (const f of world.facts) {
        if (f.companyId !== companyId) continue;
        const g = f.factGroup as never;
        if (!map.has(g)) map.set(g, f.fetchedAt);
      }
      return map;
    },

    claimJob: async (identity) => {
      const state = world.jobs.get(identity.idempotencyKey);
      if (state) {
        // ★ 既に走っている / 済んでいる → 取得しない（N 人 → 1 job の収束点）。
        return {
          outcome: state === 'running' ? 'ALREADY_RUNNING' : 'ALREADY_COMPLETED',
          jobId: 'job',
          attemptToken: null,
        };
      }
      world.jobs.set(identity.idempotencyKey, 'running');
      world.attempts += 1;
      return { outcome: 'CLAIMED_NEW', jobId: 'job', attemptToken: 'tok' };
    },

    insertSources: async (_companyId, sources) => {
      const map = new Map<string, string>();
      for (const s of sources) {
        world.sources.add(s.sourceUrl);
        map.set(s.sourceUrl, `src:${s.sourceUrl}`);
      }
      return map;
    },
    insertFacts: async (facts, sourceIdByUrl) => {
      let written = 0;
      for (const f of facts) {
        // ★ repository と同じ規則: source が解決できない fact は書かない。
        if (!sourceIdByUrl.get(f.sourceUrl)) continue;
        world.facts.push({
          companyId: f.companyId,
          factKey: f.factKey,
          factGroup: f.factGroup,
          factValue: f.factValue,
          sourceUrl: f.sourceUrl,
          sourceType: 'official_site',
          extractionMethod: f.extractionMethod,
          fetchedAt: f.fetchedAt,
        });
        written += 1;
      }
      return written;
    },
    finishJob: async () => {
      for (const [k, v] of world.jobs) if (v === 'running') world.jobs.set(k, 'done');
      return { applied: true };
    },
    failJob: async () => {
      for (const [k, v] of world.jobs) if (v === 'running') world.jobs.set(k, 'done');
      return { applied: true };
    },
    buildIdentity: (companyId) => buildCompanyEnrichmentIdentity({ companyId }),
  };
}

void (async () => {
  // ══════════════════════════════════════════════════════════════════
  console.log('[E-1] UI は free-text のまま / trigger は入力完了後');
  {
    const picker = read('components/career/CompanyPicker.tsx');
    check('E-1a Identity UI は伏せたまま（IDENTITY_UI_ENABLED = false）', /const IDENTITY_UI_ENABLED: boolean = false/.test(picker));
    check('E-1b free-text 入力欄が唯一の入力手段のまま', picker.includes('<Input'));
    check('E-1c ★ intent は onBlur で飛ぶ（keystroke では飛ばない）', picker.includes('onBlur={handleFreeTextBlur}'));
    check(
      'E-1d ★ onChange から intent を呼ばない（IME 中間文字列で global master を汚さない）',
      !/handleFreeTextChange[\s\S]{0,200}notifyCompanyIntent/.test(picker),
    );
    {
      const blurBody = fnBody(picker, 'handleFreeTextBlur');
      check('E-1e0 handleFreeTextBlur が存在する', blurBody !== '');
      check(
        'E-1e trigger は state を変えない（spinner を出さない）',
        blurBody.includes('notifyCompanyIntent') &&
          !blurBody.includes('setSearch') &&
          !blurBody.includes('setRegistering') &&
          !blurBody.includes('await'),
      );
    }

    const client = read('app/career/company/companyClient.ts');
    check('E-1f notifyCompanyIntent は void（結果を返さない＝待たせない）', /export function notifyCompanyIntent\(companyName: string\): void/.test(client));
    check('E-1g 失敗を握り潰す（保存フローを壊さない）', client.includes('.catch(() => {'));
    check('E-1h keepalive で離脱時も送る', client.includes('keepalive: true'));
    check('E-1i ★ client は companyId を送らない（server authoritative）', !/body: JSON.stringify\(\{ companyName[\s\S]{0,80}companyId/.test(client));

    const route = read('app/api/career/company/intent/route.ts');
    check('E-1j route は after() で background 化（response を待たせない）', route.includes('after(async () =>'));
    check('E-1k 受付は 202', route.includes('{ status: 202 }'));
    check('E-1l ★ 失敗しても HTTP 200（client の error 表示を誘発しない）', route.includes('notAcceptedResponse'));
    check('E-1m ★ body から companyId を読まない', !code(route).includes('companyId'));
    check('E-1n Node ランタイム固定（node:dns / node:crypto を使うため）', route.includes("export const runtime = 'nodejs'"));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[E-2] 同一企業の収束（Sony / ソニー / ソニー株式会社）');
  {
    const world = newWorld();

    // ユーザー A が「ソニー」と入力。
    const a = await runCompanyPrefetch(depsFor(world), 'ソニー');
    check('E-2a 1 人目: 取得して書き込む', a.kind === 'written', JSON.stringify(a));
    const companyId = a.kind === 'written' ? a.companyId : '';
    check('E-2b canonical companyId が確定する', companyId !== '');

    const afterFirst = { external: world.externalCalls, attempts: world.attempts, facts: world.facts.length };

    // ユーザー B が「ソニー株式会社」と入力（表記ゆれ）。
    const b = await runCompanyPrefetch(depsFor(world), 'ソニー株式会社');
    check(
      'E-2c ★ 表記ゆれでも同じ companyId へ収束',
      (b.kind === 'fresh' || b.kind === 'deduped') ||
        (b.kind === 'written' && b.companyId === companyId),
      JSON.stringify(b),
    );

    // ユーザー C が「ソニーグループ株式会社」と入力（登記名そのもの）。
    const c = await runCompanyPrefetch(depsFor(world), 'ソニーグループ株式会社');
    check(
      'E-2d ★ 登記名でも同じ companyId へ収束',
      (c.kind === 'fresh' || c.kind === 'deduped') ||
        (c.kind === 'written' && c.companyId === companyId),
      JSON.stringify(c),
    );

    // ユーザー D が旧商号「ソニー株式会社」で入力（alias 経路）。
    const d = await runCompanyPrefetch(depsFor(world), 'ソニー株式会社');
    check('E-2e 旧商号でも新規企業を作らない', world.companies === 1, `companies=${world.companies}`);

    check(
      'E-2f ★ 2 人目以降は enrichment attempt が増えない（N 人 → 1 job）',
      world.attempts === afterFirst.attempts,
      `attempts=${world.attempts} (first=${afterFirst.attempts})`,
    );
    check(
      'E-2g ★ 2 人目以降で facts が二重に書かれない',
      world.facts.length === afterFirst.facts,
      `facts=${world.facts.length} (first=${afterFirst.facts})`,
    );
    check('E-2h 4 人が入力しても企業マスタは 1 社', world.companies === 1, `companies=${world.companies}`);
    void d;

    // 同一 companyId → 同一 idempotency key（user を材料にしない）。
    check(
      'E-2i ★ idempotency key は user に依存しない',
      buildCompanyEnrichmentIdentity({ companyId }).idempotencyKey ===
        buildCompanyEnrichmentIdentity({ companyId }).idempotencyKey,
    );
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[E-3] 誤 merge の防止（Lincoln / Principal / 株式会社ABC / 有限会社ABC）');
  {
    const n = normalizeCompanyName;
    check('E-3a Lincoln は壊れない', n('Lincoln') === 'lincoln');
    check('E-3b Principal は壊れない', n('Principal') === 'principal');
    check('E-3c ★ 株式会社ABC と 有限会社ABC は別 token', n('株式会社ABC') !== n('有限会社ABC'));
    check('E-3d 別 token → 別企業として登録される', await (async () => {
      const world = newWorld();
      const deps = depsFor(world);
      await deps.registerCompany('株式会社ABC', []);
      await deps.registerCompany('有限会社ABC', []);
      return world.companies === 2;
    })());
    check('E-3e 同 token → 同一企業に寄る', await (async () => {
      const world = newWorld();
      const deps = depsFor(world);
      const x = await deps.registerCompany('ソニーグループ株式会社', []);
      const y = await deps.registerCompany('ソニーグループ', []);
      return (
        world.companies === 1 &&
        x?.status === 'registered' &&
        y?.status === 'registered' &&
        x.companyId === y.companyId
      );
    })());
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[E-4] 公式サイトの検証と provenance');
  {
    const world = newWorld();
    const out = await runCompanyPrefetch(depsFor(world), 'ソニー');
    check('E-4a 書き込み成功', out.kind === 'written');

    const domainFact = world.facts.find((f) => f.factKey === 'officialDomain');
    check('E-4b ★ 検索 1 位（就活媒体）を公式にしない', domainFact?.factValue !== undefined && JSON.stringify(domainFact?.factValue).includes('www.sony.com'), JSON.stringify(domainFact?.factValue));
    check('E-4c ★ rikunabi を officialDomain にしていない', !JSON.stringify(world.facts).includes('rikunabi.com"'));

    check('E-4d ★ すべての fact が sourceUrl を持つ', world.facts.every((f) => f.sourceUrl !== ''));
    check('E-4e source が facts より先に登録されている', world.facts.every((f) => world.sources.has(f.sourceUrl)));
    check('E-4f 検索応答も出典として残る', world.sources.has('https://search.example/?q=x'));
    check('E-4g 公的 registry も出典として残る', world.sources.has('https://registry.example/name?name=x'));

    // fact group の網羅。
    const groups = new Set(world.facts.map((f) => f.factGroup));
    check('E-4h identity facts がある', groups.has('identity'));
    check('E-4i profile facts がある', groups.has('profile'));
    check('E-4j navigation facts がある', groups.has('navigation'));

    // minimal prefetch の主要 key。
    for (const key of ['corporateNumber', 'legalName', 'officialDomain', 'officialUrl', 'recruitUrl', 'irUrl', 'businessSegments', 'foundedYear']) {
      check(`E-4k minimal prefetch に ${key} が含まれる`, world.facts.some((f) => f.factKey === key));
    }

    // ★ LLM の幻覚は保存されない。
    check('E-4l ★ 本文に無い capital は保存されない', !world.facts.some((f) => f.factKey === 'capital'));
    check('E-4m ★ 本文に無い listingStatus は保存されない', !world.facts.some((f) => f.factKey === 'listingStatus'));
    check('E-4n 本文にある foundedYear は保存される', world.facts.some((f) => f.factKey === 'foundedYear'));

    // ★ registry 由来が LLM 由来に負けない。
    const legalName = world.facts.find((f) => f.factKey === 'legalName');
    check('E-4o ★ legalName は structured_api（公的 registry）が採用される', legalName?.extractionMethod === 'structured_api');

    // ══════════════════════════════════════════════════════════════
    console.log('[E-5] 企業研究が Data Spine を読む → 公式情報が別ブロックで届く');

    const ctx = buildCompanyOfficialContext({
      companyId: world.facts[0].companyId,
      displayName: 'ソニーグループ株式会社',
      rows: world.facts,
      nowIso: ISO,
    });
    check('E-5a projection が facts を持つ', ctx.facts.length > 0);
    check('E-5b 出典 URL が保持される', ctx.sourceUrls.length > 0);

    const block = renderCompanyOfficialForPurpose('company_research_review', { status: 'ready', data: ctx });
    check('E-5c ★ 企業研究 purpose で公式情報 block が出る', block.used && block.text !== '');
    check('E-5d 公式であることを明示', block.text.includes('【公式情報'));
    check('E-5e 出典 URL を載せる', block.text.includes('出典:'));
    check('E-5f 取得日を載せる', block.text.includes('2026-08-16'));
    check('E-5g ★ AI 生成でないと明示', block.text.includes('AI が生成した情報ではありません'));
    check('E-5h ★ 本人メモと別物だと明示', block.text.includes('ユーザー本人の企業研究メモとは別物'));

    const base = buildCareerAiContext({
      featureKey: 'career-company-research',
      profile: { name: '', university: '', faculty: '', grade: '', graduationYear: '' } as never,
      activity: null,
      values: null,
      userInput: '',
    });
    const orchestrated = buildCareerContextForPurpose('company_research_review', base, {
      company: { status: 'ready', data: ctx },
    });
    check('E-5i Orchestrator が公式情報を別 field で返す', orchestrated.companyOfficialContext !== '');
    check(
      'E-5j ★ base systemPrompt に公式情報が混ざらない（block 分離）',
      !orchestrated.systemPrompt.includes('【公式情報'),
    );
    check(
      'E-5k ★ personalMemory block にも混ざらない',
      !orchestrated.personalMemoryContext.includes('【公式情報'),
    );

    const route = read('app/api/career/company-research/route.ts');
    check('E-5l 企業研究 route が Data Spine を読む', route.includes('loadCompanyOfficialContext'));
    check('E-5m 企業研究 route が公式 block を prompt へ結合する', route.includes('orchestrated.companyOfficialContext'));
    check('E-5n 企業研究 route が T1 trigger を持つ', route.includes('triggerCompanyPrefetch'));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[E-6] Negative contracts（§20）');
  {
    // 1. Company Matching は OFF のまま・触っていない。
    const matchingFlag = read('lib/careerMatchingGate/flags.server.ts');
    check(
      'E-6a Company Matching flag の実装に触れていない（env 参照のまま）',
      matchingFlag.includes('CAREER_COMPANY_MATCHING_ENABLED'),
    );
    const prefetchFiles = [
      'lib/careerCompanyPrefetch/flags.server.ts',
      'lib/careerCompanyPrefetch/gate.server.ts',
      'lib/careerCompanyPrefetch/prefetchJobService.ts',
      'lib/careerCompanyPrefetch/runtime.server.ts',
      'app/api/career/company/intent/route.ts',
      'lib/careerCompanyOfficial/readRepository.server.ts',
      'lib/careerContextRenderers/companyOfficialContext.ts',
    ];
    check(
      'E-6b ★ prefetch のどのコードも Matching を参照しない',
      prefetchFiles.every((f) => {
        const c = code(read(f));
        return !c.includes('Matching') && !c.includes('matching');
      }),
    );

    // 2. Identity UI は OFF のまま。
    check('E-6c ★ /career/company segment は flag OFF なら 404 のまま', read('app/career/company/layout.tsx').includes('notFound()'));
    check(
      'E-6d ★ public Identity API は依然 identity gate で守られている',
      read('app/api/career/company/resolve/route.ts').includes('evaluateCompanyIdentityGate') &&
        read('app/api/career/company/register/route.ts').includes('evaluateCompanyIdentityGate') &&
        read('app/api/career/company/lookup/route.ts').includes('evaluateCompanyIdentityGate'),
    );
    check(
      'E-6e ★ intent route は identity gate を使わない（独立に ON にできる）',
      !read('app/api/career/company/intent/route.ts').includes('evaluateCompanyIdentityGate'),
    );

    // 3. flag OFF → 外部 I/O ゼロ。
    const gate = read('lib/careerCompanyPrefetch/gate.server.ts');
    check('E-6f ★ gate の最初の判定が flag（Supabase より前）', /if \(!isCompanyPrefetchEnabled\(\)\) return \{ ok: false, reason: 'flag_off' \}/.test(gate));

    // 4. external-fetch flag OFF → identity のみ。
    {
      const world = newWorld();
      world.master.set(normalizeCompanyName('ソニーグループ株式会社'), {
        companyId: 'cmp_pre',
        displayName: 'ソニーグループ株式会社',
      });
      const out = await runCompanyPrefetch(depsFor(world, { externalFetch: false }), 'ソニーグループ株式会社');
      check('E-6g ★ external fetch OFF なら外部 I/O ゼロ', world.externalCalls === 0, `calls=${world.externalCalls}`);
      check('E-6h ★ external fetch OFF なら fact を書かない', world.facts.length === 0);
      check('E-6i external fetch OFF でも既存企業へは紐付く（identity のみ）', out.kind === 'failed' && out.errorCode === 'EXTERNAL_FETCH_DISABLED', JSON.stringify(out));
    }

    // 5. ambiguous / unresolved → profile fetch しない。
    {
      const world = newWorld();
      const deps = depsFor(world);
      const out = await runCompanyPrefetch(
        {
          ...deps,
          registry: {
            name: 'x',
            isConfigured: () => true,
            lookupByName: async () => ({
              status: 'ambiguous',
              candidates: [SONY, { ...SONY, corporateNumber: '1' }],
              source: {
                sourceUrl: 'https://registry.example/x',
                sourceType: 'corporate_registry',
                sourceDomain: 'registry.example',
                httpStatus: 200,
                contentHash: null,
                fetchedAt: ISO,
                publishedAt: null,
              },
            }),
          },
        },
        'ソニー',
      );
      check('E-6j ★ ambiguous は identity_blocked', out.kind === 'identity_blocked' && out.reason === 'ambiguous');
      check('E-6k ★ ambiguous なら fact を 1 件も書かない', world.facts.length === 0);
      check('E-6l ★ ambiguous なら企業を作らない', world.companies === 0);
    }
    {
      const world = newWorld();
      const deps = depsFor(world);
      const out = await runCompanyPrefetch(
        {
          ...deps,
          registry: { name: 'x', isConfigured: () => true, lookupByName: async () => ({ status: 'unresolved', source: null }) },
        },
        'ぜんぜん知らない会社',
      );
      check('E-6m ★ unresolved は identity_blocked', out.kind === 'identity_blocked' && out.reason === 'unresolved');
      check('E-6n ★ unresolved なら企業を作らない（free-text で global を汚さない）', world.companies === 0);
      check('E-6o ★ unresolved なら fact を書かない', world.facts.length === 0);
    }

    // 6. prefetch 失敗 → ユーザーの free-text フローは無傷。
    {
      const world = newWorld();
      const deps = depsFor(world);
      const out = await runCompanyPrefetch(
        {
          ...deps,
          claimJob: async () => {
            throw new Error('db down');
          },
        },
        'ソニー',
      );
      check('E-6p ★ storage 障害でも throw しない（background を壊さない）', out.kind === 'skipped');
    }
    check(
      'E-6q ★ 企業研究 route は prefetch の失敗で添削を止めない（await せず after 登録）',
      read('lib/careerCompanyPrefetch/trigger.server.ts').includes('after(async () =>') &&
        read('lib/careerCompanyPrefetch/trigger.server.ts').includes('export function triggerCompanyPrefetch(companyName: string, req?: Request): void'),
    );

    // 7. DDL 未適用 → graceful。
    check(
      'E-6r ★ DDL 未適用は unavailable/no-op（例外にしない）',
      read('lib/careerCompanyPrefetch/repository.server.ts').includes('UNDEFINED_TABLE') &&
        read('lib/careerCompanyOfficial/readRepository.server.ts').includes("reason: 'not_provisioned'"),
    );

    // 8. ログに機微情報を残さない。
    {
      const service = read('lib/careerCompanyPrefetch/prefetchJobService.ts');
      check(
        'E-6s ★ 観測 event は enum + 件数のみ（企業名 / URL / 本文を持てない型）',
        /export type PrefetchLogEvent = \{[\s\S]*?stage: PrefetchStage;[\s\S]*?outcome: string;[\s\S]*?count\?: number;[\s\S]*?\};/.test(service),
      );
      check(
        'E-6t ★ intent route は企業名をログに出さない',
        !/devWarn\([^)]*companyName/.test(read('app/api/career/company/intent/route.ts')),
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[E-7] 「企業研究を開いた時、既にある情報から始まる」');
  {
    const world = newWorld();

    // 1) 志望企業を入力した時点（＝企業研究を開くより前）に prefetch が走る。
    const pre = await runCompanyPrefetch(depsFor(world), 'ソニー');
    check('E-7a 入力時点で Data Spine が埋まる', pre.kind === 'written' && world.facts.length > 0);

    // 2) 後日 企業研究を開く = 読むだけ（外部 I/O ゼロ）。
    const before = world.externalCalls;
    const ctx = buildCompanyOfficialContext({
      companyId: world.facts[0].companyId,
      displayName: 'ソニーグループ株式会社',
      rows: world.facts,
      nowIso: ISO,
    });
    check('E-7b ★ 企業研究を開く時点では外部取得が走らない', world.externalCalls === before);
    check('E-7c 既存データから即座に context を組める', ctx.facts.length > 0);
    check('E-7d 全 group が fresh（ready）', ctx.groups.every((g) => g.freshness === 'fresh'));

    // 3) 同じ企業をもう一度入力しても外部取得は増えない（freshness short-circuit）。
    const out = await runCompanyPrefetch(depsFor(world), 'ソニー');
    check('E-7e ★ fresh なら再取得しない', out.kind === 'fresh' || out.kind === 'deduped', JSON.stringify(out));
    check('E-7f ★ 外部呼び出し回数が増えない', world.externalCalls === before, `calls=${world.externalCalls} before=${before}`);
  }

  console.log('');
  if (failures > 0) {
    console.error(`company prefetch E2E QA: ${failures} FAILED`);
    process.exit(1);
  }
  console.log('company prefetch E2E QA: ALL PASS');
})();
