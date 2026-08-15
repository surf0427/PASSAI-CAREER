/*
 * scripts/career-es-material-selection-qa.ts
 *
 * PASSAI CAREER — ES 深掘り「材料選択フェーズ」の決定論 QA（dev-only harness）。
 *
 * 背景:
 *   deep モードの深掘り前に「今回の設問に使えそうな既存 Career Data」を選ぶフェーズを追加した。
 *   候補列挙・prefilter・FULL/PARTIAL/NONE 判定・knownFacts / missingAxes 生成はすべて
 *   **決定論の純関数**で行い、AI には関連度の順位付けだけを任せる。
 *   本 harness はその決定論部分と後方互換（旧 draft / 旧 log / context 無し prompt）を固定する。
 *
 * 検証項目:
 *   1. 候補生成（空データ / 安定 ID / revision / 重複抑制 / 上限 / 壊れたデータ）
 *   2. prefilter（設問種別の重み・件数上限）
 *   3. 関連判定の正規化（未知 id 破棄 / clamp / 並び / 壊れた出力 fail-safe）
 *   4. coverage（FULL / PARTIAL / NONE）と軸カバレッジ（known / missing）
 *   5. draft 永続化（materials 保存・復元 / 旧 draft 互換 / schemaVersion 据え置き）
 *   6. 深掘り prompt（context 無しで byte 一致 / knownFacts 制約 / missingAxes / 未選択は載らない）
 *   7. 整理メモ prompt（context 無しで byte 一致 / 選択材料の統合指示）
 *   8. 質問数上限（既知の分だけ減る・下限を割らない）
 *
 * 使い方: npx tsx scripts/career-es-material-selection-qa.ts
 * 終了コード: 全 assertion pass → 0 / 1 件でも失敗 → 1。
 *
 * 注: safeStorage は呼び出し時に localStorage を lazily read するため、import 後に
 *     globals を差し込んでから storage 関数を呼べばよい（既存 draft storage QA と同方式）。
 */

// ── 最小 localStorage / window polyfill ──
const store = new Map<string, string>();
const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
g.window = {};
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
};

import {
  ES_MATERIAL_CANDIDATE_LIMIT,
  ES_MATERIAL_LABEL_MAX_CHARS,
  buildEsKnownFacts,
  buildEsMaterialCandidates,
  buildEsMissingAxisKeys,
  deriveEsMaterialCoverage,
  filterRelevantMaterials,
  latestEffectiveSelfAnalysisLog,
  normalizeSelectedMaterials,
  prefilterEsMaterialCandidates,
  toSelectedMaterial,
  type EsMaterialSelection,
} from '@/lib/careerEs/materialCandidates';
import { normalizeEsMaterialSelections } from '@/lib/careerEs/materialPrompt';
import {
  ES_AXIS_DEFS,
  ES_MIN_TURN_CAP,
  buildEsDeepSystem,
  buildEsFollowupUserPrompt,
  buildEsSeedUserPrompt,
  classifyEsQuestionType,
  esQuestionTurnCap,
  esTurnCapForContext,
  resolveEsAxisCoverage,
} from '@/lib/careerEs/deepDivePrompt';
import { buildEsOrganizeUserMessage } from '@/lib/careerEs/organizePrompt';
import { loadEsDraft, saveEsDraft } from '@/app/career/es/esDraftStorage';
import { ES_DRAFT_SCHEMA_VERSION, type CareerEsDraft } from '@/types/careerEs';
import {
  emptyCareerActivity,
  newFocusedActivityEntry,
  newOverseasEntry,
  type CareerActivity,
} from '@/types/careerActivity';
import { emptyCareerValues, type CareerValues } from '@/types/careerValues';
import type { CareerProfile } from '@/types/careerProfile';
import type {
  CareerSelfAnalysisLog,
  CareerSelfAnalysisResult,
} from '@/types/careerSelfAnalysis';

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── fixtures ────────────────────────────────────────────────────────

function activityWithExperiences(): CareerActivity {
  const a = emptyCareerActivity();
  a.focusedActivities = [
    {
      ...newFocusedActivityEntry(),
      id: 'fa-passai',
      title: 'PASSAI開発',
      category: 'プロジェクト',
      organization: '個人開発',
      role: 'リード',
      goal: 'AI開発フローを改善したかった',
      action: '設計と実装を担当し、レビュー体制を作った',
      difficulty: '仕様が頻繁に変わった',
      result: 'リリースまで到達',
      quantitativeResult: 'レビュー時間を40%削減',
      learning: '優先順位づけの重要性',
    },
  ];
  a.overseas = [
    {
      ...newOverseasEntry(),
      id: 'ov-italy',
      title: 'イタリア留学',
      country: 'イタリア',
      city: 'ミラノ',
      kind: '留学',
      period: { from: '2026年1月', to: '2026年3月' },
      purpose: '海外経験を積むため',
      activityContent: '現地の学生とプロジェクトを進めた',
      learning: '新しい環境への適応力',
    },
  ];
  a.partTimeJobs = [
    {
      id: 'pt-cafe',
      workplace: 'カフェ',
      jobContent: 'ホール接客',
      period: { from: '2024年4月', to: '' },
      role: 'スタッフ',
      scale: '10名',
      ingenuity: '導線を見直した',
      quantitativeResult: '待ち時間を2割短縮',
      learning: '現場改善の進め方',
    },
  ];
  return a;
}

