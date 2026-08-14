/*
 * scripts/career-server-context-batch2-qa.ts
 *
 * PASSAI CAREER — Server Context Expansion Batch 2 QA（cross-feature bridge 退役）。
 *   dev-only・DI fake・実 Supabase 非接続・実 AI call なし。
 *
 * B2-1  新 source kind の Layer 1 read が owner-scoped / authorize gate 越しに動く
 * B2-2  round-trip invariance: client canonical → mirror shape → row → mapper → revision が同一
 * B2-3  per-source merge: verified な kind だけ server / 他は bridge
 * B2-4  ★ 同一 semantic block が server と bridge の両方から入らない（重複注入なし）
 * B2-5  ★ parity: verified 時の server 出力 == bridge 出力（selector 共有の帰結）
 * B2-6  company_research の "latest log result" が client / selector と同一規則
 * B2-7  partial verification（一部 mismatch）で残りは server のまま
 * B2-8  purpose OFF → I/O ゼロ / non-canary → table read ゼロ
 * B2-9  context を減らさない（server 空 + bridge 有 → bridge）
 * B2-10 gd / gd_room が server 化されていない（意図的除外の固定）
 * B2-11 静的 guard: 3 purpose の route が resolver 経由で body を直接使わない
 * B2-12 静的 guard: Batch 2 module の安全境界（server-only / service role なし / Layer 3 非依存）
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-server-context-batch2-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadVerifiedCrossFeatureSources,
  serverOnlyBundle,
  type CrossFeatureSourceDeps,
} from '@/lib/careerServerContext/crossFeatureSources.server';
import { loadPurposeServerContext } from '@/lib/careerServerContext/purposeContext.server';
import { buildServerContextCanaryConfig } from '@/lib/careerServerContext/canaryGate';
import type { CareerContextPurpose } from '@/lib/careerContext/purpose';
import {
  computeSourceSyncRevision,
  computeSourceSyncRevisions,
} from '@/lib/careerSourceSync/revision';
import {
  serializeSourceSyncSignal,
  parseSourceSyncSignal,
  CAREER_SOURCE_SYNC_HEADER,
} from '@/lib/careerSourceSync/signal';
import {
  EMPTY_CAREER_SOURCE_BUNDLE,
  emptySourceStatuses,
  CAREER_SOURCE_TABLES,
  type CareerSourceBundle,
  type CareerSourceKind,
  type CareerSourceReadOutcome,
} from '@/lib/careerSourceData/types';
import {
  rowToCareerMatchingLog,
  rowToCareerCompanyResearchLog,
  rowToCareerPresentationResult,
  rowToCareerConsultationThread,
} from '@/lib/careerSourceData/rowMappers';
import {
  buildConsultationRequestContext,
  buildInterviewRequestContext,
} from '@/lib/careerMemory/selector';
import { resolveInterviewContextInputs } from '@/app/api/career/interview/resolveContextInputs';
import { resolveConsultationContextInputs } from '@/app/api/career/consultation/resolveContextInputs';
import {
  resolveCompanyResearchContextInputs,
  latestSelfAnalysisResult,
  latestMatchingResult,
} from '@/app/api/career/company-research/resolveContextInputs';
import type { CareerMatchingLog } from '@/types/careerMatching';
import type { CareerCompanyResearchLog } from '@/types/careerCompanyResearch';
import type { CareerConsultationThread } from '@/types/careerConsultation';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

const ROOT = process.cwd();
// ★ 合成 UUID。実 canary user の UUID は repo へ hardcode しない（env/operator 制御のまま）。
const CANARY = '11111111-1111-4111-8111-111111111111';
const OTHER = '00000000-0000-4000-8000-000000000001';

let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// ── fixture（client canonical 相当） ──────────────────────────────
const MATCHING_LOG = {
  id: 'm-1',
  createdAt: '2026-07-02T00:00:00.000Z',
  userInput: 'MATCH_INPUT',
  result: { summary: 'MATCH_OK', companies: [] },
} as unknown as CareerMatchingLog;

const RESEARCH_LOG = {
  id: 'cr-1',
  createdAt: '2026-07-02T01:00:00.000Z',
  updatedAt: '2026-07-02T02:00:00.000Z',
  companyName: 'RESEARCH_CO',
  industry: 'IT',
  interestLevel: 'high',
  input: { verifiedResearchText: 'TEXT' },
  review: { summary: 'REVIEW_OK' },
  fitAnalysis: { selfAnalysisFit: 'FIT_OK' },
  interviewContextSummary: 'IV_SUMMARY_OK',
  revisionHistory: [],
  favorite: false,
} as unknown as CareerCompanyResearchLog;

const THREAD = {
  id: 't-1',
  createdAt: '2026-07-02T03:00:00.000Z',
  updatedAt: '2026-07-02T04:00:00.000Z',
  title: 'THREAD_OK',
  messages: [
    { role: 'user', content: 'Q' },
    { role: 'assistant', content: 'CONSULT_INSIGHT_OK', keyInsights: ['INSIGHT_OK'] },
  ],
} as unknown as CareerConsultationThread;

const SELF_LOG = {
  id: 'sa-1',
  createdAt: '2026-07-02T00:00:00.000Z',
  userInput: '',
  result: { summary: 'SELF_OK' },
} as unknown as CareerSelfAnalysisLog;

const BUNDLE = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  profile: { name: 'N', grade: 'B3' },
  activity: { focusedActivities: [{ title: 'ACT_OK' }] },
  values: {
    selections: { priorities: ['p'], avoidances: [], industries: [], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] },
    notes: { priorities: '', avoidances: '', industries: '', jobTypes: '', workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '' },
    overallNote: '',
  },
  selfAnalysisLogs: [SELF_LOG],
  matchingLogs: [MATCHING_LOG],
  companyResearchLogs: [RESEARCH_LOG],
  consultationThreads: [THREAD],
} as unknown as CareerSourceBundle;

const ALL_KINDS: readonly CareerSourceKind[] = [
  'profile', 'activity', 'values', 'self_analysis', 'es', 'interview',
  'matching', 'company_research', 'presentation', 'consultation',
];

function reqWith(kinds: readonly CareerSourceKind[], bundle = BUNDLE): Request {
  const header = serializeSourceSyncSignal(computeSourceSyncRevisions(bundle, kinds));
  return new Request('https://example.test/x', { headers: { [CAREER_SOURCE_SYNC_HEADER]: header } });
}

function deps(opts: {
  spy?: { loads: number; kinds: CareerSourceKind[] };
  purposes?: CareerContextPurpose[];
  userId?: string;
  bundle?: CareerSourceBundle;
}): CrossFeatureSourceDeps {
  return {
    loadCanaryConfig: () =>
      buildServerContextCanaryConfig(
        opts.purposes ?? ['interview_practice', 'consultation', 'company_research_review'],
        CANARY,
      ),
    loadSources: async (kinds, authorize) => {
      if (authorize && !authorize(opts.userId ?? CANARY)) {
        return {
          bundle: EMPTY_CAREER_SOURCE_BUNDLE,
          meta: { outcome: 'unauthorized', statuses: emptySourceStatuses(), durationMs: null },
        } as CareerSourceReadOutcome;
      }
      if (opts.spy) {
        opts.spy.loads += 1;
        opts.spy.kinds = [...kinds];
      }
      const statuses = emptySourceStatuses();
      for (const k of kinds) statuses[k] = 'ok';
      return {
        bundle: opts.bundle ?? BUNDLE,
        meta: { outcome: 'ok', statuses, durationMs: 1 },
      } as CareerSourceReadOutcome;
    },
  };
}

async function main() {
  console.log('=== career-server-context-batch2-qa ===');

  // ── B2-1 ────────────────────────────────────────────────────────
  console.log('[B2-1] 新 source kind の Layer 1 read（authorize gate 越し）');
  {
    const spy = { loads: 0, kinds: [] as CareerSourceKind[] };
    const r = await loadVerifiedCrossFeatureSources(
      'interview_practice', ALL_KINDS, reqWith(ALL_KINDS), deps({ spy }),
    );
    check(spy.loads === 1, '1 回だけ read する（purpose あたり単一 read）');
    for (const k of ['matching', 'company_research', 'presentation', 'consultation'] as CareerSourceKind[]) {
      check(spy.kinds.includes(k), `${k} を read 対象に含む`);
      check(typeof CAREER_SOURCE_TABLES[k] === 'string' && CAREER_SOURCE_TABLES[k].startsWith('career_'), `${k} が career_* table へ mapping されている`);
    }
    check(r.status === 'full_server', `全 kind verified → full_server（実際: ${r.status}）`);
  }

  // ── B2-2 round-trip invariance ─────────────────────────────────
  console.log('[B2-2] round-trip invariance（canonical → mirror row → mapper → revision）');
  {
    // client canonical を「mirror が返す row」へ写し、mapper で戻して revision が一致するか。
    // ★ 意味のある data を捨てて一致させていないことを、値の存在チェックで併せて固定する。
    const cases: Array<{ kind: CareerSourceKind; row: unknown; map: (r: never) => unknown; key: keyof CareerSourceBundle }> = [
      {
        kind: 'matching',
        key: 'matchingLogs',
        row: { client_id: 'm-1', created_at: '2026-07-02T00:00:00+00:00', user_input: 'MATCH_INPUT', result: MATCHING_LOG.result },
        map: rowToCareerMatchingLog as never,
      },
      {
        kind: 'company_research',
        key: 'companyResearchLogs',
        row: {
          client_id: 'cr-1',
          created_at: '2026-07-02T01:00:00+00:00',
          updated_at: '2026-07-02T09:00:00+00:00', // ★ trigger が上書きする列（revision に含めない）
          company_name: 'RESEARCH_CO',
          industry: 'IT',
          interest_level: 'high',
          input: RESEARCH_LOG.input,
          review: RESEARCH_LOG.review,
          fit_analysis: RESEARCH_LOG.fitAnalysis,
          interview_context_summary: 'IV_SUMMARY_OK',
          revision_history: [],
          favorite: false,
        },
        map: rowToCareerCompanyResearchLog as never,
      },
      {
        kind: 'consultation',
        key: 'consultationThreads',
        row: {
          client_id: 't-1',
          created_at: '2026-07-02T03:00:00+00:00',
          updated_at: '2026-07-02T09:00:00+00:00', // ★ trigger 上書き列
          title: 'THREAD_OK',
          messages: THREAD.messages,
        },
        map: rowToCareerConsultationThread as never,
      },
    ];
    for (const c of cases) {
      const mapped = (c.map as (r: unknown) => unknown)(c.row);
      const fromMirror = { ...EMPTY_CAREER_SOURCE_BUNDLE, [c.key]: [mapped] } as unknown as CareerSourceBundle;
      const fromClient = { ...EMPTY_CAREER_SOURCE_BUNDLE, [c.key]: BUNDLE[c.key] } as unknown as CareerSourceBundle;
      const a = computeSourceSyncRevision(c.kind, fromClient);
      const b = computeSourceSyncRevision(c.kind, fromMirror);
      check(a === b, `${c.kind}: canonical と mirror 往復が同一 revision`, `${a} vs ${b}`);
      check(!a.endsWith(':invalid'), `${c.kind}: revision が算出できている`);
      // 意味のある値が sync view に残っていること（雑に捨てて一致させていない証明）。
      const view = JSON.stringify(mapped);
      check(view.length > 40, `${c.kind}: mapper が意味のある data を保持している（${view.length}B）`);
    }
    // presentation は mapper のみ健全性確認（fixture 上は空）。
    const p = rowToCareerPresentationResult({
      client_id: 'p-1', created_at: '2026-07-02T05:00:00+00:00', presentation_type: 'self_pr',
      mode: 'normal', theme: 'THEME_OK', time_limit_sec: 60, duration_sec: 55,
      transcript: 'T', result: { summary: 'PRES_OK' }, qa: null,
    } as never) as { theme?: string };
    check(p.theme === 'THEME_OK', 'presentation mapper が昇格列を写す');
  }

  // ── B2-3 / B2-7 per-source merge ────────────────────────────────
  console.log('[B2-3] per-source merge: verified な kind だけ server');
  {
    const r = await loadVerifiedCrossFeatureSources(
      'interview_practice', ALL_KINDS, reqWith(ALL_KINDS), deps({}),
    );
    for (const k of ALL_KINDS) check(r.origin[k] === 'server', `${k}: server`);
    const only = serverOnlyBundle(r);
    check(only.matchingLogs.length === 1 && only.consultationThreads.length === 1, 'server bundle に実データが入る');
  }
  console.log('[B2-7] partial verification: mismatch の kind だけ bridge');
  {
    // matching だけ壊した claim を送る。
    const claims = computeSourceSyncRevisions(BUNDLE, ALL_KINDS);
    claims.matching = 'v1:deadbeef';
    const req = new Request('https://example.test/x', {
      headers: { [CAREER_SOURCE_SYNC_HEADER]: serializeSourceSyncSignal(claims) },
    });
    const r = await loadVerifiedCrossFeatureSources('interview_practice', ALL_KINDS, req, deps({}));
    check(r.origin.matching === 'bridge', 'matching は mismatch → bridge');
    check(r.origin.self_analysis === 'server' && r.origin.company_research === 'server', '他 kind は server のまま（section isolation）');
    check(r.status === 'partial_server', `status=partial_server（実際: ${r.status}）`);
    const only = serverOnlyBundle(r);
    check(only.matchingLogs.length === 0, 'bridge 判定 kind の server 値は bundle から除去される');
  }

  // ── B2-4 / B2-5 重複注入なし + parity ───────────────────────────
  console.log('[B2-4/B2-5] 重複注入なし + verified 時の parity（interview）');
  {
    // client が送るはずの bridge payload（＝同じ selector を同じ生データで実行した結果）。
    const bridgePayload = buildInterviewRequestContext({
      profile: BUNDLE.profile,
      activity: BUNDLE.activity,
      values: BUNDLE.values,
      selfAnalysisLogs: BUNDLE.selfAnalysisLogs,
      esLogs: [],
      matchingLogs: BUNDLE.matchingLogs,
      consultationThreads: BUNDLE.consultationThreads,
      companyResearchLog: RESEARCH_LOG,
    });
    const body = {
      profile: BUNDLE.profile as never,
      activity: BUNDLE.activity as never,
      values: BUNDLE.values as never,
      selfAnalysis: bridgePayload.selfAnalysis,
      es: bridgePayload.es,
      matching: bridgePayload.matching,
      consultationInsights: bridgePayload.consultationInsights,
      companyResearch: bridgePayload.companyResearch,
    };
    const loader = (purpose: never, kinds: never, req?: Request) =>
      loadPurposeServerContext(purpose, kinds, req, (p, k, rq) =>
        loadVerifiedCrossFeatureSources(p, k, rq, deps({})),
      );
    const out = await resolveInterviewContextInputs(body, reqWith(ALL_KINDS), loader as never);

    check(out.origins.selfAnalysis === 'server', 'selfAnalysis: server 由来');
    check(out.origins.matching === 'server', 'matching: server 由来');
    check(out.origins.consultationInsights === 'server', 'consultationInsights: server 由来');
    check(out.origins.companyResearch === 'server', 'companyResearch: server 由来');
    check(out.origins.base === 'server', 'base: server 由来');
    // ★ B2-5 parity: server 経路の出力が bridge 経路と同一（selector 共有の帰結）。
    check(
      JSON.stringify(out.selfAnalysis) === JSON.stringify(bridgePayload.selfAnalysis),
      'parity: selfAnalysis が bridge と同一',
    );
    check(
      JSON.stringify(out.matching) === JSON.stringify(bridgePayload.matching),
      'parity: matching が bridge と同一',
    );
    check(
      JSON.stringify(out.consultationInsights) === JSON.stringify(bridgePayload.consultationInsights),
      'parity: consultationInsights が bridge と同一',
    );
    check(
      JSON.stringify(out.companyResearch) === JSON.stringify(bridgePayload.companyResearch),
      'parity: companyResearch が bridge と同一（logId は selection input）',
    );
    // ★ B2-4: field は 1 つしか無いので構造的に二重にならない。値が server/bridge の
    //   「連結」になっていないことを配列長で固定する。
    check(
      (out.consultationInsights?.length ?? 0) === (bridgePayload.consultationInsights?.length ?? 0),
      '重複注入なし: consultationInsights が 2 倍になっていない',
    );
  }

  console.log('[B2-4b] consultation / company_research resolver も per-source merge する');
  {
    const loader = (purpose: never, kinds: never, req?: Request) =>
      loadPurposeServerContext(purpose, kinds, req, (p, k, rq) =>
        loadVerifiedCrossFeatureSources(p, k, rq, deps({})),
      );
    const c = await resolveConsultationContextInputs(
      {
        selfAnalysisHistory: [], esHistory: [], interviewHistory: [],
        presentationHistory: [], companyResearch: [], matching: [],
      },
      reqWith(ALL_KINDS),
      loader as never,
    );
    check(c.origins.base === 'server', 'consultation: base が server');
    check(c.origins.companyResearch === 'server', 'consultation: companyResearch が server');
    check(c.companyResearch.length === 1, 'consultation: server の企業研究が 1 件入る');
    check(c.origins.matching === 'server', 'consultation: matching が server');
    // ★ parity: server 経路の各 field が「同じ生データに同じ selector を当てた結果」と一致する。
    //   件数を決め打ちせず selector を正本にする（snapshot 圧縮規則の変更に追随する）。
    const viaSelector = buildConsultationRequestContext({
      profile: BUNDLE.profile, activity: BUNDLE.activity, values: BUNDLE.values,
      selfAnalysisLogs: BUNDLE.selfAnalysisLogs, esLogs: BUNDLE.esLogs,
      interviewResults: BUNDLE.interviewResults, presentationResults: BUNDLE.presentationResults,
      companyResearchLogs: BUNDLE.companyResearchLogs, gdResults: [], gdRoomLogs: [],
      matchingLogs: BUNDLE.matchingLogs, gdResultId: null,
    });
    for (const f of ['selfAnalysisHistory', 'esHistory', 'interviewHistory', 'presentationHistory', 'companyResearch', 'matching'] as const) {
      check(
        JSON.stringify(c[f]) === JSON.stringify(viaSelector[f]),
        `consultation parity: ${f} が selector 出力と一致`,
      );
    }
    // presentation / interview は fixture が空 → bridge も空 → server（空）を採用してよい。
    check(c.origins.selfAnalysisHistory === 'server', 'consultation: selfAnalysisHistory が server');

    const cr = await resolveCompanyResearchContextInputs({}, reqWith(ALL_KINDS), loader as never);
    check(cr.origins.base === 'server', 'company_research: base が server');
    check(cr.origins.selfAnalysis === 'server', 'company_research: selfAnalysis が server');
    check(cr.origins.matching === 'server', 'company_research: matching が server');
    check(
      JSON.stringify(cr.selfAnalysis) === JSON.stringify(latestSelfAnalysisResult(BUNDLE.selfAnalysisLogs)),
      'company_research: selfAnalysis が最新 log の result',
    );
  }

  // ── B2-6 latest log result 規則 ────────────────────────────────
  console.log('[B2-6] company_research の "latest log result" が selector と同一規則');
  {
    const viaSelector = buildInterviewRequestContext({
      profile: null, activity: null, values: null,
      selfAnalysisLogs: BUNDLE.selfAnalysisLogs,
      esLogs: [], matchingLogs: BUNDLE.matchingLogs,
      consultationThreads: [], companyResearchLog: null,
    });
    check(
      JSON.stringify(latestSelfAnalysisResult(BUNDLE.selfAnalysisLogs)) === JSON.stringify(viaSelector.selfAnalysis),
      'selfAnalysis: selector projection と一致',
    );
    check(
      JSON.stringify(latestMatchingResult(BUNDLE.matchingLogs)) === JSON.stringify(viaSelector.matching),
      'matching: selector projection と一致',
    );
    check(latestSelfAnalysisResult([]) === null && latestMatchingResult(null) === null, '空 → null');
  }

  // ── B2-8 gate ───────────────────────────────────────────────────
  console.log('[B2-8] purpose OFF → I/O ゼロ / non-canary → table read ゼロ');
  {
    const spy1 = { loads: 0, kinds: [] as CareerSourceKind[] };
    const off = await loadVerifiedCrossFeatureSources(
      'interview_practice', ALL_KINDS, reqWith(ALL_KINDS), deps({ spy: spy1, purposes: [] }),
    );
    check(spy1.loads === 0, 'purpose OFF: Source read を呼ばない');
    check(off.status === 'purpose_disabled', 'status=purpose_disabled');
    check(ALL_KINDS.every((k) => off.origin[k] === 'bridge'), '全 kind bridge');

    const spy2 = { loads: 0, kinds: [] as CareerSourceKind[] };
    const notCanary = await loadVerifiedCrossFeatureSources(
      'interview_practice', ALL_KINDS, reqWith(ALL_KINDS), deps({ spy: spy2, userId: OTHER }),
    );
    check(spy2.loads === 0, 'non-canary: table read ゼロ（authorize hook で遮断）');
    check(notCanary.status === 'user_not_canary', 'status=user_not_canary');
  }

  // ── B2-9 context を減らさない ──────────────────────────────────
  console.log('[B2-9] context を減らさない（server 空 + bridge 有 → bridge）');
  {
    const EMPTY_LOGS = { ...BUNDLE, matchingLogs: [], consultationThreads: [] } as CareerSourceBundle;
    const loader = (purpose: never, kinds: never, req?: Request) =>
      loadPurposeServerContext(purpose, kinds, req, (p, k, rq) =>
        loadVerifiedCrossFeatureSources(p, k, rq, deps({ bundle: EMPTY_LOGS })),
      );
    const out = await resolveInterviewContextInputs(
      {
        matching: { summary: 'BRIDGE_MATCH' } as never,
        consultationInsights: ['BRIDGE_INSIGHT'],
      },
      reqWith(ALL_KINDS, EMPTY_LOGS),
      loader as never,
    );
    check(out.origins.matching === 'bridge', 'server 空 + bridge 有 → matching は bridge');
    check(out.origins.consultationInsights === 'bridge', 'server 空 + bridge 有 → consultationInsights は bridge');
    check((out.matching as { summary?: string } | null)?.summary === 'BRIDGE_MATCH', 'bridge 値が保持される');
  }

  // ── B2-10 gd / gd_room 除外 ────────────────────────────────────
  console.log('[B2-10] gd / gd_room を server 化していない（意図的除外）');
  {
    const kinds = Object.keys(CAREER_SOURCE_TABLES);
    check(!kinds.includes('gd'), 'source kind に gd が存在しない（mirror 無し）');
    check(!kinds.includes('gd_room'), 'source kind に gd_room が存在しない（server 書き込み）');
    const consultSrc = readFileSync(join(ROOT, 'app/api/career/consultation/resolveContextInputs.ts'), 'utf8');
    check(/gdResults:\s*\[\]/.test(consultSrc) && /gdRoomLogs:\s*\[\]/.test(consultSrc), 'consultation resolver は gd を server から組まない');
    const routeSrc = readFileSync(join(ROOT, 'app/api/career/consultation/route.ts'), 'utf8');
    check(/gd:\s*gdSnapshots/.test(routeSrc) && /gdRoom:\s*gdRoomSignals/.test(routeSrc), 'route は gd/gdRoom を bridge のまま渡す');
    check(/eventSignalsBlock/.test(routeSrc), 'Event Signal は現行位置のまま（Layer 3 分離）');
  }

  // ── B2-11 静的 guard: route wiring ─────────────────────────────
  console.log('[B2-11] 静的 guard: route が resolver 経由（body 直渡ししない）');
  {
    const specs: Array<{ rel: string; fields: string[] }> = [
      { rel: 'app/api/career/interview/start/route.ts', fields: ['profile', 'activity', 'values', 'selfAnalysis', 'es', 'matching', 'consultationInsights'] },
      { rel: 'app/api/career/interview/turn/route.ts', fields: ['profile', 'activity', 'values', 'selfAnalysis', 'es', 'matching', 'consultationInsights'] },
      { rel: 'app/api/career/interview/complete/route.ts', fields: ['profile', 'activity', 'values', 'selfAnalysis', 'es', 'matching', 'consultationInsights'] },
      { rel: 'app/api/career/company-research/route.ts', fields: ['profile', 'activity', 'values'] },
    ];
    for (const s of specs) {
      const src = readFileSync(join(ROOT, s.rel), 'utf8');
      check(/resolve\w*ContextInputs\(/.test(src), `${s.rel}: 共有 resolver 経由`);
      for (const f of s.fields) {
        check(!new RegExp(`${f}:\\s*b\\.${f}`).test(src), `${s.rel}: ${f} を body から直接渡さない`);
      }
    }
    const crSrc = readFileSync(join(ROOT, 'app/api/career/company-research/route.ts'), 'utf8');
    check(/renderSelfAnalysis\(ctx\.selfAnalysis\)/.test(crSrc), 'company-research: selfAnalysis が resolver 由来');
    check(/renderMatching\(ctx\.matching\)/.test(crSrc), 'company-research: matching が resolver 由来');
    // dedupe の presence は「実際に描画する block の有無」であり続けること（D-S5 維持）。
    check(/self_analysis:\s*selfAnalysisBlock !== ''/.test(crSrc), 'company-research: dedupe presence が描画有無ベース');
  }

  // ── B2-12 静的 guard: 安全境界 ─────────────────────────────────
  console.log('[B2-12] 静的 guard: Batch 2 module の安全境界');
  {
    for (const rel of [
      'lib/careerServerContext/crossFeatureSources.server.ts',
      'lib/careerServerContext/purposeContext.server.ts',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      check(/^import 'server-only';$/m.test(code), `${rel}: server-only`);
      check(!/serviceRole|SERVICE_ROLE/.test(code), `${rel}: service role なし`);
      check(!/eventSignal|EventSignal|careerEvents/.test(code), `${rel}: Layer 3 非依存（D-L3）`);
      check(!/NODE_ENV/.test(code), `${rel}: NODE_ENV bypass なし`);
      check(!/b\.userId|body\.userId/.test(code), `${rel}: client 由来 userId を使わない`);
    }
    for (const rel of [
      'app/api/career/interview/resolveContextInputs.ts',
      'app/api/career/consultation/resolveContextInputs.ts',
      'app/api/career/company-research/resolveContextInputs.ts',
    ]) {
      const code = readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      check(!/console\.(log|warn|error|info)/.test(code), `${rel}: 診断 log を出さない（PII 流出面を作らない）`);
      check(!/serviceRole|SERVICE_ROLE/.test(code), `${rel}: service role なし`);
    }
    // sync signal は header 経由のみ（body から identity/claim を取らない）。
    const sig = readFileSync(join(ROOT, 'lib/careerSourceSync/request.server.ts'), 'utf8');
    check(/headers/.test(sig), 'Source-Sync claim は header 経由');
    const roundTrip = parseSourceSyncSignal(
      serializeSourceSyncSignal(computeSourceSyncRevisions(BUNDLE, ALL_KINDS)),
    );
    check(roundTrip.version === 'v1', 'signal parser が健全（version）');
    check(
      Object.keys(roundTrip.revisions).length === ALL_KINDS.length,
      `signal が全 kind を運ぶ（${Object.keys(roundTrip.revisions).length}/${ALL_KINDS.length}）`,
    );
  }

  console.log('');
  console.log(failures === 0 ? 'career-server-context-batch2-qa: ALL PASS' : `career-server-context-batch2-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
