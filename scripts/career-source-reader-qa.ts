/*
 * scripts/career-source-reader-qa.ts
 *
 * PASSAI CAREER — NEXT-2: Layer 1 Source Data server reader QA（dev-only・DI fake・実 Supabase 非接続）。
 *
 * 何を守るか:
 *   [1] kinds 空 → I/O ゼロ（client も作らない）。
 *   [2] createReader null（env 未設定）→ skipped・空 bundle。
 *   [3] 未認証 / anonymous → unauthenticated・select しない。
 *   [4] 要求 kind だけ select する（不要 table へ I/O しない）。
 *   [5] row → domain 変換が client mirror と同一（共有 mapper の単一実装）。
 *   [6] 履歴系が上限に達したら truncated（revision を権威にしない）。
 *   [7] 個別 table の失敗が他 Source を巻き込まない（section 独立）。
 *   [8] never-throw（reader が throw しても空 bundle）。
 *   [9] meta に本文 / UUID / raw error を含めない。
 *   [10] 静的 guard: server reader が service role を使わず、request body の userId を受け取らない。
 *   [11] 静的 guard: rowMappers が 'use client' / server-only / Supabase client に依存しない。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-source-reader-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadCareerSourceData,
  type CareerSourceReader,
  type CareerSourceReaderDeps,
} from '@/lib/careerSourceData/serverReader.server';
import {
  CAREER_SOURCE_LOG_MAX_ROWS,
  CAREER_SOURCE_TABLES,
  isSourceRevisionAuthoritative,
  type CareerSourceKind,
} from '@/lib/careerSourceData/types';
import {
  rowToCareerEsLog,
  rowToCareerInterviewResult,
  rowToCareerSelfAnalysisLog,
  rowToCareerValues,
  type CareerEsLogRow,
  type CareerInterviewResultRow,
  type CareerSelfAnalysisResultRow,
  type CareerValuesRow,
} from '@/lib/careerSourceData/rowMappers';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const UID = '11111111-1111-1111-1111-111111111111';

// ── fixtures（DB row 相当） ──────────────────────────────────────────
const PROFILE_ROW = { data: { name: '山田太郎', grade: 'B3', preferences: [{ university: '東京大学' }] }, updated_at: null };
const ACTIVITY_ROW = { data: { focusedActivities: [{ title: '長期インターン' }] }, updated_at: '2026-07-01T00:00:00.000Z' };
const VALUES_ROW: CareerValuesRow = {
  priorities: ['成長'], avoidances: [], industries: ['IT'], job_types: [],
  work_styles: [], company_types: [], career_goals: [], culture_preferences: [],
  notes: { priorities: '備考' }, overall_note: '総合', updated_at: '2026-07-02T00:00:00.000Z',
};
const SELF_ROW: CareerSelfAnalysisResultRow = {
  client_id: 'sa-1', user_input: 'in', result: { summary: 's' }, created_at: '2026-07-03T00:00:00.000Z',
};
const ES_ROW: CareerEsLogRow = {
  client_id: 'es-1', user_input: '', result: { answer: '本文' }, edited_result: null,
  favorite: true, submitted: false,
  meta: { companyName: 'A社', question: '設問', charLimit: 400, selectionType: 'main' },
  created_at: '2026-07-04T00:00:00.000Z',
};
const INTERVIEW_ROW: CareerInterviewResultRow = {
  client_id: 'iv-1', mode: 'real', interview_type: 'personal', turns: [{ role: 'ai', text: 'q' }],
  result: { overallComment: 'c' }, company_research_log_id: 'cr-1',
  company_research_snapshot: { companyName: 'A社' }, created_at: '2026-07-05T00:00:00.000Z',
};

type Spy = { createReader: number; getUserId: number; tables: string[] };
const newSpy = (): Spy => ({ createReader: 0, getUserId: 0, tables: [] });

function makeReader(
  spy: Spy,
  over: {
    userId?: string | null;
    rowsFor?: (table: string) => unknown[] | null;
    failFor?: readonly string[];
  } = {},
): CareerSourceReader {
  const { userId = UID, rowsFor, failFor = [] } = over;
  return {
    async getUserId() { spy.getUserId++; return userId; },
    async select(table) {
      spy.tables.push(table);
      if (failFor.includes(table)) return { rows: null, failed: true };
      const rows = rowsFor
        ? rowsFor(table)
        : table === CAREER_SOURCE_TABLES.profile ? [PROFILE_ROW]
        : table === CAREER_SOURCE_TABLES.activity ? [ACTIVITY_ROW]
        : table === CAREER_SOURCE_TABLES.values ? [VALUES_ROW]
        : table === CAREER_SOURCE_TABLES.self_analysis ? [SELF_ROW]
        : table === CAREER_SOURCE_TABLES.es ? [ES_ROW]
        : table === CAREER_SOURCE_TABLES.interview ? [INTERVIEW_ROW]
        : [];
      return { rows, failed: false };
    },
  };
}

function makeDeps(spy: Spy, reader: CareerSourceReader | null | 'throw'): CareerSourceReaderDeps {
  return {
    now: () => 0,
    createReader: async () => {
      spy.createReader++;
      if (reader === 'throw') throw new Error('boom');
      return reader;
    },
  };
}

const ALL_KINDS: readonly CareerSourceKind[] = [
  'profile', 'activity', 'values', 'self_analysis', 'es', 'interview',
];

async function main() {
  console.log('[1] kinds 空 → I/O ゼロ');
  {
    const spy = newSpy();
    const r = await loadCareerSourceData([], makeDeps(spy, makeReader(spy)));
    check(r.meta.outcome === 'skipped', "outcome === 'skipped'");
    check(spy.createReader === 0 && spy.tables.length === 0, 'client 生成も select もしない');
  }

  console.log('[2] createReader null（env 未設定）→ skipped・空 bundle');
  {
    const spy = newSpy();
    const r = await loadCareerSourceData(ALL_KINDS, makeDeps(spy, null));
    check(r.meta.outcome === 'skipped' && r.bundle.profile === null, 'skipped・空 bundle');
    check(spy.getUserId === 0, 'auth も呼ばない');
  }

  console.log('[3] 未認証 / anonymous → unauthenticated・select しない');
  {
    const spy = newSpy();
    const r = await loadCareerSourceData(ALL_KINDS, makeDeps(spy, makeReader(spy, { userId: null })));
    check(r.meta.outcome === 'unauthenticated', "outcome === 'unauthenticated'");
    check(spy.tables.length === 0, 'select 未実行（owner 不明のまま読まない）');
  }

  console.log('[4] 要求 kind だけ select する');
  {
    const spy = newSpy();
    await loadCareerSourceData(['self_analysis'], makeDeps(spy, makeReader(spy)));
    check(spy.tables.length === 1 && spy.tables[0] === CAREER_SOURCE_TABLES.self_analysis, `tables = ${spy.tables.join(',')}`);

    const spy2 = newSpy();
    await loadCareerSourceData(['profile', 'activity', 'values'], makeDeps(spy2, makeReader(spy2)));
    check(spy2.tables.sort().join(',') === [CAREER_SOURCE_TABLES.profile, CAREER_SOURCE_TABLES.activity, CAREER_SOURCE_TABLES.values].sort().join(','), 'base 由来 3 table のみ');
    check(!spy2.tables.includes(CAREER_SOURCE_TABLES.es), 'es table へ I/O しない');
  }

  console.log('[5] row → domain 変換が共有 mapper と一致');
  {
    const spy = newSpy();
    const r = await loadCareerSourceData(ALL_KINDS, makeDeps(spy, makeReader(spy)));
    check(r.meta.outcome === 'ok', "outcome === 'ok'");
    check(JSON.stringify(r.bundle.values) === JSON.stringify(rowToCareerValues(VALUES_ROW)), 'values 一致');
    check(JSON.stringify(r.bundle.selfAnalysisLogs) === JSON.stringify([rowToCareerSelfAnalysisLog(SELF_ROW)]), 'self_analysis 一致');
    check(JSON.stringify(r.bundle.esLogs) === JSON.stringify([rowToCareerEsLog(ES_ROW)]), 'es 一致');
    check(JSON.stringify(r.bundle.interviewResults) === JSON.stringify([rowToCareerInterviewResult(INTERVIEW_ROW)]), 'interview 一致');
    check(JSON.stringify(r.bundle.profile) === JSON.stringify(PROFILE_ROW.data), 'profile は data jsonb をそのまま');
    check(JSON.stringify(r.bundle.activity) === JSON.stringify(ACTIVITY_ROW.data), 'activity は data jsonb をそのまま');
    // Batch 2 以降 statuses は **全 kind** を含む。要求した kind だけが 'ok' になり、
    // 要求していない kind は 'ok' にならない（読んでいないものを権威扱いしない）ことを両方固定する。
    check(ALL_KINDS.every((k) => r.meta.statuses[k] === 'ok'), '要求 kind は全て status = ok');
    const notRequested = (Object.keys(r.meta.statuses) as CareerSourceKind[]).filter((k) => !ALL_KINDS.includes(k));
    check(notRequested.length > 0, '未要求 kind が存在する（Batch 2 で追加された kind）');
    check(notRequested.every((k) => r.meta.statuses[k] !== 'ok'), '未要求 kind は ok にならない');
  }

  console.log('[6] 履歴系が上限に達したら truncated');
  {
    const spy = newSpy();
    const many = Array.from({ length: CAREER_SOURCE_LOG_MAX_ROWS }, (_, i) => ({ ...SELF_ROW, client_id: `sa-${i}` }));
    const r = await loadCareerSourceData(['self_analysis'], makeDeps(spy, makeReader(spy, { rowsFor: () => many })));
    check(r.meta.statuses.self_analysis === 'truncated', "status === 'truncated'");
    check(!isSourceRevisionAuthoritative(r.meta.statuses.self_analysis), 'truncated は revision の権威にならない');
    check(isSourceRevisionAuthoritative('ok'), "'ok' のみ権威");
  }

  console.log('[7] 個別 table の失敗が他 Source を巻き込まない');
  {
    const spy = newSpy();
    const r = await loadCareerSourceData(
      ['profile', 'self_analysis'],
      makeDeps(spy, makeReader(spy, { failFor: [CAREER_SOURCE_TABLES.profile] })),
    );
    check(r.meta.statuses.profile === 'error', 'profile = error');
    check(r.meta.statuses.self_analysis === 'ok', 'self_analysis = ok（巻き込まれない）');
    check(r.bundle.selfAnalysisLogs.length === 1, 'self_analysis の domain は取得できる');
    check(r.meta.outcome === 'error', '全体 outcome は error（呼び出し側が fail-open 判断できる）');
  }

  console.log('[8] never-throw');
  {
    const spy = newSpy();
    const r = await loadCareerSourceData(ALL_KINDS, makeDeps(spy, 'throw'));
    check(r.meta.outcome === 'error' && r.bundle.profile === null, 'throw → error・空 bundle（例外を伝播しない）');
  }

  console.log('[9] meta に本文 / UUID / raw error を含めない');
  {
    const spy = newSpy();
    const r = await loadCareerSourceData(ALL_KINDS, makeDeps(spy, makeReader(spy)));
    const json = JSON.stringify(r.meta);
    for (const secret of [UID, '山田太郎', '東京大学', '本文', 'A社', '設問']) {
      check(!json.includes(secret), `meta に "${secret}" を含めない`);
    }
  }

  console.log('[10] 静的 guard: server reader の安全境界');
  {
    const src = readFileSync(join(ROOT, 'lib/careerSourceData/serverReader.server.ts'), 'utf8');
    check(/^import 'server-only';$/m.test(src), "import 'server-only' がある");
    check(!/serviceRoleClient|SERVICE_ROLE|service_role/.test(src), 'service role を使わない（D-L7）');
    check(/auth\.getUser\(\)/.test(src), 'userId は server auth から取得する');
    check(!/req\.json|request\.json|body\.userId/.test(src), 'request body の userId を受け取らない');
    check(/is_anonymous/.test(src), 'anonymous user を除外する');
  }

  console.log('[11] 静的 guard: rowMappers は環境非依存の純関数');
  {
    const raw = readFileSync(join(ROOT, 'lib/careerSourceData/rowMappers.ts'), 'utf8');
    // 解説コメントに "use client" / server-only という語が出るため、コメント行を除いた実コードで判定する。
    const src = raw
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    check(!/'use client'|"use client"/.test(src), "'use client' directive を持たない");
    check(!/server-only/.test(src), 'server-only import を持たない');
    check(!/getBrowserSupabaseClient|createServerClient|@supabase\//.test(src), 'Supabase client に依存しない');
    check(!/process\.env/.test(src), 'env を読まない');
    // client mirror が共有 mapper を使っている（二重実装の再発防止）。
    for (const rel of [
      'lib/supabase/careerValues.ts',
      'lib/supabase/careerSelfAnalysis.ts',
      'lib/supabase/careerEs.ts',
      'lib/supabase/careerInterview.ts',
    ]) {
      const mirror = readFileSync(join(ROOT, rel), 'utf8');
      check(/careerSourceData\/rowMappers/.test(mirror), `${rel} が共有 mapper を使う`);
    }
  }

  console.log('');
  console.log(failures === 0 ? 'career-source-reader-qa: ALL PASS' : `career-source-reader-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
