/*
 * scripts/career-self-analysis-revision-qa.ts
 *
 * PASSAI CAREER — 自己分析「過去の結果を更新する」（revision lineage）QA
 * （dev-only / 実 Claude API・Supabase 非接続）。
 *
 * 背景:
 *   自己分析の更新は **既存ログの UPDATE ではなく revision の追記** で表現する。
 *   これにより (a) 過去 revision が 1 件も失われず、(b) Data Spine / downstream の
 *   「最新 = 先頭 / created_at 降順」ロジックを変えずに最新版へ切り替わる。
 *   lineage は log id（= career_self_analysis_results.client_id）に埋め、備考は userInput
 *   （= user_input 列）に入れるため、schema 変更なしで mirror を往復する。
 *
 * 検証項目（依頼の Case A〜F に対応）:
 *   1. lineage id の parse / build（既存 uuid は revision 1 として解釈される）
 *   2. collapse は revision 無しデータでは入力配列をそのまま返す（既存出力 byte 一致）
 *   3. collapse は lineage ごとに最新 revision だけを残す（順序保持）
 *   4. Case D — 更新後も更新前のログが canonical 配列から消えない
 *   5. Case E — Layer 2 projection / downstream [0] が最新 revision を指す
 *   6. Case F — 複数回更新しても revision 1→2→3 の関係が壊れない
 *   7. prompt — 更新でなければ system prompt は従来と byte 一致 / 更新ならベースと備考を含む
 *   8. idempotency — revisionOf 無しは key 不変 / 更新ごとに key が分かれる
 *   9. mirror 往復 — row mapper と Source-Sync revision が lineage を保持する
 *  10. 過去 revision は Layer 1 に残り続ける（collapse は削除ではない）
 *  11. ユーザー向け履歴モデル（自己分析ログ = lineage 1 件。revision は数えない）
 *
 * 使い方: npx tsx scripts/career-self-analysis-revision-qa.ts
 * 終了コード: 全 PASS → 0 / 1 件でも FAIL → 1。
 */

import {
  SELF_ANALYSIS_REVISION_SEPARATOR,
  buildSelfAnalysisRevisionId,
  collapseSelfAnalysisRevisions,
  latestSelfAnalysisRevision,
  nextSelfAnalysisRevision,
  parseSelfAnalysisLogId,
  selectSelfAnalysisLineage,
} from '../lib/careerSelfAnalysis/revisionLineage';
import {
  buildSelfAnalysisEntries,
  entrySummaryLabel,
  findSelfAnalysisEntry,
} from '../app/career/self-analysis/logEntries';
import { buildSelfAnalysisPastSummaries } from '../lib/careerSelfAnalysis/pastLogSummary';
import { buildSelfAnalysisMemorySection } from '../lib/careerMemory/persistence/rebuild';
import { buildSelfAnalysisHistory } from '../lib/careerConsultation/historySnapshots';
import {
  buildSelfAnalysisMessages,
  normalizeRevisionInput,
  renderRevisionInstruction,
  type SelfAnalysisSummaryInput,
} from '../lib/careerSelfAnalysis/summaryPrompt';
import { buildSelfAnalysisIdentity } from '../lib/careerGenerationJob/idempotency';
import { rowToCareerSelfAnalysisLog } from '../lib/careerSourceData/rowMappers';
import { computeSourceSyncRevision } from '../lib/careerSourceSync/revision';
import type { CareerSourceBundle } from '../lib/careerSourceData/types';
import type {
  CareerSelfAnalysisLog,
  CareerSelfAnalysisResult,
} from '../types/careerSelfAnalysis';

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('career-self-analysis-revision-qa');

// ── fixtures ────────────────────────────────────────────────────────
const ROOT_A = '11111111-1111-4111-8111-111111111111';
const ROOT_B = '22222222-2222-4222-8222-222222222222';

