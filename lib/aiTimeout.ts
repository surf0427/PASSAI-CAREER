// Anthropic messages.create() を timeout 制御で安全に呼び出すための minimal helper。
// STEP-API-TIMEOUT-01 で導入。orphan 課金（client 離脱後も AI 課金が走る現象）を防ぐ。
//
// 設計意図:
//   - SDK の RequestOptions.signal 経由で abort できるため、内部 fetch / streaming にも適用される
//   - 既存の logAiUsage / parse 経路は変えない。timeout 発生は上流 catch で AbortError として捕捉
//   - 過度な抽象化を避け、3 export のみに絞る
//   - cache identity / prompt 文言 / PROMPT_VERSION / system 引数は本 helper の対象外
//
// 使い方:
//   await anthropic.messages.create(
//     { model, max_tokens, system, messages, ... },
//     { signal: createTimeoutSignal() },
//   )
//
// 関連: lib/ai.ts（anthropic singleton）

// AI API call の default timeout（60 秒）。
// 通常 Sonnet 4-6 で max_tokens 2000 程度なら 20 秒未満で返るため、60 秒は cold start や
// 混雑時を含めても十分な余裕がある上限。
// Opus / 大型 max_tokens の route だけ呼び出し側で個別 ms を渡して延長する設計。
export const DEFAULT_AI_TIMEOUT_MS = 60_000;

// 指定 ms 経過で abort する AbortSignal を作る。
// Node 18+ なら AbortSignal.timeout(ms) が利用可能。
// 古い環境向けには AbortController + setTimeout に fallback。unref で event loop を hold しない。
export function createTimeoutSignal(ms: number = DEFAULT_AI_TIMEOUT_MS): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // timer が server lifecycle を引き止めないように unref する（Node 環境のみ）。
  (timer as unknown as { unref?: () => void }).unref?.();
  return controller.signal;
}

// ── retry 予算（STEP-API-TIMEOUT-02）─────────────────────────────────
//
// 背景（bf6d0e5 と同じ不具合クラス。当時 3 route だけ route-local に修正されていた）:
//   parse 失敗の再生成 retry を持つ route は attempt ごとに **満額の** timeout signal を
//   新規発行していた。したがって server 側の worst case は「per-call × attempt 数」であり、
//   それを囲む上位の境界（Vercel maxDuration / client の AbortController）はいずれも
//   **1 attempt 分の値**を前提に設計されていた。retry が走った瞬間に上位境界が先に切れ、
//   ユーザーには JSON エラーではなく 504 や "Load failed" 相当の汎用失敗が見える。
//
// 対策: 「1 request で AI に使ってよい合計 wall-clock」を予算として持ち、各 attempt の
//   timeout を残予算から導出する。残予算が retry に足りなければ retry せず打ち切る
//   （＝上位境界を超える前に、意味のあるエラーを自分で返す）。
//
// これは timeout の延長ではない。worst case を「per-call × attempt 数」から
// 「totalBudgetMs」へ**縮める**ための制約であり、既存の per-call 値は変えない。
export interface AiCallBudgetOptions {
  /** 1 request で AI 呼び出しに使ってよい合計 ms。囲む境界（wall / client）より内側に取る。 */
  totalBudgetMs: number;
  /** 1 回あたりの上限 ms。残予算がこれを下回ればその小さい方を使う。 */
  perCallTimeoutMs?: number;
  /** retry（2 回目以降）を発火するのに必要な最低残予算 ms。下回れば retry しない。 */
  minRetryBudgetMs?: number;
  /** 時刻源（QA で fake clock を注入する）。 */
  now?: () => number;
}

export interface AiCallBudget {
  /**
   * 次の attempt に与える timeout ms。retry するだけの残予算が無ければ null。
   * null を受けた呼び出し側は **retry せず**、そこまでの失敗理由で応答を返すこと。
   */
  nextCallTimeoutMs(): number | null;
  /** 予算生成からの経過 ms（観測ログ用）。 */
  elapsedMs(): number;
}

export function createAiCallBudget(options: AiCallBudgetOptions): AiCallBudget {
  const now = options.now ?? (() => Date.now());
  const perCall = options.perCallTimeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  const minRetry = options.minRetryBudgetMs ?? 30_000;
  const startedAt = now();
  let calls = 0;

  const elapsedMs = () => now() - startedAt;

  return {
    elapsedMs,
    nextCallTimeoutMs(): number | null {
      const remaining = options.totalBudgetMs - elapsedMs();
      // 初回は予算が残っている限り必ず試す（minRetry は retry のみに効く gate）。
      if (calls === 0) {
        if (remaining <= 0) return null;
        calls += 1;
        return Math.min(perCall, remaining);
      }
      // retry: 中途半端な残時間で再生成を始めて上位境界を超えるより、ここで打ち切る。
      if (remaining < minRetry) return null;
      calls += 1;
      return Math.min(perCall, remaining);
    },
  };
}

/**
 * `export const maxDuration = 80` の route 用の標準予算。
 * 値は bf6d0e5 が matching / presentation-evaluate / gd-feedback に route-local で導入した
 * TOTAL 74s / PER_CALL 60s / MIN_RETRY 30s と同一（wall 80s に対し 6s の余白）。
 * 同じ 3 値を route ごとに再宣言するとドリフトするため、ここを単一の出所にする。
 */
export const AI_BUDGET_PRESET_80S_WALL = {
  totalBudgetMs: 74_000,
  perCallTimeoutMs: 60_000,
  minRetryBudgetMs: 30_000,
} as const;

// catch ブロックで「これは timeout / abort か？」を判定するための narrow guard。
// Anthropic SDK は abort 経路で `AbortError` を投げる（fetch ベースの実装に従う）。
// timeout 発生時の logAiUsage は既存どおり status: 'failed' で記録する方針のため、
// 本 helper を使った特別分岐は必須ではない。abort と他エラーを区別したい route がある時に使う。
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; message?: unknown };
  return (
    e.name === 'AbortError' ||
    e.name === 'TimeoutError' ||
    (typeof e.message === 'string' && /aborted|timed out/i.test(e.message))
  );
}
