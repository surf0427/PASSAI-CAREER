/*
 * scripts/career-company-spine-expansion-qa.ts
 *
 * PASSAI CAREER — Company Data Spine の **企業分析向け項目拡張**（fact schema v2）の QA。
 *
 * 何を守るか:
 *   X-1 schema     … 追加 key が group / label / section を必ず持つ（宙に浮く key を作らない）
 *   X-2 幻覚防止    … source に無い値は保存されない・欠損は null のまま（placeholder を作らない）
 *   X-3 後方互換    … v1 形状の row / schema_revision NULL の row をそのまま読める
 *   X-4 provenance … 追加 fact も出典 URL 必須・confidence は method から決定論
 *   X-5 直列化      … DB write 形状 → read → projection で新 key が消えない
 *   X-6 prompt 接続 … 企業分析 prompt に新 fact が実際に入る / 面接の予算は据え置き
 *   X-7 部分データ  … 一部しか取れなくても crash しない・未知 key でも壊れない
 *   X-8 TTL/revision… schema 世代のズレで再取得が走る / opportunistic group が storm を生まない
 *   X-9 無関係非回帰… allowlist / 混在禁止 / 面接 gate を壊していない
 *
 * 実 DB / 実 network / 実 AI なし（全 deps を fake で注入）。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-company-spine-expansion-qa.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  COMPANY_FACT_GROUPS,
  COMPANY_FACT_KEYS,
  COMPANY_FACT_KEY_GROUP,
  OPPORTUNISTIC_FACT_GROUPS,
  PREFETCH_FACT_GROUPS,
  isKnownCompanyFactKey,
  type CompanyFactGroup,
  type CompanyFactGroupState,
  type CompanyFactKey,
  type CompanyOfficialReadResult,
} from '@/types/careerCompanyOfficial';
import {
  COMPANY_FACT_TTL_SECONDS,
  classifyGroupFreshness,
  isSchemaRevisionStale,
} from '@/lib/careerCompanyOfficial/freshness';
import { buildCompanyOfficialContext, type FactRow } from '@/lib/careerCompanyOfficial/projection';
import {
  COMPANY_FACT_SCHEMA_REVISION,
  COMPANY_FETCHER_REVISION,
  EXTRACTION_MAX_TOKENS,
  MAX_DEVELOPMENTS,
  MAX_FETCHES_PER_JOB,
  timeBudgetIsConsistent,
} from '@/lib/careerCompanyPrefetch/constants';
import { buildCompanyEnrichmentIdentity } from '@/lib/careerCompanyPrefetch/idempotency';
import {
  minPrefetchTtlSeconds,
  refreshCooldownIsConsistent,
} from '@/lib/careerCompanyPrefetch/refreshPolicy';
import {
  DEVELOPMENTS_SPEC,
  IR_SPEC,
  PHILOSOPHY_SPEC,
  RECRUITING_SPEC,
  isEmptyBySpec,
  normalizeBySpec,
  normalizeExtractedProfile,
  rejectUngroundedBySpec,
  rejectUngroundedValues,
  type ExtractedCompanyDevelopments,
  type ExtractedCompanyIr,
  type ExtractedCompanyPhilosophy,
  type ExtractedCompanyRecruiting,
} from '@/lib/careerCompanyPrefetch/extraction';
import {
  buildDevelopmentsFacts,
  buildIrFacts,
  buildPhilosophyFacts,
  buildRecruitingFacts,
  mergeFacts,
} from '@/lib/careerCompanyPrefetch/factMapping';
import { discoverPages } from '@/lib/careerCompanyPrefetch/domainVerification';
import {
  isDeadlineExceeded,
  runCompanyPrefetch,
  type PrefetchDeps,
  type SiteDocument,
} from '@/lib/careerCompanyPrefetch/prefetchJobService';
import {
  COMPANY_OFFICIAL_MAX_BYTES,
  renderCompanyOfficialForPurpose,
} from '@/lib/careerContextRenderers/companyOfficialContext';
import type { ProviderSourceRef } from '@/lib/careerCompanyPrefetch/providers/types';

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

const NOW = '2026-08-17T12:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

// ════════════════════════════════════════════════════════════════════
console.log('[X-1] schema — 追加 key が宙に浮かない');
{
  check('X-1a fact key が拡張されている（v1 の 25 key から増えている）', COMPANY_FACT_KEYS.length > 25, `keys=${COMPANY_FACT_KEYS.length}`);
  check(
    'X-1b 全 key が group を持つ（EAV の未分類 key を作らない）',
    COMPANY_FACT_KEYS.every((k) => typeof COMPANY_FACT_KEY_GROUP[k] === 'string'),
  );
  check(
    'X-1c 全 group が COMPANY_FACT_GROUPS に含まれる（DDL の CHECK と揃う）',
    COMPANY_FACT_KEYS.every((k) => (COMPANY_FACT_GROUPS as readonly string[]).includes(COMPANY_FACT_KEY_GROUP[k])),
  );
  check(
    'X-1d ★ news group には fact key を割り当てない（保存対象外の契約）',
    COMPANY_FACT_KEYS.every((k) => COMPANY_FACT_KEY_GROUP[k] !== 'news'),
  );
  check('X-1e key の重複が無い', new Set(COMPANY_FACT_KEYS).size === COMPANY_FACT_KEYS.length);
  check('X-1f 未知 key を guard で弾ける', isKnownCompanyFactKey('revenue') && !isKnownCompanyFactKey('madeUpKey'));

  // 企業分析に必要なカテゴリが実際に埋まっているか（項目数ではなく **カテゴリの網羅**を見る）。
  const required: Readonly<Record<string, readonly CompanyFactKey[]>> = {
    'identity/overview': ['legalName', 'industryLabel', 'headquartersAddress', 'foundedYear', 'employeeCount', 'listingStatus', 'representativeName'],
    business: ['businessDescription', 'businessSegments', 'mainProducts', 'businessModel', 'targetCustomers', 'overseasPresence'],
    strategy: ['missionStatement', 'visionStatement', 'corporateValues', 'selfDescribedStrengths', 'statedChallenges', 'businessRisks', 'growthStrategy', 'midTermPlanSummary', 'strategicInvestmentAreas'],
    financial: ['revenue', 'operatingProfit', 'netProfit', 'fiscalPeriodLabel', 'segmentPerformance', 'financialHighlights'],
    competition: ['namedCompetitors', 'marketPositionClaims', 'marketEnvironment'],
    recruiting: ['desiredCandidateProfile', 'jobCategories', 'organizationalCulture', 'workingStyle', 'trainingPrograms', 'careerDevelopment'],
    developments: ['recentDevelopments', 'productLaunches', 'partnerships', 'mergersAcquisitions'],
  };
  for (const [category, keys] of Object.entries(required)) {
    check(
      `X-1g カテゴリ「${category}」の key が揃っている`,
      keys.every((k) => COMPANY_FACT_KEYS.includes(k)),
      keys.filter((k) => !COMPANY_FACT_KEYS.includes(k)).join(','),
    );
  }

  // renderer 側の drift 検出（label / section の抜けは prompt から静かに消える事故になる）。
  const renderer = read('lib/careerContextRenderers/companyOfficialContext.ts');
  check(
    'X-1h ★ 全 key に日本語ラベルがある（label 抜けで key 名が prompt に出ない）',
    COMPANY_FACT_KEYS.every((k) => new RegExp(`\\n  ${k}: '`).test(renderer)),
    COMPANY_FACT_KEYS.filter((k) => !new RegExp(`\\n  ${k}: '`).test(renderer)).join(','),
  );
  check(
    'X-1i ★ 全 key が section に割り当てられている（未割当は「その他」へ落ちるが意図しない）',
    COMPANY_FACT_KEYS.every((k) => new RegExp(`'${k}'`).test(renderer.split('const SECTIONS')[1] ?? '')),
    COMPANY_FACT_KEYS.filter((k) => !new RegExp(`'${k}'`).test(renderer.split('const SECTIONS')[1] ?? '')).join(','),
  );

  const pages = discoverPages(
    [
      { href: 'https://x.co.jp/company/', label: '会社概要' },
      { href: 'https://x.co.jp/philosophy/', label: '経営理念' },
      { href: 'https://x.co.jp/ir/library/', label: '決算資料' },
      { href: 'https://x.co.jp/recruit/', label: '採用情報' },
      { href: 'https://x.co.jp/news/', label: 'ニュース' },
    ],
    'x.co.jp',
  );
  check('X-1j 理念ページを検出できる', pages.philosophy === 'https://x.co.jp/philosophy/');
  check('X-1k 決算ページを検出できる', pages.financialResults === 'https://x.co.jp/ir/library/');
}

// ════════════════════════════════════════════════════════════════════
console.log('[X-2] 幻覚防止 — 出典に無い値は保存されない');
{
  const IR_TEXT = [
    '2026年3月期 決算概要',
    '売上収益 13兆207億円、営業利益 1兆2,088億円。',
    '当社は成長投資として半導体領域へ重点的に配分します。',
  ].join('\n');

  // LLM が本文に無い数字を混ぜて返した状況を作る。
  const hallucinated = normalizeBySpec<ExtractedCompanyIr>(
    {
      fiscalPeriodLabel: '2026年3月期',
      revenue: '13兆207億円',
      operatingProfit: '1兆2,088億円',
      // ★ 本文に存在しない（LLM の記憶から出た）値。
      netProfit: '9,705億円',
      namedCompetitors: ['任天堂', 'マイクロソフト'],
      marketPositionClaims: ['世界シェア1位'],
      strategicInvestmentAreas: ['半導体領域'],
    },
    IR_SPEC,
  );
  const { value: grounded, report } = rejectUngroundedBySpec(hallucinated, IR_SPEC, IR_TEXT);

  check('X-2a 本文にある売上は残る', grounded.revenue === '13兆207億円');
  check('X-2b ★ 本文に無い純利益は落とされる', grounded.netProfit === null);
  check('X-2c ★ 本文に無い競合名は落とされる', grounded.namedCompetitors.length === 0);
  check('X-2d ★ 本文に無い市場ポジション主張は落とされる', grounded.marketPositionClaims.length === 0);
  check('X-2e 本文にある投資領域は残る', grounded.strategicInvestmentAreas.includes('半導体領域'));
  check('X-2f 落とした key が観測に残る', report.rejectedKeys.includes('netProfit'));
  check('X-2g 落としても他項目は独立に残る（部分成功を活かす）', report.kept > 0);

  // 落とされた値は **fact にならない**（null を「不明という事実」として保存しない）。
  const facts = buildIrFacts(grounded, IR_TEXT, 'https://x.co.jp/ir/', NOW);
  check('X-2h ★ null 項目の fact は作られない', !facts.some((f) => f.factKey === 'netProfit'));
  check('X-2i ★ 空配列の fact は作られない', !facts.some((f) => f.factKey === 'namedCompetitors'));
  check('X-2j placeholder（"不明" / "N/A"）を保存しない', !facts.some((f) => /不明|N\/A|null/i.test(String(f.factValue.value))));

  // 全 null なら 1 件も作らない（IR 非公開企業の正常系）。
  const emptyIr = normalizeBySpec<ExtractedCompanyIr>({}, IR_SPEC);
  check('X-2k 非上場・IR 非公開なら空判定になる', isEmptyBySpec(emptyIr));
  check('X-2l 空抽出からは fact が 0 件', buildIrFacts(emptyIr, IR_TEXT, 'https://x.co.jp/ir/', NOW).length === 0);

  // 文字列 'null' / 未知 key の混入も落とす。
  const dirty = normalizeBySpec<ExtractedCompanyRecruiting>(
    { desiredCandidateProfile: 'null', jobCategories: ['営業', '営業'], somethingUnknown: 'x' },
    RECRUITING_SPEC,
  );
  check('X-2m 文字列 "null" は null に正規化', dirty.desiredCandidateProfile === null);
  check('X-2n 配列は重複除去', dirty.jobCategories.length === 1);
  check('X-2o 未知 key は捨てる', !Object.prototype.hasOwnProperty.call(dirty, 'somethingUnknown'));

  // 追加した profile 系 key も同じ検証を通ること。
  const PROFILE_TEXT = '当社の強みは自社工場による一貫生産体制です。主な顧客は自動車メーカーです。';
  const p = rejectUngroundedValues(
    normalizeExtractedProfile({
      selfDescribedStrengths: ['自社工場による一貫生産体制', '業界No.1のブランド力'],
      targetCustomers: ['自動車メーカー'],
      businessModel: '売り切り型のライセンス収入',
    }),
    PROFILE_TEXT,
  );
  check('X-2p 追加 profile key も grounding 検証を通る', p.profile.selfDescribedStrengths.length === 1);
  check('X-2q ★ 本文に無い強みは落とされる', !p.profile.selfDescribedStrengths.includes('業界No.1のブランド力'));
  check('X-2r ★ 本文に無いビジネスモデルは落とされる', p.profile.businessModel === null);
}

// ════════════════════════════════════════════════════════════════════
console.log('[X-3] 後方互換 — v1 形状の row をそのまま読める');
{
  // v1 時代の row（新 key を 1 つも含まない / schema_revision 列が無い）。
  const v1Rows: FactRow[] = [
    { factKey: 'legalName', factGroup: 'identity', factValue: { value: 'ソニーグループ株式会社' }, sourceUrl: 'https://r/', sourceType: 'corporate_registry', extractionMethod: 'structured_api', fetchedAt: ago(3) },
    { factKey: 'businessSegments', factGroup: 'profile', factValue: { value: ['ゲーム', '音楽'] }, sourceUrl: 'https://s/', sourceType: 'official_site', extractionMethod: 'llm_extraction', fetchedAt: ago(3) },
    { factKey: 'recruitUrl', factGroup: 'navigation', factValue: { value: 'https://s/recruit' }, sourceUrl: 'https://s/', sourceType: 'official_site', extractionMethod: 'html_structured', fetchedAt: ago(3) },
  ];
  const v1 = buildCompanyOfficialContext({ companyId: 'c', displayName: 'ソニーグループ株式会社', rows: v1Rows, nowIso: NOW });
  check('X-3a v1 row を読める（fact が消えない）', v1.facts.length === 3);
  check('X-3b v1 でも group 鮮度は prefetch 対象の 3 つ', v1.groups.length === PREFETCH_FACT_GROUPS.length);
  check('X-3c v1 row でも配列は「、」結合のまま', v1.facts.find((f) => f.factKey === 'businessSegments')?.displayValue === 'ゲーム、音楽');
  check(
    'X-3d ★ v1 row は prompt にも従来どおり載る',
    renderCompanyOfficialForPurpose('company_research_review', { status: 'ready', data: v1 }).text.includes('- 事業セグメント: ゲーム、音楽'),
  );

  // schema_revision NULL（列が無かった時代の row）は **stale 扱いにしない**
  //   → 「旧 row を全部 stale にして毎日再取得」という storm を作らない。
  check('X-3e ★ schemaRevision NULL は stale にしない', !isSchemaRevisionStale(null, COMPANY_FACT_SCHEMA_REVISION));
  check('X-3f 現行世代は stale にしない', !isSchemaRevisionStale(COMPANY_FACT_SCHEMA_REVISION, COMPANY_FACT_SCHEMA_REVISION));
  check('X-3g ★ 旧世代は stale', isSchemaRevisionStale('company-facts-v1', COMPANY_FACT_SCHEMA_REVISION));
  check('X-3h 現行世代が未指定なら判定しない（安全側）', !isSchemaRevisionStale('company-facts-v1', ''));

  const freshOld = classifyGroupFreshness('profile', ago(1), NOW, {
    factSchemaRevision: 'company-facts-v1',
    currentSchemaRevision: COMPANY_FACT_SCHEMA_REVISION,
  });
  check('X-3i ★ TTL 内でも旧世代なら stale（新 key を取りに行ける）', freshOld.freshness === 'stale');
  const freshNew = classifyGroupFreshness('profile', ago(1), NOW, {
    factSchemaRevision: COMPANY_FACT_SCHEMA_REVISION,
    currentSchemaRevision: COMPANY_FACT_SCHEMA_REVISION,
  });
  check('X-3j 現行世代 + TTL 内なら fresh（余計な再取得をしない）', freshNew.freshness === 'fresh');
  check('X-3k opts 省略時は従来と同じ（TTL のみで判定）', classifyGroupFreshness('profile', ago(1), NOW).freshness === 'fresh');
}

// ════════════════════════════════════════════════════════════════════
console.log('[X-4] provenance — 追加 fact も出典必須');
{
  const philosophy: ExtractedCompanyPhilosophy = {
    missionStatement: '技術で世界を変える',
    visionStatement: null,
    corporateValues: ['誠実', '挑戦'],
  };
  const TEXT = '経営理念: 技術で世界を変える。行動指針は誠実と挑戦です。';
  const facts = buildPhilosophyFacts(philosophy, TEXT, 'https://x.co.jp/philosophy/', NOW);

  check('X-4a すべての fact が sourceUrl を持つ', facts.length > 0 && facts.every((f) => f.sourceUrl !== ''));
  check('X-4b sourceUrl が空なら fact を作らない', buildPhilosophyFacts(philosophy, TEXT, '', NOW).length === 0);
  check('X-4c confidence は method から決定論（llm_extraction=0.6）', facts.every((f) => f.confidence === 0.6));
  check('X-4d extractionMethod が llm_extraction', facts.every((f) => f.extractionMethod === 'llm_extraction'));
  check('X-4e ★ rawExcerpt に原文の該当箇所が残る', facts.find((f) => f.factKey === 'missionStatement')?.factValue.rawExcerpt?.includes('技術で世界を変える') === true);
  check('X-4f factGroup が key の割当と一致', facts.every((f) => f.factGroup === COMPANY_FACT_KEY_GROUP[f.factKey]));

  const ir = buildIrFacts(
    normalizeBySpec<ExtractedCompanyIr>({ fiscalPeriodLabel: '2026年3月期', revenue: '13兆円' }, IR_SPEC),
    '2026年3月期 売上収益 13兆円',
    'https://x.co.jp/ir/',
    NOW,
  );
  check('X-4g ★ 財務値には決算期が asOf として付く（基準日なき数値を出さない）', ir.find((f) => f.factKey === 'revenue')?.factValue.asOf === '2026年3月期');

  // 出典が解決できない fact を落とす経路が persistence 側にあること（静的契約）。
  const repo = read('lib/careerCompanyPrefetch/repository.server.ts');
  check('X-4h persistence は source 未解決の fact を落とす', repo.includes('fact dropped: source unresolved'));
  check('X-4i ★ persistence が schema_revision を書く', repo.includes('schema_revision: COMPANY_FACT_SCHEMA_REVISION'));
  check('X-4j freshness read が schema_revision を読む', repo.includes("read('fact_group, fetched_at, schema_revision')"));
  // ★ deploy 順序（コード先行 / DDL 後追い）の吸収。実 DB（v1 適用済み・v2 未適用）で
  //   42703 を確認した上での対策なので、静的にも固定する。
  check(
    'X-4k ★ 列が無い DB では v1 形状へ fallback する（read が落ちない）',
    repo.includes('isMissingSchemaRevisionColumn') && repo.includes("read('fact_group, fetched_at')"),
  );
  check(
    'X-4l ★ 列が無い DB では schema_revision を外して insert し直す（fact が 1 件も書けない事故を防ぐ）',
    repo.includes('v1Rows') && repo.includes('schema_revision: _omit'),
  );
}

// ════════════════════════════════════════════════════════════════════
console.log('[X-5] 直列化 — DB write 形状 → read → projection で消えない');
{
  const src: ProviderSourceRef = {
    sourceUrl: 'https://x.co.jp/ir/',
    sourceType: 'ir_document',
    sourceDomain: 'x.co.jp',
    httpStatus: 200,
    contentHash: null,
    fetchedAt: NOW,
    publishedAt: null,
  };

  const drafts = mergeFacts('cmp_x', [
    buildIrFacts(
      normalizeBySpec<ExtractedCompanyIr>(
        { fiscalPeriodLabel: '2026年3月期', revenue: '13兆207億円', segmentPerformance: ['ゲーム 4兆円', '音楽 1兆円'], statedChallenges: ['海外比率の向上'] },
        IR_SPEC,
      ),
      '2026年3月期 売上収益 13兆207億円 ゲーム 4兆円 音楽 1兆円 課題は海外比率の向上',
      src.sourceUrl,
      NOW,
    ),
    buildRecruitingFacts(
      normalizeBySpec<ExtractedCompanyRecruiting>({ desiredCandidateProfile: '自ら考え動ける人', jobCategories: ['技術', '営業'] }, RECRUITING_SPEC),
      '求める人物像: 自ら考え動ける人。募集職種は技術・営業。',
      'https://x.co.jp/recruit/',
      NOW,
    ),
    buildDevelopmentsFacts(
      normalizeBySpec<ExtractedCompanyDevelopments>({ recentDevelopments: ['2026年7月 新工場を稼働'], partnerships: ['2026年6月 A社と資本提携'] }, DEVELOPMENTS_SPEC),
      'https://x.co.jp/news/',
      NOW,
    ),
  ]);

  // repository.server.ts の insertFacts と同じ row 形状 → readRepository の FactRow へ。
  const rows: FactRow[] = drafts.map((f) => ({
    factKey: f.factKey,
    factGroup: f.factGroup,
    factValue: JSON.parse(JSON.stringify(f.factValue)) as unknown, // jsonb 往復を模す
    sourceUrl: src.sourceUrl,
    sourceType: 'ir_document',
    extractionMethod: f.extractionMethod,
    fetchedAt: f.fetchedAt,
  }));

  const ctx = buildCompanyOfficialContext({ companyId: 'cmp_x', displayName: 'X 株式会社', rows, nowIso: NOW });
  const byKey = new Map(ctx.facts.map((f) => [f.factKey, f]));

  check('X-5a 財務 fact が往復で消えない', byKey.get('revenue')?.displayValue === '13兆207億円');
  check('X-5b 配列 fact が往復で消えない（「、」結合）', byKey.get('segmentPerformance')?.displayValue === 'ゲーム 4兆円、音楽 1兆円');
  check('X-5c 採用 fact が往復で消えない', byKey.get('desiredCandidateProfile')?.displayValue === '自ら考え動ける人');
  check('X-5d 動向 fact が往復で消えない', byKey.get('recentDevelopments')?.displayValue === '2026年7月 新工場を稼働');
  check('X-5e asOf が往復で消えない', byKey.get('revenue')?.asOf === '2026年3月期');
  check('X-5f ★ 新 group（developments）が projection で認識される', byKey.get('recentDevelopments')?.factGroup === 'developments');
  check(
    'X-5g ★ opportunistic group の fact は既定で stale にならない（marker の意味を保つ）',
    ['revenue', 'desiredCandidateProfile', 'recentDevelopments'].every((k) => byKey.get(k as CompanyFactKey)?.freshness === 'fresh'),
    JSON.stringify(['revenue', 'desiredCandidateProfile', 'recentDevelopments'].map((k) => byKey.get(k as CompanyFactKey)?.freshness)),
  );
  check(
    'X-5h ★ 読み出し status は prefetch 対象 group だけで決まる（IR 非公開企業を partial にしない）',
    ctx.groups.length === PREFETCH_FACT_GROUPS.length &&
      ctx.groups.every((g) => (PREFETCH_FACT_GROUPS as readonly string[]).includes(g.factGroup)),
  );
}

// ════════════════════════════════════════════════════════════════════
console.log('[X-6] prompt 接続 — 企業分析に実際に入る');

/** 企業分析向けの「全部そろった」context を組む。 */
function fullContext() {
  const rows: FactRow[] = (
    [
      ['legalName', 'identity', 'ソニーグループ株式会社'],
      ['foundedYear', 'identity', '1946年5月7日'],
      ['employeeCount', 'profile', '113,000名'],
      ['representativeName', 'profile', '山田太郎'],
      ['businessDescription', 'profile', 'ゲーム・音楽・映画・エレクトロニクスを展開'],
      ['businessModel', 'profile', 'ハードとコンテンツの循環による収益'],
      ['missionStatement', 'profile', 'クリエイティビティとテクノロジーの力で世界を感動で満たす'],
      ['selfDescribedStrengths', 'profile', ['多様な事業ポートフォリオ']],
      ['revenue', 'ir', '13兆207億円'],
      ['operatingProfit', 'ir', '1兆2,088億円'],
      ['midTermPlanSummary', 'ir', '感動を届ける事業の拡大を掲げる'],
      ['statedChallenges', 'ir', ['半導体供給の安定化']],
      ['marketEnvironment', 'ir', 'ゲーム市場は成長が続く'],
      ['desiredCandidateProfile', 'recruiting', '自ら課題を見つけて動ける人'],
      ['organizationalCulture', 'recruiting', '挑戦を後押しする文化'],
      ['recentDevelopments', 'developments', ['2026年7月 新スタジオ設立を発表']],
      ['recruitUrl', 'navigation', 'https://sony.com/recruit'],
    ] as [CompanyFactKey, CompanyFactGroup, string | string[]][]
  ).map(([factKey, factGroup, value]) => ({
    factKey,
    factGroup,
    factValue: { value },
    sourceUrl: 'https://www.sony.com/about/',
    sourceType: 'official_site',
    extractionMethod: 'llm_extraction',
    fetchedAt: ago(2),
  }));
  return buildCompanyOfficialContext({ companyId: 'cmp_sony', displayName: 'ソニーグループ株式会社', rows, nowIso: NOW });
}

