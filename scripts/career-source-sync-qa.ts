/*
 * scripts/career-source-sync-qa.ts
 *
 * PASSAI CAREER — D-R2 closure の土台: source-sync revision と wire signal の QA
 *   （dev-only・純関数・実 Supabase 非接続）。
 *
 * 何を守るか:
 *   [1] ★最重要★ mirror 往復不変性:
 *       client domain → Supabase mirror row → rowMappers → domain で sync revision が **変わらない**。
 *       ここが壊れると恒久 mismatch になり Personal Memory が永久に veto される（機能が無効化される）。
 *       timestamptz の表記揺れ / values.updated_at の trigger 上書き / ES の meta 非保存 field を含めて検証する。
 *   [2] 内容が変われば revision も変わる（stale を verified と誤認しない = 安全方向）。
 *   [3] 正規化の健全性: 同一時刻の表記揺れのみを吸収し、異なる時刻は区別する。
 *   [4] wire format の直列化 / parse 往復。
 *   [5] parse の default deny: 未設定 / 長すぎ / 未知 version / 未知 kind / 不正値 / 重複 / 件数超過。
 *   [6] verifySourceSync の優先順位（unreadable > unclaimed > mismatch > verified）。
 *   [7] trust model 静的 guard: signal を DB selector / user_id / content 生成に使っていない。
 *   [8] signal に PII / 生データが含まれない（8 hex token のみ）。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-source-sync-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeSourceSyncRevision,
  computeSourceSyncRevisions,
  CAREER_SOURCE_SYNC_VERSION,
} from '@/lib/careerSourceSync/revision';
import {
  parseSourceSyncSignal,
  serializeSourceSyncSignal,
  verifySourceSync,
  allSourcesVerified,
  summarizeVetoReason,
  isSourceUsable,
  CAREER_SOURCE_SYNC_MAX_LENGTH,
  EMPTY_SOURCE_SYNC_SIGNAL,
} from '@/lib/careerSourceSync/signal';
import {
  careerEsLogToMeta,
  rowToCareerValues,
  rowToCareerEsLog,
  rowToCareerSelfAnalysisLog,
  rowToCareerInterviewResult,
  rowToCareerProfile,
  rowToCareerActivity,
} from '@/lib/careerSourceData/rowMappers';
import type { CareerEsLog } from '@/types/careerEs';
import { SECTION_SOURCE_KINDS } from '@/lib/careerMemory/persistence/sourceProjection';
import { normalizeCareerEsResult } from '@/lib/careerEs/resultShape';
import {
  PERSONAL_MEMORY_SYNC_KINDS,
  BASE_CONTEXT_SYNC_KINDS,
} from '@/lib/careerSourceSync/kinds';
import { BASE_CONTEXT_SOURCE_KINDS } from '@/lib/careerServerContext/baseContextPolicy';
import {
  CAREER_SOURCE_KINDS,
  EMPTY_CAREER_SOURCE_BUNDLE,
  emptySourceStatuses,
  type CareerSourceBundle,
  type CareerSourceKind,
} from '@/lib/careerSourceData/types';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// Postgres timestamptz が返す表記（client の toISOString とは違う）。
const PG_TS = '2026-07-02T00:00:00+00:00';
const CLIENT_TS = '2026-07-02T00:00:00.000Z';

const PROFILE = {
  name: '山田太郎', grade: 'B3', graduationYear: '2027',
  preferences: [{ university: '東京大学', faculty: '工学部' }],
  targetIndustries: ['IT'], strengths: ['実行力'],
};
const ACTIVITY = {
  focusedActivities: [{ id: 'a1', title: 'インターン', period: { from: '2025-04', to: '2025-09' } }],
  updatedAt: CLIENT_TS,
};
const VALUES = {
  selections: {
    priorities: ['成長'], avoidances: [], industries: ['IT'], jobTypes: [],
    workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [],
  },
  notes: {
    priorities: '備考', avoidances: '', industries: '', jobTypes: '',
    workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '',
  },
  overallNote: '総合', updatedAt: CLIENT_TS,
};
const SELF_LOGS = [{ id: 'sa-1', createdAt: CLIENT_TS, userInput: 'in', result: { summary: 's', strengths: ['計画性'] } }];
// ★ Audit P1-A 以降、body / review / groupId / version / mode / deepDive も meta へ往復する
//   （careerEsLogToMeta ⇄ rowToCareerEsLog）。fixture もその実態に合わせる。
// ★ client canonical は `loadEsLogs()` → `normalizeEsLog` を通るため、result は必ず
//   canonical shape（4 string + 3 list、欠損は '' / []）に、deepDive は
//   `normalizeCareerEsDeepDive` の出力形（turns 必須 / memo・materials は存在時のみ）になる。
//   fixture もその実態に合わせる（生の部分オブジェクトは client 側に存在しない形）。
//   `createEsWorkspaceLog` も `{ ...emptyEsResult(), answer: body }` を保存する。
const ES_LOGS = [{
  id: 'es-1', createdAt: CLIENT_TS, userInput: '',
  result: normalizeCareerEsResult({ answer: '本文' }),
  body: '本文', mode: 'write', groupId: 'es-1', version: 1,
  deepDive: {
    turns: [{ role: 'question', content: 'なぜ取り組んだ？' }, { role: 'answer', content: '理由' }],
    memo: ['整理メモ'],
  },
  review: { overallScore: 72, rank: 'B', overallComment: '総評', breakdown: { logic: 72, specificity: 72, originality: 72, readability: 72, persuasion: 72, companyFit: 72 }, strengths: ['S'], improvements: ['I'], missingElements: ['M'], recruiterComments: ['R'], priorityActions: ['P'] },
  companyName: 'A社', question: '設問', charLimit: 400, selectionType: 'main',
  favorite: true, submitted: false,
}];
const INTERVIEW = [{
  id: 'iv-1', createdAt: CLIENT_TS, mode: 'real', interviewType: 'personal',
  turns: [{ role: 'question', content: 'q' }], result: { overallComment: 'c' },
}];

const CLIENT_BUNDLE = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  profile: PROFILE, activity: ACTIVITY, values: VALUES,
  selfAnalysisLogs: SELF_LOGS, esLogs: ES_LOGS, interviewResults: INTERVIEW,
} as unknown as CareerSourceBundle;

// client domain → mirror row（lib/supabase/career*.ts の upsert 形）→ rowMappers → domain。
const MIRROR_BUNDLE = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  profile: rowToCareerProfile({ data: PROFILE, updated_at: PG_TS }),
  activity: rowToCareerActivity({ data: ACTIVITY, updated_at: PG_TS }),
  values: rowToCareerValues({
    priorities: VALUES.selections.priorities, avoidances: [], industries: ['IT'],
    job_types: [], work_styles: [], company_types: [], career_goals: [], culture_preferences: [],
    notes: VALUES.notes, overall_note: VALUES.overallNote,
    updated_at: PG_TS, // ★ DB trigger が now() で上書きする（client 値と一致しない）
  }),
  selfAnalysisLogs: SELF_LOGS.map((l) => rowToCareerSelfAnalysisLog({
    client_id: l.id, user_input: l.userInput, result: l.result, created_at: PG_TS,
  })),
  // ★ meta は **実際の write mapper**（careerEsLogToMeta）で組む。手で組み直すと
  //   write 側の落ちを QA が検出できない（Audit P1-A の meta 欠落が長く残った原因）。
  esLogs: ES_LOGS.map((l) => rowToCareerEsLog({
    client_id: l.id, user_input: l.userInput, result: l.result, edited_result: null,
    favorite: l.favorite, submitted: l.submitted,
    meta: careerEsLogToMeta(l as unknown as CareerEsLog),
    created_at: PG_TS,
  })),
  interviewResults: INTERVIEW.map((l) => rowToCareerInterviewResult({
    client_id: l.id, mode: l.mode, interview_type: l.interviewType, turns: l.turns,
    result: l.result, company_research_log_id: null, company_research_snapshot: null, created_at: PG_TS,
  })),
} as unknown as CareerSourceBundle;

function main() {
  console.log('[1] ★ mirror 往復不変性（これが壊れると Memory が永久 veto される）');
  {
    for (const kind of CAREER_SOURCE_KINDS) {
      const a = computeSourceSyncRevision(kind, CLIENT_BUNDLE);
      const b = computeSourceSyncRevision(kind, MIRROR_BUNDLE);
      check(a === b, `${kind}: client と mirror 往復後で revision 一致`, `${a} vs ${b}`);
    }
    // ★ 追加の安全網: ES result が壊れた形（DDL 既定の `{}` など）でも、
    //   client 正規化（esStorage.normalizeEsLog → normalizeCareerEsResult）と
    //   mirror 正規化（rowToCareerEsLog → normalizeCareerEsResult）が **同じ shape** を
    //   作ることを固定する。ここが非対称になると revision が永久に一致せず、
    //   Personal Memory が恒久 veto される（この QA の存在理由そのもの）。
    for (const raw of [{}, { answer: '本文' }, { gakuchika: 'G' }] as unknown[]) {
      const clientSide = [{ id: 'sym-1', createdAt: CLIENT_TS, userInput: '', result: normalizeCareerEsResult(raw), favorite: false, submitted: false }];
      const mirrorSide = [rowToCareerEsLog({
        client_id: 'sym-1', user_input: '', result: raw, edited_result: null,
        favorite: false, submitted: false, meta: {}, created_at: CLIENT_TS,
      } as never)];
      const ra = computeSourceSyncRevision('es', { ...EMPTY_CAREER_SOURCE_BUNDLE, esLogs: clientSide } as unknown as CareerSourceBundle);
      const rb = computeSourceSyncRevision('es', { ...EMPTY_CAREER_SOURCE_BUNDLE, esLogs: mirrorSide } as unknown as CareerSourceBundle);
      check(ra === rb, `es: 壊れた result（${JSON.stringify(raw)}）でも client/mirror 正規化が対称`, `${ra} vs ${rb}`);
    }
    check(
      computeSourceSyncRevision('values', CLIENT_BUNDLE) === computeSourceSyncRevision('values', MIRROR_BUNDLE),
      'values.updatedAt（DB trigger 上書き）が revision に影響しない',
    );
    check(
      computeSourceSyncRevision('es', CLIENT_BUNDLE) === computeSourceSyncRevision('es', MIRROR_BUNDLE),
      'ES の body/review/groupId/version/mode/deepDive が meta 往復後も revision 一致（P1-A）',
    );
    // ★ P1-A 回帰: これらが meta から落ちると別端末 restore で添削・版履歴・深掘りが失われ、
    //   現行 ES が LegacyView へ誤降格する。write mapper 側の欠落を直接固定する。
    {
      const meta = careerEsLogToMeta(ES_LOGS[0] as unknown as CareerEsLog);
      for (const key of ['body', 'review', 'groupId', 'version', 'mode', 'deepDive']) {
        check(meta[key] !== undefined, `es meta が ${key} を往復させる`);
      }
    }
  }

  console.log('[2] 内容差は必ず revision 差になる（安全方向）');
  {
    const cases: Array<[string, CareerSourceKind, CareerSourceBundle]> = [
      ['self_analysis: result 変更', 'self_analysis', { ...CLIENT_BUNDLE, selfAnalysisLogs: [{ ...SELF_LOGS[0], result: { summary: 'X' } }] } as unknown as CareerSourceBundle],
      ['self_analysis: 1 件削除', 'self_analysis', { ...CLIENT_BUNDLE, selfAnalysisLogs: [] } as unknown as CareerSourceBundle],
      ['self_analysis: 1 件追加', 'self_analysis', { ...CLIENT_BUNDLE, selfAnalysisLogs: [...SELF_LOGS, { id: 'sa-2', createdAt: '2026-08-01T00:00:00.000Z', userInput: '', result: {} }] } as unknown as CareerSourceBundle],
      ['es: companyName 変更', 'es', { ...CLIENT_BUNDLE, esLogs: [{ ...ES_LOGS[0], companyName: 'B社' }] } as unknown as CareerSourceBundle],
      ['es: favorite トグル', 'es', { ...CLIENT_BUNDLE, esLogs: [{ ...ES_LOGS[0], favorite: false }] } as unknown as CareerSourceBundle],
      ['values: 選択変更', 'values', { ...CLIENT_BUNDLE, values: { ...VALUES, selections: { ...VALUES.selections, priorities: ['安定'] } } } as unknown as CareerSourceBundle],
      ['profile: 志望業界変更', 'profile', { ...CLIENT_BUNDLE, profile: { ...PROFILE, targetIndustries: ['金融'] } } as unknown as CareerSourceBundle],
      ['activity: 追加', 'activity', { ...CLIENT_BUNDLE, activity: { ...ACTIVITY, focusedActivities: [] } } as unknown as CareerSourceBundle],
      ['interview: result 変更', 'interview', { ...CLIENT_BUNDLE, interviewResults: [{ ...INTERVIEW[0], result: { overallComment: 'z' } }] } as unknown as CareerSourceBundle],
    ];
    for (const [label, kind, changed] of cases) {
      check(
        computeSourceSyncRevision(kind, CLIENT_BUNDLE) !== computeSourceSyncRevision(kind, changed),
        `${label} → revision が変わる`,
      );
    }
    // 全 Source 空 = 削除済み状態も別 revision。
    check(
      computeSourceSyncRevision('self_analysis', EMPTY_CAREER_SOURCE_BUNDLE) !==
        computeSourceSyncRevision('self_analysis', CLIENT_BUNDLE),
      '削除済み（空）と非空で revision が異なる',
    );
  }

  console.log('[3] タイムスタンプ正規化の健全性');
  {
    const mk = (ts: string) => ({ ...EMPTY_CAREER_SOURCE_BUNDLE, selfAnalysisLogs: [{ id: 'x', createdAt: ts, userInput: '', result: {} }] } as unknown as CareerSourceBundle);
    check(
      computeSourceSyncRevision('self_analysis', mk('2026-07-02T00:00:00.000Z')) ===
        computeSourceSyncRevision('self_analysis', mk('2026-07-02T00:00:00+00:00')),
      '同一時刻の表記揺れは吸収する',
    );
    check(
      computeSourceSyncRevision('self_analysis', mk('2026-07-02T00:00:00.000Z')) !==
        computeSourceSyncRevision('self_analysis', mk('2026-07-02T00:00:01.000Z')),
      '1 秒違えば別 revision（過剰正規化していない）',
    );
    // 日付のみの文字列（活動期間などのユーザー入力）は時刻成分が無いので触らない。
    const p1 = { ...EMPTY_CAREER_SOURCE_BUNDLE, activity: { focusedActivities: [{ period: { from: '2025-04-01' } }] } } as unknown as CareerSourceBundle;
    const p2 = { ...EMPTY_CAREER_SOURCE_BUNDLE, activity: { focusedActivities: [{ period: { from: '2025-04-02' } }] } } as unknown as CareerSourceBundle;
    check(
      computeSourceSyncRevision('activity', p1) !== computeSourceSyncRevision('activity', p2),
      '日付のみのユーザー入力も区別される',
    );
  }

  console.log('[4] wire format の直列化 / parse 往復');
  {
    const revisions = computeSourceSyncRevisions(CLIENT_BUNDLE);
    const wire = serializeSourceSyncSignal(revisions);
    check(wire.startsWith(`${CAREER_SOURCE_SYNC_VERSION}:`), 'version prefix を持つ');
    check(wire.length <= CAREER_SOURCE_SYNC_MAX_LENGTH, `長さ上限内（${wire.length}B）`);
    const parsed = parseSourceSyncSignal(wire);
    for (const kind of CAREER_SOURCE_KINDS) {
      check(parsed.revisions[kind] === revisions[kind], `${kind}: 往復で一致`);
    }
  }

  console.log('[5] parse は default deny');
  {
    const bad: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['数値', 42],
      ['空文字', ''],
      ['空白のみ', '   '],
      ['version なし', 'profile=1a2b3c4d'],
      ['未知 version', 'v9:profile=1a2b3c4d'],
      ['長すぎ', `v1:${'a'.repeat(CAREER_SOURCE_SYNC_MAX_LENGTH)}`],
      ['件数超過', `v1:${CAREER_SOURCE_KINDS.map((k) => `${k}=1a2b3c4d`).join(',')},extra=1a2b3c4d`],
    ];
    for (const [label, raw] of bad) {
      const r = parseSourceSyncSignal(raw);
      check(Object.keys(r.revisions).length === 0, `${label} → 空 signal（全 kind veto）`);
    }
    // 未知 kind / 不正値は当該 entry のみ無視（他 entry は生きる）。
    const mixed = parseSourceSyncSignal('v1:profile=1a2b3c4d,bogus=1a2b3c4d,activity=ZZZZ,values=deadbeef');
    check(mixed.revisions.profile === 'v1:1a2b3c4d', '正常 entry は採用');
    check(mixed.revisions.values === 'v1:deadbeef', '正常 entry は採用（2 件目）');
    check(!('bogus' in mixed.revisions), '未知 kind は無視（allowlist）');
    check(mixed.revisions.activity === undefined, '不正値の kind は unclaimed（採用しない）');
    // 重複は最初のみ。
    const dup = parseSourceSyncSignal('v1:profile=1a2b3c4d,profile=deadbeef');
    check(dup.revisions.profile === 'v1:1a2b3c4d', '重複 kind は最初のみ採用');
    // SQL / パス注入っぽい値が通らない。
    for (const inj of ["v1:profile=' OR 1=1--", 'v1:profile=../../etc/passwd', 'v1:profile=<script>']) {
      check(Object.keys(parseSourceSyncSignal(inj).revisions).length === 0, `注入文字列を拒否: ${inj.slice(0, 22)}`);
    }
  }

  console.log('[6] verifySourceSync の優先順位と veto 集約');
  {
    const server = computeSourceSyncRevisions(CLIENT_BUNDLE);
    const okStatuses = emptySourceStatuses();
    for (const k of CAREER_SOURCE_KINDS) okStatuses[k] = 'ok';

    const good = parseSourceSyncSignal(serializeSourceSyncSignal(server));
    const v1 = verifySourceSync(good, server, okStatuses);
    check(CAREER_SOURCE_KINDS.every((k) => v1[k] === 'verified'), '一致 → 全 verified');
    check(allSourcesVerified(v1, ['profile', 'activity', 'values']), 'allSourcesVerified true');
    check(summarizeVetoReason(v1, ['profile']) === null, 'veto 理由なし');

    // mismatch
    const stale = verifySourceSync(good, { ...server, profile: 'v1:00000000' }, okStatuses);
    check(stale.profile === 'mismatch', '不一致 → mismatch');
    check(!allSourcesVerified(stale, ['profile']), 'mismatch は使用不可');

    // unclaimed
    const v3 = verifySourceSync(EMPTY_SOURCE_SYNC_SIGNAL, server, okStatuses);
    check(CAREER_SOURCE_KINDS.every((k) => v3[k] === 'unclaimed'), 'signal 無し → 全 unclaimed');
    check(!allSourcesVerified(v3, CAREER_SOURCE_KINDS), 'unclaimed は使用不可');

    // unreadable が最優先（signal が一致していても read 失敗なら使わない）
    for (const st of ['error', 'truncated', 'skipped'] as const) {
      const statuses = { ...okStatuses, profile: st };
      const v = verifySourceSync(good, server, statuses);
      check(v.profile === 'unreadable', `status=${st} → unreadable（最優先）`);
      check(summarizeVetoReason(v, ['profile', 'activity']) === 'unreadable', `status=${st} → 集約も unreadable`);
    }
    check(!isSourceUsable('mismatch') && !isSourceUsable('unclaimed') && !isSourceUsable('unreadable'), 'verified 以外は使用不可');
    check(isSourceUsable('verified'), 'verified のみ使用可');
  }

  console.log('[6b] client が送る kind と server が要求する kind の drift 防止');
  {
    // Personal Memory の 4 section が由来する Source の和集合。
    const required = new Set<string>();
    for (const kinds of Object.values(SECTION_SOURCE_KINDS)) for (const k of kinds) required.add(k);
    const sent = new Set<string>(PERSONAL_MEMORY_SYNC_KINDS);
    const missing = [...required].filter((k) => !sent.has(k)).sort();
    check(missing.length === 0, 'client が Personal Memory 由来 kind をすべて送る', missing.join(','));
    check(
      BASE_CONTEXT_SYNC_KINDS.slice().sort().join(',') === BASE_CONTEXT_SOURCE_KINDS.slice().sort().join(','),
      'base context の client/server kind 集合が一致',
    );
    // ★ 送信 kind が不足しても危険側にはならない（unclaimed → veto）ことを明示。
    const server = computeSourceSyncRevisions(CLIENT_BUNDLE);
    const okStatuses = emptySourceStatuses();
    for (const k of CAREER_SOURCE_KINDS) okStatuses[k] = 'ok';
    const partial = parseSourceSyncSignal(serializeSourceSyncSignal({ profile: server.profile }));
    const v = verifySourceSync(partial, server, okStatuses);
    check(v.profile === 'verified' && v.es === 'unclaimed', '不足 kind は unclaimed（安全側）');
  }

  console.log('[7] trust model 静的 guard');
  {
    const sig = readFileSync(join(ROOT, 'lib/careerSourceSync/signal.ts'), 'utf8');
    const code = sig.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(!/\.eq\(|\.in\(|\.from\(|supabase/i.test(code), 'signal を DB selector に使わない（Supabase API 非依存）');
    check(!/user_id|userId/.test(code), 'signal に user_id 概念を持ち込まない');
    check(!/process\.env/.test(code), 'env を読まない（純関数）');

    // reader 側: client signal が select 条件へ渡っていない。
    const server = readFileSync(join(ROOT, 'lib/careerMemory/persistence/personalMemoryReadServer.server.ts'), 'utf8');
    check(/verifySourceSync\(/.test(server), 'read path が verifySourceSync を通す');
    check(/allSourcesVerified\(/.test(server), 'read path が allSourcesVerified で veto する');
    check(!/selectSections\([^)]*syncSignal/.test(server), 'syncSignal を select 引数へ渡していない');
    check(/auth\.getUser\(\)/.test(server), 'owner は引き続き server auth 由来');
    check(!/serviceRole|SERVICE_ROLE/.test(server), 'service role を使わない');
  }

  console.log('[8] signal に PII / 生データが含まれない');
  {
    const wire = serializeSourceSyncSignal(computeSourceSyncRevisions(CLIENT_BUNDLE));
    for (const secret of ['山田太郎', '東京大学', 'A社', '設問', '本文', '備考', '総合', 'インターン']) {
      check(!wire.includes(secret), `wire に "${secret}" を含めない`);
    }
    check(/^v1:(?:[a-z_]+=[0-9a-f]{8}|[a-z_]+=invalid)(?:,[a-z_]+=(?:[0-9a-f]{8}|invalid))*$/.test(wire), 'wire は kind=8hex の羅列のみ');
  }

  console.log('');
  console.log(failures === 0 ? 'career-source-sync-qa: ALL PASS' : `career-source-sync-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
