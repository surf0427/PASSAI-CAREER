/**
 * Company Prefetch — enrichment の orchestration（DI・never-throw・I/O は全て注入）。
 *
 * 既存 `lib/careerSelfAnalysis/summaryJobService.ts` と同じ形:
 *   副作用（provider / storage / clock / LLM）はすべて deps で受け取り、
 *   本 module には **分岐と順序だけ**を置く。これにより QA（tsx）が
 *   ネットワーク・DB・AI 無しで全経路を決定論検証できる。
 *
 * ── 実行順（この順番であることが安全性の本体）────────────────────────
 *   1. identity 解決        … 外部 registry（AI 不使用）→ canonical companyId
 *      ★ ambiguous / unresolved なら **profile enrichment へ進まない**
 *   2. freshness short-circuit … fresh なら claim すらせず終了（cost 0）
 *   3. job claim            … company-scoped。ALREADY_RUNNING なら何もしない
 *   4. 外部取得             … domain discovery → 検証 → 会社概要取得 → 抽出 → 出典検証
 *   5. 永続化               … source を先に書き、その id を持つ fact だけを書く
 *   6. terminal 更新        … completed / partial / failed（fenced）
 *
 * 部分成功を許す: identity は取れたが公式サイトが落ちていた、という状態を
 * failed に丸めない（取れた fact を捨てない）。
 *
 * ── TTL lifecycle（fresh → stale → refresh → fresh …）────────────────
 *   Stage 2 の freshness 判定は「取るか / 取らないか」の 2 値ではなく、
 *   **どの fact_group を取り直すか（refresh scope）**を決める。
 *     全 group fresh          → 外部 I/O ゼロで終了（kind: 'fresh'）
 *     一部 group が stale     → その group に必要な取得だけを行う
 *       identity fresh        → 公的 registry を叩かない（既存の identity facts が現行値）
 *       profile/navigation fresh → 公式サイトを取りに行かない
 *   取得できた fact は **新しい fetched_at / valid_until を持つ行として積む**（上書き削除しない）。
 *   取得に失敗した group は old fact をそのまま残す（last-known-good + stale）。
 *
 *   「もう一度取ってよいか」の最終判定は job 台帳（claim RPC）が持つ。
 *   terminal 行は **永久禁止ではなく cooldown 付きの休止**である
 *   （`lib/careerCompanyPrefetch/refreshPolicy.ts` / DDL §7 の CLAIMED_REFRESH）。
 */

import type { CompanyRegisterResult } from '@/types/careerCompanyIdentity';
import type {
  CompanyFactGroup,
  DraftOfficialCompanyFact,
} from '@/types/careerCompanyOfficial';
import { PREFETCH_FACT_GROUPS } from '@/types/careerCompanyOfficial';
import { classifyGroupFreshness, shouldRefetchGroup } from '@/lib/careerCompanyOfficial/freshness';
import { MAX_DOMAIN_CANDIDATES, type CompanyEnrichmentErrorCode } from './constants';
import { discoverPages, sameSite, verifyOfficialDomain } from './domainVerification';
import type { ExtractedCompanyProfile } from './extraction';
import { isEmptyExtraction, rejectUngroundedValues } from './extraction';
import {
  buildDomainFacts,
  buildExtractedProfileFacts,
  buildIdentityFacts,
  buildJsonLdFacts,
  buildNavigationFacts,
  mergeFacts,
} from './factMapping';
import type { JsonLdOrganization } from './htmlText';
import type { CompanyEnrichmentIdentity } from './idempotency';
import { buildOfficialSiteQuery } from './providers/searchParse';
import type {
  CompanySearchProvider,
  CorporateRegistryProvider,
  ProviderSourceRef,
  RegistryCompanyCandidate,
} from './providers/types';

// ── 観測イベント（★ enum と件数のみ。企業名・URL・本文を含めない）──────
export type PrefetchStage =
  | 'gate'
  | 'identity'
  | 'freshness'
  | 'claim'
  | 'discovery'
  | 'extraction'
  | 'persist'
  | 'terminal';