function result(tag: string): CareerSelfAnalysisResult {
  return {
    summary: `${tag} の全体所感`,
    strengths: [`${tag} 強み`],
    weaknesses: [`${tag} 弱み`],
    gakuchikaIdeas: [`${tag} ガクチカ`],
    selfPrIdeas: [`${tag} 自己PR`],
    esAngles: [`${tag} ES切り口`],
    interviewQuestions: [`${tag} 想定質問`],
    nextActions: [`${tag} 次アクション`],
    careerDirection: `${tag} の方向性`,
    recommendedIndustries: [`${tag} 業界`],
    recommendedJobs: [`${tag} 職種`],
    suitableEnvironment: [`${tag} 環境`],
    valueKeywords: [`${tag}価値観`],
    strengthKeywords: [`${tag}強み語`],
    motivationSources: [`${tag} 動機`],
    stressFactors: [`${tag} ストレス`],
    companySelectionCriteria: [`${tag} 企業条件`],
    developmentPoints: [`${tag} 伸びしろ`],
  };
}

function log(id: string, createdAt: string, tag: string, userInput = ''): CareerSelfAnalysisLog {
  return { id, createdAt, userInput, result: result(tag) };
}

// 新規 2 件（revision 無し。既存ユーザー相当）。canonical は「先頭が最新」。
const NO_REVISION: CareerSelfAnalysisLog[] = [
  log(ROOT_B, '2026-08-02T00:00:00.000Z', 'B1'),
  log(ROOT_A, '2026-08-01T00:00:00.000Z', 'A1'),
];

// A を 2 回更新した状態（appendSelfAnalysisLog は先頭へ積むので新しい版が先頭）。
const WITH_REVISIONS: CareerSelfAnalysisLog[] = [
  log(buildSelfAnalysisRevisionId(ROOT_A, 3), '2026-08-04T00:00:00.000Z', 'A3', '3回目の備考'),
  log(buildSelfAnalysisRevisionId(ROOT_A, 2), '2026-08-03T00:00:00.000Z', 'A2', '2回目の備考'),
  log(ROOT_B, '2026-08-02T00:00:00.000Z', 'B1'),
  log(ROOT_A, '2026-08-01T00:00:00.000Z', 'A1'),
];

// ── 1. lineage id の parse / build ──────────────────────────────────
check('1a 既存 uuid は revision 1 の起点として解釈される', (() => {
  const p = parseSelfAnalysisLogId(ROOT_A);
  return p.rootId === ROOT_A && p.revision === 1;
})());
check('1b revision id を parse すると rootId / revision に戻る', (() => {
  const p = parseSelfAnalysisLogId(buildSelfAnalysisRevisionId(ROOT_A, 7));
  return p.rootId === ROOT_A && p.revision === 7;
})());
check(
  '1c 区切りは uuid に現れない文字列',
  !ROOT_A.includes(SELF_ANALYSIS_REVISION_SEPARATOR),
);
check('1d 壊れた suffix は revision 1 扱い（未知 id で落ちない）', (() => {
  const p = parseSelfAnalysisLogId(`${ROOT_A}::rXX`);
  return p.revision === 1 && p.rootId === `${ROOT_A}::rXX`;
})());
check('1e 非文字列 id でも throw しない', (() => {
  const p = parseSelfAnalysisLogId(undefined);
  return p.revision === 1 && p.rootId === '';
})());
check('1f revision 1 表記（::r1）は起点として扱う（二重採番を作らない）', (() => {
  const p = parseSelfAnalysisLogId(`${ROOT_A}::r1`);
  return p.revision === 1;
})());

// ── 2. collapse は既存データを変えない（byte 一致の根拠） ─────────────
check(
  '2a revision 無しデータでは入力配列がそのまま返る（同一参照）',
  collapseSelfAnalysisRevisions(NO_REVISION) === NO_REVISION,
);
check('2b 空配列 / null でも落ちない', (() => {
  return (
    collapseSelfAnalysisRevisions([]).length === 0 &&
    collapseSelfAnalysisRevisions(null).length === 0
  );
})());
check(
  '2c 派生（pastSummaries）は revision 無しデータで従来出力と一致',
  JSON.stringify(buildSelfAnalysisPastSummaries(NO_REVISION)) ===
    JSON.stringify(
      NO_REVISION.slice(0, 3).map((l) => buildSelfAnalysisPastSummaries([l])[0]),
    ),
);

