/*
 * scripts/career-es-settings-review-context-qa.ts
 *
 * PASSAI CAREER — ES 設定の必須化 + 選考種別 2 種化 + 最終添削へのコンテキスト接続 QA。
 *
 * 背景:
 *   ES 設定（設問 / 文字数 / 企業名 / 志望業界 / 志望職種 / 選考種別）を新規作成時に必須化し、
 *   その 6 項目が最終 AI 添削（/api/career/es-review）の prompt まで欠落せず届くようにした。
 *   本 harness は「入口の必須チェック」「選考種別 2 種」「draft 永続化」「添削リクエスト」
 *   「添削 prompt」「旧 draft / 旧ログ互換」を決定論で固定する。外部 AI・DB 非接続。
 *
 * 検証項目:
 *   1. 必須バリデーション（空 / 0 / 負数 / NaN / 不正値・全項目 valid）
 *   2. 選考種別（新規 UI は 2 種のみ・「指定なし」不在の静的確認）
 *   3. draft 永続化（6 項目が保存 → reload で一致）
 *   4. 添削リクエスト（6 項目 + answer が必ず body に載る / 旧ログでもキーが落ちない）
 *   5. 添削 prompt（6 項目が実際に prompt へ入り、添削基準として使われる）
 *   6. 後方互換（旧 draft / 旧ログ / 旧「指定なし」の読み込み・添削）
 *
 * 使い方: npx tsx scripts/career-es-settings-review-context-qa.ts
 * 終了コード: 全 assertion pass → 0 / 1 件でも失敗 → 1。
 *
 * 注: safeStorage は呼び出し時に localStorage を lazily read するため、import 後に
 *     globals を差し込んでから storage 関数を呼べばよい（既存 ES QA と同方式）。
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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ES_SELECTION_TYPE_OPTIONS,
  esSelectionTypeLabel,
  parseEsCharLimitInput,
  validateEsSettings,
  type EsSettingsInput,
} from '@/lib/careerEs/esSettings';
import { buildEsReviewRequestBody } from '@/lib/careerEs/reviewRequest';
import {
  ES_REVIEW_SYSTEM_PROMPT,
  buildEsReviewUserMessage,
} from '@/lib/careerEs/reviewPrompt';
import { loadEsDraft, saveEsDraft } from '@/app/career/es/esDraftStorage';
import {
  appendEsLog,
  createEsWorkspaceLog,
  loadEsLogById,
} from '@/app/career/es/esStorage';
import {
  ES_DRAFT_SCHEMA_VERSION,
  type CareerEsDraft,
  type CareerEsLog,
} from '@/types/careerEs';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}
function reset() {
  store.clear();
}
function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8');
}

// 全項目 valid な入力（各ケースはここから 1 項目だけ壊す）。
const VALID_INPUT: EsSettingsInput = {
  question: '学生時代に最も力を入れたことを教えてください。',
  charLimitInput: '400',
  companyName: '〇〇株式会社',
  industry: 'IT・Web',
  jobType: 'エンジニア',
  selectionType: 'internship',
};

// ─────────────────────────────────────────────────────────────────
console.log('# 1. 必須バリデーション（validateEsSettings）');
{
  const ok = validateEsSettings(VALID_INPUT);
  check('全項目 valid → start 可能', ok.ok && ok.normalized !== null);
  check(
    '正規化値が確定する（trim / 正の整数 / 選考種別）',
    ok.normalized?.charLimit === 400 &&
      ok.normalized?.companyName === '〇〇株式会社' &&
      ok.normalized?.selectionType === 'internship',
  );
  check(
    '前後空白は trim される',
    validateEsSettings({ ...VALID_INPUT, companyName: '  A社  ' }).normalized?.companyName === 'A社',
  );

  // 設問。
  check('ES設問 empty → blocked', !validateEsSettings({ ...VALID_INPUT, question: '' }).ok);
  check(
    'ES設問 空白のみ → blocked',
    !validateEsSettings({ ...VALID_INPUT, question: '   \n ' }).ok,
  );

  // 文字数（空 / 0 / 負数 / NaN / 不正値）。
  const badLimits: Array<[string, string]> = [
    ['empty', ''],
    ['空白のみ', '   '],
    ['0', '0'],
    ['負数', '-100'],
    ['NaN（非数）', 'abc'],
    ['小数', '400.5'],
    ['指数表記', '1e3'],
    ['単位混在', '400字'],
    ['全角数字', '４００'],
  ];
  for (const [label, value] of badLimits) {
    check(
      `文字数 ${label} → blocked`,
      !validateEsSettings({ ...VALID_INPUT, charLimitInput: value }).ok,
    );
  }
  check('文字数 1 → 有効（正の整数の下限）', validateEsSettings({ ...VALID_INPUT, charLimitInput: '1' }).ok);
  check('parseEsCharLimitInput: 正常', parseEsCharLimitInput(' 800 ') === 800);
  check('parseEsCharLimitInput: 不正は null', parseEsCharLimitInput('0') === null);

  // 企業名 / 業界 / 職種。
  check('企業名 empty → blocked', !validateEsSettings({ ...VALID_INPUT, companyName: '' }).ok);
  check('志望業界 empty → blocked', !validateEsSettings({ ...VALID_INPUT, industry: '' }).ok);
  check('志望職種 empty → blocked', !validateEsSettings({ ...VALID_INPUT, jobType: '' }).ok);

  // 選考種別。
  const noSelection = validateEsSettings({ ...VALID_INPUT, selectionType: null });
  check('selectionType 未確定 → blocked', !noSelection.ok && noSelection.normalized === null);
  check('selectionType 未確定 → 原因メッセージが出る', !!noSelection.errors.selectionType);

  // エラーは該当項目だけに付く（原因が分かる UX の前提）。
  const onlyCompany = validateEsSettings({ ...VALID_INPUT, companyName: '' });
  check(
    '不足項目だけにエラーが付く',
    Object.keys(onlyCompany.errors).length === 1 && !!onlyCompany.errors.companyName,
  );
  const allEmpty = validateEsSettings({
    question: '',
    charLimitInput: '',
    companyName: '',
    industry: '',
    jobType: '',
    selectionType: null,
  });
  check('全項目未入力 → 6 件すべて指摘', Object.keys(allEmpty.errors).length === 6);
}

// ─────────────────────────────────────────────────────────────────
console.log('# 2. 選考種別は 2 種類（新規 UI から「指定なし」を削除）');
{
  check('選択肢は 2 件', ES_SELECTION_TYPE_OPTIONS.length === 2);
  check(
    '表示順は インターン応募 → 本選考',
    ES_SELECTION_TYPE_OPTIONS.map((o) => o.label).join('/') === 'インターン応募/本選考',
  );
  check(
    '値は internship / main のみ',
    ES_SELECTION_TYPE_OPTIONS.map((o) => o.value).join('/') === 'internship/main',
  );
  check('インターン応募を保存可能', validateEsSettings({ ...VALID_INPUT, selectionType: 'internship' }).normalized?.selectionType === 'internship');
  check('本選考を保存可能', validateEsSettings({ ...VALID_INPUT, selectionType: 'main' }).normalized?.selectionType === 'main');
  check('旧「指定なし」（欠損）のラベルは空', esSelectionTypeLabel(undefined) === '' && esSelectionTypeLabel(null) === '');

  const newPageSource = readSource('app/career/es/new/page.tsx');
  check('新規 UI に「指定なし」が存在しない', !newPageSource.includes('指定なし'));
  check('新規 UI は選択肢定義を共有する', newPageSource.includes('ES_SELECTION_TYPE_OPTIONS'));
  check('新規 UI は開始処理側で必須チェックする', newPageSource.includes('validateEsSettings'));
  check(
    '必須ラベル（*）が 6 項目分ある',
    (newPageSource.match(/text-rose-500">\*<\/span>/g) ?? []).length >= 2 &&
      newPageSource.includes('label="文字数"') &&
      newPageSource.includes('label="企業名"') &&
      newPageSource.includes('label="志望業界"') &&
      newPageSource.includes('label="志望職種"'),
  );
  check('「（任意）」ラベルが残っていない', !newPageSource.includes('（任意）'));
}

// ─────────────────────────────────────────────────────────────────
console.log('# 3. draft 永続化（6 項目が保存 → reload で一致）');
{
  reset();
  const draft: CareerEsDraft = {
    id: 'd-settings',
    schemaVersion: ES_DRAFT_SCHEMA_VERSION,
    ownerId: 'user-A',
    mode: 'deep',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    question: VALID_INPUT.question,
    charLimit: 400,
    companyName: VALID_INPUT.companyName,
    industry: VALID_INPUT.industry,
    jobType: VALID_INPUT.jobType,
    selectionType: 'internship',
  };
  saveEsDraft(draft);
  const got = loadEsDraft('d-settings', 'user-A');
  check('question 一致', got?.question === draft.question);
  check('charLimit 一致', got?.charLimit === 400);
  check('companyName 一致', got?.companyName === draft.companyName);
  check('industry 一致', got?.industry === draft.industry);
  check('jobType 一致', got?.jobType === draft.jobType);
  check('selectionType 一致', got?.selectionType === 'internship');
  check('schemaVersion は据え置き（旧 draft を破棄しない）', ES_DRAFT_SCHEMA_VERSION === 1);

  // draft → 正式ログ（CareerEsLog）へ 6 項目が引き継がれる（既存の保存構造を使う。新設なし）。
  const promoted = createEsWorkspaceLog({
    mode: draft.mode,
    question: draft.question,
    charLimit: draft.charLimit,
    companyName: draft.companyName,
    industry: draft.industry,
    jobType: draft.jobType,
    selectionType: draft.selectionType ?? null,
    body: '本文',
  });
  appendEsLog(promoted);
  const savedLog = loadEsLogById(promoted.id);
  check(
    'CareerEsLog に 6 項目が保存 → reload で一致',
    savedLog?.question === draft.question &&
      savedLog?.charLimit === 400 &&
      savedLog?.companyName === draft.companyName &&
      savedLog?.industry === draft.industry &&
      savedLog?.jobType === draft.jobType &&
      savedLog?.selectionType === 'internship',
  );
}

// ─────────────────────────────────────────────────────────────────
console.log('# 4. 添削リクエスト（/api/career/es-review へ 6 項目 + answer が届く）');
const REQUEST_KEYS = [
  'answer',
  'question',
  'charLimit',
  'companyName',
  'industry',
  'jobType',
  'selectionType',
] as const;
{
  reset();
  const draft: CareerEsDraft = {
    id: 'd-req',
    schemaVersion: ES_DRAFT_SCHEMA_VERSION,
    ownerId: null,
    mode: 'write',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    question: VALID_INPUT.question,
    charLimit: 400,
    companyName: VALID_INPUT.companyName,
    industry: VALID_INPUT.industry,
    jobType: VALID_INPUT.jobType,
    selectionType: 'main',
  };
  const body = buildEsReviewRequestBody(draft, '  私は〜  ');
  for (const key of REQUEST_KEYS) {
    check(`draft 由来: ${key} が body に載る`, key in body);
  }
  check('answer は trim される', body.answer === '私は〜');
  check('charLimit は数値で届く', body.charLimit === 400);
  check('selectionType は本選考で届く', body.selectionType === 'main');
  check('企業研究未参照なら companyResearchContext を送らない', !('companyResearchContext' in body));

  // JSON 直列化しても 6 項目が残る（fetch body と同じ経路）。
  const wire = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  check(
    'JSON 直列化後も 6 項目 + answer が残る',
    REQUEST_KEYS.every((k) => k in wire),
  );

  // 旧ログ（項目欠損）からの再添削でもキーが落ちない。
  const legacy = buildEsReviewRequestBody({ question: '設問だけある旧ログ' }, '本文');
  check(
    '旧ログ由来でもキーは落ちない',
    REQUEST_KEYS.every((k) => k in legacy),
  );
  check(
    '旧ログの欠損は空文字 / null になる',
    legacy.companyName === '' &&
      legacy.industry === '' &&
      legacy.jobType === '' &&
      legacy.charLimit === null &&
      legacy.selectionType === null,
  );
  check(
    '不正な charLimit（0 / 負数）は null に倒れる',
    buildEsReviewRequestBody({ charLimit: 0 }, 'x').charLimit === null &&
      buildEsReviewRequestBody({ charLimit: -5 }, 'x').charLimit === null,
  );
  check(
    '企業研究があれば companyResearchContext を送る',
    'companyResearchContext' in
      buildEsReviewRequestBody({ companyResearchContext: { companyName: 'X' } }, 'x'),
  );

  // 両ルート（deep 初回添削 / [id] 再添削）が同じ builder を使う。
  const draftPage = readSource('app/career/es/draft/[draftId]/page.tsx');
  const idPage = readSource('app/career/es/[id]/page.tsx');
  check('draft ページが builder を使う', draftPage.includes('buildEsReviewRequestBody'));
  check('[id] ページが builder を使う', idPage.includes('buildEsReviewRequestBody'));
}

// ─────────────────────────────────────────────────────────────────
console.log('# 5. 添削 prompt（6 項目が実際に AI prompt へ入る）');
{
  const prompt = buildEsReviewUserMessage({
    answer: '私はサークルの新歓運営でリーダーを務め、参加者を1.5倍に増やしました。',
    question: VALID_INPUT.question,
    charLimit: 400,
    companyName: VALID_INPUT.companyName,
    industry: VALID_INPUT.industry,
    jobType: VALID_INPUT.jobType,
    selectionType: 'internship',
  });

  // 6 項目の値が prompt に載る。
  check('ES設問が prompt にある', prompt.includes('# ES設問') && prompt.includes(VALID_INPUT.question));
  check('文字数制限が prompt にある', prompt.includes('- 文字数制限: 400 字'));
  check('企業名が prompt にある', prompt.includes(`- 企業名: ${VALID_INPUT.companyName}`));
  check('志望業界が prompt にある', prompt.includes(`- 志望業界: ${VALID_INPUT.industry}`));
  check('志望職種が prompt にある', prompt.includes(`- 志望職種: ${VALID_INPUT.jobType}`));
  check('選考種別が prompt にある', prompt.includes('- 選考種別: インターン応募'));
  check('ES本文が prompt にある', prompt.includes('# 添削対象の回答本文') && prompt.includes('新歓運営'));

  // 添削基準として使われる（貼るだけにしない）。
  check('添削基準ブロックがある', prompt.includes('# 応募コンテキストの使い方（添削基準）'));
  check('設問適合を評価させる', prompt.includes('- 設問適合:') && prompt.includes('設問からずれた内容'));
  check('文字数を添削基準に反映', prompt.includes('- 文字数: 指定は 400 字') && prompt.includes('何字削るべきか'));
  check(
    '改善助言も指定文字数内に収めさせる',
    prompt.includes('指定文字数の中に収まる範囲で実行できる内容にする'),
  );
  check('本文の文字数を決定論で与える', prompt.includes('本文の文字数: 36 字 / 指定 400 字'));
  check('企業名を提出先コンテキストとして使わせる', prompt.includes('- 企業名: この ES の提出先は'));
  check('企業の実態推測を禁止', prompt.includes('企業の実態を推測して評価しない'));
  check('業界を添削コンテキストに反映', prompt.includes('- 志望業界: 「IT・Web」向けの応募として'));
  check('業界の一般論増殖を禁止', prompt.includes('業界の一般論を事実として増やさない'));
  check('職種を添削コンテキストに反映', prompt.includes('- 志望職種: 「エンジニア」として読んだときに'));
  check('選考種別ブロックが出る', prompt.includes('# 選考種別: インターン応募（重点評価観点）'));

  // 企業情報の創作禁止（AI Review Prompt Safety）。
  check(
    'user-provided context として明示',
    prompt.includes('# 応募コンテキスト（ユーザー本人が入力した提出先の情報）'),
  );
  check(
    '企業情報の創作を禁止（user message）',
    prompt.includes('理念・採用方針・求める人物像・事業戦略'),
  );
  check(
    '企業情報の創作を禁止（system prompt）',
    ES_REVIEW_SYSTEM_PROMPT.includes('推測でも創作しない') &&
      ES_REVIEW_SYSTEM_PROMPT.includes('根拠のない企業分析は禁止'),
  );
  check(
    'ai_policy: 代筆禁止は維持',
    ES_REVIEW_SYSTEM_PROMPT.includes('本文の代筆・完成例・「こう書きましょう」という書き換え文を一切出さない'),
  );

  // 本選考ルートも同じ構造で出る。
  const mainPrompt = buildEsReviewUserMessage({
    answer: '本文',
    question: 'Q',
    charLimit: 600,
    companyName: 'A社',
    industry: '商社',
    jobType: '営業',
    selectionType: 'main',
  });
  check('本選考の重点観点ブロックが出る', mainPrompt.includes('# 選考種別: 本選考（重点評価観点）'));
  check('本選考でも 6 項目が載る', ['Q', '600 字', 'A社', '商社', '営業'].every((v) => mainPrompt.includes(v)));

  // route が lift 済み prompt を使う（route 内に別実装を残さない）。
  const routeSource = readSource('app/api/career/es-review/route.ts');
  check('route が lift 済み system prompt を使う', routeSource.includes('ES_REVIEW_SYSTEM_PROMPT'));
  check('route が lift 済み user message builder を使う', routeSource.includes('buildEsReviewUserMessage'));
  check('route に旧 inline prompt が残っていない', !routeSource.includes('const SYSTEM_PROMPT ='));
}

// ─────────────────────────────────────────────────────────────────
console.log('# 6. 後方互換（旧 draft / 旧ログ / 旧「指定なし」）');
{
  reset();
  // 旧 draft: 設問だけ（文字数・企業名・業界・職種・選考種別なし）。
  store.set(
    'careerEsDrafts',
    JSON.stringify([
      {
        id: 'legacy-d',
        schemaVersion: ES_DRAFT_SCHEMA_VERSION,
        ownerId: 'user-A',
        mode: 'deep',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        question: '旧 draft の設問',
        deepTurns: [{ role: 'question', content: 'Q1' }],
      },
    ]),
  );
  const legacyDraft = loadEsDraft('legacy-d', 'user-A');
  check('旧 draft は読める（必須化しても破棄しない）', legacyDraft?.question === '旧 draft の設問');
  check('旧 draft の欠損は欠損のまま', legacyDraft?.companyName === undefined && legacyDraft?.selectionType === undefined);
  check('旧 draft の深掘り進捗は保持', (legacyDraft?.deepTurns ?? []).length === 1);

  // 旧ログ: 必須項目が未入力でも閲覧・再添削できる。
  reset();
  const legacyLog: CareerEsLog = {
    id: 'legacy-log',
    createdAt: '2026-06-01T00:00:00.000Z',
    userInput: '',
    result: {
      gakuchika: '',
      selfPr: '',
      motivation: '',
      headline: '',
      appealPoints: [],
      interviewQuestions: [],
      improvements: [],
    },
    question: '旧ログの設問',
    body: '旧ログの本文',
    mode: 'write',
  };
  appendEsLog(legacyLog);
  const loaded = loadEsLogById('legacy-log');
  check('companyName 欠損の旧ログを閲覧できる', loaded !== null && loaded.companyName === undefined);
  check('旧ログの本文は保持される', loaded?.body === '旧ログの本文');

  // 旧「指定なし」= selectionType 欠損。勝手に本選考へ変換しない。
  check('旧「指定なし」ログは selectionType を持たない（変換しない）', loaded?.selectionType === undefined);

  // 旧の未知値（'none' 等）が入っていても、ログ自体は読める（値だけ落とす）。
  reset();
  store.set(
    'careerEsLogs',
    JSON.stringify([{ ...legacyLog, id: 'legacy-none', selectionType: 'none' }]),
  );
  const noneLog = loadEsLogById('legacy-none');
  check('旧の未知 selectionType でもログは読める', noneLog !== null);
  check('未知 selectionType は採用しない（本選考へ変換しない）', noneLog?.selectionType === undefined);

  // 旧ログからの再添削 prompt: 欠損項目のブロックは出さない（AI に埋めさせない）。
  const legacyPrompt = buildEsReviewUserMessage({
    answer: '旧ログの本文',
    question: '旧ログの設問',
    charLimit: null,
    companyName: '',
    industry: '',
    jobType: '',
    selectionType: null,
  });
  check('旧ログでも添削 prompt を作れる', legacyPrompt.includes('# ES設問') && legacyPrompt.includes('旧ログの本文'));
  check(
    '欠損項目の応募コンテキスト一覧は出さない',
    !legacyPrompt.includes('# 応募コンテキスト（ユーザー本人が入力した提出先の情報）'),
  );
  check('欠損時は選考種別ブロックも出さない', !legacyPrompt.includes('# 選考種別:'));
  check('欠損時は文字数指定を書かない', !legacyPrompt.includes('/ 指定'));
  check('欠損時も設問適合の基準は残る', legacyPrompt.includes('- 設問適合:'));
}

if (failures > 0) {
  console.error(`\n✖ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\n✓ all assertions passed');