{
  const ready: CompanyOfficialReadResult = { status: 'ready', data: fullContext() };
  const block = renderCompanyOfficialForPurpose('company_research_review', ready);

  check('X-6a block が生成される', block.used);
  check('X-6b ★ 財務が prompt に入る', block.text.includes('- 売上高: 13兆207億円') && block.text.includes('- 営業利益: 1兆2,088億円'));
  check('X-6c ★ 戦略が prompt に入る', block.text.includes('中期経営計画（IR からの抜粋）') && block.text.includes('自社が挙げている課題'));
  check('X-6d ★ 理念が prompt に入る', block.text.includes('経営理念・ミッション'));
  check('X-6e ★ 事業構造が prompt に入る', block.text.includes('ビジネスモデル・収益構造'));
  check('X-6f ★ 市場環境が prompt に入る', block.text.includes('市場環境・業界動向'));
  check('X-6g ★ 採用が prompt に入る', block.text.includes('求める人物像') && block.text.includes('組織文化・社風'));
  check('X-6h ★ 最近の動向が prompt に入る', block.text.includes('最近の主な発表'));

  // §7 の「整理して渡す」= 企業分析の観点で section 化されている。
  for (const section of ['■ 会社概要', '■ 事業', '■ 理念・戦略', '■ 業績・財務', '■ 市場・競合', '■ 採用・組織', '■ 最近の動向', '■ 参照ページ']) {
    check(`X-6i section「${section}」が出る`, block.text.includes(section));
  }
  check(
    'X-6j ★ section の順序が企業分析の観点順',
    (() => {
      const order = ['■ 会社概要', '■ 事業', '■ 理念・戦略', '■ 業績・財務', '■ 市場・競合', '■ 採用・組織', '■ 最近の動向', '■ 参照ページ'].map((s) => block.text.indexOf(s));
      return order.every((v, i) => i === 0 || (v > 0 && v > order[i - 1]));
    })(),
  );
  check('X-6k 出典 URL を保持', block.text.includes('出典:'));
  check('X-6l ★ 一次情報であることの明示を保持', block.text.includes('AI が生成した情報ではありません'));
  check('X-6m ★ 補って断定しない指示を保持', block.text.includes('補って断定しないでください'));

  // token 予算: 企業分析は拡張、面接は据え置き。
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  check('X-6n 企業分析 block は予算内', bytes(block.text) <= 4600, `bytes=${bytes(block.text)}`);
  const iv = renderCompanyOfficialForPurpose('interview_practice', ready);
  check('X-6o ★ 面接 block は従来予算のまま（interview prompt を肥大させない）', bytes(iv.text) <= COMPANY_OFFICIAL_MAX_BYTES, `bytes=${bytes(iv.text)}`);
  check('X-6p ★ 面接 block の方が小さい（purpose 別 budget が効いている）', bytes(iv.text) < bytes(block.text));
  check('X-6q 明示 opts は purpose budget より優先', bytes(renderCompanyOfficialForPurpose('company_research_review', ready, { maxBytes: 600 }).text) <= 600);

  // 空 section の見出しを出さない（負の証拠を書かない）。
  const partialOnly = buildCompanyOfficialContext({
    companyId: 'c',
    displayName: 'Y',
    rows: [{ factKey: 'legalName', factGroup: 'identity', factValue: { value: 'Y 株式会社' }, sourceUrl: 'https://y/', sourceType: 'official_site', extractionMethod: 'structured_api', fetchedAt: ago(1) }],
    nowIso: NOW,
  });
  const small = renderCompanyOfficialForPurpose('company_research_review', { status: 'partial', data: partialOnly });
  check('X-6r ★ 空 section の見出しは出さない（無いことを prompt に書かない）', small.used && !small.text.includes('■ 業績・財務') && !small.text.includes('■ 採用・組織'));

  // 企業研究 route が読む経路が残っていること（配線の静的契約）。
  const route = read('app/api/career/company-research/route.ts');
  check('X-6s 企業研究 route が Data Spine を読む', route.includes('loadCompanyOfficialContext'));
  check('X-6t 企業研究 route が公式情報を独立 block として結合する', route.includes('orchestrated.companyOfficialContext'));
  const orchestrator = read('lib/careerContext/orchestrator.ts');
  check('X-6u orchestrator が renderer 経由で渡す', orchestrator.includes('renderCompanyOfficialForPurpose'));
}