// Case 2（Partial）用: 「高校時代から経営・ビジネスに興味があった」だけがある状態。
function activityWithOnlyInterest(): CareerActivity {
  const a = emptyCareerActivity();
  a.personality = {
    ...a.personality,
    values: '高校時代から経営・ビジネスに興味があった',
  };
  return a;
}

function valuesWithAxes(): CareerValues {
  const v = emptyCareerValues();
  v.selections.priorities = ['成長環境', '裁量の大きさ'];
  v.notes.industries = 'IT・Web に興味がある';
  return v;
}

function profileFixture(): CareerProfile {
  return {
    name: '就活 太郎',
    grade: '大学3年',
    track: '',
    preferences: [{ university: '〇〇大学', faculty: '商学部' }],
    examTypes: [],
    graduationYear: '2027年卒',
  };
}

function selfAnalysisResult(over: Partial<CareerSelfAnalysisResult> = {}): CareerSelfAnalysisResult {
  return {
    summary: '',
    strengths: [],
    weaknesses: [],
    gakuchikaIdeas: [],
    selfPrIdeas: [],
    esAngles: [],
    interviewQuestions: [],
    nextActions: [],
    careerDirection: '',
    recommendedIndustries: [],
    recommendedJobs: [],
    suitableEnvironment: [],
    valueKeywords: [],
    strengthKeywords: [],
    motivationSources: [],
    stressFactors: [],
    companySelectionCriteria: [],
    developmentPoints: [],
    ...over,
  };
}

function selfAnalysisLog(id: string, createdAt: string, over: Partial<CareerSelfAnalysisResult>): CareerSelfAnalysisLog {
  return { id, createdAt, userInput: '', result: selfAnalysisResult(over) };
}

// ── 1. 候補生成 ──────────────────────────────────────────────────────
section('1. 候補生成');

const emptyCandidates = buildEsMaterialCandidates({
  activity: emptyCareerActivity(),
  values: emptyCareerValues(),
  profile: null,
  selfAnalysisLogs: [],
});
check('1a 入力が空なら候補 0 件（NONE ケース）', emptyCandidates.length === 0);

check(
  '1b 全 source が null / undefined でも throw せず 0 件',
  buildEsMaterialCandidates({}).length === 0,
);

const fullCandidates = buildEsMaterialCandidates({
  activity: activityWithExperiences(),
  values: valuesWithAxes(),
  profile: profileFixture(),
  selfAnalysisLogs: [
    selfAnalysisLog('sa-1', '2026-07-01T00:00:00.000Z', {
      careerDirection: '事業づくりに関わりたい',
      esAngles: ['開発プロジェクトでの巻き込み'],
    }),
  ],
});
const ids = fullCandidates.map((c) => c.id);
check(
  '1c 活動エントリは entry.id を含む安定 ID になる',
  ids.includes('activity:focusedActivities:fa-passai') && ids.includes('activity:overseas:ov-italy'),
  ids.join(', '),
);
check('1d 同じ入力なら候補列は完全に同一（決定論）', JSON.stringify(
  buildEsMaterialCandidates({
    activity: activityWithExperiences(),
    values: valuesWithAxes(),
    profile: profileFixture(),
    selfAnalysisLogs: [
      selfAnalysisLog('sa-1', '2026-07-01T00:00:00.000Z', {
        careerDirection: '事業づくりに関わりたい',
        esAngles: ['開発プロジェクトでの巻き込み'],
      }),
    ],
  }),
) === JSON.stringify(fullCandidates));

check(
  '1e 就活軸・基本情報・自己分析も候補になる',
  ids.includes('values:priorities') &&
    ids.includes('profile:education') &&
    ids.some((id) => id.startsWith('selfAnalysis:sa-1:careerDirection')),
  ids.join(', '),
);
check(
  '1f profile は coverage に数えない（属性であり材料ではない）',
  fullCandidates.find((c) => c.id === 'profile:education')?.countsTowardCoverage === false,
);
check(
  '1g 活動候補は coverage に数える',
  fullCandidates.find((c) => c.id === 'activity:focusedActivities:fa-passai')?.countsTowardCoverage === true,
);
check(
  '1h ラベルは上限内（… を含めても超えない）',
  fullCandidates.every((c) => c.label.length <= ES_MATERIAL_LABEL_MAX_CHARS + 1),
  String(Math.max(...fullCandidates.map((c) => c.label.length))),
);
check(
  '1i facts は「ラベル: 値」形式で、選択材料の中身を持つ',
  fullCandidates
    .find((c) => c.id === 'activity:overseas:ov-italy')
    ?.facts.some((f) => f.startsWith('国・地域: イタリア')) === true,
);