// ── 3. collapse は lineage ごとに最新 revision だけを残す ─────────────
const collapsed = collapseSelfAnalysisRevisions(WITH_REVISIONS);
check('3a lineage 数だけ残る（A の 3 版 + B = 2 件）', collapsed.length === 2);
check(
  '3b A は最新 revision 3 が残る',
  parseSelfAnalysisLogId(collapsed[0].id).revision === 3,
);
check('3c 元の並び順（新しい順）が保たれる', collapsed[1].id === ROOT_B);
check(
  '3d 同じ自己分析が複数件として数えられない（重複人格化の防止）',
  new Set(collapsed.map((l) => parseSelfAnalysisLogId(l.id).rootId)).size === collapsed.length,
);

// ── 4. Case D — 履歴保持 ────────────────────────────────────────────
check(
  '4a 更新後も更新前のログが canonical 配列に残る（rev1 / rev2 / rev3 すべて存在）',
  [ROOT_A, buildSelfAnalysisRevisionId(ROOT_A, 2), buildSelfAnalysisRevisionId(ROOT_A, 3)].every(
    (id) => WITH_REVISIONS.some((l) => l.id === id),
  ),
);
check(
  '4b collapse は削除ではない（元配列は 4 件のまま）',
  WITH_REVISIONS.length === 4,
);
check('4c lineage を辿ると全版を新しい順に取得できる', (() => {
  const lineage = selectSelfAnalysisLineage(WITH_REVISIONS, ROOT_A);
  return (
    lineage.length === 3 &&
    lineage.map((l) => parseSelfAnalysisLogId(l.id).revision).join(',') === '3,2,1'
  );
})());
check('4d 更新前の結果内容が失われていない', (() => {
  const lineage = selectSelfAnalysisLineage(WITH_REVISIONS, ROOT_A);
  return lineage[2].result.summary === 'A1 の全体所感';
})());
check('4e 各版の備考が保持される（userInput 経由で mirror を往復する field）', (() => {
  const lineage = selectSelfAnalysisLineage(WITH_REVISIONS, ROOT_A);
  return lineage[0].userInput === '3回目の備考' && lineage[1].userInput === '2回目の備考';
})());

// ── 5. Case E — 最新版取得（Data Spine / downstream） ────────────────
const section = buildSelfAnalysisMemorySection(WITH_REVISIONS);
const payload = section.section.payload as {
  meta: { sourceCount: number };
  latest: Array<{ summary: string }>;
};
check('5a Layer 2 projection の latest[0] が最新 revision', payload.latest[0].summary === 'A3 の全体所感');
check(
  '5b Layer 2 の件数は lineage 数（版を別々の自己分析として数えない）',
  payload.meta.sourceCount === 2,
);
check(
  '5c Layer 2 に古い版が「別の自己分析」として混ざらない',
  !payload.latest.some((l) => l.summary === 'A1 の全体所感' || l.summary === 'A2 の全体所感'),
);
check(
  '5d downstream の [0]（interview / matching / presentation）は最新 revision',
  WITH_REVISIONS[0].result.summary === 'A3 の全体所感',
);
check(
  '5e server 読み（created_at DESC）でも [0] は最新 revision',
  [...WITH_REVISIONS].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0].result.summary ===
    'A3 の全体所感',
);
check(
  '5f 相談AI 履歴も lineage ごとに最新版 1 件',
  buildSelfAnalysisHistory(WITH_REVISIONS).length === 2,
);
check(
  '5g 自己分析 prompt の過去ログも lineage ごとに最新版 1 件',
  buildSelfAnalysisPastSummaries(WITH_REVISIONS).length === 2,
);
check(
  '5h Layer 2 の sourceUpdatedAt は最新 revision の生成時刻',
  section.sourceUpdatedAt === '2026-08-04T00:00:00.000Z',
);

