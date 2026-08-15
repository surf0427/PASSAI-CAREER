/*
 * Self-Analysis MODEL A/B — Sonnet 4.6 vs Haiku 4.5.
 *
 * Isolates exactly one variable: the model. Everything else is held identical —
 * same fixtures, same buildSelfAnalysisMessages() output, same max_tokens,
 * same temperature policy (0.5 then 0 on parse retry, mirroring
 * runSelfAnalysisGenerationAttempt), same parse + normalize + validate path.
 *
 * DOCUMENTED, UNAVOIDABLE PARAMETER DIFFERENCE:
 *   Haiku 4.5 rejects output_config.effort with HTTP 400
 *   ("This model does not support the effort parameter." — verified against the
 *   live API and the Models API, which reports effort.supported=false).
 *   Sonnet therefore runs WITH effort:'low' (its production setting) and Haiku
 *   runs WITHOUT it. Note the bias direction: effort:'low' damps Sonnet's output,
 *   so this asymmetry works AGAINST Haiku on latency, not for it.
 *   thinking:{type:'disabled'} is accepted by both and is applied to both.
 *
 * Execution order is INTERLEAVED and counterbalanced per profile (S,H,H,S,S,H)
 * to spread provider-load / time-of-day bias across arms.
 *
 * Writes nothing to Supabase and never touches the job table, so there is no
 * idempotency-key interaction with real jobs.
 *
 * Usage: npx tsx --tsconfig tsconfig.realtime-test.json scripts/_model_ab_tmp/ab.ts
 */

import { writeFileSync } from 'node:fs';

import { anthropic, extractJson } from '@/lib/ai';
import {
  buildSelfAnalysisMessages,
  normalizeResult,
  hasMeaningfulResult,
  SELF_ANALYSIS_MAX_TOKENS,
} from '@/lib/careerSelfAnalysis/summaryPrompt';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';

import { CASES } from './fixtures';

const RUNS = Number(process.env.AB_RUNS ?? '3');
const OUT = process.env.AB_OUT ?? '/tmp/ab.json';

type ArmId = 'sonnet' | 'haiku' | 'sonnet_noeffort';
type Arm = { id: ArmId; model: string; extra: Record<string, unknown> };

const ALL_ARMS: Arm[] = [
  {
    // Production config as shipped.
    id: 'sonnet',
    model: 'claude-sonnet-4-6',
    extra: { thinking: { type: 'disabled' }, output_config: { effort: 'low' } },
  },
  {
    id: 'haiku',
    model: 'claude-haiku-4-5',
    // no output_config: rejected with 400 by this model (see header).
    extra: { thinking: { type: 'disabled' } },
  },
  {
    // CONTROL ARM. Parameter-matched to Haiku (no effort) so that
    // sonnet_noeffort vs haiku isolates MODEL with zero parameter asymmetry.
    // Without this, any Sonnet-vs-Haiku difference is confounded by effort:'low'.
    id: 'sonnet_noeffort',
    model: 'claude-sonnet-4-6',
    extra: { thinking: { type: 'disabled' } },
  },
];

const ARMS: Arm[] = ALL_ARMS.filter(
  (a) => (process.env.AB_ARMS ?? 'sonnet,haiku').split(',').includes(a.id),
);

const ARRAY_FIELDS = [
  'strengths', 'weaknesses', 'gakuchikaIdeas', 'selfPrIdeas', 'esAngles',
  'interviewQuestions', 'nextActions', 'recommendedIndustries', 'recommendedJobs',
  'suitableEnvironment', 'valueKeywords', 'strengthKeywords', 'motivationSources',
  'stressFactors', 'companySelectionCriteria', 'developmentPoints',
] as const;