export type PrefetchLogEvent = {
  stage: PrefetchStage;
  /** 固定 enum の結果コード。 */
  outcome: string;
  /** 数値のみ（件数・所要 ms）。 */
  count?: number;
};

// ── 結果 ─────────────────────────────────────────────────────────────
export type PrefetchOutcome =
  /** flag / gate / rate limit などで何もしなかった。 */
  | { kind: 'skipped'; reason: 'flag_off' | 'not_provisioned' | 'no_company' }
  /** 既に fresh なので外部 I/O をしなかった（**cost 0 の正常系**）。 */
  | { kind: 'fresh'; companyId: string }
  /** 別 request が同じ企業を取得中 / 完了済み（**N 人 → 1 job の収束点**）。 */
  | { kind: 'deduped'; companyId: string; outcome: string }
  /** identity を確定できなかった（誤情報を書かないための正常な停止）。 */
  | { kind: 'identity_blocked'; reason: 'ambiguous' | 'unresolved' | 'register_failed' }
  /** 取得して書けた。 */
  | {
      kind: 'written';
      companyId: string;
      status: 'completed' | 'partial';
      factsWritten: number;
      sourcesWritten: number;
      errorCode: CompanyEnrichmentErrorCode | null;
    }
  /** 取得に失敗した（fact は 1 件も書けていない）。 */
  | { kind: 'failed'; companyId: string; errorCode: CompanyEnrichmentErrorCode };

// ── deps ─────────────────────────────────────────────────────────────
export type SiteDocument = {
  url: string;
  text: string;
  title: string;
  links: readonly { href: string; label: string }[];
  jsonLd: JsonLdOrganization | null;
  source: ProviderSourceRef;
};

export type PrefetchDeps = {
  /** 現在時刻（ISO）。関数内で new Date() を読まない＝テスト可能。 */
  now: () => string;
  /** 外部ネットワーク取得が許可されているか（`CAREER_..._EXTERNAL_FETCH_ENABLED`）。 */
  externalFetchEnabled: () => boolean;

  registry: CorporateRegistryProvider;
  search: CompanySearchProvider;
  /** 1 ページ取得（SSRF guard 済み・JSON-LD 抽出済み）。 */
  fetchSite: (url: string) => Promise<{ ok: true; document: SiteDocument } | { ok: false }>;
  /** LLM 抽出（**抽出器としてのみ**。失敗は null）。 */
  extractProfile: (sourceText: string) => Promise<ExtractedCompanyProfile | null>;

  /** 既存 Company Identity の企業登録（alias 込み dedupe。無改修で再利用）。 */
  registerCompany: (
    displayName: string,
    aliases: readonly string[],
  ) => Promise<CompanyRegisterResult | null>;
  /** 既存企業への紐付けのみ（新規作成しない）。registry が使えないときの経路。 */
  resolveExistingCompany: (
    rawName: string,
  ) => Promise<{ companyId: string; displayName: string } | null>;

  /** fact_group 別の最終取得時刻。 */
  loadFreshness: (companyId: string) => Promise<Map<CompanyFactGroup, string>>;
  claimJob: (identity: CompanyEnrichmentIdentity) => Promise<{
    outcome: string;
    jobId: string;
    attemptToken: string | null;
  }>;
  insertSources: (
    companyId: string,
    sources: readonly ProviderSourceRef[],
  ) => Promise<Map<string, string>>;
  insertFacts: (
    facts: readonly DraftOfficialCompanyFact[],
    sourceIdByUrl: ReadonlyMap<string, string>,
  ) => Promise<number>;
  finishJob: (args: {
    jobId: string;
    attemptToken: string;
    status: 'completed' | 'partial';
    factsWritten: number;
    sourcesWritten: number;
    errorCode: CompanyEnrichmentErrorCode | null;
  }) => Promise<{ applied: boolean }>;
  failJob: (args: {
    jobId: string;
    attemptToken: string;
    errorCode: CompanyEnrichmentErrorCode;
  }) => Promise<{ applied: boolean }>;
  /** 法人番号を master へ付与（best-effort）。 */
  attachCorporateNumber?: (companyId: string, corporateNumber: string) => Promise<boolean>;
  /** identity の別表記を alias として登録する材料（registerCompany の aliases 引数で渡す）。 */
  buildIdentity: (companyId: string) => CompanyEnrichmentIdentity;
  log?: (event: PrefetchLogEvent) => void;
};