// ── 6. Case F — 複数回更新しても lineage が壊れない ──────────────────
check('6a 次の revision 番号は最大 + 1', nextSelfAnalysisRevision(WITH_REVISIONS, ROOT_A) === 4);
check('6b 未更新 lineage の次は 2', nextSelfAnalysisRevision(WITH_REVISIONS, ROOT_B) === 2);
check('6c 未知 root でも 2 から始まる（採番が 1 に戻らない）', nextSelfAnalysisRevision(WITH_REVISIONS, 'unknown') === 2);
check('6d 現在の最大 revision を返す', latestSelfAnalysisRevision(WITH_REVISIONS, ROOT_A) === 3);
check('6e 3 回目の更新を追記しても関係が壊れない', (() => {
  const next = nextSelfAnalysisRevision(WITH_REVISIONS, ROOT_A);
  const appended = [
    log(buildSelfAnalysisRevisionId(ROOT_A, next), '2026-08-05T00:00:00.000Z', 'A4'),
    ...WITH_REVISIONS,
  ];
  const lineage = selectSelfAnalysisLineage(appended, ROOT_A);
  return (
    lineage.map((l) => parseSelfAnalysisLogId(l.id).revision).join(',') === '4,3,2,1' &&
    collapseSelfAnalysisRevisions(appended).length === 2 &&
    (collapseSelfAnalysisRevisions(appended)[0].result.summary === 'A4 の全体所感')
  );
})());
check(
  '6f 別 lineage の更新は互いに干渉しない',
  (() => {
    const appended = [
      log(buildSelfAnalysisRevisionId(ROOT_B, 2), '2026-08-06T00:00:00.000Z', 'B2'),
      ...WITH_REVISIONS,
    ];
    const c = collapseSelfAnalysisRevisions(appended);
    return (
      c.length === 2 &&
      c.some((l) => l.result.summary === 'B2 の全体所感') &&
      c.some((l) => l.result.summary === 'A3 の全体所感')
    );
  })(),
);

// ── 7. prompt ───────────────────────────────────────────────────────
const BASE_INPUT: SelfAnalysisSummaryInput = {
  profile: { university: 'テスト大学' } as SelfAnalysisSummaryInput['profile'],
  activity: {
    academics: { seminar: 'テーマ' },
  } as unknown as SelfAnalysisSummaryInput['activity'],
  values: null,
  userInput: '',
  conversation: [],
  pastSummaries: [],
};
const plain = buildSelfAnalysisMessages(BASE_INPUT);
const plainWithNullRevision = buildSelfAnalysisMessages({ ...BASE_INPUT, revisionOf: null });
check(
  '7a revisionOf 未指定 / null の system prompt は byte 一致（新規生成は不変）',
  plain.system === plainWithNullRevision.system && plain.user === plainWithNullRevision.user,
);
check('7b 更新でない prompt には更新指示が含まれない', !plain.system.includes('既存の自己分析の「更新」'));

const REVISION_INPUT = {
  rootId: ROOT_A,
  revision: 2,
  baseCreatedAt: '2026-08-01T00:00:00.000Z',
  base: result('A1'),
  note: 'インターンの経験を反映してほしい',
};
const updated = buildSelfAnalysisMessages({ ...BASE_INPUT, revisionOf: REVISION_INPUT });
check('7c 更新 prompt に更新タスクの指示が入る', updated.system.includes('既存の自己分析の「更新」'));
check('7d 更新 prompt にベース結果の全体所感が入る', updated.system.includes('A1 の全体所感'));
check('7e 更新 prompt にベース結果の各 field が入る', updated.system.includes('A1 企業条件'));
check('7f 更新 prompt にユーザーの備考が入る', updated.system.includes('インターンの経験を反映してほしい'));
check(
  '7g ゼロから作り直さない指示が入っている',
  updated.system.includes('ゼロから別の自己分析を作り直すのではなく'),
);
check('7h 出力は全文（差分ではない）と明示している', updated.system.includes('差分ではなく'));
check('7i 出力スキーマ指示は共通のまま（contract 非破壊）', updated.system.includes('"careerDirection"'));