// 重複抑制: 同じラベルの候補が 2 つできる入力。
const dupActivity = emptyCareerActivity();
dupActivity.focusedActivities = [
  { ...newFocusedActivityEntry(), id: 'x1', title: '同じ活動', action: 'A' },
  { ...newFocusedActivityEntry(), id: 'x2', title: '同じ活動', action: 'B' },
];
check(
  '1j 同一ラベルの候補は 1 件に抑制される',
  buildEsMaterialCandidates({ activity: dupActivity }).filter((c) => c.label.includes('同じ活動')).length === 1,
);

// 件数上限: 大量エントリ。
const manyActivity = emptyCareerActivity();
manyActivity.focusedActivities = Array.from({ length: 40 }, (_, i) => ({
  ...newFocusedActivityEntry(),
  id: `many-${i}`,
  title: `活動${i}`,
  action: '何かをした',
}));
const manyCandidates = buildEsMaterialCandidates({ activity: manyActivity });
check(
  '1k 1 セクションから拾うエントリ数に上限がある',
  manyCandidates.length <= 8,
  String(manyCandidates.length),
);

// 壊れたデータ。
const malformed = {
  activity: { focusedActivities: 'not-an-array', personality: 42, overseas: [null, 'x', {}] },
  values: { selections: 'broken', notes: null },
  profile: { preferences: 'broken' },
  selfAnalysisLogs: [null, { id: 1 }, { id: 'ok', result: null }],
} as unknown as Parameters<typeof buildEsMaterialCandidates>[0];
let malformedOk = true;
try {
  buildEsMaterialCandidates(malformed);
} catch {
  malformedOk = false;
}
check('1l 壊れた / 旧スキーマのデータでも throw しない', malformedOk);

// 長文の切り詰め。
const longActivity = emptyCareerActivity();
longActivity.focusedActivities = [
  {
    ...newFocusedActivityEntry(),
    id: 'long',
    title: 'あ'.repeat(300),
    action: 'い'.repeat(500),
  },
];
const longCandidate = buildEsMaterialCandidates({ activity: longActivity })[0];
check(
  '1m 長文はラベル・fact ともに切り詰められる',
  longCandidate.label.length <= ES_MATERIAL_LABEL_MAX_CHARS + 1 &&
    longCandidate.facts.every((f) => f.length <= 140),
);

// ── 2. 自己分析 revision（最新の有効な 1 件のみ）─────────────────────
section('2. 自己分析 revision');

const revisionLogs: CareerSelfAnalysisLog[] = [
  selfAnalysisLog('root-a', '2026-06-01T00:00:00.000Z', { careerDirection: '古い方向性' }),
  selfAnalysisLog('root-a::r2', '2026-07-01T00:00:00.000Z', { careerDirection: '新しい方向性' }),
];
check(
  '2a lineage の最新 revision が採用される',
  latestEffectiveSelfAnalysisLog(revisionLogs)?.id === 'root-a::r2',
);
const revisionCandidates = buildEsMaterialCandidates({ selfAnalysisLogs: revisionLogs });
check(
  '2b 古い revision の内容は候補に出ない',
  revisionCandidates.some((c) => c.label.includes('新しい方向性')) &&
    !revisionCandidates.some((c) => c.label.includes('古い方向性')),
);
check(
  '2c 自己分析由来の fact には出所プレフィックスが付く',
  revisionCandidates.every((c) => c.facts.every((f) => f.startsWith('［過去の自己分析］'))),
);
check('2d 自己分析ログが空なら候補 0 件', buildEsMaterialCandidates({ selfAnalysisLogs: [] }).length === 0);

// ── 3. prefilter ────────────────────────────────────────────────────
section('3. prefilter');