function emit(deps: PrefetchDeps, event: PrefetchLogEvent): void {
  try {
    deps.log?.(event);
  } catch {
    /* 観測で本処理を壊さない */
  }
}

// ── Stage 1: identity ────────────────────────────────────────────────
type IdentityResolution =
  | {
      kind: 'resolved';
      companyId: string;
      displayName: string;
      candidate: RegistryCompanyCandidate | null;
      registrySource: ProviderSourceRef | null;
    }
  | { kind: 'blocked'; reason: 'ambiguous' | 'unresolved' | 'register_failed' };

/**
 * free-text 企業名 → canonical companyId（**外部 registry を使う段**）。
 *
 * ★ 呼び出し規約: 本関数は outbound I/O を行いうる。
 *   呼び出し側（`runCompanyPrefetch`）は **先に内部 registry 照合と freshness 判定**を済ませ、
 *   「取りに行く必要がある」と決まったときにだけ本関数へ来ること。
 *   （既知かつ fresh な企業で毎回 registry を叩くと、Requirement C の cost 制御が崩れる。）
 *
 * ★ 設計判断（P0-3 の緩和策）:
 *   **公的 registry で裏が取れた企業だけ新規作成する。**
 *   ユーザーの自由入力だけで全ユーザー共有テーブルへ行を作れると、
 *   誤登録・荒らしが append-only の global データとして残る（in-app 訂正手段が無い）。
 *   registry が使えない構成（flag OFF / env 未設定 / 国外企業）では
 *   **既存企業への紐付けのみ**行い、新規作成はしない。
 *
 * @param internal 内部 registry 照合で既に解決済みの企業（あれば）。
 *                 registry が使えないときの着地点になる。
 */
export async function resolveCompanyIdentity(
  deps: PrefetchDeps,
  rawName: string,
  internal: { companyId: string; displayName: string } | null = null,
): Promise<IdentityResolution> {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name === '') return { kind: 'blocked', reason: 'unresolved' };

  // (a) 公的 registry（AI 不使用・決定論）。
  const lookup = await deps.registry.lookupByName(name);

  if (lookup.status === 'ambiguous') {
    // ★ 1 社に絞れないなら確定しない。facts も取りに行かない。
    emit(deps, { stage: 'identity', outcome: 'ambiguous', count: lookup.candidates.length });
    return { kind: 'blocked', reason: 'ambiguous' };
  }

  if (lookup.status === 'resolved') {
    const c = lookup.candidate;
    // 別表記を alias として渡す（既存 registerCompany が衝突を判定して安全に落とす）。
    const aliases = [name, c.legalNameKana ?? '', c.legalNameEn ?? '', ...c.formerNames].filter(
      (a) => typeof a === 'string' && a.trim() !== '',
    );
    const registered = await deps.registerCompany(c.legalName, aliases);

    if (!registered) {
      emit(deps, { stage: 'identity', outcome: 'register_failed' });
      return { kind: 'blocked', reason: 'register_failed' };
    }
    if (registered.status === 'ambiguous') {
      // 既存マスタ側で複数社に一致した。自動 merge しない（既存不変条件）。
      emit(deps, { stage: 'identity', outcome: 'master_ambiguous' });
      return { kind: 'blocked', reason: 'ambiguous' };
    }

    if (deps.attachCorporateNumber) {
      await deps.attachCorporateNumber(registered.companyId, c.corporateNumber);
    }
    emit(deps, { stage: 'identity', outcome: registered.created ? 'created' : 'linked' });
    return {
      kind: 'resolved',
      companyId: registered.companyId,
      displayName: registered.displayName,
      candidate: c,
      registrySource: lookup.source,
    };
  }

  // (b) registry が使えない / 該当なし → **既存企業への紐付けのみ**（新規作成しない）。
  const existing = internal ?? (await deps.resolveExistingCompany(name));
  if (existing) {
    emit(deps, { stage: 'identity', outcome: 'linked_existing' });
    return {
      kind: 'resolved',
      companyId: existing.companyId,
      displayName: existing.displayName,
      candidate: null,
      registrySource: null,
    };
  }

  emit(deps, {
    stage: 'identity',
    outcome: lookup.status === 'failed' ? `registry_${lookup.reason}` : 'unresolved',
  });
  return { kind: 'blocked', reason: 'unresolved' };
}