// ════════════════════════════════════════════════════════════════════
console.log('[X-7] 部分データ / 壊れた入力で crash しない');
{
  const broken: FactRow[] = [
    { factKey: 'revenue', factGroup: 'ir', factValue: null, sourceUrl: 'https://x/', sourceType: 'ir_document', extractionMethod: 'llm_extraction', fetchedAt: ago(1) },
    { factKey: 'unknownFutureKey', factGroup: 'ir', factValue: { value: '将来の key' }, sourceUrl: 'https://x/', sourceType: 'ir_document', extractionMethod: 'llm_extraction', fetchedAt: ago(1) },
    { factKey: 'statedChallenges', factGroup: 'ir', factValue: { value: [] }, sourceUrl: 'https://x/', sourceType: 'ir_document', extractionMethod: 'llm_extraction', fetchedAt: ago(1) },
    { factKey: 'desiredCandidateProfile', factGroup: 'zzz_unknown_group', factValue: { value: '人物像' }, sourceUrl: 'https://x/', sourceType: 'bogus', extractionMethod: 'bogus', fetchedAt: ago(1) },
  ];
  const ctx = buildCompanyOfficialContext({ companyId: 'c', displayName: 'Z', rows: broken, nowIso: NOW });
  check('X-7a factValue=null は fact にしない', !ctx.facts.some((f) => f.factKey === 'revenue'));
  check('X-7b 空配列は fact にしない', !ctx.facts.some((f) => f.factKey === 'statedChallenges'));
  check('X-7c ★ 未知 group でも key の割当から復帰する', ctx.facts.some((f) => f.factKey === 'desiredCandidateProfile' && f.factGroup === 'recruiting'));
  check('X-7d 未知 key でも throw しない', ctx.facts.some((f) => f.factKey === ('unknownFutureKey' as CompanyFactKey)));
  check('X-7e 不正 sourceType / method は既定値へ倒す', ctx.facts.every((f) => typeof f.sourceType === 'string' && typeof f.extractionMethod === 'string'));

  const block = renderCompanyOfficialForPurpose('company_research_review', { status: 'partial', data: ctx });
  check('X-7f 壊れた row 混在でも block を作れる', block.used);
  check('X-7g ★ 未知 key は section「その他」に落ちて消えない', block.text.includes('■ その他') && block.text.includes('将来の key'));

  check('X-7h fact 0 件なら空（負の証拠を書かない）', renderCompanyOfficialForPurpose('company_research_review', { status: 'ready', data: { ...ctx, facts: [] } }).text === '');
  for (const bad of [
    { status: 'unavailable', reason: 'no_facts' },
    { status: 'disabled', reason: 'flag_off' },
  ] as CompanyOfficialReadResult[]) {
    check(`X-7i ${bad.status} は必ず空`, renderCompanyOfficialForPurpose('company_research_review', bad).text === '');
  }
}