// normalize（API body の防御正規化）
check('7j 不正な revisionOf は null（新規生成にフォールバック）', (() => {
  return (
    normalizeRevisionInput(null) === null &&
    normalizeRevisionInput({}) === null &&
    normalizeRevisionInput({ rootId: ROOT_A, revision: 1, base: result('X') }) === null &&
    normalizeRevisionInput({ rootId: '', revision: 2, base: result('X') }) === null
  );
})());
check(
  '7k ベース結果が空同然なら null（更新の土台が無い）',
  normalizeRevisionInput({ rootId: ROOT_A, revision: 2, base: {}, note: 'x' }) === null,
);
check('7l 正常な revisionOf は正規化されて通る', (() => {
  const n = normalizeRevisionInput({ ...REVISION_INPUT, revision: '2' });
  return !!n && n.revision === 2 && n.rootId === ROOT_A && n.note === REVISION_INPUT.note;
})());
check(
  '7m renderRevisionInstruction は更新でなければ null（結合に影響しない）',
  renderRevisionInstruction(null) === null,
);

// ── 8. idempotency ─────────────────────────────────────────────────
const identityArgs = {
  userId: 'user-1',
  feature: 'self_analysis',
  operation: 'summary',
  profile: BASE_INPUT.profile,
  activity: BASE_INPUT.activity,
  values: null,
  conversation: [],
  promptRevision: 'p1',
  outputSchemaRevision: 's1',
  model: 'm1',
};
const keyPlain = buildSelfAnalysisIdentity(identityArgs).idempotencyKey;
const keyNullRevision = buildSelfAnalysisIdentity({ ...identityArgs, revisionOf: null }).idempotencyKey;
check('8a revisionOf 無し / null の key は同一（既存 flow の key が変わらない）', keyPlain === keyNullRevision);

const keyRev2 = buildSelfAnalysisIdentity({ ...identityArgs, revisionOf: REVISION_INPUT }).idempotencyKey;
check('8b 更新生成の key は新規生成と別', keyRev2 !== keyPlain);
check(
  '8c 備考が違えば key が分かれる（前回結果の再利用を防ぐ）',
  buildSelfAnalysisIdentity({
    ...identityArgs,
    revisionOf: { ...REVISION_INPUT, note: '別の備考' },
  }).idempotencyKey !== keyRev2,
);
check(
  '8d 版番号が違えば key が分かれる（2 回目以降の更新が dedupe されない）',
  buildSelfAnalysisIdentity({
    ...identityArgs,
    revisionOf: { ...REVISION_INPUT, revision: 3 },
  }).idempotencyKey !== keyRev2,
);
check(
  '8e ベース結果が違えば key が分かれる',
  buildSelfAnalysisIdentity({
    ...identityArgs,
    revisionOf: { ...REVISION_INPUT, base: result('A2') },
  }).idempotencyKey !== keyRev2,
);
check(
  '8f 同一入力なら key は決定的（連打・reload で重複生成しない）',
  buildSelfAnalysisIdentity({ ...identityArgs, revisionOf: REVISION_INPUT }).idempotencyKey ===
    keyRev2,
);

// ── 9. mirror 往復（schema 変更なしで lineage が保持される） ──────────
const mirrored = WITH_REVISIONS.map((l) =>
  rowToCareerSelfAnalysisLog({
    client_id: l.id,
    user_input: l.userInput,
    result: l.result,
    created_at: l.createdAt,
  }),
);
check(
  '9a client_id 経由で lineage が往復する（rowMapper 変更なし）',
  JSON.stringify(mirrored.map((l) => parseSelfAnalysisLogId(l.id))) ===
    JSON.stringify(WITH_REVISIONS.map((l) => parseSelfAnalysisLogId(l.id))),
);
check(
  '9b user_input 経由で備考が往復する',
  mirrored[0].userInput === '3回目の備考',
);
check(
  '9c mirror 由来ログでも collapse / latest が client と同じ結果になる',
  JSON.stringify(buildSelfAnalysisPastSummaries(mirrored)) ===
    JSON.stringify(buildSelfAnalysisPastSummaries(WITH_REVISIONS)),
);

function bundle(logs: CareerSelfAnalysisLog[]): CareerSourceBundle {
  return { selfAnalysisLogs: logs } as unknown as CareerSourceBundle;
}
check(
  '9d 更新を追記すると Source-Sync revision が変わる（stale mirror を fresh と誤認しない）',
  computeSourceSyncRevision('self_analysis', bundle(NO_REVISION)) !==
    computeSourceSyncRevision('self_analysis', bundle(WITH_REVISIONS)),
);
check(
  '9e 同一内容なら client / server で Source-Sync revision が一致する（veto されない）',
  computeSourceSyncRevision('self_analysis', bundle(WITH_REVISIONS)) ===
    computeSourceSyncRevision('self_analysis', bundle(mirrored)),
);

