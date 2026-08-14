// PASSAI CAREER — cross-feature source の per-source server/bridge マージ（Batch 2 / `D-S6`）。
//
// ★ 設計の核心:
//   既存の **pure selector**（`lib/careerMemory/selector.ts`）は「生 domain log → request payload」を
//   すでに完全に定義している（latest 選択 / history 件数上限 / truncate / dedup / fallback）。
//   Batch 2 はそれを **再実装しない**。同じ selector に、localStorage の代わりに
//   **検証済み Layer 1 の生 log を流し込む**だけにする。
//
//   これにより自動的に成立するもの:
//     - history / latest / cap / compaction の意味論が完全に保存される（同一コード）
//     - context budget が変わらない（同一コード）
//     - payload が **1 つだけ**組み立てられるので、**重複注入が構造的に起きない**
//
// ★ per-source マージ:
//   source kind ごとに `verified` なら server の生 log を、そうでなければ bridge（request body）
//   由来の値を選ぶ。選んだ結果を **1 回だけ** selector へ渡す。
//   → `matching` だけ mismatch なら matching だけ bridge、他は server（`D-S1` の section isolation）。
//
// 厳守:
//   - server-only。userId は server auth 由来のみ。service role を使わない。
//   - never-throw / fail-open（判定不能なら bridge）。
//   - **同じ semantic block を server と bridge の両方から入れない**（selector 入力段で択一する）。

import 'server-only';

import type { CareerContextPurpose } from '@/lib/careerContext/purpose';
import { loadRequestSourceSnapshot } from '@/lib/careerSourceData/requestSnapshot.server';
import {
  EMPTY_CAREER_SOURCE_BUNDLE,
  emptySourceStatuses,
  type CareerSourceBundle,
  type CareerSourceKind,
  type CareerSourceReadOutcome,
  type CareerSourceReadStatus,
  requiresSourceSync,
} from '@/lib/careerSourceData/types';
import { computeSourceSyncRevisions } from '@/lib/careerSourceSync/revision';
import {
  isSourceUsable,
  verifySourceSync,
  EMPTY_SOURCE_SYNC_SIGNAL,
  type CareerSourceSyncSignal,
  type SourceSyncVerdict,
} from '@/lib/careerSourceSync/signal';
import { readSourceSyncSignal } from '@/lib/careerSourceSync/request.server';
import {
  isServerContextCanaryUser,
  isServerContextPurposeEnabled,
  type ServerContextCanaryConfig,
} from './canaryGate';
import { loadServerContextCanaryConfigFromEnv } from './canaryGate.server';

/** kind 別の採用元（観測用・PII なし）。 */
export type SourceOrigin = 'server' | 'bridge';

export type CrossFeatureSourceResult = {
  /** 検証済み server source（verified な kind のみ実データ。他は空）。 */
  bundle: CareerSourceBundle;
  /** kind → 採用元。'server' の kind だけ bundle の値を使ってよい。 */
  origin: Readonly<Record<CareerSourceKind, SourceOrigin>>;
  /** kind → sync verdict（観測用）。 */
  verdicts: Readonly<Record<CareerSourceKind, SourceSyncVerdict>> | null;
  /** kind → Layer 1 read status（base 判定が既存 policy をそのまま使うために持ち回る）。 */
  statuses: Readonly<Record<CareerSourceKind, CareerSourceReadStatus>>;
  /** purpose 全体の状態（観測用）。 */
  status:
    | 'purpose_disabled'
    | 'user_not_canary'
    | 'full_server'       // 要求 kind すべて server
    | 'partial_server'    // 一部 server / 一部 bridge
    | 'bridge_fallback';  // すべて bridge
};

export type CrossFeatureSourceDeps = {
  loadCanaryConfig: () => ServerContextCanaryConfig;
  /**
   * `req` は **request-local snapshot の key**（`D-S13`）。同じ request 内で
   * Personal Memory resolver が同じ kind を再度読まないようにするために渡す。
   */
  loadSources: (
    kinds: readonly CareerSourceKind[],
    authorize?: (userId: string) => boolean,
    req?: Request,
  ) => Promise<CareerSourceReadOutcome>;
};

const realDeps: CrossFeatureSourceDeps = {
  loadCanaryConfig: loadServerContextCanaryConfigFromEnv,
  loadSources: (kinds, authorize, req) => loadRequestSourceSnapshot(kinds, req, authorize),
};

