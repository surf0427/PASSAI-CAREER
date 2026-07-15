// 自己分析まとめ生成 — provider 抽象（Step2）。
//
// job attempt から Claude 呼び出しを DI 可能にするための最小境界。
// QA は fake provider を注入し、外部 Claude API を実行せずに検証する。
//
// error 分類は **固定 allowlist の error_code のみ** を返す。raw provider message /
// raw response は返さない・保存しない（呼び出し側もそれを DB/log に載せない）。

import { anthropic } from '@/lib/ai';
import { isAbortError } from '@/lib/aiTimeout';
import type { GenerationJobErrorCode } from '@/lib/careerGenerationJob/constants';
import { SELF_ANALYSIS_MODEL } from '@/lib/careerGenerationJob/constants';
import { SELF_ANALYSIS_MAX_TOKENS } from './summaryPrompt';

export interface ProviderGenerateArgs {
  system: string;
  user: string;
  temperature: number;
  signal: AbortSignal;
}

export interface ProviderResult {
  /** text ブロックの結合結果（無ければ空文字）。 */
  text: string;
  /** provider の停止理由（'max_tokens' 等）。 */
  stopReason: string | null;
}

export interface SelfAnalysisProvider {
  generate(args: ProviderGenerateArgs): Promise<ProviderResult>;
}

/** 実 Claude provider（route から注入）。timeout は signal（AbortSignal）で制御。 */
export const anthropicSelfAnalysisProvider: SelfAnalysisProvider = {
  async generate({ system, user, temperature, signal }) {
    const message = await anthropic.messages.create(
      {
        model: SELF_ANALYSIS_MODEL,
        max_tokens: SELF_ANALYSIS_MAX_TOKENS,
        temperature,
        system,
        messages: [{ role: 'user', content: user }],
      },
      { signal },
    );
    const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
    return { text, stopReason: message.stop_reason ?? null };
  },
};

/**
 * provider 例外を固定 allowlist error_code へ分類する。
 *   - abort/timeout → PROVIDER_TIMEOUT（retryable）
 *   - 429           → PROVIDER_RATE_LIMITED（retryable）
 *   - 5xx           → PROVIDER_5XX（retryable）
 *   - その他（fetch/network 等）→ NETWORK（retryable）
 * raw message は参照して分類のみに使い、返り値には含めない。
 */
export function classifyProviderError(error: unknown): GenerationJobErrorCode {
  if (isAbortError(error)) return 'PROVIDER_TIMEOUT';
  const status =
    error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : undefined;
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (typeof status === 'number' && status >= 500) return 'PROVIDER_5XX';
  return 'NETWORK';
}