// ── Stage 2: official domain discovery ───────────────────────────────
type DiscoveryResult = {
  document: SiteDocument | null;
  sources: ProviderSourceRef[];
  /** 検証で不採用になった候補数（観測用）。 */
  rejected: number;
};

/**
 * 検索候補を **1 件ずつ実際に取得して検証**し、最初に検証を通ったものを公式サイトとする。
 *
 * ★ 「検索 1 位だから公式」とはしない。検証を通る候補が無ければ document=null
 *   （＝ officialDomain fact を作らない）。誤ったドメインの会社概要を保存しない。
 */
export async function discoverOfficialSite(
  deps: PrefetchDeps,
  displayName: string,
  candidate: RegistryCompanyCandidate | null,
): Promise<DiscoveryResult> {
  const sources: ProviderSourceRef[] = [];

  const query = buildOfficialSiteQuery(displayName, candidate?.legalName ?? null);
  if (query === '') return { document: null, sources, rejected: 0 };

  const search = await deps.search.searchOfficialSite(query);
  if (search.status === 'failed') {
    emit(deps, { stage: 'discovery', outcome: `search_${search.reason}` });
    return { document: null, sources, rejected: 0 };
  }
  if (search.status === 'empty') {
    emit(deps, { stage: 'discovery', outcome: 'search_empty' });
    return { document: null, sources, rejected: 0 };
  }
  // ★ 検索応答そのものも出典として残す（候補がどこから来たかを追跡できる）。
  sources.push(search.source);

  const names = {
    displayName,
    legalName: candidate?.legalName ?? null,
    legalNameEn: candidate?.legalNameEn ?? null,
    formerNames: candidate?.formerNames ?? [],
  };

  let rejected = 0;
  for (const hit of search.hits.slice(0, MAX_DOMAIN_CANDIDATES)) {
    const fetched = await deps.fetchSite(hit.url);
    if (!fetched.ok) {
      rejected += 1;
      continue;
    }
    const doc = fetched.document;
    const host = doc.source.sourceDomain;

    const verdict = verifyOfficialDomain({
      host,
      title: doc.title,
      bodyText: doc.text,
      jsonLdNames: [doc.jsonLd?.name ?? null, doc.jsonLd?.legalName ?? null],
      names,
    });

    if (!verdict.verified) {
      rejected += 1;
      emit(deps, { stage: 'discovery', outcome: `rejected_${verdict.reason}` });
      continue;
    }

    sources.push(doc.source);
    emit(deps, { stage: 'discovery', outcome: `verified_${verdict.reason}` });
    return { document: doc, sources, rejected };
  }

  emit(deps, { stage: 'discovery', outcome: 'no_verified_domain', count: rejected });
  return { document: null, sources, rejected };
}

// ── Stage 3: minimal profile prefetch ───────────────────────────────
/**
 * 公式サイト（トップ + 会社概要）から profile / navigation facts を組む。
 *
 * LLM は **抽出器としてのみ**使い、抽出値は必ず `rejectUngroundedValues` で
 * 原文に実在するか検証してから fact 化する。
 */
