/*
 * scripts/career-company-ingest-coverage-qa.ts
 *
 * PASSAI CAREER — Company Data Spine の **複数社バッチ取り込み**契約 QA（dev-only）。
 *
 * 既存 `career-company-prefetch-e2e-qa.ts` が 1 社の取り込み契約（identity 収束 / job 1 回 claim /
 * domain 検証 / provenance / renderer）を固定しているのに対し、本 QA は
 * **初回リリースで複数社を投入するときにだけ現れる性質**を固定する:
 *
 *   [A] multi-company ingest      … 同一 deps で N 社を逐次投入して N 社が独立に成立する
 *   [B] failure isolation         … 1 社が取得失敗しても他社の成功データが壊れない
 *   [C] idempotent ingest         … 同じ企業を 2 度投入しても master / source / fact が増殖しない
 *   [D] duplicate source 防止     … 同一 sourceUrl は 1 行に畳まれる
 *   [E] duplicate fact 防止       … 同一 factKey は最新 1 件へ merge される
 *   [F] usable status             … 各社が renderer で使える状態（fact>=1 / source>=1）になる
 *   [G] consultation 互換         … 投入した各社が purpose='consultation' で非空 block になる
 *   [H] ingest script 契約        … 企業一覧を production runtime へ持ち込まない / 逐次 / 手動 INSERT なし
 *
 * 厳守: 実 DB / 実 network / 実 AI に触れない（全 deps を fake で注入）。
 *   日時・乱数を持ち込まない（now は固定 ISO）。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-company-ingest-coverage-qa.ts
 * 終了コード: 全 PASS → 0 / 1 件でも FAIL → 1
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  runCompanyPrefetch,
  type PrefetchDeps,
  type SiteDocument,
} from '@/lib/careerCompanyPrefetch/prefetchJobService';
import { buildCompanyEnrichmentIdentity } from '@/lib/careerCompanyPrefetch/idempotency';
import { normalizeExtractedProfile } from '@/lib/careerCompanyPrefetch/extraction';
import { buildCompanyOfficialContext, type FactRow } from '@/lib/careerCompanyOfficial/projection';
import { summarizeFreshness } from '@/lib/careerCompanyOfficial/freshness';
import { renderCompanyOfficialForPurpose } from '@/lib/careerContextRenderers/companyOfficialContext';
import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
import type { ProviderSourceRef, RegistryCompanyCandidate } from '@/lib/careerCompanyPrefetch/providers/types';

const ROOT = process.cwd();
const ISO = '2026-08-22T00:00:00.000Z';

let fail = 0;
const check = (ok: boolean, label: string, detail?: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) fail += 1;
};

// ── fake world（DB の代わり）────────────────────────────────────────────
type Company = { companyId: string; displayName: string; normalized: string };
type SourceRow = { companyId: string; sourceUrl: string };
type Fact = { companyId: string; factKey: string; factGroup: string; factValue: unknown; sourceUrl: string; fetchedAt: string };
type Job = { jobId: string; status: string; attempts: number };

type World = {
  companies: Company[];
  sources: SourceRow[];
  facts: Fact[];
  jobs: Map<string, Job>;
  registerCalls: number;
};

const newWorld = (): World => ({ companies: [], sources: [], facts: [], jobs: new Map(), registerCalls: 0 });

const normalize = (name: string) => name.replace(/(株式会社|有限会社|合同会社)/g, '').trim();

/** 取り込み対象の fixture 企業（公式サイト本文は「そのページに実際にある文字列」だけを持つ）。 */
const FIXTURES: Record<string, { domain: string; legalName: string; corporateNumber: string; body: string }> = {
  アルファ工業株式会社: {
    domain: 'www.alpha-example.co.jp',
    legalName: 'アルファ工業株式会社',
    corporateNumber: '1000000000001',
    body: 'アルファ工業株式会社\n事業内容 精密部品の製造・販売\n設立 1962年4月\n従業員数 3,200名\n本社 愛知県名古屋市',
  },
  ベータ商事株式会社: {
    domain: 'www.beta-example.co.jp',
    legalName: 'ベータ商事株式会社',
    corporateNumber: '1000000000002',
    body: 'ベータ商事株式会社\n事業内容 資源・食料の総合商社\n設立 1948年7月\n従業員数 5,800名\n本社 東京都千代田区',
  },
  ガンマソフト株式会社: {
    domain: 'www.gamma-example.co.jp',
    legalName: 'ガンマソフト株式会社',
    corporateNumber: '1000000000003',
    body: 'ガンマソフト株式会社\n事業内容 業務用ソフトウェアの開発\n設立 2004年1月\n従業員数 640名\n本社 東京都渋谷区',
  },
  // 検索が空を返す企業（＝公式サイトを特定できない）。取り込みは失敗するのが正しい。
  デルタ未知株式会社: {
    domain: '',
    legalName: 'デルタ未知株式会社',
    corporateNumber: '1000000000004',
    body: '',
  },
};