type Row = {
  orderIndex: number;
  arm: string;
  model: string;
  caseId: string;
  run: number;
  ok: boolean;
  errorKind: string | null;
  providerDurationMs: number;   // final (successful) provider call
  totalDurationMs: number;      // includes parse retry if any
  parseRetry: boolean;
  inputChars: number;
  inputTokens: number;
  outputChars: number;
  outputTokens: number;
  stopReason: string | null;
  truncated: boolean;
  schemaValid: boolean;
  meaningful: boolean;
  allKeysPresent: boolean;
  typesOk: boolean;
  emptyFields: string[];
  duplicateItems: number;
  oversizeItems: number;        // array items > 60 chars (nextActions allowed 120)
  arrayItemCount: number;
  totalResultChars: number;
  perFieldChars: Record<string, number>;
  perFieldCount: Record<string, number>;
  result?: CareerSelfAnalysisResult;
};

function analyse(r: CareerSelfAnalysisResult) {
  const perFieldChars: Record<string, number> = {};
  const perFieldCount: Record<string, number> = {};
  const empty: string[] = [];
  let arrayItemCount = 0;
  let duplicateItems = 0;
  let oversizeItems = 0;
  const seen = new Set<string>();

  perFieldChars.summary = r.summary.length;
  perFieldChars.careerDirection = r.careerDirection.length;
  if (!r.summary.trim()) empty.push('summary');
  if (!r.careerDirection.trim()) empty.push('careerDirection');

  for (const f of ARRAY_FIELDS) {
    const arr = r[f] as string[];
    perFieldCount[f] = arr.length;
    perFieldChars[f] = arr.join('').length;
    arrayItemCount += arr.length;
    if (arr.length === 0) empty.push(f);
    const limit = f === 'nextActions' ? 120 : f.endsWith('Keywords') ? 30 : 60;
    for (const item of arr) {
      const t = item.trim();
      if (t.length > limit) oversizeItems += 1;
      const k = `${f}::${t}`;
      if (seen.has(k)) duplicateItems += 1;
      seen.add(k);
    }
  }
  return {
    perFieldChars, perFieldCount, empty, arrayItemCount, duplicateItems, oversizeItems,
    totalResultChars: JSON.stringify(r).length,
  };
}

function typesOk(raw: unknown): { allKeys: boolean; types: boolean } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const scalars = ['summary', 'careerDirection'];
  const allKeys = [...scalars, ...ARRAY_FIELDS].every((k) => k in o);
  const types =
    scalars.every((k) => typeof o[k] === 'string') &&
    ARRAY_FIELDS.every((k) => Array.isArray(o[k]) && (o[k] as unknown[]).every((v) => typeof v === 'string'));
  return { allKeys, types };
}