const prefiltered = prefilterEsMaterialCandidates(fullCandidates, 'gakuchika');
check(
  '3a ガクチカでは経験系が先頭に来る',
  prefiltered[0]?.group === 'experience',
  prefiltered[0]?.id,
);
check(
  '3b 志望動機では就活軸・自己分析が経験より前に来る',
  (() => {
    const m = prefilterEsMaterialCandidates(fullCandidates, 'motivation');
    const firstValues = m.findIndex((c) => c.group === 'values' || c.group === 'selfAnalysis');
    const firstExperience = m.findIndex((c) => c.group === 'experience');
    return firstValues >= 0 && firstValues < firstExperience;
  })(),
);
check(
  '3c 件数上限を超えない',
  prefilterEsMaterialCandidates(manyCandidates, 'gakuchika').length <= ES_MATERIAL_CANDIDATE_LIMIT,
);
check(
  '3d 同じ入力で並びが安定する（決定論）',
  JSON.stringify(prefilterEsMaterialCandidates(fullCandidates, 'gakuchika')) ===
    JSON.stringify(prefiltered),
);

// ── 4. 関連判定の正規化（AI 出力の検証）───────────────────────────────
section('4. 関連判定の正規化');

const knownIds = new Set(['activity:focusedActivities:fa-passai', 'activity:overseas:ov-italy']);
const normalized = normalizeEsMaterialSelections(
  {
    selections: [
      { id: 'activity:overseas:ov-italy', relevance: 70, reason: '新しい環境への適応' },
      { id: 'activity:does-not-exist', relevance: 99, reason: '幻覚' },
      { id: 'activity:focusedActivities:fa-passai', relevance: 95, reason: '主体的な改善経験' },
      { id: 'activity:overseas:ov-italy', relevance: 10, reason: '重複' },
    ],
  },
  knownIds,
);
check('4a 未知 id（幻覚）は破棄される', !normalized.some((s) => s.id === 'activity:does-not-exist'));
check('4b 既知 id だけが残る', normalized.length === 2);
check('4c 関連度の高い順に並ぶ', normalized[0].id === 'activity:focusedActivities:fa-passai');
check('4d 重複 id は 1 件だけ採用される', normalized.filter((s) => s.id === 'activity:overseas:ov-italy').length === 1);
check(
  '4e relevance は 0〜100 に clamp される',
  normalizeEsMaterialSelections(
    { selections: [{ id: 'activity:overseas:ov-italy', relevance: 999 }] },
    knownIds,
  )[0].relevance === 100 &&
    normalizeEsMaterialSelections(
      { selections: [{ id: 'activity:overseas:ov-italy', relevance: -50 }] },
      knownIds,
    )[0].relevance === 0,
);
check(
  '4f relevance が数値でなければ 0 に倒す',
  normalizeEsMaterialSelections(
    { selections: [{ id: 'activity:overseas:ov-italy', relevance: 'とても高い' }] },
    knownIds,
  )[0].relevance === 0,
);
check(
  '4g 壊れた AI 出力は空配列（fail-safe＝関連なし）',
  normalizeEsMaterialSelections(null, knownIds).length === 0 &&
    normalizeEsMaterialSelections({ selections: 'broken' }, knownIds).length === 0 &&
    normalizeEsMaterialSelections({}, knownIds).length === 0 &&
    normalizeEsMaterialSelections({ selections: [null, 3, 'x'] }, knownIds).length === 0,
);
check(
  '4h 空の selections はエラーではなく「関連なし」',
  normalizeEsMaterialSelections({ selections: [] }, knownIds).length === 0,
);

// ── 5. coverage（FULL / PARTIAL / NONE）─────────────────────────────
section('5. coverage 判定');

const gakuchikaCandidates = prefilterEsMaterialCandidates(
  buildEsMaterialCandidates({ activity: activityWithExperiences() }),
  'gakuchika',
);
const fullSelection: EsMaterialSelection[] = [
  { id: 'activity:focusedActivities:fa-passai', relevance: 95, reason: '' },
];
check(
  '5a 観点が十分埋まる材料 → full',
  deriveEsMaterialCoverage(gakuchikaCandidates, fullSelection, 'gakuchika') === 'full',
);

// Case 2: 「高校時代から経営に興味」だけ → 関連はあるが不足が多い。
const interestCandidates = buildEsMaterialCandidates({ activity: activityWithOnlyInterest() });
const interestSelection: EsMaterialSelection[] = [
  { id: 'activity:personality', relevance: 75, reason: '' },
];
check(
  '5b 一部だけ埋まる材料 → partial',
  deriveEsMaterialCoverage(interestCandidates, interestSelection, 'other') === 'partial',
);
check(
  '5c 閾値未満（relevance < 60）しか無い → none',
  deriveEsMaterialCoverage(
    gakuchikaCandidates,
    [{ id: 'activity:focusedActivities:fa-passai', relevance: 40, reason: '' }],
    'gakuchika',
  ) === 'none',
);
check(
  '5d selections が空 → none',
  deriveEsMaterialCoverage(gakuchikaCandidates, [], 'gakuchika') === 'none',
);
check(
  '5e profile だけが関連 → none（属性は材料の根拠にしない）',
  deriveEsMaterialCoverage(
    buildEsMaterialCandidates({ profile: profileFixture() }),
    [{ id: 'profile:education', relevance: 90, reason: '' }],
    'other',
  ) === 'none',
);
check(
  '5f 閾値以上の候補だけが選抜される',
  filterRelevantMaterials(gakuchikaCandidates, [
    { id: 'activity:focusedActivities:fa-passai', relevance: 90, reason: '' },
    { id: 'activity:overseas:ov-italy', relevance: 30, reason: '' },
  ]).length === 1,
);