export async function buildProfileAndNavigationFacts(
  deps: PrefetchDeps,
  top: SiteDocument,
): Promise<{ facts: DraftOfficialCompanyFact[][]; sources: ProviderSourceRef[]; aboutFetched: boolean }> {
  const fetchedAt = deps.now();
  const sources: ProviderSourceRef[] = [];
  const factGroups: DraftOfficialCompanyFact[][] = [];

  const host = top.source.sourceDomain;
  const registrable = host.split('.').slice(-2).join('.');
  const pages = discoverPages(top.links, host);

  // navigation（リンク検出のみ。AI 不使用）。
  factGroups.push(buildNavigationFacts(pages, top.source.sourceUrl, fetchedAt));

  // 会社概要ページ。無ければトップページ本文を対象にする。
  let aboutDoc: SiteDocument = top;
  let aboutFetched = false;
  if (pages.about && pages.about !== top.url && sameSite(pages.about, registrable)) {
    const res = await deps.fetchSite(pages.about);
    if (res.ok) {
      aboutDoc = res.document;
      aboutFetched = true;
      sources.push(res.document.source);
    }
  }

  // officialDomain / officialUrl / aboutPageUrl（URL 自体が事実）。
  factGroups.push(
    buildDomainFacts(host, top.url, aboutFetched ? aboutDoc.url : null, top.source.sourceUrl, fetchedAt),
  );

  // JSON-LD（構造化・AI 不使用・LLM より優先）。
  factGroups.push(buildJsonLdFacts(aboutDoc.jsonLd, aboutDoc.source.sourceUrl, fetchedAt));

  // LLM 抽出（★ 最後。かつ検証を通ったものだけ）。
  const extracted = await deps.extractProfile(aboutDoc.text);
  if (extracted) {
    const { profile, report } = rejectUngroundedValues(extracted, aboutDoc.text);
    emit(deps, {
      stage: 'extraction',
      outcome: report.rejectedKeys.length > 0 ? 'partially_rejected' : 'grounded',
      count: report.kept,
    });
    if (!isEmptyExtraction(profile)) {
      factGroups.push(
        buildExtractedProfileFacts(profile, aboutDoc.text, aboutDoc.source.sourceUrl, fetchedAt),
      );
    }
  } else {
    emit(deps, { stage: 'extraction', outcome: 'unavailable' });
  }

  return { facts: factGroups, sources, aboutFetched };
}

// ── 本体 ─────────────────────────────────────────────────────────────
/** fact_group 別の鮮度をまとめて評価する（DB read 1 回）。 */
async function loadGroupStates(deps: PrefetchDeps, companyId: string) {
  const latest = await deps.loadFreshness(companyId);
  const now = deps.now();
  return PREFETCH_FACT_GROUPS.map((g) => classifyGroupFreshness(g, latest.get(g) ?? null, now));
}

/**
 * 「今回取りに行く group」＝ missing / stale な group だけ（**refresh scope**）。
 *
 * ★ 一部 group が stale なだけで企業データ全部を取り直さない。
 *   identity（TTL 180 日）が fresh なのに profile（90 日）の期限が来ただけなら、
 *   公的 registry へは行かず公式サイトだけを取り直す。
 */
async function loadRefreshScope(
  deps: PrefetchDeps,
  companyId: string,
): Promise<CompanyFactGroup[]> {
  const states = await loadGroupStates(deps, companyId);
  return states.filter((s) => shouldRefetchGroup(s.freshness)).map((s) => s.factGroup);
}

/**
 * 企業名 1 件分の prefetch を実行する（never-throw）。
 *
 * ★ 呼び出し側（route）は結果を待たない（`after()` で登録する）。
 *   ここで throw すると background task が unhandled rejection になるため、
 *   すべての失敗を戻り値へ落とす。
 */
