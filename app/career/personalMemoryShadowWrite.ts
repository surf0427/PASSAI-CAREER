'use client';

// PASSAI CAREER — Personal Memory shadow-write の app 層 wiring（P16-D）。
//
// 責務: flag ON かつ save 直後に、localStorage canonical から現 Source を読み、section builder で
//   決定的 payload を作り、lib coordinator（coordinateShadowWrite）へ best-effort で渡す。
//   **load + build は app 層（本ファイル）** の責務（lib→app 依存を作らないため）。coordinator（lib）は
//   flag/session/store/compare-and-set/write を担う。
//
// 厳守:
//   - すべて void / never-throw / fire-and-forget（Source 保存・UI・画面遷移・AI response の成功条件にしない）。
//   - flag OFF なら **即 return（追加処理ゼロ）**＝localStorage load も coordinator 呼び出しもしない。
//   - Memory read（prompt 用）はしない。Event Signal / Event Log を触らない。prompt を生成しない。
//   - 氏名/mail/phone・transcript・ES 本文全文は builder の projection で payload に載らない（型で担保）。

import { buildCareerAiContext } from '@/lib/careerAi';
import { isCareerPersonalMemoryShadowWriteEnabled } from '@/lib/careerMemory/persistence/shadowWriteFlag';
import { coordinateShadowWrite } from '@/lib/careerMemory/persistence/productionShadowWriter';
import { resolveCanaryEligibility } from '@/lib/careerMemory/persistence/canaryEligibilityClient';
import type { CareerPersonalMemorySectionKey } from '@/lib/careerMemory/persistence/schema';
import {
  buildBaseMemorySection,
  buildSelfAnalysisMemorySection,
  buildEsMemorySection,
  buildInterviewMemorySection,
  type SectionRebuildResult,
} from '@/lib/careerMemory/persistence/rebuild';
// localStorage canonical loaders（既存・guarded）。
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { loadActivityData } from '@/app/career/activity/activityStorage';
import { loadCareerValues } from '@/app/career/values/careerValuesStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import { loadEsLogs } from '@/app/career/es/esStorage';
import { loadInterviewResults } from '@/app/career/interview/interviewStorage';

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// P16-G: shadow write の二重 gate 用の注入可能依存（QA では fake を差し替える）。
//   write 条件 = master flag ON AND canary eligible（allowlisted member × allowed section）。
//   ★ Source load（loadAndBuild）は eligibility allow の後でのみ呼ぶ（deny 時は load しない）。
export type ShadowWriteGateDeps = {
  isEnabled: () => boolean;
  resolveEligibility: (section: CareerPersonalMemorySectionKey) => Promise<boolean>;
  loadAndBuild: () => SectionRebuildResult;
  coordinate: (built: SectionRebuildResult) => Promise<unknown>;
};

// gated pipeline（awaitable・never-throw）。順序: eligibility → Source load+build → compare-and-set。
//   eligibility deny 時は loadAndBuild / coordinate を呼ばない（Source load ゼロ）。
export async function runGatedShadowWrite(
  section: CareerPersonalMemorySectionKey,
  deps: ShadowWriteGateDeps,
): Promise<void> {
  try {
    const eligible = await deps.resolveEligibility(section);
    if (!eligible) return; // deny → Source load も write もしない
    const built = deps.loadAndBuild();
    await deps.coordinate(built);
  } catch {
    /* never-throw */
  }
}

// ── 実依存（section 別。real coordinator / real eligibility / real loaders） ──
const realBaseDeps: ShadowWriteGateDeps = {
  isEnabled: isCareerPersonalMemoryShadowWriteEnabled,
  resolveEligibility: resolveCanaryEligibility,
  loadAndBuild: () => {
    const profile = safe(() => loadBasicInfo(), null);
    const activity = safe(() => loadActivityData(), null);
    const values = safe(() => loadCareerValues(), null);
    // 氏名等 PII を落とした CareerProfileContext を得るために共通基盤の normalizer を使う（.profile のみ利用）。
    const ctx = buildCareerAiContext({
      featureKey: 'career-consultation',
      profile,
      activity,
      values,
      userInput: '',
    });
    return buildBaseMemorySection(ctx.profile, activity, values);
  },
  coordinate: coordinateShadowWrite,
};
const realSelfAnalysisDeps: ShadowWriteGateDeps = {
  isEnabled: isCareerPersonalMemoryShadowWriteEnabled,
  resolveEligibility: resolveCanaryEligibility,
  loadAndBuild: () => buildSelfAnalysisMemorySection(safe(() => loadSelfAnalysisLogs(), [])),
  coordinate: coordinateShadowWrite,
};
const realEsDeps: ShadowWriteGateDeps = {
  isEnabled: isCareerPersonalMemoryShadowWriteEnabled,
  resolveEligibility: resolveCanaryEligibility,
  loadAndBuild: () => buildEsMemorySection(safe(() => loadEsLogs(), [])),
  coordinate: coordinateShadowWrite,
};
const realInterviewDeps: ShadowWriteGateDeps = {
  isEnabled: isCareerPersonalMemoryShadowWriteEnabled,
  resolveEligibility: resolveCanaryEligibility,
  loadAndBuild: () => buildInterviewMemorySection(safe(() => loadInterviewResults(), [])),
  coordinate: coordinateShadowWrite,
};

// master flag OFF なら **同期 return**（追加処理ゼロ＝eligibility API も呼ばない）。ON なら gated pipeline を fire-and-forget。
function dispatchGated(section: CareerPersonalMemorySectionKey, deps: ShadowWriteGateDeps): void {
  if (!deps.isEnabled()) return; // flag OFF → 追加処理ゼロ（resolver 0 回・Source load 0）
  void runGatedShadowWrite(section, deps);
}

// base: profile / activity / values のいずれか保存後に、現在の 3 Source を再取得して再構築する。
export function shadowWriteBaseMemory(deps: ShadowWriteGateDeps = realBaseDeps): void {
  dispatchGated('base', deps);
}

// self_analysis: 完成 result の canonical ログ保存後に、全 self-analysis ログから再構築する。
export function shadowWriteSelfAnalysisMemory(deps: ShadowWriteGateDeps = realSelfAnalysisDeps): void {
  dispatchGated('self_analysis', deps);
}

// es: canonical ES ログ保存後に、全 ES ログから再構築する。
export function shadowWriteEsMemory(deps: ShadowWriteGateDeps = realEsDeps): void {
  dispatchGated('es', deps);
}

// interview: 完成 result の canonical 保存後に、全 interview 結果から再構築する。
export function shadowWriteInterviewMemory(deps: ShadowWriteGateDeps = realInterviewDeps): void {
  dispatchGated('interview', deps);
}