// ── 10. 過去 revision は削除されない ────────────────────────────────
check(
  '10a Layer 1（canonical 配列）は collapse の影響を受けない',
  collapseSelfAnalysisRevisions(WITH_REVISIONS) !== WITH_REVISIONS &&
    WITH_REVISIONS.length === 4,
);
check(
  '10b 更新は同じ client_id を上書きしない（別レコードとして insert される）',
  new Set(WITH_REVISIONS.map((l) => l.id)).size === WITH_REVISIONS.length,
);

// ── 11. ユーザー向け履歴モデル（自己分析ログ = lineage 1 件） ──────────
// revision は「自己分析ログ」として数えず、各ログは current result のみを見せる。
// UI（hub の件数 / ログ一覧 / 結果画面）はすべてこの派生を通る。
const entriesNoRevision = buildSelfAnalysisEntries(NO_REVISION);
const entriesWithRevisions = buildSelfAnalysisEntries(WITH_REVISIONS);

check('11a A — 初回生成のみなら 1 件（1 lineage = 1 ログ）', buildSelfAnalysisEntries([log(ROOT_A, '2026-08-01T00:00:00.000Z', 'A1')]).length === 1);
check(
  '11b B — 情報を追加して更新しても件数は 1 件のまま',
  buildSelfAnalysisEntries(
    selectSelfAnalysisLineage(WITH_REVISIONS, ROOT_A),
  ).length === 1,
);
check(
  '11c F — もう一度新しく自己分析すると 2 件になる',
  entriesWithRevisions.length === 2 && entriesNoRevision.length === 2,
);
check(
  '11d D/G — 各ログの current は最新 revision の結果',
  entriesWithRevisions[0].current.result.summary === 'A3 の全体所感' &&
    entriesWithRevisions[1].current.result.summary === 'B1 の全体所感',
);
check(
  '11e 作成日時は初回生成（revision 1）の時刻',
  entriesWithRevisions[0].createdAt === '2026-08-01T00:00:00.000Z',
);
check(
  '11f 最終更新日時は最新 revision の時刻（更新済みのときだけ）',
  entriesWithRevisions[0].updatedAt === '2026-08-04T00:00:00.000Z' &&
    entriesWithRevisions[1].updatedAt === null,
);
check(
  '11g 更新前の結果はユーザー向け一覧に別ログとして現れない',
  !entriesWithRevisions.some((e) =>
    ['A1 の全体所感', 'A2 の全体所感'].includes(e.current.result.summary),
  ),
);
check(
  '11h rootId で 1 件を選べる（一覧 → 結果画面の受け渡し）',
  findSelfAnalysisEntry(entriesWithRevisions, ROOT_A)?.current.result.summary ===
    'A3 の全体所感' &&
    findSelfAnalysisEntry(entriesWithRevisions, 'unknown') === null &&
    findSelfAnalysisEntry(entriesWithRevisions, null) === null,
);
check(
  '11i H — 派生は非破壊（内部 revision lineage は 4 件のまま辿れる）',
  WITH_REVISIONS.length === 4 && selectSelfAnalysisLineage(WITH_REVISIONS, ROOT_A).length === 3,
);
check('11j 空 / null でも落ちない', (() => {
  return buildSelfAnalysisEntries([]).length === 0 && buildSelfAnalysisEntries(null).length === 0;
})());
check(
  '11k 一覧の識別ラベルは要約（空なら fallback 表示）',
  entrySummaryLabel(entriesWithRevisions[0]) === 'A3 の全体所感' &&
    entrySummaryLabel({
      ...entriesWithRevisions[0],
      current: { ...entriesWithRevisions[0].current, result: { ...result('X'), summary: '  ' } },
    }) === '（要約なし）',
);

console.log(`\n結果: PASS ${passes} / FAIL ${failures}`);
process.exit(failures > 0 ? 1 : 0);