// ════════════════════════════════════════════════════════════════════
console.log('[X-8] TTL / revision — 再取得は 1 回だけ・storm を作らない');

type World = {
  facts: { companyId: string; factGroup: CompanyFactGroup; fetchedAt: string; schemaRevision: string | null }[];
  claims: string[];
  fetches: string[];
  extractions: string[];
  nowIso: string;
  status: string | null;
};

function siteDoc(url: string, text: string, links: readonly { href: string; label: string }[]): SiteDocument {
  return {
    url,
    text,
    title: 'X 株式会社',
    links,
    jsonLd: null,
    source: { sourceUrl: url, sourceType: 'official_site', sourceDomain: 'x.co.jp', httpStatus: 200, contentHash: null, fetchedAt: '', publishedAt: null },
  };
}

const SITE_LINKS = [
  { href: 'https://x.co.jp/company/', label: '会社概要' },
  { href: 'https://x.co.jp/philosophy/', label: '経営理念' },
  { href: 'https://x.co.jp/ir/library/', label: '決算資料' },
  { href: 'https://x.co.jp/recruit/', label: '採用情報' },
  { href: 'https://x.co.jp/news/', label: 'ニュース' },
];

const PAGE_TEXT: Readonly<Record<string, string>> = {
  'https://x.co.jp/': 'X 株式会社の公式サイトです。',
  'https://x.co.jp/company/': '会社概要。X 株式会社。設立 2000年4月1日。従業員数 500名。事業内容は受託開発です。',
  'https://x.co.jp/philosophy/': '経営理念: 技術で社会を支える。',
  'https://x.co.jp/ir/library/': '2026年3月期 売上高 120億円。課題は人材確保です。',
  'https://x.co.jp/recruit/': '求める人物像: 学び続ける人。募集職種はエンジニアです。',
  'https://x.co.jp/news/': '2026年7月 新オフィスを開設しました。',
};