// ── 6. 軸カバレッジ（known / missing）───────────────────────────────
section('6. 軸カバレッジ');

const passaiMaterial = toSelectedMaterial(
  gakuchikaCandidates.find((c) => c.id === 'activity:focusedActivities:fa-passai')!,
);
const gakuchikaCoverage = resolveEsAxisCoverage('gakuchika', passaiMaterial.factKinds);
check(
  '6a goal / difficulty / action がある材料は該当軸を満たす',
  ['motive', 'difficulty', 'action'].every((k) => gakuchikaCoverage.known.some((a) => a.key === k)),
  gakuchikaCoverage.known.map((a) => a.key).join(','),
);

// 成果・学びが無い材料 → その 2 軸が missing。
const partialActivity = emptyCareerActivity();
partialActivity.focusedActivities = [
  {
    ...newFocusedActivityEntry(),
    id: 'partial',
    title: '部分的な活動',
    goal: '目標があった',
    difficulty: '困難があった',
    action: '行動した',
  },
];
const partialMaterial = toSelectedMaterial(
  buildEsMaterialCandidates({ activity: partialActivity }).find((c) => c.id === 'activity:focusedActivities:partial')!,
);
const partialMissing = buildEsMissingAxisKeys('gakuchika', [partialMaterial]);
check(
  '6b 成果・学びの field が無ければ result / learning が missing になる',
  partialMissing.includes('result') && partialMissing.includes('learning'),
  partialMissing.join(','),
);
check(
  '6c 埋まっている軸は missing に入らない',
  !partialMissing.includes('motive') && !partialMissing.includes('difficulty') && !partialMissing.includes('action'),
);
check(
  '6d 材料なし → 全観点が missing（1 から深掘り）',
  buildEsMissingAxisKeys('gakuchika', []).length === ES_AXIS_DEFS.gakuchika.length,
);
check(
  '6e 企業固有の観点（whyCompany）は材料があっても必ず missing',
  buildEsMissingAxisKeys('motivation', [passaiMaterial]).includes('whyCompany'),
);

// ── 7. knownFacts の生成 ───────────────────────────────────────────
section('7. knownFacts');

const knownFacts = buildEsKnownFacts([passaiMaterial]);
check('7a 選択材料の事実が行として出る', knownFacts.length > 0);
check(
  '7b 各行に材料名の見出しが付く',
  knownFacts.every((f) => f.startsWith(`【${passaiMaterial.label}】`)),
);
check(
  '7c 選択していない材料は 1 行も含まれない',
  !knownFacts.some((f) => f.includes('イタリア')),
);
check('7d 材料なし → 空配列', buildEsKnownFacts([]).length === 0 && buildEsKnownFacts(null).length === 0);
check(
  '7e 壊れた材料配列でも throw しない',
  buildEsKnownFacts([null, 'x', { label: 1 }] as never).length === 0,
);

// ── 8. draft 永続化 ────────────────────────────────────────────────
section('8. draft 永続化');

function baseDraft(over: Partial<CareerEsDraft> = {}): CareerEsDraft {
  return {
    id: 'draft-1',
    schemaVersion: ES_DRAFT_SCHEMA_VERSION,
    ownerId: null,
    mode: 'deep',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    question: '学生時代に最も力を入れたことを教えてください。',
    ...over,
  };
}

store.clear();
saveEsDraft(
  baseDraft({
    materials: { decided: true, coverage: 'partial', selected: [passaiMaterial] },
  }),
);
const restored = loadEsDraft('draft-1', null);
check('8a materials が保存・復元される', restored?.materials?.decided === true);
check('8b coverage が保持される', restored?.materials?.coverage === 'partial');
check(
  '8c 選択材料の label / facts / factKinds が復元される',
  restored?.materials?.selected[0]?.label === passaiMaterial.label &&
    (restored?.materials?.selected[0]?.facts.length ?? 0) === passaiMaterial.facts.length &&
    (restored?.materials?.selected[0]?.factKinds.length ?? 0) === passaiMaterial.factKinds.length,
);

