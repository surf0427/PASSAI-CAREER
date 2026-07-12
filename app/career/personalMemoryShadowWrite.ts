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
import {
  buildBaseMemorySection,
  buildSelfAnalysisMemorySection,
  buildEsMemorySection,
  buildInterviewMemorySection,
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

// base: profile / activity / values のいずれか保存後に、現在の 3 Source を再取得して再構築する。
export function shadowWriteBaseMemory(): void {
  if (!isCareerPersonalMemoryShadowWriteEnabled()) return; // flag OFF → 追加処理ゼロ
  void (async () => {
    try {
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
      const built = buildBaseMemorySection(ctx.profile, activity, values);
      await coordinateShadowWrite(built);
    } catch {
      /* never-throw */
    }
  })();
}

// self_analysis: 完成 result の canonical ログ保存後に、全 self-analysis ログから再構築する。
export function shadowWriteSelfAnalysisMemory(): void {
  if (!isCareerPersonalMemoryShadowWriteEnabled()) return;
  void (async () => {
    try {
      const logs = safe(() => loadSelfAnalysisLogs(), []);
      await coordinateShadowWrite(buildSelfAnalysisMemorySection(logs));
    } catch {
      /* never-throw */
    }
  })();
}

// es: canonical ES ログ保存後に、全 ES ログから再構築する。
export function shadowWriteEsMemory(): void {
  if (!isCareerPersonalMemoryShadowWriteEnabled()) return;
  void (async () => {
    try {
      const logs = safe(() => loadEsLogs(), []);
      await coordinateShadowWrite(buildEsMemorySection(logs));
    } catch {
      /* never-throw */
    }
  })();
}

// interview: 完成 result の canonical 保存後に、全 interview 結果から再構築する。
export function shadowWriteInterviewMemory(): void {
  if (!isCareerPersonalMemoryShadowWriteEnabled()) return;
  void (async () => {
    try {
      const results = safe(() => loadInterviewResults(), []);
      await coordinateShadowWrite(buildInterviewMemorySection(results));
    } catch {
      /* never-throw */
    }
  })();
}
