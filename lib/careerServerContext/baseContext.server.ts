// PASSAI CAREER — server-driven base context loader（NEXT-6 / Data Spine bridge retirement）。
//
// ★ 配置理由: 本 module は **通電済み** の Layer 1 server loader である。
//   lib/careerContextLoaders/ は P17-A の「常に disabled を返す fail-closed scaffold」置き場であり、
//   静的 guard が「production から import 0」を強制している。live loader を同居させると
//   その guard の意味が壊れるため、live 側は本 directory（lib/careerServerContext）に置く。
//
// 責務: purpose が opt-in 済みなら、profile / activity / values を **Layer 1 から server 側で読み**、
//   request body 由来の bridge context を置き換える。opt-in していない purpose・読めない・空 の場合は
//   `null` を返し、route は従来どおり request body を使う（出力 byte 完全互換）。
//
// 厳守:
//   - server-only。service role を使わない（owner-scoped RLS のみ）。userId は server auth 由来。
//   - never-throw / fail-open。どんな失敗でも null（＝従来経路）へ倒す。
//   - 本文 / PII / UUID / env を log しない。
//   - Layer 1 read は careerSourceData の単一 reader を再利用（別 client を作らない）。

import 'server-only';

import type { CareerContextPurpose } from '@/lib/careerContext/purpose';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import { loadCareerSourceData } from '@/lib/careerSourceData/serverReader.server';
import type { CareerSourceKind, CareerSourceReadOutcome } from '@/lib/careerSourceData/types';
// D-R2 closure: client canonical と mirror の一致検証（veto 専用・client 申告ベース）。
import { computeSourceSyncRevisions } from '@/lib/careerSourceSync/revision';
import {
  allSourcesVerified,
  verifySourceSync,
  EMPTY_SOURCE_SYNC_SIGNAL,
  type CareerSourceSyncSignal,
} from '@/lib/careerSourceSync/signal';
import {
  BASE_CONTEXT_SOURCE_KINDS,
  decideBaseContextSource,
  isServerContextEnabledForPurpose,
  parseServerContextPurposes,
  type BaseContextDecisionReason,
} from './baseContextPolicy';

export const CAREER_SERVER_CONTEXT_PURPOSES_ENV = 'CAREER_SERVER_CONTEXT_PURPOSES';

// route が request body の代わりに使う base 入力（Orchestrator へ渡す形と 1:1）。
export type ServerBaseContext = {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
};

export type ServerBaseContextResult = {
  // null なら「従来どおり request body を使う」。
  context: ServerBaseContext | null;
  reason: BaseContextDecisionReason;
};

export type ServerBaseContextDeps = {
  enabledPurposes: () => CareerContextPurpose[];
  loadSources: (kinds: readonly CareerSourceKind[]) => Promise<CareerSourceReadOutcome>;
};

const realDeps: ServerBaseContextDeps = {
  enabledPurposes: () => parseServerContextPurposes(process.env[CAREER_SERVER_CONTEXT_PURPOSES_ENV]),
  loadSources: (kinds) => loadCareerSourceData(kinds),
};

// 「実データがあるか」の判定（3 Source すべて空なら request body へ fallback）。
function hasAnyData(outcome: CareerSourceReadOutcome): boolean {
  const { profile, activity, values } = outcome.bundle;
  if (profile && Object.keys(profile).length > 0) return true;
  if (activity && Object.keys(activity).length > 0) return true;
  if (values) return true;
  return false;
}

/**
 * purpose 別に server-driven base context を解決する（never-throw・fail-open）。
 * opt-in していない purpose では **I/O ゼロ**（Source read もしない）。
 *
 * ★ D-R2: `syncSignal` 未指定（= claim なし）なら server Source を採用しない。
 *   fallback 先は request body bridge なので、product 出力は従来どおり。
 */
export async function loadServerBaseContext(
  purpose: CareerContextPurpose,
  syncSignal: CareerSourceSyncSignal = EMPTY_SOURCE_SYNC_SIGNAL,
  deps: ServerBaseContextDeps = realDeps,
): Promise<ServerBaseContextResult> {
  try {
    const enabled = isServerContextEnabledForPurpose(purpose, deps.enabledPurposes());
    if (!enabled) return { context: null, reason: 'flag_off' };

    const outcome = await deps.loadSources(BASE_CONTEXT_SOURCE_KINDS);
    // client 申告 canonical == mirror を検証できたか（3 Source すべて）。
    const verification = verifySourceSync(
      syncSignal,
      computeSourceSyncRevisions(outcome.bundle, BASE_CONTEXT_SOURCE_KINDS),
      outcome.meta.statuses,
    );
    const decision = decideBaseContextSource(
      true,
      outcome.meta.statuses,
      hasAnyData(outcome),
      allSourcesVerified(verification, BASE_CONTEXT_SOURCE_KINDS),
    );
    if (!decision.useServerSource) return { context: null, reason: decision.reason };

    return {
      context: {
        profile: (outcome.bundle.profile as CareerProfileInput | null) ?? null,
        activity: (outcome.bundle.activity as CareerActivityInput | null) ?? null,
        values: (outcome.bundle.values as CareerValuesInput | null) ?? null,
      },
      reason: decision.reason,
    };
  } catch {
    return { context: null, reason: 'source_unavailable' };
  }
}