function depsFor(world: World, opts: { schemaRevisionOfExisting?: string | null } = {}): PrefetchDeps {
  return {
    now: () => world.nowIso,
    externalFetchEnabled: () => true,
    registry: {
      name: 'fake',
      isConfigured: () => false,
      lookupByName: async () => ({ status: 'unresolved', source: null }),
    },
    search: {
      name: 'fake',
      isConfigured: () => true,
      searchOfficialSite: async () => ({
        status: 'ok',
        hits: [{ url: 'https://x.co.jp/', title: 'X 株式会社', snippet: '' }],
        source: { sourceUrl: 'https://search/', sourceType: 'search_result', sourceDomain: 'search', httpStatus: 200, contentHash: null, fetchedAt: world.nowIso, publishedAt: null },
      }),
    },
    fetchSite: async (url) => {
      world.fetches.push(url);
      const text = PAGE_TEXT[url];
      if (text === undefined) return { ok: false };
      return { ok: true, document: siteDoc(url, text, url === 'https://x.co.jp/' ? SITE_LINKS : []) };
    },
    extractProfile: async () => {
      world.extractions.push('profile');
      return normalizeExtractedProfile({ legalName: 'X 株式会社', employeeCount: '500名', businessDescription: '受託開発' });
    },
    extractPhilosophy: async () => {
      world.extractions.push('philosophy');
      return normalizeBySpec<ExtractedCompanyPhilosophy>({ missionStatement: '技術で社会を支える' }, PHILOSOPHY_SPEC);
    },
    extractIr: async () => {
      world.extractions.push('ir');
      return normalizeBySpec<ExtractedCompanyIr>({ fiscalPeriodLabel: '2026年3月期', revenue: '120億円', statedChallenges: ['人材確保'] }, IR_SPEC);
    },
    extractRecruiting: async () => {
      world.extractions.push('recruiting');
      return normalizeBySpec<ExtractedCompanyRecruiting>({ desiredCandidateProfile: '学び続ける人', jobCategories: ['エンジニア'] }, RECRUITING_SPEC);
    },
    extractDevelopments: async () => {
      world.extractions.push('developments');
      return normalizeBySpec<ExtractedCompanyDevelopments>({ recentDevelopments: ['2026年7月 新オフィスを開設'] }, DEVELOPMENTS_SPEC);
    },
    registerCompany: async () => null,
    resolveExistingCompany: async () => ({ companyId: 'cmp_x', displayName: 'X 株式会社' }),
    loadFreshness: async (companyId) => {
      const map = new Map<CompanyFactGroup, CompanyFactGroupState>();
      for (const f of world.facts) {
        if (f.companyId !== companyId) continue;
        const prev = map.get(f.factGroup);
        if (!prev || Date.parse(f.fetchedAt) > Date.parse(prev.fetchedAt)) {
          map.set(f.factGroup, {
            fetchedAt: f.fetchedAt,
            schemaRevision: opts.schemaRevisionOfExisting ?? f.schemaRevision,
          });
        }
      }
      return map;
    },
    claimJob: async (identity) => {
      world.claims.push(identity.idempotencyKey);
      return { outcome: 'CLAIMED_NEW', jobId: 'job_1', attemptToken: 'tok_1' };
    },
    insertSources: async (_companyId, sources) => new Map(sources.map((s) => [s.sourceUrl, `src_${s.sourceUrl}`])),
    insertFacts: async (facts) => {
      for (const f of facts) {
        world.facts.push({ companyId: f.companyId, factGroup: f.factGroup, fetchedAt: f.fetchedAt, schemaRevision: COMPANY_FACT_SCHEMA_REVISION });
      }
      return facts.length;
    },
    finishJob: async (args) => {
      world.status = args.status;
      return { applied: true };
    },
    failJob: async () => {
      world.status = 'failed';
      return { applied: true };
    },
    buildIdentity: (companyId) => buildCompanyEnrichmentIdentity({ companyId }),
  };
}

