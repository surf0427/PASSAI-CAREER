/*
 * scripts/career-company-prefetch-ttl-qa.ts
 *
 * PASSAI CAREER — Company Data Spine の **TTL 再取得ライフサイクル** QA。
 *
 * 直した事故（回帰させてはいけないもの）:
 *   company-scoped idempotency key には時間成分が無い（company_id + task + revisions）。
 *   そのため 1 度 completed になった job 行は natural key が永久に同じままで、
 *   claim RPC が `ALREADY_COMPLETED` を返し続け、**TTL が切れても外部取得が二度と走らなかった**。
 *   `fetcher_revision` を上げるコード変更でしか再取得できない状態だった。
 *
 * ここで固定する契約:
 *   T1 fresh（age = TTL/2）           → 外部取得 0 回・既存データを再利用
 *   T2 expired（age = TTL + ε）       → 再取得が走り・新しい fact が積まれ・freshness が更新される
 *   T3 boundary（age = TTL ちょうど） → **fresh**（age <= TTL が fresh。DB cooldown も同時に開く）
 *   T4 failed refresh                 → last-known-good が残る / 空上書きしない / 偽 fresh にしない
 *   T5 concurrent                     → 同一企業への同時 refresh は外部取得 1 回へ収束
 *   T6 refresh 直後の 2 回目          → 外部取得 0 回
 *   T7 ★ もう一度 TTL が切れたら再び取得できる（成功 job による永久ブロックが無い）
 *   T8 refresh scope                  → fresh な group のための外部取得を走らせない
 *   T9 policy / SQL / 配線の静的契約
 *
 * 実 DB / 実 network / 実 AI なし（全 deps を fake で注入）。
 * ★ job 台帳の fake は `lib/careerCompanyPrefetch/refreshPolicy.ts` の
 *   `decideCompanyJobClaim` をそのまま使う（＝ SQL 関数と 1:1 対応する判定を実際に動かす）。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-company-prefetch-ttl-qa.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeCompanyName } from '@/lib/careerCompanyKnowledge/identity';
import {
  COMPANY_FACT_TTL_SECONDS,
  classifyGroupFreshness,
  summarizeFreshness,
} from '@/lib/careerCompanyOfficial/freshness';
import { buildCompanyOfficialContext } from '@/lib/careerCompanyOfficial/projection';
import {
  FAILURE_COOLDOWN_SECONDS,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  REFRESH_COOLDOWN_SECONDS,
} from '@/lib/careerCompanyPrefetch/constants';
import { buildCompanyEnrichmentIdentity } from '@/lib/careerCompanyPrefetch/idempotency';
import { normalizeExtractedProfile } from '@/lib/careerCompanyPrefetch/extraction';
import {
  runCompanyPrefetch,
  type PrefetchDeps,
  type PrefetchOutcome,
  type SiteDocument,
} from '@/lib/careerCompanyPrefetch/prefetchJobService';
import {
  decideCompanyJobClaim,
  isRefreshCycleDue,
  minPrefetchTtlSeconds,
  refreshCooldownIsConsistent,
  type CompanyJobLedgerState,
} from '@/lib/careerCompanyPrefetch/refreshPolicy';
import type { RegistryCompanyCandidate } from '@/lib/careerCompanyPrefetch/providers/types';
import type { CompanyFactGroup } from '@/types/careerCompanyOfficial';

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

const SECOND = 1000;
/** prefetch 対象 group の最短 TTL（= profile / navigation の 90 日）。 */
const MIN_TTL_MS = minPrefetchTtlSeconds() * SECOND;
/** identity group の TTL（180 日）。scope 検証に使う。 */
const IDENTITY_TTL_MS = COMPANY_FACT_TTL_SECONDS.identity * SECOND;

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

// ════════════════════════════════════════════════════════════════════
// fake world（全ユーザーが共有する global な DB 相当 + 進められる時計）
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

type FactRow = {
  companyId: string;
  factKey: string;
  factGroup: string;
  factValue: unknown;
  sourceUrl: string;
  sourceType: string;
  extractionMethod: string;
  fetchedAt: string;
};

type LedgerRow = CompanyJobLedgerState & {
  attemptToken: string | null;
  refreshCycleCount: number;
};

type World = {
  /** 進められる時計（ms）。 */
  nowMs: number;
  master: Map<string, { companyId: string; displayName: string }>;
  companies: number;
  /** 外部 I/O（registry / search / site fetch）の回数。 */
  externalCalls: number;
  /** registry 単体の呼び出し回数（scope 検証用）。 */
  registryCalls: number;
  /** site fetch の回数（scope 検証用）。 */
  siteCalls: number;
  jobs: Map<string, LedgerRow>;
  tokenSeq: number;
  /** claim の outcome 履歴（観測）。 */
  claimOutcomes: string[];
  facts: FactRow[];
  sources: Set<string>;
};

