/*
 * scripts/career-interview-target-operative-qa.ts
 *
 * PASSAI CAREER — 面接 target の operative-prompt 到達 QA（dev-only 常設・決定的）。
 *
 * 目的:
 *   「より精度を上げたい人向け」カード（target）の情報が、system の背景ブロックだけでなく、
 *   質問生成の operative prompt（buildSeedUserPrompt / buildFollowupUserPrompt）へ到達し、
 *   ユーザーが面接中に体感できる差分を生むことをセンチネル方式で機械的に保証する。
 *   併せて「target 未入力時は operative prompt が byte 不変」「評価側は不変」「system と user の
 *   責務分担」を回帰ガードする。外部 AI 非実行・実データ非参照・DB/Supabase 非接続。
 *
 *   ★ 面接 基本情報フォームの簡素化以降:
 *     - 必須は 企業名 / 業界 / 職種 / 選考種別 の 4 項目（section F で静的に固定）。
 *     - interviewPhase（選考フェーズ）/ companyMemo（企業メモ）は入力・保存・prompt から廃止。
 *       旧データに残っていても normalize が読み捨て、prompt へ一切漏れないことを固定する。
 *
 *   ★ Company Data Spine A 層（Company Official Facts）接続以降（section H）:
 *     - A 層（公式・出典付きの一次情報）と B 層（本人の企業研究メモ）が **別ブロック**で
 *       面接 system prompt へ届くこと。
 *     - 企業理解 / 本番 / 圧迫は同一 data source、自己分析モードは A 層を主 context にしないこと。
 *     - A 層なし / B 層なし / 両方なし / companyId なしでも面接が成立すること（graceful degradation）。
 *
 * 使い方: npx tsx scripts/career-interview-target-operative-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSeedUserPrompt,
  buildFollowupUserPrompt,
  buildFinalUserPrompt,
  buildFinalFeedbackInstruction,
  buildInterviewBaseSystem,
} from '@/app/api/career/interview/interviewPrompt';
import {
  normalizeInterviewTarget,
  isInterviewTargetComplete,
  getInterviewModeConfig,
  CAREER_INTERVIEW_MODES,
  CAREER_INTERVIEW_MODE_ORDER,
} from '@/app/career/interview/interviewModes';
import type { CareerInterviewTurn } from '@/types/careerInterview';

// フィールドごとに固有センチネル（到達を出現回数で機械判定する）。
// memo / phase は「廃止済み入力が prompt へ漏れないこと」を証明するための負のセンチネル。
const S = {
  company: 'テスト株式会社',
  job: 'JOBSENT法人営業',
  memo: 'MEMOSENT_顧客課題を構造的に整理し社内外を巻き込む人材を重視',
  focus: 'FOCUSSENT_ガクチカの再現性と法人営業で成果を出せる根拠を練習したい',
};

const count = (hay: string, needle: string) =>
  needle === '' ? 0 : hay.split(needle).length - 1;

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};

// 決定的な会話履歴（中盤・長尺）。
const TURNS: CareerInterviewTurn[] = [
  { role: 'question', content: '学生時代に力を入れたことを教えてください。' },
  { role: 'answer', content: 'サークルの新歓活動でリーダーを務め参加者を増やしました。' },
];
const LONG_TURNS: CareerInterviewTurn[] = [
  ...TURNS,
  { role: 'question', content: '最も苦労した点は何ですか。' },
  { role: 'answer', content: '意見の対立をまとめる調整に苦労しました。' },
  { role: 'question', content: 'どう乗り越えましたか。' },
  { role: 'answer', content: '個別に要望を聞き共通目標を再設定しました。' },
];

const MODE = 'real' as const;

// ── ケースA: target 未入力 → operative prompt が byte 不変（null/undefined/無効すべて） ──
console.log('\n# A. target 未入力（完全互換）');
const seedBase = buildSeedUserPrompt(MODE);
const followBase = buildFollowupUserPrompt(TURNS, MODE);
check(buildSeedUserPrompt(MODE, null) === seedBase, 'seed: null は無引数と byte 一致');
check(buildSeedUserPrompt(MODE, undefined) === seedBase, 'seed: undefined は無引数と byte 一致');
check(
  buildSeedUserPrompt(MODE, normalizeInterviewTarget({ companyName: '   ' })) === seedBase,
  'seed: 無効 target（空 companyName→null）は byte 一致',
);
check(buildFollowupUserPrompt(TURNS, MODE, null) === followBase, 'followup: null は byte 一致');
check(
  buildFollowupUserPrompt(TURNS, MODE, undefined) === followBase,
  'followup: undefined は byte 一致',
);
check(
  count(seedBase, S.focus) === 0 && count(followBase, S.job) === 0,
  'target 未入力: センチネルが operative prompt に一切出ない',
);

// ── ケースB: focusPoint のみ実質有効 ──
console.log('\n# B. focusPoint のみ');
const tB = normalizeInterviewTarget({ companyName: S.company, focusPoint: S.focus })!;
const seedB = buildSeedUserPrompt(MODE, tB);
const followB = buildFollowupUserPrompt(TURNS, MODE, tB);
check(count(seedB, S.focus) === 1, 'seed: focusPoint 由来指示が到達（1回・復唱過剰なし）');
check(count(followB, S.focus) === 1, 'followup: focusPoint 由来の優先ルールが到達（1回）');
check(followB.includes('最優先'), 'followup: focusPoint が「最優先」として明示される');
check(seedB !== seedBase && followB !== followBase, 'target 未入力との byte 差分が発生');
check(count(seedB, S.job) === 0 && count(followB, S.job) === 0, '未入力の jobType 指示は出ない');
check(
  followB.includes('無理に聞かない') && followB.includes('繰り返さない'),
  'followup: 復唱・重複・不自然な転換の抑止が入る',
);

// ── ケースC: jobType あり ──
console.log('\n# C. jobType あり');
const tC = normalizeInterviewTarget({ companyName: S.company, jobType: S.job })!;
const seedC = buildSeedUserPrompt(MODE, tC);
const followC = buildFollowupUserPrompt(TURNS, MODE, tC);
check(count(seedC, S.job) === 1, 'seed: 職種に接続しやすい入口の指示が到達');
check(count(followC, S.job) === 1, 'followup: 職種能力を確認する指示が到達');
check(followC.includes('捏造しない'), 'followup: 企業固有基準の捏造禁止ガードが入る');
check(count(seedC, S.focus) === 0, '未入力の focusPoint 指示は出ない');

// ── ケースD: 必須4項目すべて入力（+ 廃止フィールドを混ぜても漏れない） ──
// ★ 旧データ相当として interviewPhase / companyMemo を意図的に混ぜる。normalize が読み捨て、
//   seed / followup / system / 評価 instruction のどこにも出ないことを固定する。
console.log('\n# D. 必須4項目すべて入力（廃止フィールド混入あり）');
const RAW_D = {
  companyName: S.company,
  industry: 'IT・SaaS',
  jobType: S.job,
  selectionType: 'main',
  // 廃止済み（旧 localStorage データに残っている想定）。
  interviewPhase: 'final',
  companyMemo: S.memo,
  focusPoint: S.focus,
};
const tD = normalizeInterviewTarget(RAW_D)!;
const seedD = buildSeedUserPrompt(MODE, tD);
const followD = buildFollowupUserPrompt(TURNS, MODE, tD);
check(count(seedD, S.focus) === 1 && count(seedD, S.job) === 1, 'seed: focus/job が user に到達');
check(
  count(followD, S.focus) === 1 && count(followD, S.job) === 1,
  'followup: focus/job が user に到達',
);
// 廃止済み入力は normalize の時点で落ちる（型・保存・prompt のいずれにも載せない）。
check(
  !('interviewPhase' in tD) && !('companyMemo' in tD),
  'normalize: 旧 interviewPhase / companyMemo は target に載らない（読み捨て）',
);
check(
  tD.companyName === S.company &&
    tD.industry === 'IT・SaaS' &&
    tD.jobType === S.job &&
    tD.selectionType === 'main',
  'normalize: 必須4項目（企業名/業界/職種/選考種別）は保持される',
);
// system prompt（背景ブロック）にも廃止フィールドは一切出ない。
const systemD = buildInterviewBaseSystem({ target: tD, interviewType: MODE });
check(
  count(systemD, S.memo) === 0 && !systemD.includes('選考フェーズ') && !systemD.includes('企業メモ'),
  'system: companyMemo / 選考フェーズ のブロックが存在しない',
);
check(
  count(seedD, S.memo) === 0 && count(followD, S.memo) === 0,
  'operative: companyMemo 由来の文言が seed / followup に出ない',
);
check(
  systemD.includes('事実は断定・捏造せず') && followD.includes('捏造しない'),
  '企業事実の断定・捏造禁止ガードは維持されている（memo 廃止で失われていない）',
);

// ── ケースE: 長い面接履歴でも focusPoint 優先と復唱回避が維持 ──
console.log('\n# E. 長い面接履歴');
const followE = buildFollowupUserPrompt(LONG_TURNS, MODE, tD);
check(count(followE, S.focus) === 1, 'long: focusPoint は毎回そのまま復唱せず 1 回参照');
check(followE.includes('最優先'), 'long: focusPoint 優先ルールが維持');
check(followE.includes('自然に統合した1問'), 'long: 直前回答との自然な統合指示が維持');
check(
  followE.includes('学生時代に力を入れたこと') && followE.includes('意見の対立をまとめる調整'),
  'long: 既存の transcript（直前回答含む）が維持される',
);

// ── 評価側が不変であることの確認（target あり complete は既存仕様のまま） ──
console.log('\n# 評価側の不変確認');
const finalUser = buildFinalUserPrompt(TURNS);
check(count(finalUser, S.focus) === 0, 'final user prompt は target 非依存（従来どおり）');
const feedbackInstr = buildFinalFeedbackInstruction(MODE, false, tD);
check(
  feedbackInstr.includes('targetFeedback') && feedbackInstr.includes('weakPointsForThisTarget'),
  '評価 instruction は既存の targetFeedback スキーマを維持',
);
// 選考フェーズ廃止に伴い、phaseSpecificComment は新規面接では出力させない
// （型・結果画面は過去ログ表示のためだけに残している）。
check(
  !feedbackInstr.includes('phaseSpecificComment') && count(feedbackInstr, S.memo) === 0,
  '評価 instruction に phaseSpecificComment / companyMemo が出力指示として残っていない',
);
check(
  feedbackInstr.includes('jobFitComment') && feedbackInstr.includes('selectionTypeComment'),
  '評価 instruction は職種・選考種別の評価軸を維持（必須入力に対応）',
);

// ── ケースF: 基本情報フォームの必須契約（静的） ──
// operative prompt では検証できない UI 側の必須化を、ソース上の不変条件として固定する。
console.log('\n# F. 基本情報フォームの必須契約');
const targetPage = readFileSync(
  join(process.cwd(), 'app/career/interview/target/page.tsx'),
  'utf8',
);
// ★ 実コードだけを見る（廃止理由を説明する行コメントを誤検知しないため。
//   career-company-spine-qa の「field 宣言だけを見る」と同じ方針）。
const targetPageCode = targetPage
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
// ★ 必須判定は共有純関数（isInterviewTargetComplete）へ一本化してある。
//   UI（基本情報フォーム / 面接モード選択）と start route が同じ述語を使うため、
//   「画面は通すのに API は弾く（またはその逆）」という食い違いが構造的に起きない。
//   まず述語そのものを behavioral に固定し、次に各 boundary が実際に使っているかを見る。
const FULL_TARGET = {
  companyName: S.company,
  industry: 'IT・SaaS',
  jobType: S.job,
  selectionType: 'main' as const,
};
check(
  isInterviewTargetComplete(normalizeInterviewTarget(FULL_TARGET)) &&
    !isInterviewTargetComplete(normalizeInterviewTarget({ ...FULL_TARGET, companyName: '' })) &&
    !isInterviewTargetComplete(normalizeInterviewTarget({ ...FULL_TARGET, industry: '' })) &&
    !isInterviewTargetComplete(normalizeInterviewTarget({ ...FULL_TARGET, jobType: '   ' })) &&
    !isInterviewTargetComplete(
      normalizeInterviewTarget({ ...FULL_TARGET, selectionType: undefined }),
    ) &&
    !isInterviewTargetComplete(null),
  'F-1 必須4項目（企業名/業界/職種/選考種別）が欠けると面接を開始できない',
);
check(
  /canProceed\s*=\s*isInterviewTargetComplete\(/.test(targetPageCode),
  'F-1b 基本情報フォームの「次へ」が同じ必須判定を使う',
);
check(
  /useState<CareerInterviewSelectionType \| null>\(null\)/.test(targetPage),
  'F-2 選考種別は初期選択を持たない（ユーザーが明示的に選ぶ）',
);
check(
  !targetPageCode.includes('指定なし'),
  'F-3 選考種別に「指定なし」の選択肢が存在しない',
);
check(
  !targetPageCode.includes('選考フェーズ') && !targetPageCode.includes('interviewPhase'),
  'F-4 選考フェーズ UI / state が存在しない',
);
check(
  !targetPageCode.includes('companyMemo') &&
    !targetPageCode.includes('企業について分かっていること'),
  'F-5 企業メモ UI / state が存在しない（企業情報は企業分析 / Company Data Spine の領分）',
);
check(
  targetPageCode.includes('loadCompanyApplicationDefaults'),
  'F-6 Application Context の初期値供給は維持されている',
);
// UI の disabled だけに頼らず、新規面接の開始 boundary（start route）でも必須を検証する。
// ★ turn / complete には課さない（既に始まった面接・旧セッションを完走させるため）。
const startRoute = readFileSync(
  join(process.cwd(), 'app/api/career/interview/start/route.ts'),
  'utf8',
);
check(
  /if\s*\(!isInterviewTargetComplete\(target\)\)/.test(startRoute) &&
    startRoute.includes('status: 400'),
  'F-7 start route が不完全な target を 400 で弾く（validation boundary への反映）',
);
const turnRoute = readFileSync(
  join(process.cwd(), 'app/api/career/interview/turn/route.ts'),
  'utf8',
);
const completeRoute = readFileSync(
  join(process.cwd(), 'app/api/career/interview/complete/route.ts'),
  'utf8',
);
check(
  !turnRoute.includes('isInterviewTargetComplete') &&
    !completeRoute.includes('isInterviewTargetComplete'),
  'F-8 turn / complete には必須検証を課さない（進行中・旧セッションの完走互換）',
);

// ── ケースG: 音声のみ / 面接モード 4 種類の契約（静的） ──
console.log('\n# G. 音声のみ・面接モード 4 種類');
const setupPage = readFileSync(
  join(process.cwd(), 'app/career/interview/setup/page.tsx'),
  'utf8',
);
const setupPageCode = setupPage
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
check(
  CAREER_INTERVIEW_MODE_ORDER.length === 4 &&
    CAREER_INTERVIEW_MODE_ORDER.join(',') === 'self_analysis,motivation,real,pressure',
  'G-1 新規面接で選べるモードは 4 種類だけ（自己分析 / 企業理解 / 本番 / 圧迫面接）',
);
check(
  CAREER_INTERVIEW_MODES.map((m) => m.label).join('・') ===
    '自己分析モード・企業理解モード・本番モード・圧迫面接モード',
  'G-2 4 モードの表示ラベルが本番 UX の名称になっている',
);
// 旧モードは UI から消えるが、過去ログのラベル解決は維持する（read 互換）。
check(
  getInterviewModeConfig('gakuchika').label === 'ガクチカ深掘り' &&
    getInterviewModeConfig('self_pr').label === '自己PR深掘り',
  'G-3 旧モード（gakuchika / self_pr）は過去ログ表示のため config を保持',
);
check(
  /mode:\s*'voice'/.test(setupPageCode) && !/setMode\(/.test(setupPageCode),
  'G-4 新規セッションは常に音声（テキスト / 音声の selector が無い）',
);
check(
  !setupPageCode.includes('テキストで回答') && !setupPageCode.includes('回答モード'),
  'G-5 テキスト面接の選択肢・回答モード選択 UI が存在しない',
);
const sessionPage = readFileSync(
  join(process.cwd(), 'app/career/interview/session/page.tsx'),
  'utf8',
);
const sessionPageCode = sessionPage
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
check(
  !/<Textarea/.test(sessionPageCode),
  'G-6 面接中にキーボードで回答を入力する UI が存在しない',
);
// ★ 内部 text pipeline（STT transcript → LLM → AI 応答テキスト → TTS）は削除しない。
check(
  sessionPageCode.includes('onFinalTranscript') &&
    sessionPageCode.includes('startListening') &&
    sessionPageCode.includes('speak(') &&
    sessionPageCode.includes("role: 'answer'"),
  'G-7 内部 text pipeline（STT transcript / LLM 入力 / TTS 読み上げ）は維持されている',
);
check(
  sessionPageCode.includes('voiceError') && sessionPageCode.includes('sttSupported'),
  'G-8 マイク不可・音声認識エラー時に案内が出る（無反応にしない）',
);
// ── 音声モード UI（テキスト混在の解消）を固定する ──
// 音声モードは「質問は耳で聞く / 回答は口で話す」に集中させる。質問本文の常時表示や
// 小さすぎる録音 CTA へ逆戻りしないよう、条件分岐そのものを guard する。
check(
  /const isVoiceMode\s*=\s*session\?\.mode !== 'text'/.test(sessionPageCode) &&
    /const showQuestionText\s*=\s*!isVoiceMode \|\| !ttsSupported/.test(sessionPageCode),
  'G-9 音声モード判定と「質問本文を出すか」の条件が明示されている',
);
check(
  /\{question && showQuestionText &&/.test(sessionPageCode) &&
    /\{question && !showQuestionText &&/.test(sessionPageCode) &&
    sessionPageCode.includes('もう一度聞く'),
  'G-10 音声モードでは質問本文を出さず、聞き直し操作（もう一度聞く）だけを置く',
);
check(
  /size=\{isVoiceMode \? 'lg' : 'sm'\}/.test(sessionPageCode) &&
    sessionPageCode.includes('録音して回答'),
  'G-11 音声モードの「録音して回答」は主役 CTA サイズ（テキスト時の sm より大きい）',
);
check(
  /if \(isVoiceMode && ttsSupported/.test(sessionPageCode),
  'G-12 質問の自動読み上げは音声モードでのみ走る（質問本文を消しても TTS は動く）',
);

// ── ケースH: Company Data Spine A 層（公式情報）の面接接続 ──
// A 層（外部・公式の一次情報）と B 層（本人の企業研究メモ）が **別ブロック**で system prompt に
// 届くこと、モード別の扱い、欠損時の graceful degradation を固定する。
console.log('\n# H. Company Data Spine A 層の面接接続');

const A = {
  business: 'AOFFICIALSENT_法人向けクラウド勤怠管理サービスの開発と提供',
  source: 'https://example-official.co.jp/company/',
};
const B = { research: 'BRESEARCHSENT_説明会で聞いた現場の裁量の大きさに惹かれた' };

// A 層 read 結果（実 repository と同じ型・同じ projection 形）。
const officialContext = {
  companyId: 'cmp_test',
  displayName: S.company,
  facts: [
    {
      factKey: 'businessDescription' as const,
      factGroup: 'profile' as const,
      displayValue: A.business,
      unit: null,
      asOf: null,
      sourceUrl: A.source,
      sourceType: 'official_site' as const,
      fetchedAt: '2026-08-01T00:00:00.000Z',
      freshness: 'fresh' as const,
      extractionMethod: 'html_structured' as const,
    },
  ],
  groups: [
    {
      factGroup: 'profile' as const,
      freshness: 'fresh' as const,
      fetchedAt: '2026-08-01T00:00:00.000Z',
      validUntil: '2026-12-01T00:00:00.000Z',
      ageSeconds: 100,
    },
  ],
  sourceUrls: [A.source],
  oldestFetchedAt: '2026-08-01T00:00:00.000Z',
  newestFetchedAt: '2026-08-01T00:00:00.000Z',
};
const OFFICIAL_READY = { status: 'ready' as const, data: officialContext };
const researchCtx = {
  logId: 'log1',
  companyName: S.company,
  verifiedResearchTextPreview: B.research,
} as unknown as Parameters<typeof buildInterviewBaseSystem>[0]['companyResearch'];

const sysWith = (
  mode: 'self_analysis' | 'motivation' | 'real' | 'pressure',
  opts: { official?: boolean; research?: boolean } = {},
) =>
  buildInterviewBaseSystem({
    target: tD,
    interviewType: mode,
    ...(opts.official ? { companyOfficial: OFFICIAL_READY } : {}),
    ...(opts.research ? { companyResearch: researchCtx } : {}),
  });

// H-1〜H-3: 企業理解 / 本番 / 圧迫は A 層を受け取る（同一 data source）。
for (const mode of ['motivation', 'real', 'pressure'] as const) {
  const sys = sysWith(mode, { official: true });
  check(
    count(sys, A.business) === 1 && sys.includes('【公式情報'),
    `H-1 ${mode}: A 層（公式情報）が system prompt へ届く`,
  );
  check(
    sys.includes(A.source),
    `H-2 ${mode}: 出典 URL が併記される（provenance）`,
  );
}
// ★ 本番 / 圧迫は persona・guidance（＝behavior）が違うのは正しい。ここで固定したいのは
//   「企業 context（A 層 block と B 層の中身）が両モードで同一」＝ data source が同じこと。
const officialBlockOf = (sys: string) => {
  const i = sys.indexOf('【公式情報');
  // block 同士は '\n\n' 区切りで結合される。先頭の 1 block だけ取り出す。
  return i < 0 ? '' : sys.slice(i).split('\n\n')[0];
};
{
  const realSys = sysWith('real', { official: true, research: true });
  const pressureSys = sysWith('pressure', { official: true, research: true });
  check(
    officialBlockOf(realSys) !== '' &&
      officialBlockOf(realSys) === officialBlockOf(pressureSys) &&
      count(realSys, B.research) === count(pressureSys, B.research) &&
      count(realSys, A.business) === count(pressureSys, A.business),
    'H-3 ★ 圧迫は本番と同一の企業 data source（圧迫専用経路を作っていない）',
  );
  check(
    realSys !== pressureSys &&
      pressureSys.includes('圧迫面接モード') &&
      realSys.includes('本番モード'),
    'H-3b 差分は interviewer behavior（persona / guidance）だけに現れる',
  );
}

// H-4: A 層と B 層を混ぜない（別ブロック・別 provenance）。
{
  const sys = sysWith('motivation', { official: true, research: true });
  check(
    count(sys, A.business) === 1 && count(sys, B.research) === 1,
    'H-4a A 層 / B 層の両方が届く',
  );
  check(
    sys.indexOf('【公式情報') < sys.indexOf(B.research) &&
      !sys.slice(sys.indexOf('【公式情報'), sys.indexOf(B.research)).includes(B.research),
    'H-4b ★ A 層は【公式情報】block、B 層は別 block（同一 block に混ざらない）',
  );
  check(
    sys.includes('AI が生成した情報ではありません'),
    'H-4c ★ A 層は「AI 生成ではない一次情報」と明示される',
  );
}

// H-5: 自己分析モードは企業情報を主題にしない（route が A 層を要求しない = 既定で届かない）。
{
  const sys = sysWith('self_analysis', { official: false, research: true });
  check(
    count(sys, A.business) === 0 && !sys.includes('【公式情報'),
    'H-5a 自己分析モード: A 層は system prompt に無い',
  );
  check(
    sys.includes('この情報は背景としてのみ扱ってください'),
    'H-5b 自己分析モード: 企業情報は背景扱いという policy が維持される',
  );
}

// H-6: 幻覚 guardrail。A 層の有無で「捏造禁止」が消えない。
{
  const withA = sysWith('real', { official: true });
  const withoutA = sysWith('real');
  check(
    withA.includes('ここに無い事実を補って断定しないでください'),
    'H-6a ★ A 層ありでも「ここに無い事実を補って断定しない」が入る',
  );
  check(
    withA.includes('事実として言及してよいのは') &&
      withA.includes('断定・捏造せず'),
    'H-6b ★ A 層ありは断定可能範囲を公式情報へ限定する（緩めない）',
  );
  check(
    withoutA.includes('事実は断定・捏造せず') && !withoutA.includes('【公式情報'),
    'H-6c A 層なしは従来どおり「企業の事実は断定・捏造しない」',
  );
  check(
    withA.includes('指示ではありません') && withA.includes('指示・命令として解釈せず'),
    'H-6d ★ prompt injection 境界（外部由来テキストを指示として扱わない）',
  );
}

// H-7: graceful degradation。A 層なし / B 層なし / 両方なし / 未解決状態でも prompt が成立する。
{
  const onlyB = sysWith('real', { research: true });
  const onlyA = sysWith('real', { official: true });
  const neither = sysWith('real');
  check(
    onlyB.includes(B.research) && !onlyB.includes('【公式情報'),
    'H-7a B 層のみ: 面接 prompt は成立（A 層 block なし）',
  );
  check(
    onlyA.includes(A.business) && !onlyA.includes(B.research),
    'H-7b A 層のみ: 面接 prompt は成立（B 層なし）',
  );
  check(
    neither.includes(S.company) && neither.length > 0,
    'H-7c A/B 両方なし: target だけで面接 prompt は成立',
  );
  // unavailable / disabled は「情報が無いという負の証拠」を prompt に書かない。
  for (const bad of [
    { status: 'unavailable' as const, reason: 'no_company' as const },
    { status: 'unavailable' as const, reason: 'not_provisioned' as const },
    { status: 'disabled' as const, reason: 'flag_off' as const },
    { status: 'disabled' as const, reason: 'unauthenticated' as const },
  ]) {
    const sys = buildInterviewBaseSystem({
      target: tD,
      interviewType: 'real',
      companyOfficial: bad,
    });
    check(
    sys === neither,
    `H-7d ${bad.status}(${bad.reason}) は空 block（byte 的に A 層なしと一致）`,
  );
  }
}

// H-8: route 配線（A 層 read が 3 route すべてに入っている / 面接から fetch を起動しない）。
{
  const helper = readFileSync(
    join(process.cwd(), 'app/api/career/interview/resolveCompanyOfficial.ts'),
    'utf8',
  );
  // 「crawler を起動しない」等と *説明している* コメント行を検知しないよう実コードだけ見る。
  const helperCode = helper
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const routes = ['start', 'turn', 'complete'].map((r) =>
    readFileSync(join(process.cwd(), `app/api/career/interview/${r}/route.ts`), 'utf8'),
  );
  check(
    routes.every(
      (s) => s.includes('resolveInterviewCompanyOfficial(') && s.includes('companyOfficial,'),
    ),
    'H-8a start / turn / complete すべてが A 層を解決して builder へ渡す',
  );
  check(
    helper.includes("from '@/lib/careerCompanyOfficial/readRepository.server'"),
    'H-8b ★ 既存の read repository を使う（面接側で企業 read を再実装しない）',
  );
  check(
    !/\bfetch\(|triggerCompanyPrefetch|enqueue|crawl/i.test(helperCode) &&
      routes.every((s) => !/triggerCompanyPrefetch|companyPrefetch/i.test(s)),
    'H-8c ★ 面接 runtime から fetch / crawl / prefetch を起動しない（read のみ）',
  );
  check(
    /interviewType !== 'self_analysis'/.test(helper),
    'H-8d ★ 自己分析モードは A 層を要求しない（mode gate が helper にある）',
  );
  check(
    /catch\s*\{[\s\S]{0,200}return null;/.test(helperCode),
    'H-8e never-throw（read 失敗は null に倒して面接を止めない）',
  );
  check(
    helper.includes('companyId: companyId || null') &&
      helper.includes('companyName: companyName || null'),
    'H-8f ★ companyId を必須にしない（企業名だけでも解決を試みる）',
  );
}

console.log('');
console.log(fails === 0 ? 'ALL_PASS' : `FAIL: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
