# Self-Analysis model benchmark (manual, spends real API budget)

Controlled A/B harness for deciding which model generates the Self-Analysis
summary. Isolates **model** — same fixtures, same `buildSelfAnalysisMessages()`
output, same `max_tokens`, same temperature policy (0.5 then 0 on parse retry),
same parse/normalize/validate path as production.

**These scripts call the real Anthropic API and cost money. They are NOT part of
`qa:*` and must never run in CI.**

| file | purpose |
| --- | --- |
| `fixtures.ts` | LIGHT / NORMAL / HEAVY synthetic personas, shaped to the real `BasicInfo` / `CareerActivity` / `CareerValues` types. No real user data. |
| `ab.ts` | Interleaved, counterbalanced A/B runner. Records latency, tokens, throughput, stop_reason, schema validity, key/type checks, empty fields, duplicates and output-cap violations per run. |
| `judge-ab.ts` | Blind pairwise quality judge (`claude-opus-5`). Sees content only — no model names, latency, or cost. Runs both presentation orders to cancel position bias. |
| `anchors.ts` | Deterministic genericness metric: share of output items citing a user-specific fact from the fixture. Judge-independent. |

## Arms

`ab.ts` exposes three arms via `AB_ARMS` (default `sonnet,haiku`):

- `sonnet` — production config: `claude-sonnet-4-6`, `thinking:disabled`, `effort:'low'`
- `haiku` — `claude-haiku-4-5`, `thinking:disabled`, **no `effort`**
- `sonnet_noeffort` — control: Sonnet with `effort` removed, parameter-matched to Haiku

> **Haiku 4.5 does not support `output_config.effort`** — it returns
> `400 "This model does not support the effort parameter."`, and the Models API
> reports `effort.supported=false`. Sonnet-vs-Haiku is therefore not fully
> parameter-matched; run `sonnet_noeffort` to isolate the model cleanly.

## Usage

```sh
set -a; . ./.env.local; set +a
AB_RUNS=3 AB_OUT=/tmp/ab.json \
  npx tsx --tsconfig tsconfig.realtime-test.json scripts/selfAnalysisModelBenchmark/ab.ts

AB_RUNS=3 AB_ARMS=sonnet_noeffort AB_OUT=/tmp/ab_ctrl.json \
  npx tsx --tsconfig tsconfig.realtime-test.json scripts/selfAnalysisModelBenchmark/ab.ts

npx tsx --tsconfig tsconfig.realtime-test.json scripts/selfAnalysisModelBenchmark/anchors.ts /tmp/ab.json
JUDGE_OUT=/tmp/judge.json \
  npx tsx --tsconfig tsconfig.realtime-test.json scripts/selfAnalysisModelBenchmark/judge-ab.ts /tmp/ab.json
```

## Result of the 2026-08-15 run (Sonnet 4.6 vs Haiku 4.5)

Haiku is ~2x faster per token and 24–36% faster wall-clock, but generates
~13–29% more output, truncated 1/3 HEAVY runs at `max_tokens` (a non-retryable
`OUTPUT_TRUNCATED`), and lost 15 of 16 blind quality comparisons
(overall 4.16 vs 4.76; grounding 4.06 vs 5.00; 2.5x more unsupported claims).
**Decision: keep Sonnet 4.6.**