store.clear();
saveEsDraft(baseDraft({ deepTurns: [{ role: 'question', content: 'Q1' }] }));
const legacyDraft = loadEsDraft('draft-1', null);
check('8d materials を持たない旧 draft も読める', !!legacyDraft && legacyDraft.materials === undefined);
check('8e 旧 draft の既存フィールドは失われない', legacyDraft?.deepTurns?.length === 1);
check('8f schemaVersion は据え置き（1）', ES_DRAFT_SCHEMA_VERSION === 1 && legacyDraft?.schemaVersion === 1);

// 壊れた materials は「未実施」に倒す（draft 自体は破棄しない）。
store.clear();
g.localStorage = {
  getItem: () =>
    JSON.stringify([
      {
        ...baseDraft(),
        materials: { decided: 'yes', coverage: 'weird', selected: [{ id: 1 }, null] },
      },
    ]),
  setItem: () => {},
  removeItem: () => {},
};
const brokenDraft = loadEsDraft('draft-1', null);
check('8g 壊れた materials は未実施扱い（draft は破棄しない）', !!brokenDraft && brokenDraft.materials === undefined);
// polyfill を戻す。
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
};
check(
  '8h 保存材料の正規化は不正要素を落とす',
  normalizeSelectedMaterials([{ id: 'a', sourceKind: 'activity' }, { id: 'b' }, null]).length === 1,
);

// ── 9. 深掘り prompt（後方互換 + 既知情報の制約）──────────────────────
section('9. 深掘り prompt');

const QUESTION = '学生時代に最も力を入れたことを教えてください。';

// 現行（context 無し）の golden。既存ユーザー・NONE ケースで 1 文字も変わらないことを固定する。
const LEGACY_GAKUCHIKA_SYSTEM = [
  'あなたは、日本の新卒就活のエントリーシート（ES）作成を支援する「深掘りの壁打ちパートナー」です。',
  '面接官ではありません。学生本人が、ある ES 設問に答えるための「材料（経験・考え・エピソード）」を',
  '自分の言葉で整理できるよう、対話でやさしく深掘りします。',
  '',
  '【最重要ルール（ai_policy）】',
  '- あなたは ES 本文を書きません。本文の代筆・完成文・例文・「こう書きましょう」を一切出しません。',
  '- あなたの役割は、良い質問を1つずつ投げて、本人の中にある具体を引き出すことだけです。',
  '',
  '【話し方・進め方】',
  '- 質問は必ず1つだけ。毎回言い回しを変え、定型文にしない。',
  '- 詰問・尋問にしない。答えやすく開かれた問いにする（Yes/Noで終わらせない）。',
  '- 学生の実体験・具体に即して掘る（一般論で埋めない）。抽象的すぎる質問は避ける。',
  '- 事実確認が必要な情報（企業の事業内容・待遇・選考等）は断定しない。',
  '',
  '【今回の ES 設問（種別: ガクチカ（学生時代に力を入れたこと））】',
  QUESTION,
  '',
  '【この設問で引き出したい観点（この中から、まだ十分聞けていない最重要の1点を選んで掘る）】',
  '- 取り組んだ背景・動機（なぜそれに力を入れたのか）',
  '- 直面した課題・困難と、そのときの思考プロセス',
  '- 具体的な行動（自分が何をしたか。役割・工夫）',
  '- 定量的な成果・変化（数字／Before・After／周囲への影響）',
  '- 学び・そこから得たもの（再現性・今後どう活きるか）',
].join('\n');

check(
  '9a context 無しの system prompt は現行と byte 一致',
  buildEsDeepSystem(QUESTION, 'gakuchika') === LEGACY_GAKUCHIKA_SYSTEM,
);
check(
  '9b 空の context（NONE ケース）も現行と byte 一致',
  buildEsDeepSystem(QUESTION, 'gakuchika', { knownFacts: [], missingAxes: [] }) ===
    LEGACY_GAKUCHIKA_SYSTEM,
);
check(
  '9c undefined / null の context も現行と byte 一致',
  buildEsDeepSystem(QUESTION, 'gakuchika', { knownFacts: null, missingAxes: null }) ===
    LEGACY_GAKUCHIKA_SYSTEM,
);