async function runOne(arm: Arm, caseId: string, run: number, orderIndex: number): Promise<Row> {
  const c = CASES.find((x) => x.id === caseId)!;
  const { system, user } = buildSelfAnalysisMessages(c.input);

  const base = {
    model: arm.model,
    max_tokens: SELF_ANALYSIS_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
    ...arm.extra,
  };

  const t0 = Date.now();
  let parseRetry = false;
  let lastMsg: Awaited<ReturnType<typeof anthropic.messages.create>> | null = null;
  let parsedRaw: unknown = null;
  let providerDurationMs = 0;
  let errorKind: string | null = null;

  // Mirror production: attempt 1 at temp 0.5, one parse retry at temp 0.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const p0 = Date.now();
    try {
      lastMsg = await anthropic.messages.create(
        { ...base, temperature: attempt === 2 ? 0 : 0.5 } as never,
        { signal: AbortSignal.timeout(225_000) },
      );
    } catch (e) {
      providerDurationMs = Date.now() - p0;
      errorKind = e instanceof Error ? e.name : 'UNKNOWN';
      break;
    }
    providerDurationMs = Date.now() - p0;
    const blk = lastMsg.content.find((b) => b.type === 'text');
    const text = blk && blk.type === 'text' ? blk.text : '';
    if (lastMsg.stop_reason === 'max_tokens') break; // truncation: production fails, no retry
    try {
      parsedRaw = JSON.parse(extractJson(text));
      break;
    } catch {
      if (attempt === 1) { parseRetry = true; continue; }
      errorKind = 'PARSE_FAILED';
    }
  }

  const totalDurationMs = Date.now() - t0;
  const blk = lastMsg?.content.find((b) => b.type === 'text');
  const text = blk && blk.type === 'text' ? blk.text : '';
  const parsed = parsedRaw ? normalizeResult(parsedRaw) : null;
  const a = parsed
    ? analyse(parsed)
    : { perFieldChars: {}, perFieldCount: {}, empty: [], arrayItemCount: 0, duplicateItems: 0, oversizeItems: 0, totalResultChars: 0 };
  const tk = parsedRaw ? typesOk(parsedRaw) : { allKeys: false, types: false };

  return {
    orderIndex, arm: arm.id, model: arm.model, caseId, run,
    ok: !!lastMsg && !errorKind,
    errorKind,
    providerDurationMs, totalDurationMs, parseRetry,
    inputChars: system.length + user.length,
    inputTokens: lastMsg?.usage.input_tokens ?? 0,
    outputChars: text.length,
    outputTokens: lastMsg?.usage.output_tokens ?? 0,
    stopReason: lastMsg?.stop_reason ?? null,
    truncated: lastMsg?.stop_reason === 'max_tokens',
    schemaValid: !!parsed,
    meaningful: parsed ? hasMeaningfulResult(parsed) : false,
    allKeysPresent: tk.allKeys,
    typesOk: tk.types,
    emptyFields: a.empty,
    duplicateItems: a.duplicateItems,
    oversizeItems: a.oversizeItems,
    arrayItemCount: a.arrayItemCount,
    totalResultChars: a.totalResultChars,
    perFieldChars: a.perFieldChars,
    perFieldCount: a.perFieldCount,
    result: parsed ?? undefined,
  };
}

async function main() {
  // Counterbalanced interleave per profile. For the 2-arm run this is S,H,H,S,S,H
  // so neither arm is systematically early or late within a profile.
  const rows: Row[] = [];
  let order = 0;

  for (const c of CASES) {
    const counts: Record<string, number> = Object.fromEntries(ARMS.map((a) => [a.id, 0]));
    const seq: ArmId[] =
      ARMS.length === 2
        ? (['sonnet', 'haiku', 'haiku', 'sonnet', 'sonnet', 'haiku'] as ArmId[])
            .filter((x) => ARMS.some((a) => a.id === x))
            .slice(0, RUNS * ARMS.length)
        : Array.from({ length: RUNS * ARMS.length }, (_, i) => ARMS[i % ARMS.length].id);
    for (const armId of seq) {
      const arm = ARMS.find((a) => a.id === armId)!;
      counts[armId] += 1;
      const r = await runOne(arm, c.id, counts[armId], order++);
      rows.push(r);
      console.log(
        `#${String(r.orderIndex).padStart(2)} ${c.id.padEnd(7)} ${r.arm.padEnd(7)} run${r.run}  ` +
          `${String((r.providerDurationMs / 1000).toFixed(1) + 's').padStart(7)}  ` +
          `in=${String(r.inputTokens).padStart(5)} out=${String(r.outputTokens).padStart(5)}  ` +
          `${(r.outputTokens / (r.providerDurationMs / 1000)).toFixed(0).padStart(3)}tok/s  ` +
          `stop=${String(r.stopReason).padEnd(9)} schema=${r.schemaValid ? 'OK ' : 'FAIL'} ` +
          `keys=${r.allKeysPresent ? 'Y' : 'N'} types=${r.typesOk ? 'Y' : 'N'} ` +
          `items=${String(r.arrayItemCount).padStart(3)} empty=${r.emptyFields.length} ` +
          `dup=${r.duplicateItems} over=${r.oversizeItems}${r.parseRetry ? ' PARSE_RETRY' : ''}${r.errorKind ? ' ERR=' + r.errorKind : ''}`,
      );
    }
  }
  writeFileSync(OUT, JSON.stringify(rows, null, 2));
  console.log(`\nwrote ${rows.length} rows -> ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