function siteDocFor(name: string): SiteDocument {
  const f = FIXTURES[name];
  const source: ProviderSourceRef = {
    sourceUrl: `https://${f.domain}/company/`,
    sourceType: 'official_site',
    sourceDomain: f.domain,
    httpStatus: 200,
    contentHash: `hash-${f.domain}`,
    fetchedAt: ISO,
    publishedAt: null,
  };
  return { url: source.sourceUrl, text: f.body, title: f.legalName, links: [], jsonLd: null, source };
}

function candidateFor(name: string): RegistryCompanyCandidate {
  const f = FIXTURES[name];
  return {
    corporateNumber: f.corporateNumber,
    legalName: f.legalName,
    legalNameKana: null,
    legalNameEn: null,
    prefecture: null,
    address: null,
    registrationStatus: '存続',
    formerNames: [],
  };
}

function depsFor(world: World): PrefetchDeps {
  const searchSource = (name: string): ProviderSourceRef => ({
    sourceUrl: `https://search.example/?q=${encodeURIComponent(name)}`,
    sourceType: 'search_result',
    sourceDomain: 'search.example',
    httpStatus: 200,
    contentHash: `search-${name}`,
    fetchedAt: ISO,
    publishedAt: null,
  });
  // 直近に問い合わせた企業名（search → fetchSite の対応付けに使う fake 内部状態）。
  let current = '';

  return {
    now: () => ISO,
    externalFetchEnabled: () => true,
    log: (e: unknown) => { if (process.env.QA_DEBUG === '1') console.log('   stage:', JSON.stringify(e)); },

    registry: {
      name: 'fake-registry',
      isConfigured: () => true,
      async lookupByName(rawName: string) {
        const name = Object.keys(FIXTURES).find((n) => rawName.includes(normalize(n)));
        // ★ 失敗社は registry でも公式サイトでも裏が取れない（＝ identity を確定しない）。
        //   誤った企業の事実を書くくらいなら何も書かない、が既存の不変条件。
        if (!name || FIXTURES[name].domain === '') return { status: 'unresolved', source: null };
        return { status: 'resolved', candidate: candidateFor(name), source: searchSource(name) };
      },
    },
    search: {
      name: 'fake-search',
      isConfigured: () => true,
      async searchOfficialSite(query: string) {
        const name = Object.keys(FIXTURES).find((n) => query.includes(normalize(n)));
        current = name ?? '';
        if (!name || FIXTURES[name].domain === '') {
          // [B] 1 社だけ「公式サイトを特定できない」状態にする。
          return { status: 'empty', source: null };
        }
        return {
          status: 'ok',
          hits: [{ url: `https://${FIXTURES[name].domain}/company/`, title: FIXTURES[name].legalName, snippet: '' }],
          source: searchSource(name),
        };
      },
    },
    async fetchSite(url: string) {
      const name = Object.keys(FIXTURES).find((n) => FIXTURES[n].domain !== '' && url.includes(FIXTURES[n].domain));
      if (!name) return { ok: false };
      current = name;
      return { ok: true, document: siteDocFor(name) };
    },
    async extractProfile(sourceText: string) {
      // 原文に実在する値だけを返し、production と同じ normalizer を通す
      //   （grounding 検証・上限適用の挙動を本番と揃える）。
      const pick = (label: string) => {
        const m = new RegExp(`${label} (.+)`).exec(sourceText);
        return m ? m[1].trim() : null;
      };
      return normalizeExtractedProfile({
        legalName: FIXTURES[current]?.legalName ?? null,
        businessDescription: pick('事業内容'),
        employeeCount: pick('従業員数'),
        foundedYear: pick('設立'),
        headquartersAddress: pick('本社'),
      });
    },

    async registerCompany(displayName: string) {
      world.registerCalls += 1;
      const token = normalize(displayName);
      const existing = world.companies.find((c) => c.normalized === token);
      if (existing) return { status: 'registered', companyId: existing.companyId, displayName: existing.displayName } as never;
      const companyId = `cmp_fake_${world.companies.length + 1}`;
      world.companies.push({ companyId, displayName, normalized: token });
      return { status: 'registered', companyId, displayName } as never;
    },
    async resolveExistingCompany(rawName: string) {
      const token = normalize(rawName);
      const hit = world.companies.find((c) => c.normalized === token);
      return hit ? { companyId: hit.companyId, displayName: hit.displayName } : null;
    },

    async loadFreshness(companyId: string) {
      const map = new Map<never, never>();
      for (const f of world.facts.filter((x) => x.companyId === companyId)) {
        // 既存 fact があれば「その group は取得済み（同一時刻）」として返す。
        (map as Map<string, unknown>).set(f.factGroup, { fetchedAt: f.fetchedAt, schemaRevision: 'company-facts-v2' });
      }
      return map as never;
    },
    buildIdentity: (companyId: string) => buildCompanyEnrichmentIdentity({ companyId }),
    async claimJob(identity: { idempotencyKey: string }) {
      const key = identity.idempotencyKey;
      const existing = world.jobs.get(key);
      if (existing) return { outcome: 'ALREADY_COMPLETED', jobId: existing.jobId, attemptToken: null };
      const jobId = `job_${world.jobs.size + 1}`;
      world.jobs.set(key, { jobId, status: 'claimed', attempts: 1 });
      return { outcome: 'CLAIMED_NEW', jobId, attemptToken: `tok_${jobId}` };
    },
    async insertSources(companyId: string, sources: readonly ProviderSourceRef[]) {
      const map = new Map<string, string>();
      for (const s of sources) {
        // [D] 同一 sourceUrl は 1 行に畳む（DB の unique 制約と同じ意味）。
        if (!world.sources.some((r) => r.companyId === companyId && r.sourceUrl === s.sourceUrl)) {
          world.sources.push({ companyId, sourceUrl: s.sourceUrl });
        }
        map.set(s.sourceUrl, `src_${s.sourceUrl}`);
      }
      return map;
    },
    async insertFacts(facts: readonly Fact[]) {
      let written = 0;
      for (const f of facts) {
        // [E] 同一 (company, factKey) は最新へ置き換え（append ではなく現行値 1 件）。
        const idx = world.facts.findIndex((x) => x.companyId === f.companyId && x.factKey === f.factKey);
        const row: Fact = {
          companyId: f.companyId,
          factKey: f.factKey,
          factGroup: f.factGroup,
          factValue: f.factValue,
          sourceUrl: f.sourceUrl,
          fetchedAt: f.fetchedAt,
        };
        if (idx >= 0) world.facts[idx] = row;
        else world.facts.push(row);
        written += 1;
      }
      return written;
    },
    async finishJob({ jobId, status }: { jobId: string; status: string }) {
      for (const j of world.jobs.values()) if (j.jobId === jobId) j.status = status;
    },
    async failJob({ jobId }: { jobId: string }) {
      for (const j of world.jobs.values()) if (j.jobId === jobId) j.status = 'failed';
    },
    async attachCorporateNumber() { /* fake: 何もしない */ },
  } as unknown as PrefetchDeps;
}