const contextSystem = buildEsDeepSystem(QUESTION, 'gakuchika', {
  knownFacts,
  missingAxes: buildEsMissingAxisKeys('gakuchika', [passaiMaterial]),
});
check('9d knownFacts が prompt に載る', contextSystem.includes('【すでに分かっていること'));
check(
  '9e 選択材料の事実が本文として載る',
  knownFacts.every((f) => contextSystem.includes(f)),
);
check(
  '9f 「同じ事実を確認する質問は禁止」の制約が入る',
  contextSystem.includes('同じ事実を確認する質問は禁止します。') &&
    contextSystem.includes('不足している情報だけを質問してください。'),
);
check(
  '9g 未選択の材料は prompt に載らない',
  !contextSystem.includes('イタリア') && !contextSystem.includes('カフェ'),
);
check(
  '9h missingAxes の観点だけが「まだ聞けていない観点」に出る',
  contextSystem.includes('【まだ聞けていない観点') &&
    contextSystem.includes('- 定量的な成果・変化（数字／Before・After／周囲への影響）') &&
    !contextSystem.includes('【この設問で引き出したい観点'),
);
check(
  '9i 埋まっている観点は「掘り直さない」側に出る',
  contextSystem.includes('【すでに材料が揃っている観点（掘り直さない）】') &&
    contextSystem.includes('- 取り組んだ背景・動機（なぜそれに力を入れたのか）'),
);
check(
  '9j 自己分析由来の材料があるときだけ扱いの注意書きが出る',
  buildEsDeepSystem(QUESTION, 'gakuchika', {
    knownFacts: ['【方向性】［過去の自己分析］キャリアの方向性: 事業づくり'],
  }).includes('が付いた項目は本人の整理メモです') &&
    !contextSystem.includes('が付いた項目は本人の整理メモです'),
);
check(
  '9k 未知の軸 key しか無ければ従来の観点リストに倒す（fail-safe）',
  buildEsDeepSystem(QUESTION, 'gakuchika', { missingAxes: ['unknown-axis'] }) ===
    LEGACY_GAKUCHIKA_SYSTEM,
);

// seed / followup。
check(
  '9l seed prompt は context 無しで従来どおり',
  buildEsSeedUserPrompt('gakuchika') === buildEsSeedUserPrompt('gakuchika', { knownFacts: [] }),
);
check(
  '9m seed prompt は既知材料があると「聞き返さない」方針になる',
  buildEsSeedUserPrompt('gakuchika', { knownFacts }).includes('そこに書かれている事実は聞き返さず'),
);
const turns = [
  { role: 'question' as const, content: 'Q1' },
  { role: 'answer' as const, content: 'A1' },
];
check(
  '9n followup prompt は context 無しで従来どおり',
  buildEsFollowupUserPrompt('gakuchika', turns) ===
    buildEsFollowupUserPrompt('gakuchika', turns, { knownFacts: [], missingAxes: [] }),
);
check(
  '9o followup prompt に再質問禁止の指示が入る',
  buildEsFollowupUserPrompt('gakuchika', turns, { knownFacts }).includes(
    '絶対に聞き返さない',
  ),
);

// ── 10. 質問数上限 ─────────────────────────────────────────────────
section('10. 質問数上限');

check('10a 既知なし → 従来の上限（ガクチカ 7）', esQuestionTurnCap('gakuchika') === 7);
check(
  '10b context 無しなら従来の上限',
  esTurnCapForContext('gakuchika') === 7 && esTurnCapForContext('gakuchika', { knownFacts: [] }) === 7,
);
check(
  '10c 既知の観点が 3 つなら上限が 3 減る',
  esTurnCapForContext('gakuchika', { missingAxes: ['result', 'learning'] }) === 7 - 3,
);
check(
  '10d 下限（ES_MIN_TURN_CAP）を割らない',
  esTurnCapForContext('gakuchika', { missingAxes: ['result'] }) === ES_MIN_TURN_CAP &&
    esQuestionTurnCap('gakuchika', 99) === ES_MIN_TURN_CAP,
);
check(
  '10e 不正な satisfiedAxisCount でも従来値に倒す',
  esQuestionTurnCap('gakuchika', Number.NaN) === 7 && esQuestionTurnCap('gakuchika', -5) === 7,
);

// ── 11. 整理メモ prompt ────────────────────────────────────────────
section('11. 整理メモ prompt');

const organizeTurns = [
  { role: 'question' as const, content: '一番苦労した点は？' },
  { role: 'answer' as const, content: '仕様変更が続いたこと' },
];
check(
  '11a knownFacts 無しなら従来と byte 一致',
  buildEsOrganizeUserMessage(QUESTION, organizeTurns) ===
    [
      `【ES設問】\n${QUESTION}`,
      '',
      `【深掘りQ&A（本人の回答）】\nQ. 一番苦労した点は？\nA. 仕様変更が続いたこと`,
      '',
      '上記の回答をもとに、本人が自分で本文を書くための材料メモを、指定の JSON 形式で整理してください。',
      '本文は書かないでください。',
    ].join('\n'),
);
check(
  '11b 空配列も従来と byte 一致',
  buildEsOrganizeUserMessage(QUESTION, organizeTurns, []) ===
    buildEsOrganizeUserMessage(QUESTION, organizeTurns),
);
const organizeWithFacts = buildEsOrganizeUserMessage(QUESTION, organizeTurns, knownFacts);
check(
  '11c 選択材料が整理メモの入力に入る',
  organizeWithFacts.includes('【本人が今回の材料として選んだ既存の情報'),
);
check(
  '11d 重複禁止・創作禁止の指示が入る',
  organizeWithFacts.includes('同じ事実を2回書かない') && organizeWithFacts.includes('創作しない'),
);
check(
  '11e 未選択の候補は整理メモの入力に混ざらない',
  !organizeWithFacts.includes('イタリア') && !organizeWithFacts.includes('カフェ'),
);

