// 自己分析まとめ生成 — background attempt（Step2）。
//
// 役割: atomic claim 済みの job に対し、同一 bounded invocation 内で
//   after()/waitUntil() から起動される生成本体。provider 呼び出し → parse →
//   schema validation → **fenced complete / fenced fail** までを担う。
//
// 厳守:
//   - 渡される値は認証・validation 完了後の immutable な値に限定（Request/cookie/
//     client 指定 user・key は渡さない — 呼び出し側の責務）。
//   - raw provider error / raw response / input 本文 を DB 引数・log・error_code に載せない。
//   - retryable/non-retryable いずれでも現 attempt_token で fenced fail を試行する。
//     applied=false は lease を失った旧 attempt＝上書きしない。
//   - provider deadline は Function deadline より十分手前。finalization reserve を残す。
//     Function 強制終了時は running のまま残し lease reclaim で回復（completed へ勝手に変えない）。

import { extractJson } from '@/lib/ai';
import type {
  GenerationJobCompleteArgs,
  GenerationJobFailArgs,
  GenerationJobUpdateResult,
} from '@/lib/careerGenerationJob/types';
import type { GenerationJobErrorCode } from '@/lib/careerGenerationJob/constants';
import { PROVIDER_DEADLINE_MS } from '@/lib/careerGenerationJob/constants';
import { GenerationJobStorageError } from '@/lib/careerGenerationJob/errors';
import {
  buildSelfAnalysisMessages,
  hasMeaningfulResult,
  normalizeResult,
  type SelfAnalysisSummaryInput,
} from './summaryPrompt';
import {
  classifyProviderError,
  type SelfAnalysisProvider,
} from './summaryProvider';

/** background attempt の安全な観測イベント（PII/本文なし）。 */
export interface AttemptLogEvent {
  stage: 'complete' | 'fail';
  errorCode?: GenerationJobErrorCode;
  applied: boolean;
  providerDurationMs: number | null;
  totalDurationMs: number;
}

export interface RunAttemptDeps {
  provider: SelfAnalysisProvider;
  completeJob: (args: GenerationJobCompleteArgs) => Promise<GenerationJobUpdateResult>;
  failJob: (args: GenerationJobFailArgs) => Promise<GenerationJobUpdateResult>;
  /** ms 経過で abort する signal を作る（実装は AbortSignal.timeout）。 */
  createSignal: (ms: number) => AbortSignal;
  /** 単調増加のミリ秒時刻（Date.now を注入）。 */
  now: () => number;
  /** 安全な観測ログ（no-op 可）。 */
  log?: (event: AttemptLogEvent) => void;
}

export interface RunAttemptParams {
  userId: string;
  jobId: string;
  attemptToken: string;
  validatedInput: SelfAnalysisSummaryInput;
}

// storage/unknown 例外 → 固定 allowlist（DB 由来は TRANSIENT_DB＝retryable）。
function classifyFinalizeError(error: unknown): GenerationJobErrorCode {
  if (error instanceof GenerationJobStorageError) return 'TRANSIENT_DB';
  return 'TRANSIENT_DB';
}

/**
 * background 生成の本体。例外を外へ投げず、必ず DB terminal state 更新を試みる。
 * 返り値なし（結果は DB へ fenced 保存）。
 */
export async function runSelfAnalysisGenerationAttempt(
  deps: RunAttemptDeps,
  params: RunAttemptParams,
): Promise<void> {
  const startedAt = deps.now();
  const { system, user } = buildSelfAnalysisMessages(params.validatedInput);

  let providerDurationMs: number | null = null;

  const finalizeFail = async (errorCode: GenerationJobErrorCode): Promise<void> => {
    const totalDurationMs = deps.now() - startedAt;
    try {
      const res = await deps.failJob({
        userId: params.userId,
        jobId: params.jobId,
        attemptToken: params.attemptToken,
        errorCode,
        providerDurationMs,
        totalDurationMs,
      });
      deps.log?.({ stage: 'fail', errorCode, applied: res.applied, providerDurationMs, totalDurationMs });
    } catch {
      // fenced fail 自体の失敗は握りつぶす（running のまま lease reclaim で回復）。
    }
  };

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成（legacy と同方針・同一 attempt 内）。
    let result: ReturnType<typeof normalizeResult> | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const p0 = deps.now();
      let res;
      try {
        res = await deps.provider.generate({
          system,
          user,
          temperature: attempt === 2 ? 0 : 0.5,
          signal: deps.createSignal(PROVIDER_DEADLINE_MS),
        });
      } catch (error) {
        providerDurationMs = deps.now() - p0;
        await finalizeFail(classifyProviderError(error));
        return;
      }
      providerDurationMs = deps.now() - p0;

      // max_tokens 到達の途中切れは長さ起因＝非 retryable。
      if (res.stopReason === 'max_tokens') {
        await finalizeFail('OUTPUT_TRUNCATED');
        return;
      }

      try {
        result = normalizeResult(JSON.parse(extractJson(res.text)));
        break;
      } catch {
        if (attempt === 1) continue;
        await finalizeFail('PARSE_FAILED');
        return;
      }
    }

    if (!result) {
      await finalizeFail('PARSE_FAILED');
      return;
    }

    // 空同然の出力を正式結果にしない。
    if (!hasMeaningfulResult(result)) {
      await finalizeFail('SCHEMA_VALIDATION_FAILED');
      return;
    }

    const totalDurationMs = deps.now() - startedAt;
    const res = await deps.completeJob({
      userId: params.userId,
      jobId: params.jobId,
      attemptToken: params.attemptToken,
      result,
      providerDurationMs,
      totalDurationMs,
    });
    deps.log?.({ stage: 'complete', applied: res.applied, providerDurationMs, totalDurationMs });
  } catch (error) {
    // 想定外（例: completeJob の DB 例外）。現 attempt_token で fenced fail を試行。
    await finalizeFail(classifyFinalizeError(error));
  }
}