export async function runCompanyPrefetch(
  deps: PrefetchDeps,
  rawName: string,
): Promise<PrefetchOutcome> {
  try {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name === '') return { kind: 'identity_blocked', reason: 'unresolved' };

    // ── Stage 1a: **内部** registry 照合（DB のみ・outbound I/O ゼロ）────
    //   既知企業ならここで companyId が決まる。外部 provider にはまだ触らない。
    const internal = await deps.resolveExistingCompany(name);

    // ── Stage 1b: freshness short-circuit（★ どんな外部 I/O よりも前）────
    //   「既に知っている企業で、情報も新しい」なら **1 バイトも取りに行かない**。
    //   これが Requirement C（同じ企業を何度入力しても外部検索しない）の本体。
    //   ここを identity 解決より後ろに置くと、既知企業でも毎回 registry を叩いてしまう。
    //   ★ fresh でなかった場合は「どの group が古いか」をそのまま refresh scope として持ち回る。
    let refreshScope: CompanyFactGroup[] | null = null;
    if (internal) {
      refreshScope = await loadRefreshScope(deps, internal.companyId);
      if (refreshScope.length === 0) {
        emit(deps, { stage: 'freshness', outcome: 'all_fresh_internal' });
        return { kind: 'fresh', companyId: internal.companyId };
      }
      emit(deps, { stage: 'freshness', outcome: 'refresh_scoped', count: refreshScope.length });
    }

    // ── Stage 1c: identity の確定 ────────────────────────────────────
    //   ★ identity group が fresh で、かつ内部 registry で既に企業が決まっているなら
    //     **公的 registry を叩かない**（R6: 期限の来ていない source を取り直さない）。
    //     この場合 candidate は無く identity facts も作らない（既存の値がそのまま現行値）。
    let identity: IdentityResolution;
    if (internal && refreshScope && !refreshScope.includes('identity')) {
      identity = {
        kind: 'resolved',
        companyId: internal.companyId,
        displayName: internal.displayName,
        candidate: null,
        registrySource: null,
      };
      emit(deps, { stage: 'identity', outcome: 'fresh_skipped' });
    } else {
      identity = await resolveCompanyIdentity(deps, name, internal);
    }

    if (identity.kind === 'blocked') {
      return { kind: 'identity_blocked', reason: identity.reason };
    }
    const { companyId, displayName, candidate, registrySource } = identity;

    // ── Stage 2: freshness 再確認（companyId が内部解決と違いうるため）──
    if (!internal || internal.companyId !== companyId) {
      refreshScope = await loadRefreshScope(deps, companyId);
      if (refreshScope.length === 0) {
        emit(deps, { stage: 'freshness', outcome: 'all_fresh' });
        return { kind: 'fresh', companyId };
      }
    }

    // ここまで来た時点で refreshScope は必ず非空（空なら上で return 済み）。
    const targetGroups: readonly CompanyFactGroup[] = refreshScope ?? PREFETCH_FACT_GROUPS;

    // ── Stage 3: claim（company-scoped）──────────────────────────────
    const jobIdentity = deps.buildIdentity(companyId);
    const claim = await deps.claimJob(jobIdentity);
    emit(deps, { stage: 'claim', outcome: claim.outcome });
    if (!claim.attemptToken) {
      // ALREADY_RUNNING / ALREADY_COMPLETED / FAILED_NON_RETRYABLE / RETRY_LIMIT_REACHED
      // ★ いずれも **今は**取りに行かないという意味であり、永久禁止ではない。
      //   cooldown を過ぎれば同じ行が CLAIMED_REFRESH で再び開く（refreshPolicy.ts）。
      return { kind: 'deduped', companyId, outcome: claim.outcome };
    }
    const attemptToken = claim.attemptToken;

    // ── Stage 4: 取得 ────────────────────────────────────────────────
    const fetchedAt = deps.now();
    const factGroups: DraftOfficialCompanyFact[][] = [];
    const sources: ProviderSourceRef[] = [];

    // identity facts（registry 由来。AI 不使用・最高 confidence）。
    if (candidate && registrySource) {
      sources.push(registrySource);
      factGroups.push(buildIdentityFacts(candidate, registrySource.sourceUrl, fetchedAt));
    }

    let externalFailure: CompanyEnrichmentErrorCode | null = null;

    // ★ 公式サイト取得は profile / navigation のどちらかが対象のときだけ走る（R6）。
    //   identity だけを取り直す場合、サイトへは 1 バイトも出さない。
    const needsOfficialSite =
      targetGroups.includes('profile') || targetGroups.includes('navigation');

    if (!needsOfficialSite) {
      emit(deps, { stage: 'discovery', outcome: 'skipped_fresh' });
    } else if (deps.externalFetchEnabled()) {
      const discovery = await discoverOfficialSite(deps, displayName, candidate);
      sources.push(...discovery.sources);
      if (discovery.document) {
        const profile = await buildProfileAndNavigationFacts(deps, discovery.document);
        factGroups.push(...profile.facts);
        sources.push(...profile.sources);
      } else {
        // ★ 検証を通るドメインが無い = profile を取りに行かない（誤情報より欠損を選ぶ）。
        externalFailure = 'DOMAIN_UNVERIFIED';
      }
    } else {
      externalFailure = 'EXTERNAL_FETCH_DISABLED';
    }

    // ── Stage 5: 永続化（source → fact の順）─────────────────────────
    const merged = mergeFacts(companyId, factGroups);
    if (merged.length === 0) {
      // 1 件も事実が組めなかった。外部要因が特定できていればそれを、
      // 特定できなければ「使える値が無かった」として非 retryable で確定させる。
      const errorCode: CompanyEnrichmentErrorCode = externalFailure ?? 'EXTRACTION_REJECTED';
      await deps.failJob({ jobId: claim.jobId, attemptToken, errorCode });
      emit(deps, { stage: 'terminal', outcome: 'failed' });
      return { kind: 'failed', companyId, errorCode };
    }

    const sourceIdByUrl = await deps.insertSources(companyId, sources);
    const factsWritten = await deps.insertFacts(merged, sourceIdByUrl);
    emit(deps, { stage: 'persist', outcome: 'written', count: factsWritten });

    if (factsWritten === 0) {
      const errorCode: CompanyEnrichmentErrorCode = 'TRANSIENT_DB';
      await deps.failJob({ jobId: claim.jobId, attemptToken, errorCode });
      return { kind: 'failed', companyId, errorCode };
    }

    // ── Stage 6: terminal ────────────────────────────────────────────
    // 対象 group をすべて満たしたか（部分成功を completed と偽らない）。
    // ★ 判定は **今回の refresh scope** に対して行う。fresh だったので取りに行かなかった
    //   group を「欠けている」とは数えない（正しい scoped refresh を partial と偽らない）。
    const writtenGroups = new Set(merged.map((f) => f.factGroup));
    const complete = targetGroups.every((g) => writtenGroups.has(g));
    const status: 'completed' | 'partial' = complete && !externalFailure ? 'completed' : 'partial';
    const errorCode = status === 'partial' ? (externalFailure ?? 'PARTIAL_RESULT') : null;

    await deps.finishJob({
      jobId: claim.jobId,
      attemptToken,
      status,
      factsWritten,
      sourcesWritten: sourceIdByUrl.size,
      errorCode,
    });
    emit(deps, { stage: 'terminal', outcome: status, count: factsWritten });

    return {
      kind: 'written',
      companyId,
      status,
      factsWritten,
      sourcesWritten: sourceIdByUrl.size,
      errorCode,
    };
  } catch (err) {
    // ★ background task なので絶対に throw しない。DDL 未適用もここへ落ちる。
    const reason =
      err && typeof err === 'object' && (err as { reason?: unknown }).reason === 'UNDEFINED_TABLE'
        ? 'not_provisioned'
        : 'no_company';
    emit(deps, { stage: 'terminal', outcome: `aborted_${reason}` });
    return { kind: 'skipped', reason: reason as 'not_provisioned' | 'no_company' };
  }
}