// ── 12. シナリオ（Case 1 / 2 / 3）──────────────────────────────────
section('12. シナリオ');

// Case 1: ガクチカ × 複数経験あり。
{
  const candidates = prefilterEsMaterialCandidates(
    buildEsMaterialCandidates({
      activity: activityWithExperiences(),
      values: valuesWithAxes(),
      profile: profileFixture(),
    }),
    classifyEsQuestionType(QUESTION),
  );
  const selections: EsMaterialSelection[] = [
    { id: 'activity:focusedActivities:fa-passai', relevance: 95, reason: '' },
    { id: 'activity:overseas:ov-italy', relevance: 70, reason: '' },
  ];
  const coverage = deriveEsMaterialCoverage(candidates, selections, 'gakuchika');
  const selected = filterRelevantMaterials(candidates, selections).map(toSelectedMaterial);
  const facts = buildEsKnownFacts(selected);
  const missing = buildEsMissingAxisKeys('gakuchika', selected);
  const system = buildEsDeepSystem(QUESTION, 'gakuchika', { knownFacts: facts, missingAxes: missing });
  check('12a Case1 候補が複数出る', candidates.length >= 3);
  check('12b Case1 coverage は none ではない', coverage !== 'none');
  check(
    '12c Case1 留学先（イタリア）は既知として prompt に載る',
    system.includes('国・地域: イタリア'),
  );
  check(
    '12d Case1 未選択のアルバイトは prompt に載らない',
    !system.includes('カフェ'),
  );
}

// Case 2: 大学選択理由 × 「高校時代から経営に興味」だけ（partial）。
{
  const q = '現在の大学を選んだ理由を教えてください。';
  const type = classifyEsQuestionType(q);
  const candidates = prefilterEsMaterialCandidates(
    buildEsMaterialCandidates({ activity: activityWithOnlyInterest(), profile: profileFixture() }),
    type,
  );
  const selections: EsMaterialSelection[] = [{ id: 'activity:personality', relevance: 75, reason: '' }];
  const coverage = deriveEsMaterialCoverage(candidates, selections, type);
  const selected = filterRelevantMaterials(candidates, selections).map(toSelectedMaterial);
  const missing = buildEsMissingAxisKeys(type, selected);
  const system = buildEsDeepSystem(q, type, { knownFacts: buildEsKnownFacts(selected), missingAxes: missing });
  check('12e Case2 その情報が候補に出る', candidates.some((c) => c.id === 'activity:personality'));
  check('12f Case2 coverage は partial', coverage === 'partial');
  check(
    '12g Case2 既知の興味が prompt に載る',
    system.includes('高校時代から経営・ビジネスに興味があった'),
  );
  // 「高校時代から経営に興味」は価値観であり、その他設問の 4 観点（核心/経験/行動/結果）は
  // どれも埋めない。つまり不足観点は残ったまま＝深掘りは続くが、既知の興味は聞き返されない。
  check(
    '12h Case2 不足観点は残るが、既知の情報は聞き返さない',
    missing.length > 0 &&
      missing.length <= ES_AXIS_DEFS[type].length &&
      system.includes('同じ事実を確認する質問は禁止します。'),
  );
}

// Case 3: 大学選択理由 × 関連データなし（none）。
{
  const q = '現在の大学を選んだ理由を教えてください。';
  const type = classifyEsQuestionType(q);
  const candidates = prefilterEsMaterialCandidates(
    buildEsMaterialCandidates({ activity: emptyCareerActivity(), profile: profileFixture() }),
    type,
  );
  // profile しか無い → 関連ありでも coverage は none。
  const coverage = deriveEsMaterialCoverage(candidates, [{ id: 'profile:education', relevance: 80, reason: '' }], type);
  check('12i Case3 coverage は none', coverage === 'none');
  const system = buildEsDeepSystem(q, type, { knownFacts: [], missingAxes: [] });
  check(
    '12j Case3 通常の深掘り prompt（既知ブロックなし）',
    !system.includes('【すでに分かっていること') && system.includes('【この設問で引き出したい観点'),
  );
  check(
    '12k Case3 質問数は従来どおり',
    esTurnCapForContext(type, { knownFacts: [], missingAxes: [] }) === esQuestionTurnCap(type),
  );
}

console.log(`\n結果: PASS ${passes} / FAIL ${failures}`);
process.exit(failures > 0 ? 1 : 0);