/** world の fact 行から production projection を通して読み出し結果を作る。 */
function readFor(world: World, companyId: string, displayName: string): CompanyOfficialReadResult {
  const rows: FactRow[] = world.facts
    .filter((f) => f.companyId === companyId)
    .map((f) => ({
      factKey: f.factKey,
      factGroup: f.factGroup,
      factValue: f.factValue,
      sourceUrl: f.sourceUrl,
      sourceType: 'official_site',
      extractionMethod: 'llm_extraction',
      fetchedAt: f.fetchedAt,
    }));
  if (rows.length === 0) return { status: 'unavailable', reason: 'no_facts' };
  const data = buildCompanyOfficialContext({ companyId, displayName, rows, nowIso: ISO });
  if (data.facts.length === 0) return { status: 'unavailable', reason: 'no_facts' };
  const summary = summarizeFreshness(data.groups);
  if (summary === 'missing') return { status: 'unavailable', reason: 'no_facts' };
  if (summary === 'ready') return { status: 'ready', data };
  if (summary === 'partial') return { status: 'partial', data };
  return { status: 'stale', data };
}

async function main(): Promise<void> {
  console.log('career-company-ingest-coverage-qa');
  console.log('');

  const OK_NAMES = ['アルファ工業株式会社', 'ベータ商事株式会社', 'ガンマソフト株式会社'];
  const FAIL_NAME = 'デルタ未知株式会社';

  // ── [A][B] multi-company + failure isolation ─────────────────────────
  console.log('[A][B] 複数社の逐次投入 / 1 社失敗の隔離');
  const world = newWorld();
  const deps = depsFor(world);
  const outcomes: Array<{ name: string; kind: string }> = [];
  // ★ 逐次（batch script と同じ順序・同じ deps）。途中で 1 社失敗させる。
  for (const name of [OK_NAMES[0], FAIL_NAME, OK_NAMES[1], OK_NAMES[2]]) {
    const out = await runCompanyPrefetch(deps, name);
    if (process.env.QA_DEBUG === '1') console.log('  debug:', name, JSON.stringify(out));
    outcomes.push({ name, kind: out.kind });
  }
  const kindOf = (n: string) => outcomes.find((o) => o.name === n)?.kind ?? '';
  check(OK_NAMES.every((n) => kindOf(n) === 'written'), '3 社が written で成立', JSON.stringify(outcomes));
  check(kindOf(FAIL_NAME) === 'identity_blocked', '裏の取れない 1 社は identity_blocked（何も書かない）', kindOf(FAIL_NAME));
  check(
    OK_NAMES.every((n) => {
      const c = world.companies.find((x) => x.normalized === normalize(n));
      return !!c && world.facts.some((f) => f.companyId === c.companyId);
    }),
    '[B] 失敗社を挟んでも他社の fact は残る（batch rollback しない）',
  );
  check(
    !world.facts.some((f) => {
      const c = world.companies.find((x) => x.companyId === f.companyId);
      return c?.normalized === normalize(FAIL_NAME);
    }),
    '[B] 失敗社の fact は 1 件も書かれない（欠損を選ぶ）',
  );
  check(new Set(world.companies.map((c) => c.companyId)).size === world.companies.length, '企業 ID が重複しない');
  console.log('');

  // ── [C][D][E] idempotency ────────────────────────────────────────────
  console.log('[C][D][E] 同一企業の再投入で増殖しない');
  const beforeCompanies = world.companies.length;
  const beforeSources = world.sources.length;
  const beforeFacts = world.facts.length;
  const again = await runCompanyPrefetch(deps, OK_NAMES[0]);
  check(again.kind === 'fresh' || again.kind === 'deduped', '2 回目は fresh / deduped（外部取得しない）', again.kind);
  check(world.companies.length === beforeCompanies, '[C] master が増えない');
  check(world.sources.length === beforeSources, '[D] source が増殖しない');
  check(world.facts.length === beforeFacts, '[E] fact が増殖しない');
  console.log('');

  // ── [F][G] usable status / consultation 互換 ─────────────────────────
  console.log('[F][G] 各社が使える状態 / consultation renderer 互換');
  for (const name of OK_NAMES) {
    const c = world.companies.find((x) => x.normalized === normalize(name))!;
    const facts = world.facts.filter((f) => f.companyId === c.companyId);
    const sources = world.sources.filter((s) => s.companyId === c.companyId);
    const read = readFor(world, c.companyId, c.displayName);
    const block = renderCompanyOfficialForPurpose('consultation', read);
    check(facts.length >= 1 && sources.length >= 1, `[F] fact>=1 / source>=1 | ${name}`, `facts=${facts.length} sources=${sources.length}`);
    check(read.status === 'ready' || read.status === 'partial' || read.status === 'stale', `[F] usable status | ${name}`, read.status);
    check(block.used && block.text.includes(name), `[G] consultation block が非空で企業名を含む | ${name}`);
    check(block.text.includes('【公式情報'), `[G] 公式情報ヘッダを持つ | ${name}`);
  }
  // 2 社同時（比較相談）でも両社の block が同時に作れる。
  {
    const [a, b] = OK_NAMES;
    const ca = world.companies.find((x) => x.normalized === normalize(a))!;
    const cb = world.companies.find((x) => x.normalized === normalize(b))!;
    const ba = renderCompanyOfficialForPurpose('consultation', readFor(world, ca.companyId, ca.displayName));
    const bb = renderCompanyOfficialForPurpose('consultation', readFor(world, cb.companyId, cb.displayName));
    const joined = `${ba.text}\n\n${bb.text}`;
    check(ba.used && bb.used && joined.includes(a) && joined.includes(b), '[G] 2 社比較用に両社の block を同時に作れる');
    check(joined.split('【公式情報').length - 1 === 2, '[G] 公式情報 block は 2 社分ぴったり');
  }
  console.log('');

  // ── [H] ingest script の契約（静的検証）──────────────────────────────
  console.log('[H] operator ingest script の契約');
  const scriptPath = join(ROOT, 'scripts/career-company-ingest.ts');
  const script = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf-8') : '';
  check(script !== '', 'scripts/career-company-ingest.ts が存在する');
  check(/runCompanyPrefetch\(/.test(script), '正式 pipeline（runCompanyPrefetch）を通す');
  check(!/insert\s*\(|INSERT INTO/i.test(script), '手動 INSERT をしない');
  check(!/\.delete\(|DELETE FROM|TRUNCATE/i.test(script), '削除操作を持たない');
  check(/for \(const name of names\)/.test(script), '逐次ループ（並列 fetch をしない）');
  check(!/Promise\.all\(\s*names/.test(script), '企業リストを並列実行しない');
  check(/--dry-run/.test(script), 'dry-run を持つ（投入前に identity を確認できる）');
  // 企業一覧を production bundle へ持ち込んでいないこと（app/ 配下に launch list が無い）。
  const appHasList = /const\s+(COMPANIES|LAUNCH_COMPANIES|COMPANY_LIST)\s*=/.test(
    readFileSync(join(ROOT, 'app/api/career/company/intent/route.ts'), 'utf-8'),
  );
  check(!appHasList, '企業一覧を production runtime へハードコードしていない');
  console.log('');

  console.log(fail === 0 ? 'career-company-ingest-coverage-qa: ALL PASS' : `career-company-ingest-coverage-qa: ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