function newWorld(): World {
  return { facts: [], claims: [], fetches: [], extractions: [], nowIso: NOW, status: null };
}

{
  // 定数側の不変条件は据え置き（cooldown を縮めていない＝ storm を作っていない）。
  check('X-8a refresh cooldown が freshness policy と整合', refreshCooldownIsConsistent());
  check('X-8b prefetch 最短 TTL は 90 日のまま（再取得頻度を上げていない）', minPrefetchTtlSeconds() === 90 * 24 * 3600);
  check('X-8c 時間予算が整合（route maxDuration の内側）', timeBudgetIsConsistent());
  check(
    'X-8d ★ opportunistic group は refresh cycle を駆動しない',
    OPPORTUNISTIC_FACT_GROUPS.every((g) => !PREFETCH_FACT_GROUPS.includes(g)),
  );
  check(
    'X-8e ★ opportunistic group を prefetch に入れていない（cooldown を縮めずに済む）',
    Math.min(...PREFETCH_FACT_GROUPS.map((g) => COMPANY_FACT_TTL_SECONDS[g])) === minPrefetchTtlSeconds(),
  );

  // revision を上げたので idempotency key が v1 と衝突しない（新しい取得サイクルを開ける）。
  // ★ String() で literal 型を widen する（constant が revert されたら落ちる assertion）。
  check('X-8f fact schema revision が v1 から上がっている', String(COMPANY_FACT_SCHEMA_REVISION) !== 'company-facts-v1');
  check('X-8g fetcher revision が更新されている', String(COMPANY_FETCHER_REVISION) !== 'company-prefetch-fetcher-2026-08-16');
  check(
    'X-8h ★ schema revision が変われば idempotency key も変わる',
    buildCompanyEnrichmentIdentity({ companyId: 'cmp_x', schemaRevision: 'company-facts-v1' }).idempotencyKey !==
      buildCompanyEnrichmentIdentity({ companyId: 'cmp_x' }).idempotencyKey,
  );
  check('X-8i max_tokens を引き上げている（key 増で truncate させない）', EXTRACTION_MAX_TOKENS >= 3_000);
  check('X-8j fetch 予算がページ数に足りる', MAX_FETCHES_PER_JOB >= 8);
  check('X-8k 締切判定は pure（両方読めなければ止めない）', !isDeadlineExceeded('bogus', NOW) && !isDeadlineExceeded(NOW, null) && isDeadlineExceeded(NOW, ago(1)));
}