function newWorld(): World {
  return {
    nowMs: T0,
    master: new Map(),
    companies: 0,
    externalCalls: 0,
    registryCalls: 0,
    siteCalls: 0,
    jobs: new Map(),
    tokenSeq: 0,
    claimOutcomes: [],
    facts: [],
    sources: new Set(),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

type Options = {
  /** registry を使えなくする（既存企業への紐付けのみになる）。 */
  registryUnresolved?: boolean;
  /** 公式サイト検索を失敗させる（DOMAIN_UNVERIFIED を作る）。 */
  searchFails?: boolean;
};

function depsFor(world: World, opts: Options = {}): PrefetchDeps {
  const now = () => iso(world.nowMs);

  const siteDoc = (): SiteDocument => ({
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
      // ★ 出典の fetchedAt も「その時点の時刻」（再取得ごとに変わる）。
      fetchedAt: now(),
      publishedAt: null,
    },
  });

  return {
    now,
    externalFetchEnabled: () => true,

    registry: {
      name: 'fake-registry',
      isConfigured: () => true,
      lookupByName: async (raw) => {
        world.externalCalls += 1;
        world.registryCalls += 1;
        if (opts.registryUnresolved) return { status: 'unresolved', source: null };
        const target = normalizeCompanyName(raw);
        const matches = [SONY.legalName, 'ソニー', SONY.legalNameKana, ...SONY.formerNames].some(
          (n) => normalizeCompanyName(n ?? '') === target,
        );
        if (!matches) return { status: 'unresolved', source: null };
        return {
          status: 'resolved',
          candidate: SONY,
          source: {
            sourceUrl: `https://registry.example/name?at=${world.nowMs}`,
            sourceType: 'corporate_registry',
            sourceDomain: 'registry.example',
            httpStatus: 200,
            contentHash: 'hash-registry',
            fetchedAt: now(),
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
        if (opts.searchFails) return { status: 'failed', reason: 'timeout' };
        return {
          status: 'ok',
          hits: [{ url: 'https://www.sony.com/', title: 'ソニーグループ株式会社', snippet: '' }],
          source: {
            sourceUrl: `https://search.example/?at=${world.nowMs}`,
            sourceType: 'search_result',
            sourceDomain: 'search.example',
            httpStatus: 200,
            contentHash: 'hash-search',
            fetchedAt: now(),
            publishedAt: null,
          },
        };
      },
    },

    fetchSite: async (url) => {
      world.externalCalls += 1;
      world.siteCalls += 1;
      const base = siteDoc();
      if (url.includes('/company/')) {
        return {
          ok: true,
          document: {
            ...base,
            url,
            source: { ...base.source, sourceUrl: url, contentHash: 'hash-about' },
          },
        };
      }
      return { ok: true, document: base };
    },

    extractProfile: async () =>
      normalizeExtractedProfile({
        legalName: 'ソニーグループ株式会社',
        foundedYear: '1946年5月7日',
        businessSegments: ['ゲーム＆ネットワークサービス', '音楽', '映画'],
        employeeCount: '113,000名',
      }),

    registerCompany: async (displayName, aliases) => {
      const key = normalizeCompanyName(displayName);
      const existing = world.master.get(key);
      if (existing) return { status: 'registered', ...existing, created: false };
      const created = { companyId: `cmp_${world.companies + 1}`, displayName };
      world.companies += 1;
      world.master.set(key, created);
      for (const alias of aliases) {
        const token = normalizeCompanyName(alias);
        if (token === '' || world.master.has(token)) continue;
        world.master.set(token, created);
      }
      return { status: 'registered', ...created, created: true };
    },
    resolveExistingCompany: async (raw) => world.master.get(normalizeCompanyName(raw)) ?? null,

    loadFreshness: async (companyId) => {
      // group ごとの **最新** fetched_at（repository.server.ts と同じ規則）。
      const map = new Map<CompanyFactGroup, string>();
      for (const f of world.facts) {
        if (f.companyId !== companyId) continue;
        const g = f.factGroup as CompanyFactGroup;
        const prev = map.get(g);
        if (!prev || Date.parse(f.fetchedAt) > Date.parse(prev)) map.set(g, f.fetchedAt);
      }
      return map;
    },

    // ★ SQL 関数 career_company_enrichment_job_claim と同じ判定（refreshPolicy を実際に動かす）。
    claimJob: async (identity) => {
      const key = identity.idempotencyKey;
      const existing = world.jobs.get(key);
      const nowIso = now();

      if (!existing) {
        const token = `tok_${(world.tokenSeq += 1)}`;
        world.jobs.set(key, {
          status: 'running',
          attemptCount: 1,
          leaseExpiresAt: iso(world.nowMs + LEASE_SECONDS * SECOND),
          completedAt: null,
          failedAt: null,
          errorCode: null,
          attemptToken: token,
          refreshCycleCount: 1,
        });
        world.claimOutcomes.push('CLAIMED_NEW');
        return { outcome: 'CLAIMED_NEW', jobId: key, attemptToken: token };
      }

      const decision = decideCompanyJobClaim(existing, nowIso);
      world.claimOutcomes.push(decision.outcome);
      if (!decision.claimed) {
        return { outcome: decision.outcome, jobId: key, attemptToken: null };
      }

      const token = `tok_${(world.tokenSeq += 1)}`;
      world.jobs.set(key, {
        status: 'running',
        attemptCount: decision.attemptCount,
        leaseExpiresAt: iso(world.nowMs + LEASE_SECONDS * SECOND),
        completedAt: null,
        failedAt: null,
        errorCode: null,
        attemptToken: token,
        refreshCycleCount:
          existing.refreshCycleCount + (decision.outcome === 'CLAIMED_REFRESH' ? 1 : 0),
      });
      return { outcome: decision.outcome, jobId: key, attemptToken: token };
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
        if (!sourceIdByUrl.get(f.sourceUrl)) continue;
        // ★ append-only（既存行を消さない・上書きしない）。
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

    // fenced 更新（status=running かつ attempt_token 一致のときだけ適用）。
    finishJob: async ({ jobId, attemptToken, status, errorCode }) => {
      const row = world.jobs.get(jobId);
      if (!row || row.status !== 'running' || row.attemptToken !== attemptToken) {
        return { applied: false };
      }
      world.jobs.set(jobId, {
        ...row,
        status,
        completedAt: iso(world.nowMs),
        failedAt: null,
        errorCode: status === 'partial' ? (errorCode ?? 'PARTIAL_RESULT') : null,
        attemptToken: null,
        leaseExpiresAt: null,
      });
      return { applied: true };
    },
    failJob: async ({ jobId, attemptToken, errorCode }) => {
      const row = world.jobs.get(jobId);
      if (!row || row.status !== 'running' || row.attemptToken !== attemptToken) {
        return { applied: false };
      }
      world.jobs.set(jobId, {
        ...row,
        status: 'failed',
        completedAt: null,
        failedAt: iso(world.nowMs),
        errorCode,
        attemptToken: null,
        leaseExpiresAt: null,
      });
      return { applied: true };
    },

    buildIdentity: (companyId) => buildCompanyEnrichmentIdentity({ companyId }),
  };
}

/** その企業の group 別 freshness（呼び出し側と同じ判定）。 */
function freshnessOf(world: World, companyId: string, group: CompanyFactGroup) {
  const rows = world.facts.filter((f) => f.companyId === companyId && f.factGroup === group);
  const latest = rows.reduce<string | null>(
    (acc, r) => (acc === null || Date.parse(r.fetchedAt) > Date.parse(acc) ? r.fetchedAt : acc),
    null,
  );
  return classifyGroupFreshness(group, latest, iso(world.nowMs));
}

/** 1 企業を最初に取得しきった状態を作る（t = T0）。 */
async function seedWorld(): Promise<{ world: World; companyId: string; first: PrefetchOutcome }> {
  const world = newWorld();
  const first = await runCompanyPrefetch(depsFor(world), 'ソニー');
  const companyId = first.kind === 'written' ? first.companyId : '';
  return { world, companyId, first };
}

void (async () => {
  // ══════════════════════════════════════════════════════════════════
  console.log('[T0] seed: 初回取得が成立する');
  const seed = await seedWorld();
  check('T0a 初回は written', seed.first.kind === 'written', JSON.stringify(seed.first));
  check(
    'T0b 初回は completed（全対象 group を取得）',
    seed.first.kind === 'written' && seed.first.status === 'completed',
    JSON.stringify(seed.first),
  );
  check('T0c fact が書かれている', seed.world.facts.length > 0);
  check('T0d 対象 3 group が揃っている', ['identity', 'profile', 'navigation'].every((g) => seed.world.facts.some((f) => f.factGroup === g)));

  // ══════════════════════════════════════════════════════════════════
  console.log('[T1] fresh（age = TTL/2）→ 外部取得 0 回・既存データを再利用');
  {
    const { world, companyId } = await (async () => {
      const s = await seedWorld();
      return { world: s.world, companyId: s.companyId };
    })();
    const before = { external: world.externalCalls, facts: world.facts.length };

    world.nowMs = T0 + MIN_TTL_MS / 2;
    const out = await runCompanyPrefetch(depsFor(world), 'ソニー');

    check('T1a outcome は fresh（claim すらしない）', out.kind === 'fresh', JSON.stringify(out));
    check('T1b ★ 外部取得 0 回', world.externalCalls === before.external, `calls=${world.externalCalls} before=${before.external}`);
    check('T1c fact が増えない（既存データを再利用）', world.facts.length === before.facts);
    check(
      'T1d 全 group が fresh のまま',
      (['identity', 'profile', 'navigation'] as CompanyFactGroup[]).every(
        (g) => freshnessOf(world, companyId, g).freshness === 'fresh',
      ),
    );
    check('T1e claim が 1 度も追加で走っていない', world.claimOutcomes.length === 1, world.claimOutcomes.join(','));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[T2] expired（age = TTL + ε）→ 再取得・新 fact・freshness 更新');
  {
    const s = await seedWorld();
    const { world, companyId } = s;
    const before = { external: world.externalCalls, facts: world.facts.length };

    world.nowMs = T0 + MIN_TTL_MS + SECOND;
    check(
      'T2a 前提: profile が stale と判定される',
      freshnessOf(world, companyId, 'profile').freshness === 'stale',
    );

    const out = await runCompanyPrefetch(depsFor(world), 'ソニー');

    check('T2b ★ 再取得が走る（written）', out.kind === 'written', JSON.stringify(out));
    check('T2c ★ 外部取得が発生する', world.externalCalls > before.external, `calls=${world.externalCalls}`);
    check('T2d ★ claim は CLAIMED_REFRESH（永久 ALREADY_COMPLETED ではない）', world.claimOutcomes.includes('CLAIMED_REFRESH'), world.claimOutcomes.join(','));
    check('T2e 新しい fact が積まれる（履歴は消さない）', world.facts.length > before.facts);
    check(
      'T2f ★ freshness が更新される（profile が fresh へ戻る）',
      freshnessOf(world, companyId, 'profile').freshness === 'fresh',
    );
    check(
      'T2g 新 fact の fetchedAt が現在時刻',
      world.facts.some((f) => f.factGroup === 'profile' && Date.parse(f.fetchedAt) === world.nowMs),
    );
    check(
      'T2h 旧 fact も残っている（上書き削除しない）',
      world.facts.some((f) => f.factGroup === 'profile' && Date.parse(f.fetchedAt) === T0),
    );
    check(
      'T2i job は新サイクルへ（refresh_cycle_count = 2）',
      Array.from(world.jobs.values()).every((j) => j.refreshCycleCount === 2),
    );
    check(
      'T2j 新サイクルの attempt 予算がリセットされる',
      Array.from(world.jobs.values()).every((j) => j.attemptCount === 1),
    );

    // ── T6: refresh 成功直後の 2 回目 ──────────────────────────────
    console.log('[T6] refresh 成功直後の 2 回目 → 外部取得 0 回');
    const afterRefresh = world.externalCalls;
    const second = await runCompanyPrefetch(depsFor(world), 'ソニー');
    check('T6a 2 回目は fresh', second.kind === 'fresh', JSON.stringify(second));
    check('T6b ★ 2 回目の外部取得は 0 回', world.externalCalls === afterRefresh, `calls=${world.externalCalls}`);

    // ── T7: さらに TTL が切れたら **また**取得できる ──────────────
    console.log('[T7] ★ もう一度 TTL が切れたら再び取得できる（永久ブロックが無い）');
    const beforeThird = world.externalCalls;
    world.nowMs = world.nowMs + MIN_TTL_MS + SECOND;
    const third = await runCompanyPrefetch(depsFor(world), 'ソニー');
    check('T7a 3 サイクル目も written', third.kind === 'written', JSON.stringify(third));
    check('T7b ★ 3 サイクル目でも外部取得が走る', world.externalCalls > beforeThird);
    check(
      'T7c ★ refresh_cycle_count が 3（成功 job が永久ブロックにならない）',
      Array.from(world.jobs.values()).every((j) => j.refreshCycleCount === 3),
    );
    check(
      'T7d 3 サイクル目も freshness が更新される',
      freshnessOf(world, companyId, 'profile').freshness === 'fresh',
    );
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[T2-] 修正前の挙動を witness する（revert したら T2 が落ちることの担保）');
  {
    const s = await seedWorld();
    const { world } = s;
    const before = world.externalCalls;
    world.nowMs = T0 + MIN_TTL_MS + SECOND;

    // 修正前の claim: completed は cooldown を見ずに永久 ALREADY_COMPLETED。
    const deps = depsFor(world);
    const out = await runCompanyPrefetch(
      {
        ...deps,
        claimJob: async (identity) => {
          const row = world.jobs.get(identity.idempotencyKey);
          if (row && row.status === 'completed') {
            return { outcome: 'ALREADY_COMPLETED', jobId: identity.idempotencyKey, attemptToken: null };
          }
          return deps.claimJob(identity);
        },
      },
      'ソニー',
    );

    check(
      'T2-a 修正前の claim では stale でも取得できない（＝ 直した事故そのもの）',
      out.kind === 'deduped' && out.outcome === 'ALREADY_COMPLETED',
      JSON.stringify(out),
    );
    check('T2-b 修正前は外部取得も走らない', world.externalCalls === before, `delta=${world.externalCalls - before}`);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[T3] boundary（age = TTL ちょうど）→ 既存仕様どおり fresh');
  {
    const s = await seedWorld();
    const { world, companyId } = s;
    const before = world.externalCalls;

    world.nowMs = T0 + MIN_TTL_MS; // ちょうど TTL
    check(
      'T3a ★ age = TTL ちょうどは fresh（age <= TTL が fresh）',
      freshnessOf(world, companyId, 'profile').freshness === 'fresh',
      JSON.stringify(freshnessOf(world, companyId, 'profile')),
    );
    const out = await runCompanyPrefetch(depsFor(world), 'ソニー');
    check('T3b ちょうどでは再取得しない', out.kind === 'fresh', JSON.stringify(out));
    check('T3c ちょうどでは外部取得 0 回', world.externalCalls === before);

    world.nowMs = T0 + MIN_TTL_MS + SECOND;
    check(
      'T3d TTL + 1 秒で stale になる',
      freshnessOf(world, companyId, 'profile').freshness === 'stale',
    );

    // ★ DB 側 cooldown は freshness より **早く**開いていること
    //   （呼び出し側が stale と判定した瞬間に claim が拒まれる窓を作らない）。
    const terminal: CompanyJobLedgerState = {
      status: 'completed',
      attemptCount: 1,
      leaseExpiresAt: null,
      completedAt: iso(T0),
      failedAt: null,
      errorCode: null,
    };
    check(
      'T3e ★ cooldown 境界は TTL ちょうどで開く（>=）',
      isRefreshCycleDue(terminal, iso(T0 + MIN_TTL_MS)),
    );
    check(
      'T3f cooldown 未経過では開かない',
      !isRefreshCycleDue(terminal, iso(T0 + MIN_TTL_MS - SECOND)),
    );
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[T4] failed refresh → last-known-good を壊さない');
  {
    const s = await seedWorld();
    const { world, companyId } = s;
    const factsBefore = world.facts.length;
    const identityFactsBefore = world.facts.filter((f) => f.factGroup === 'identity').length;
    const profileLatestBefore = freshnessOf(world, companyId, 'profile').fetchedAt;

    world.nowMs = T0 + MIN_TTL_MS + SECOND;
    // registry も検索も使えない = 1 件も新しい事実を作れない refresh。
    const out = await runCompanyPrefetch(
      depsFor(world, { registryUnresolved: true, searchFails: true }),
      'ソニー',
    );

    check('T4a 取得は failed で終わる', out.kind === 'failed', JSON.stringify(out));
    check(
      'T4b ★ 既存 fact が 1 件も消えていない',
      world.facts.length === factsBefore,
      `facts=${world.facts.length} before=${factsBefore}`,
    );
    check(
      'T4c ★ identity facts が残っている（空データで上書きしない）',
      world.facts.filter((f) => f.factGroup === 'identity').length === identityFactsBefore,
    );
    check(
      'T4d ★ freshness を偽って更新しない（fetchedAt が進んでいない）',
      freshnessOf(world, companyId, 'profile').fetchedAt === profileLatestBefore,
    );
    check(
      'T4e stale のまま（fresh と偽らない）',
      freshnessOf(world, companyId, 'profile').freshness === 'stale',
    );
    check(
      'T4f job は failed terminal（error_code が残る）',
      Array.from(world.jobs.values()).every((j) => j.status === 'failed' && j.errorCode !== null),
    );

    // last-known-good が **読める**こと（stale-while-revalidate）。
    const ctx = buildCompanyOfficialContext({
      companyId,
      displayName: 'ソニーグループ株式会社',
      rows: world.facts.filter((f) => f.companyId === companyId),
      nowIso: iso(world.nowMs),
    });
    check('T4g ★ 失敗後も既存データを読める', ctx.facts.length > 0);
    check('T4h 読み出し status は stale（unavailable ではない）', summarizeFreshness(ctx.groups) === 'stale');

    // ★ 失敗が永久ブロックにならない（failure cooldown 経過で再試行できる）。
    const beforeRetry = world.externalCalls;
    world.nowMs = world.nowMs + FAILURE_COOLDOWN_SECONDS * SECOND;
    const retry = await runCompanyPrefetch(depsFor(world), 'ソニー');
    check('T4i ★ failure cooldown 経過後は再取得できる', retry.kind === 'written', JSON.stringify(retry));
    check('T4j 再取得で外部 I/O が走る', world.externalCalls > beforeRetry);
    check(
      'T4k 再取得成功で freshness が回復する',
      freshnessOf(world, companyId, 'profile').freshness === 'fresh',
    );
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[T5] concurrent refresh → 外部取得は 1 回へ収束');
  {
    const s = await seedWorld();
    const { world } = s;
    const before = world.externalCalls;
    world.nowMs = T0 + MIN_TTL_MS + SECOND;

    // 同一企業へ 3 request 同時（表記ゆれも混ぜる）。
    const results = await Promise.all([
      runCompanyPrefetch(depsFor(world), 'ソニー'),
      runCompanyPrefetch(depsFor(world), 'ソニー株式会社'),
      runCompanyPrefetch(depsFor(world), 'ソニーグループ株式会社'),
    ]);

    const written = results.filter((r) => r.kind === 'written').length;
    const deduped = results.filter((r) => r.kind === 'deduped').length;
    check('T5a ★ 実際に取得したのは 1 request のみ', written === 1, JSON.stringify(results.map((r) => r.kind)));
    check('T5b 残りは deduped', deduped === results.length - 1, JSON.stringify(results.map((r) => r.kind)));
    check(
      'T5c ★ dedupe は ALREADY_RUNNING（実行中の job を横取りしない）',
      world.claimOutcomes.filter((o) => o === 'ALREADY_RUNNING').length === results.length - 1,
      world.claimOutcomes.join(','),
    );
    check(
      'T5d ★ 外部取得は 1 セットだけ（3 倍にならない）',
      world.externalCalls - before <= 3,
      `delta=${world.externalCalls - before}`,
    );
    check('T5e 企業マスタは 1 社のまま', world.companies === 1, `companies=${world.companies}`);

    // ★ dedupe は「今」だけ。次の TTL では再び取得できる。
    world.nowMs = world.nowMs + MIN_TTL_MS + SECOND;
    const later = await runCompanyPrefetch(depsFor(world), 'ソニー');
    check('T5f ★ dedupe 後も次サイクルで再取得できる', later.kind === 'written', JSON.stringify(later));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[T8] refresh scope → fresh な group のために外部へ出ない');
  {
    const s = await seedWorld();
    const { world, companyId } = s;

    // identity(180日) は fresh・profile/navigation(90日) だけ stale の時点へ進める。
    world.nowMs = T0 + MIN_TTL_MS + SECOND;
    check('T8a 前提: identity は fresh', freshnessOf(world, companyId, 'identity').freshness === 'fresh');
    check('T8b 前提: profile は stale', freshnessOf(world, companyId, 'profile').freshness === 'stale');
    check('T8c 前提: identity TTL > profile TTL', IDENTITY_TTL_MS > MIN_TTL_MS);

    const registryBefore = world.registryCalls;
    const siteBefore = world.siteCalls;
    const out = await runCompanyPrefetch(depsFor(world), 'ソニー');

    check('T8d 取得は成立する', out.kind === 'written', JSON.stringify(out));
    check(
      'T8e ★ identity が fresh なら公的 registry を叩かない（不要な deep refresh をしない）',
      world.registryCalls === registryBefore,
      `registryCalls=${world.registryCalls} before=${registryBefore}`,
    );
    check('T8f stale な公式サイトは取り直す', world.siteCalls > siteBefore);
    check(
      'T8g ★ scope 内を満たしたので partial ではなく completed',
      out.kind === 'written' && out.status === 'completed' && out.errorCode === null,
      JSON.stringify(out),
    );
    check(
      'T8h ★ fresh な identity のために registry 出典を取り直していない',
      !world.facts.some(
        (f) => Date.parse(f.fetchedAt) === world.nowMs && f.sourceUrl.includes('registry.example'),
      ),
    );
    check(
      'T8h2 ★ registry 由来 fact（structured_api）を AI 抽出で置き換えていない',
      world.facts
        .filter((f) => f.factKey === 'corporateNumber')
        .every((f) => f.extractionMethod === 'structured_api'),
    );
    check(
      'T8i identity の既存 fact は保持される',
      world.facts.some((f) => f.factGroup === 'identity' && Date.parse(f.fetchedAt) === T0),
    );
    check(
      'T8j ★ provenance を混同しない（fact は必ず sourceUrl を持つ）',
      world.facts.every((f) => f.sourceUrl !== '' && world.sources.has(f.sourceUrl)),
    );
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('[T9] policy / SQL / 配線の静的契約');
  {
    // ── policy の不変条件 ────────────────────────────────────────
    check('T9a cooldown が freshness policy と整合（DB が claim を拒む窓を作らない）', refreshCooldownIsConsistent());
    check(
      'T9b REFRESH_COOLDOWN_SECONDS = prefetch 対象の最短 TTL',
      REFRESH_COOLDOWN_SECONDS === minPrefetchTtlSeconds(),
      `${REFRESH_COOLDOWN_SECONDS} vs ${minPrefetchTtlSeconds()}`,
    );
    check('T9c failure cooldown は refresh cooldown より短い', FAILURE_COOLDOWN_SECONDS < REFRESH_COOLDOWN_SECONDS);

    // ── 判定表（SQL と 1:1）────────────────────────────────────────
    const base: CompanyJobLedgerState = {
      status: 'completed',
      attemptCount: 1,
      leaseExpiresAt: null,
      completedAt: iso(T0),
      failedAt: null,
      errorCode: null,
    };
    const atCooldown = iso(T0 + REFRESH_COOLDOWN_SECONDS * SECOND);
    const beforeCooldown = iso(T0 + REFRESH_COOLDOWN_SECONDS * SECOND - SECOND);

    check('T9d completed かつ cooldown 未経過 → ALREADY_COMPLETED', decideCompanyJobClaim(base, beforeCooldown).outcome === 'ALREADY_COMPLETED');
    check('T9e ★ completed かつ cooldown 経過 → CLAIMED_REFRESH', decideCompanyJobClaim(base, atCooldown).outcome === 'CLAIMED_REFRESH');
    check('T9f CLAIMED_REFRESH は attempt を 1 へ戻す', decideCompanyJobClaim(base, atCooldown).attemptCount === 1);

    const running: CompanyJobLedgerState = {
      status: 'running',
      attemptCount: 1,
      leaseExpiresAt: iso(T0 + LEASE_SECONDS * SECOND),
      completedAt: null,
      failedAt: null,
      errorCode: null,
    };
    check('T9g running（lease 有効）→ ALREADY_RUNNING', decideCompanyJobClaim(running, iso(T0 + SECOND)).outcome === 'ALREADY_RUNNING');
    check(
      'T9h ★ 実行中は refresh より優先（横取りしない）',
      decideCompanyJobClaim(
        { ...running, leaseExpiresAt: iso(T0 + REFRESH_COOLDOWN_SECONDS * SECOND + LEASE_SECONDS * SECOND) },
        atCooldown,
      ).outcome === 'ALREADY_RUNNING',
    );
    check(
      'T9i lease 切れ running は同一サイクルで reclaim',
      decideCompanyJobClaim({ ...running, leaseExpiresAt: iso(T0) }, iso(T0 + SECOND)).outcome === 'CLAIMED_RETRY',
    );

    const exhausted: CompanyJobLedgerState = {
      status: 'failed',
      attemptCount: MAX_ATTEMPTS,
      leaseExpiresAt: null,
      completedAt: null,
      failedAt: iso(T0),
      errorCode: 'RETRY_LIMIT_REACHED',
    };
    check(
      'T9j attempt 上限到達かつ cooldown 未経過 → 取得しない',
      !decideCompanyJobClaim(exhausted, iso(T0 + SECOND)).claimed,
    );
    check(
      'T9k ★ attempt 上限到達でも cooldown 経過後は取得できる（永久ブロックなし）',
      decideCompanyJobClaim(exhausted, iso(T0 + FAILURE_COOLDOWN_SECONDS * SECOND)).outcome === 'CLAIMED_REFRESH',
    );
    check(
      'T9l ★ non-retryable 失敗も永久ブロックにしない',
      decideCompanyJobClaim(
        { ...exhausted, errorCode: 'DOMAIN_UNVERIFIED', attemptCount: 1 },
        iso(T0 + FAILURE_COOLDOWN_SECONDS * SECOND),
      ).outcome === 'CLAIMED_REFRESH',
    );
    check(
      'T9m non-retryable は cooldown 未経過では取得しない',
      decideCompanyJobClaim({ ...exhausted, errorCode: 'DOMAIN_UNVERIFIED', attemptCount: 1 }, iso(T0 + SECOND))
        .outcome === 'FAILED_NON_RETRYABLE',
    );

    // ── SQL 側（DDL）が同じ契約を持つ ─────────────────────────────
    const sql = read('supabase/career_company_official_facts_apply.sql');
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.career_company_enrichment_job_claim');
    const fn = fnStart >= 0 ? sql.slice(fnStart) : '';
    check('T9n claim RPC に CLAIMED_REFRESH がある', fn.includes("'CLAIMED_REFRESH'"));
    check('T9o claim RPC が cooldown 引数を取る', fn.includes('p_refresh_after_seconds') && fn.includes('p_failure_cooldown_seconds'));
    check(
      'T9p ★ ALREADY_RUNNING の判定が refresh 判定より前',
      fn.indexOf("'ALREADY_RUNNING'") >= 0 && fn.indexOf("'ALREADY_RUNNING'") < fn.indexOf('v_refresh_due :='),
    );
    check(
      'T9q ★ refresh 分岐が ALREADY_COMPLETED より前（completed を永久 terminal にしない）',
      fn.indexOf("'CLAIMED_REFRESH'") < fn.indexOf("'ALREADY_COMPLETED'"),
    );
    check('T9r refresh で attempt_count を 1 へ戻す', /IF v_refresh_due THEN[\s\S]*?attempt_count = 1/.test(fn));
    check('T9s refresh で refresh_cycle_count を進める', fn.includes('refresh_cycle_count = COALESCE(v_row.refresh_cycle_count, 1) + 1'));
    check(
      'T9t ★ refresh で facts / sources を消さない',
      !/DELETE FROM public\.career_company_(official_facts|sources)/.test(sql),
    );
    check(
      'T9u 旧 signature を DROP してから作り直す（overload を残さない）',
      sql.includes('DROP FUNCTION IF EXISTS public.career_company_enrichment_job_claim('),
    );
    check(
      'T9v GRANT / REVOKE が新 signature を指す',
      sql.includes('text, text, text, text, text, int, int, text[], int, int'),
    );

    // ── repository が cooldown を必ず渡す ─────────────────────────
    const repo = read('lib/careerCompanyPrefetch/repository.server.ts');
    check('T9w repository が p_refresh_after_seconds を渡す', repo.includes('p_refresh_after_seconds: REFRESH_COOLDOWN_SECONDS'));
    check('T9x repository が p_failure_cooldown_seconds を渡す', repo.includes('p_failure_cooldown_seconds: FAILURE_COOLDOWN_SECONDS'));

    // ── service が scope を持って外部 I/O を絞る ───────────────────
    const service = read('lib/careerCompanyPrefetch/prefetchJobService.ts');
    check('T9y service が refresh scope を計算する', service.includes('loadRefreshScope'));
    check('T9z service が scope に対して completed を判定する', service.includes('targetGroups.every((g) => writtenGroups.has(g))'));

    // ── 非同期境界を壊していない（同期 Deep Research 化していない）──
    check(
      'T9-1 intent route は after() のまま（応答を待たせない）',
      read('app/api/career/company/intent/route.ts').includes('after(async () =>'),
    );
    check(
      'T9-2 企業研究 route は prefetch を await しない',
      /(?<!await )triggerCompanyPrefetch\(companyName, req\);/.test(read('app/api/career/company-research/route.ts')),
    );
    // ── 変更禁止領域が動いていない ─────────────────────────────────
    check(
      'T9-3 Company Matching flag は code default OFF のまま',
      /return raw\.trim\(\)\.toLowerCase\(\) === 'true';/.test(read('lib/careerMatchingGate/flag.ts')),
    );
    check(
      'T9-4 CompanyPicker の Identity UI は伏せたまま',
      /const IDENTITY_UI_ENABLED: boolean = false/.test(read('components/career/CompanyPicker.tsx')),
    );
    check(
      'T9-5 Company Identity flag も code default OFF のまま',
      read('lib/careerCompanySpine/flags.server.ts').includes(
        "process.env.CAREER_COMPANY_IDENTITY_ENABLED === 'true'",
      ),
    );
  }

  console.log('');
  if (failures > 0) {
    console.error(`company prefetch TTL QA: ${failures} FAILED`);
    process.exit(1);
  }
  console.log('company prefetch TTL QA: ALL PASS');
})();