function allBridge(
  status: CrossFeatureSourceResult['status'],
  verdicts: CrossFeatureSourceResult['verdicts'] = null,
): CrossFeatureSourceResult {
  const origin = {} as Record<CareerSourceKind, SourceOrigin>;
  for (const k of Object.keys(emptySourceStatuses()) as CareerSourceKind[]) origin[k] = 'bridge';
  return { bundle: EMPTY_CAREER_SOURCE_BUNDLE, origin, verdicts, statuses: emptySourceStatuses(), status };
}

/**
 * 要求 kind を canary gate + Source-Sync 越しに解決する（never-throw・fail-open）。
 *
 * gate:
 *   purpose opt-in AND canary user AND （kind 単位で）Source-Sync verified
 *
 * purpose 未 opt-in → **I/O ゼロ**。canary 対象外 → auth のみで **table read ゼロ**。
 */
export async function loadVerifiedCrossFeatureSources(
  purpose: CareerContextPurpose,
  kinds: readonly CareerSourceKind[],
  req?: Request,
  deps: CrossFeatureSourceDeps = realDeps,
): Promise<CrossFeatureSourceResult> {
  try {
    if (kinds.length === 0) return allBridge('bridge_fallback');
    const canary = deps.loadCanaryConfig();
    if (!isServerContextPurposeEnabled(purpose, canary)) return allBridge('purpose_disabled');

    const outcome = await deps.loadSources(
      kinds,
      (userId) => isServerContextCanaryUser(userId, canary),
      req,
    );
    if (outcome.meta.outcome === 'unauthorized') return allBridge('user_not_canary');

    const signal: CareerSourceSyncSignal = req
      ? readSourceSyncSignal(req)
      : EMPTY_SOURCE_SYNC_SIGNAL;
    // Source-Sync は **Class 1 の kind だけ**に対して評価する
    //   （Class 2 に claim を要求すると永久 mismatch になり機能が無効化される）。
    const syncKinds = kinds.filter((k) => requiresSourceSync(k));
    const verdicts = verifySourceSync(
      signal,
      computeSourceSyncRevisions(outcome.bundle, syncKinds),
      outcome.meta.statuses,
    );

    // kind 単位で採用元を決める。
    //
    // ★ authority class で判定が分かれる（`D-S10`）:
    //   - Class 1（device-canonical + mirrored）: Source-Sync verified のときだけ server。
    //   - Class 2（server-authoritative / gd_room）: **client claim を要求しない**。
    //     server が著者なのだから client cache との一致を求めるのは意味が無く、
    //     求めると「client の cache が古い ⟹ 正しい server データを使えない」という
    //     逆向きの誤りになる。read が権威的（status='ok'）であることだけを条件にする。
    //     ※ authorization は免除されない（purpose gate + canary gate + owner-scoped RLS は同じ）。
    const origin = {} as Record<CareerSourceKind, SourceOrigin>;
    let serverCount = 0;
    for (const k of Object.keys(emptySourceStatuses()) as CareerSourceKind[]) {
      const wanted = kinds.includes(k);
      const usable = requiresSourceSync(k)
        ? isSourceUsable(verdicts[k])
        : outcome.meta.statuses[k] === 'ok';
      const ok = wanted && usable;
      origin[k] = ok ? 'server' : 'bridge';
      if (ok) serverCount += 1;
    }

    const status: CrossFeatureSourceResult['status'] =
      serverCount === 0
        ? 'bridge_fallback'
        : serverCount === kinds.length
          ? 'full_server'
          : 'partial_server';

    return { bundle: outcome.bundle, origin, verdicts, statuses: outcome.meta.statuses, status };
  } catch {
    return allBridge('bridge_fallback');
  }
}

/** verified な kind だけ server 値を残し、他は空にした bundle（selector へ渡す安全形）。 */
export function serverOnlyBundle(result: CrossFeatureSourceResult): CareerSourceBundle {
  const b = result.bundle;
  const o = result.origin;
  return {
    profile: o.profile === 'server' ? b.profile : null,
    activity: o.activity === 'server' ? b.activity : null,
    values: o.values === 'server' ? b.values : null,
    selfAnalysisLogs: o.self_analysis === 'server' ? b.selfAnalysisLogs : [],
    esLogs: o.es === 'server' ? b.esLogs : [],
    interviewResults: o.interview === 'server' ? b.interviewResults : [],
    matchingLogs: o.matching === 'server' ? b.matchingLogs : [],
    companyResearchLogs: o.company_research === 'server' ? b.companyResearchLogs : [],
    presentationResults: o.presentation === 'server' ? b.presentationResults : [],
    consultationThreads: o.consultation === 'server' ? b.consultationThreads : [],
    gdRoomLogs: o.gd_room === 'server' ? b.gdRoomLogs : [],
  };
}