async function main(): Promise<void> {
  {
    // 初回取得: 追加 group もまとめて書ける。
    const world = newWorld();
    const out = await runCompanyPrefetch(depsFor(world), 'X 株式会社');
    const groups = new Set(world.facts.map((f) => f.factGroup));

    check('X-8l 初回で written', out.kind === 'written', JSON.stringify(out));
    check('X-8m profile / navigation が書ける', groups.has('profile') && groups.has('navigation'));
    check('X-8n ★ ir group が書ける', groups.has('ir'));
    check('X-8o ★ recruiting group が書ける', groups.has('recruiting'));
    check('X-8p ★ developments group が書ける', groups.has('developments'));
    check('X-8q ページ別に抽出している（1 回の巨大 call にしない）', new Set(world.extractions).size === 5, world.extractions.join(','));
    check('X-8r fetch 回数が予算内', world.fetches.length <= MAX_FETCHES_PER_JOB, `fetches=${world.fetches.length}`);
  }

  {
    // ★★ storm 防止の中核 ★★
    //   IR / 採用 / ニュースページを持たない企業（＝ 中小企業の大多数）でも、
    //   prefetch 対象 group が揃っていれば `completed` になること。
    //   ここが partial になると failure cooldown（1 日）で毎日再取得が走り、
    //   ほぼ全企業に対して外部 I/O が日次で発生する。
    //
    //   条件を「prefetch 対象 3 group が揃う」に固定するため、registry が解決する
    //   世界（identity facts が書ける）＋ navigation リンクはあるが **その先のページは
    //   404**（＝ opportunistic group は 1 件も取れない）を作る。
    const world = newWorld();
    const base = depsFor(world);
    const candidate = {
      corporateNumber: '1234567890123',
      legalName: 'X 株式会社',
      legalNameKana: null,
      legalNameEn: null,
      prefecture: '東京都',
      address: '東京都港区1-1-1',
      registrationStatus: '存続',
      formerNames: [] as readonly string[],
    };
    const registrySource: ProviderSourceRef = {
      sourceUrl: 'https://registry/?name=X',
      sourceType: 'corporate_registry',
      sourceDomain: 'registry',
      httpStatus: 200,
      contentHash: null,
      fetchedAt: NOW,
      publishedAt: null,
    };

    const out = await runCompanyPrefetch(
      {
        ...base,
        registry: {
          name: 'fake',
          isConfigured: () => true,
          lookupByName: async () => ({ status: 'resolved', candidate, source: registrySource }),
        },
        registerCompany: async () => ({ status: 'registered', companyId: 'cmp_x', displayName: 'X 株式会社', created: true }),
        // トップページだけ取得でき、採用 / IR / ニュースのページは 404。
        //   → navigation facts（recruitUrl 等）は **リンク検出だけで**書ける。
        //   → opportunistic group は 1 件も書けない。
        fetchSite: async (url) => {
          world.fetches.push(url);
          return url === 'https://x.co.jp/'
            ? { ok: true, document: siteDoc(url, PAGE_TEXT[url], SITE_LINKS) }
            : { ok: false };
        },
      },
      'X 株式会社',
    );

    const written = new Set(world.facts.map((f) => f.factGroup));
    check('X-8s0 written で終わる', out.kind === 'written', JSON.stringify(out));
    check(
      'X-8s1 prefetch 対象 3 group が揃っている（前提の確認）',
      PREFETCH_FACT_GROUPS.every((g) => written.has(g)),
      [...written].join(','),
    );
    check(
      'X-8s ★ opportunistic group が 0 件でも completed（恒常 partial → 日次再取得を作らない）',
      world.status === 'completed',
      `status=${world.status}`,
    );
    check(
      'X-8s2 取れなかった group の fact は 1 件も捏造されない',
      !world.facts.some((f) => (OPPORTUNISTIC_FACT_GROUPS as readonly string[]).includes(f.factGroup)),
    );
  }

  {
    // ★ 本 slice の中核: TTL 内でも **旧 schema 世代**なら取り直す。
    const world = newWorld();
    world.facts = PREFETCH_FACT_GROUPS.map((g) => ({ companyId: 'cmp_x', factGroup: g, fetchedAt: ago(1), schemaRevision: 'company-facts-v1' }));
    const out = await runCompanyPrefetch(depsFor(world, { schemaRevisionOfExisting: 'company-facts-v1' }), 'X 株式会社');
    check('X-8t ★ TTL 内 + 旧世代 → 取得が走る（新 key が埋まる）', out.kind === 'written', JSON.stringify(out));
    check('X-8u ★ 取り直しで ir / recruiting / developments が入る', ['ir', 'recruiting', 'developments'].every((g) => world.facts.some((f) => f.factGroup === g)));

    // 取り直した後は現行世代になるので、もう走らない（1 世代 1 回だけ＝ storm にならない）。
    const settled = newWorld();
    settled.facts = PREFETCH_FACT_GROUPS.map((g) => ({ companyId: 'cmp_x', factGroup: g, fetchedAt: ago(1), schemaRevision: COMPANY_FACT_SCHEMA_REVISION }));
    const again = await runCompanyPrefetch(depsFor(settled), 'X 株式会社');
    check('X-8v ★ 現行世代 + TTL 内 → 外部 I/O ゼロ（fresh で打ち切る）', again.kind === 'fresh' && settled.fetches.length === 0 && settled.claims.length === 0, JSON.stringify(again));
  }

  {
    // 締切を過ぎている場合はページを増やさない（既取得分は捨てない）。
    const world = newWorld();
    const deps = depsFor(world);
    // now が常に締切より後になるよう、時計を大きく進めた deps を使う。
    let calls = 0;
    const impatient: PrefetchDeps = {
      ...deps,
      now: () => (calls++ < 2 ? NOW : new Date(Date.parse(NOW) + 10 * 60 * 60 * 1000).toISOString()),
    };
    const out = await runCompanyPrefetch(impatient, 'X 株式会社');
    check('X-8w ★ 締切超過でも job は成立する（取れた分は保存する）', out.kind === 'written' || out.kind === 'failed', JSON.stringify(out));
    check('X-8x ★ 締切超過後は追加ページを取りに行かない', world.fetches.length <= 2, `fetches=${world.fetches.join(',')}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('[X-9] 無関係な回帰が無い');
  {
    const renderer = read('lib/careerContextRenderers/companyOfficialContext.ts');
    check('X-9a renderer は本人メモ型を import しない', !renderer.includes('careerCompanyResearch'));
    check('X-9b renderer は AI 派生（derived）を扱わない', !renderer.includes('CompanyDerivedRecord'));
    check('X-9c renderer は Layer 5 を import しない', !renderer.includes('careerCompanyKnowledge'));
    // ★ 元の意図（= purpose へ勝手に流し込まない）はそのまま維持する。
    //   ES / プレゼンは Data Spine connection で **意図的に** opt-in したため、
    //   「未 opt-in の purpose は空」+「opt-in した purpose は専用 usage note を伴う」の
    //   2 点で「事故で流れ込んでいないこと」を固定する（allowlist の意味を弱めない）。
    check(
      'X-9d 未 opt-in purpose は allowlist 外のまま（勝手に流し込まない）',
      renderCompanyOfficialForPurpose('gd_feedback', { status: 'ready', data: fullContext() })
        .text === '' &&
        renderCompanyOfficialForPurpose('matching', { status: 'ready', data: fullContext() })
          .text === '',
    );
    check(
      'X-9d2 ES purpose は **意図的な opt-in**（ES 専用 usage note を伴う）',
      renderCompanyOfficialForPurpose('es_review', {
        status: 'ready',
        data: fullContext(),
      }).text.includes('代筆・創作しないでください'),
    );

    const runtime = read('lib/careerCompanyPrefetch/runtime.server.ts');
    for (const dep of ['extractPhilosophy', 'extractIr', 'extractRecruiting', 'extractDevelopments']) {
      check(`X-9e runtime が ${dep} を配線している（optional dep の配線漏れ防止）`, runtime.includes(`${dep}(sourceText`));
    }
    check('X-9f 抽出 model は据え置き（安価な抽出器）', runtime.includes('COMPANY_EXTRACTION_MODEL'));
    check('X-9g 抽出は temperature 0（決定論）', runtime.includes('temperature: 0'));
    check('X-9h ★ truncate した JSON を parse しない', runtime.includes("stop_reason === 'max_tokens'"));

    const extraction = read('lib/careerCompanyPrefetch/extraction.ts');
    check('X-9i ★ 全 prompt が「知識を使わない」契約を共有する', (extraction.match(/あなたの知識を一切使わないでください/g) ?? []).length >= 1 && extraction.includes('EXTRACTION_PREAMBLE'));
    check('X-9j ★ 財務 prompt が計算・換算を禁止している', extraction.includes('計算・換算・丸めをしないでください'));
    check('X-9k ★ 動向 prompt が件数を絞る（ニュース羅列にしない）', MAX_DEVELOPMENTS <= 6 && extraction.includes('ニュースを全部並べないでください'));
    check('X-9l ★ 課題 / 強みは「企業自身の記述」に限定されている', extraction.includes('企業自身が課題 / リスクとして書いている記述') && extraction.includes('企業が自社の強みとして書いている記述'));

    const types = read('types/careerCompanyOfficial.ts');
    check('X-9m ★ PREFETCH_FACT_GROUPS に追加禁止の理由が書かれている', types.includes('ここに group を足してはいけない'));
    check('X-9n derived（AI 派生）は facts と型でも分離されたまま', types.includes('ai_derived_not_fact') || types.includes('facts テーブルへは絶対に入れない'));
  }

  // ════════════════════════════════════════════════════════════════════
  if (failures > 0) {
    console.error(`\n❌ company spine expansion QA: ${failures} FAILED`);
    process.exit(1);
  }
  console.log('\n✅ ALL PASS — 企業分析向け項目拡張が取得 → 保存 → 更新 → prompt まで繋がっている');

}

void main();
