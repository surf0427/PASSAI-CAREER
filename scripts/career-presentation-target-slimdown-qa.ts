/*
 * scripts/career-presentation-target-slimdown-qa.ts
 *
 * PASSAI CAREER — プレゼン 選考文脈フォーム簡素化の回帰 QA（dev-only 常設・決定的）。
 *
 * 目的:
 *   プレゼン機能から廃止した 3 項目
 *     - 想定シーン（scenario）
 *     - 発表形式（format）
 *     - 企業について分かっていること・メモ（companyMemo）
 *   が、UI / state / normalize / config / prompt のどこにも「幽霊フィールド」として
 *   残っていないことをセンチネル方式で機械的に固定する。
 *   併せて 選考種別（selectionType）が 本選考 / インターン選考 の 2 択のみであること、
 *   残した入力（企業名・業界・職種・選考種別・難易度・特に練習したいこと）が
 *   prompt へ到達し続けることを回帰ガードする。
 *   外部 AI 非実行・実データ非参照・DB/Supabase 非接続。
 *
 * 使い方: npx tsx scripts/career-presentation-target-slimdown-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildThemeUserPrompt,
  buildEvaluateUserPrompt,
  buildEvaluateInstruction,
  buildQaUserPrompt,
} from '@/app/api/career/presentation/presentationPrompt';
import {
  normalizePresentationTarget,
  presentationConfigFromTarget,
  CAREER_PRESENTATION_SELECTION_TYPES,
  CAREER_PRESENTATION_NEW_SESSION_TYPE,
  getSelectionTypeLabel,
} from '@/app/career/presentation/presentationModes';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// 廃止した入力の「負のセンチネル」。旧下書きに混ぜ、prompt へ 1 度も漏れないことを見る。
const S = {
  company: 'テスト株式会社',
  job: 'JOBSENT法人営業',
  focus: 'FOCUSSENT_結論ファーストで話す練習',
  memo: 'MEMOSENT_主力事業はBtoB SaaSで直近は海外展開に注力している',
};

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};
const section = (t: string) => console.log(`\n── ${t} ──`);

// ════════════════════════════════════════════════════════════════════
section('A. normalize — 廃止フィールドを読み捨てる');

// ★ 旧下書き相当として scenario / format / companyMemo を意図的に混ぜる。
const legacyDraft = {
  companyName: S.company,
  industry: 'IT・通信',
  jobType: S.job,
  selectionType: 'internship',
  difficulty: 'hard',
  focusPoint: S.focus,
  scenario: 'company_proposal',
  format: 'group_rep',
  companyMemo: S.memo,
};

const target = normalizePresentationTarget(legacyDraft);
check(!!target, 'normalize: 旧下書きから target を復元できる');

const tKeys = Object.keys(target ?? {});
check(
  !tKeys.includes('scenario') && !tKeys.includes('format') && !tKeys.includes('companyMemo'),
  'normalize: 旧 scenario / format / companyMemo は target に載らない（読み捨て）',
);
check(
  target?.companyName === S.company &&
    target?.industry === 'IT・通信' &&
    target?.jobType === S.job &&
    target?.selectionType === 'internship' &&
    target?.difficulty === 'hard' &&
    target?.focusPoint === S.focus,
  'normalize: 残した 6 項目は欠けずに復元される',
);

// 廃止フィールドだけの下書きは「有効な文脈なし」＝ null（指定なし扱い）。
check(
  normalizePresentationTarget({
    scenario: 'case',
    format: 'individual',
    companyMemo: S.memo,
  }) === null,
  'normalize: 廃止フィールドだけの旧下書きは null（文脈として復活しない）',
);

// ════════════════════════════════════════════════════════════════════
section('B. config — target からの写しに廃止フィールドが出ない');

const config = presentationConfigFromTarget(target);
const cKeys = Object.keys(config);
check(
  !cKeys.includes('scenario') && !cKeys.includes('format') && !cKeys.includes('companyMemo'),
  'config: 廃止フィールドが写されない',
);
check(
  config.companyName === S.company &&
    config.jobType === S.job &&
    config.selectionType === 'internship' &&
    config.focusPoint === S.focus,
  'config: 残した項目は写される',
);

// ════════════════════════════════════════════════════════════════════
section('C. prompt — 3 route すべてに廃止フィールドが漏れない');

// 旧ログ相当（config に廃止フィールドが残っているケース）を cast で強制的に流し込む。
const legacyConfig = {
  ...config,
  scenario: 'company_proposal',
  format: 'group_rep',
  companyMemo: S.memo,
} as typeof config;

const prompts: Array<{ name: string; text: string }> = [
  {
    name: 'theme',
    text: buildThemeUserPrompt({ config: legacyConfig, timeLimitSec: 180, difficulty: 'hard' }),
  },
  {
    name: 'evaluate(user)',
    text: buildEvaluateUserPrompt({
      theme: 'あなたの強みを3分で',
      timeLimitSec: 180,
      durationSec: 170,
      transcript: '発表本文',
      config: legacyConfig,
    }),
  },
  {
    name: 'evaluate(instruction)',
    text: buildEvaluateInstruction({ theme: 'あなたの強みを3分で', config: legacyConfig }),
  },
  {
    name: 'qa',
    text: buildQaUserPrompt({
      theme: 'あなたの強みを3分で',
      transcript: '発表本文',
      turns: [],
      config: legacyConfig,
    }),
  },
];

for (const p of prompts) {
  check(!p.text.includes(S.memo), `${p.name}: 企業メモ本文が出ない`);
  check(!p.text.includes('企業メモ'), `${p.name}: 「企業メモ」由来の instruction が出ない`);
  check(!p.text.includes('想定シーン'), `${p.name}: 「想定シーン」ブロックが出ない`);
  check(!p.text.includes('発表形式'), `${p.name}: 「発表形式」ブロックが出ない`);
  check(!p.text.includes('グループ代表発表'), `${p.name}: 発表形式のラベルが出ない`);
  // 想定シーン固有の語彙。「企業課題提案」は難易度 hard の hint にも出るため使わない。
  check(!p.text.includes('GD後の発表'), `${p.name}: 想定シーンのラベルが出ない`);
  check(!p.text.includes('このシーン'), `${p.name}: シーン別の出し分け文言が出ない`);
  check(!p.text.includes('company_proposal'), `${p.name}: 旧 scenario の内部値が出ない`);
  check(!p.text.includes('group_rep'), `${p.name}: 旧 format の内部値が出ない`);
}

// 残した入力は prompt へ到達し続ける（削除の巻き添えで消えていないこと）。
const themeText = prompts[0].text;
const evalText = prompts[1].text;
check(themeText.includes(S.company), 'theme: 企業名が到達する');
check(themeText.includes(S.job), 'theme: 職種が到達する');
check(themeText.includes(S.focus), 'theme: 特に練習したいことが到達する');
check(themeText.includes('難しめ'), 'theme: 難易度が到達する');
check(themeText.includes('選考種別: インターン選考'), 'theme: 選考種別が到達する');
check(evalText.includes('選考種別: インターン選考'), 'evaluate: 選考種別が到達する');
check(evalText.includes(S.company) && evalText.includes(S.job), 'evaluate: 企業名・職種が到達する');

// 企業情報の hallucination ガードは（メモの有無に関わらず）常に置かれる。
check(
  buildThemeUserPrompt({ config: {} }).includes('断定'),
  'theme: 企業メモが無くても事実断定ガードが残る（無条件の指示）',
);

// ════════════════════════════════════════════════════════════════════
section('D. 選考種別 — 本選考 / インターン選考 の 2 択のみ');

check(CAREER_PRESENTATION_SELECTION_TYPES.length === 2, '選択肢は 2 つだけ');
check(
  CAREER_PRESENTATION_SELECTION_TYPES.map((o) => o.label).join(',') === '本選考,インターン選考',
  'ラベルは 本選考 / インターン選考',
);
check(
  !CAREER_PRESENTATION_SELECTION_TYPES.some((o) => o.label === '指定なし' || o.value === null),
  '「指定なし」の選択肢は存在しない',
);
check(
  CAREER_PRESENTATION_SELECTION_TYPES.map((o) => o.value).join(',') === 'main,internship',
  '内部値は既存の main / internship のまま（migration 不要）',
);
// 未選択（optional）は許容される＝ラベル解決は null を返し、条件行に出ない。
check(getSelectionTypeLabel(undefined) === null, '未選択は null（入力は任意のまま）');
check(
  !buildThemeUserPrompt({ config: { companyName: S.company } }).includes('選考種別'),
  '未選択なら prompt に選考種別の行が出ない',
);

// ════════════════════════════════════════════════════════════════════
section('E. UI — setup 画面から 3 項目が消えている');

const targetPage = read('app/career/presentation/target/page.tsx');
check(!targetPage.includes('想定シーン'), 'target page: 「想定シーン」の文言が無い');
check(!targetPage.includes('発表形式'), 'target page: 「発表形式」の文言が無い');
check(
  !targetPage.includes('企業について分かっていること'),
  'target page: 企業メモの textarea ラベルが無い',
);
check(
  !targetPage.includes('scenario') &&
    !targetPage.includes('companyMemo') &&
    !targetPage.includes('setFormat'),
  'target page: 廃止フィールドの state / 参照が無い',
);
check(
  targetPage.includes('CompanyPicker') && targetPage.includes('企業を指定せずに練習する'),
  'target page: 企業選択・企業を指定しない導線は維持されている',
);

const setupPage = read('app/career/presentation/setup/page.tsx');
check(
  !setupPage.includes('scenario') && !setupPage.includes('getFormatLabel'),
  'setup page: 廃止フィールドの参照が無い',
);

const sessionPage = read('app/career/presentation/session/page.tsx');
check(
  !sessionPage.includes('scenario') && !sessionPage.includes('cfg?.format'),
  'session page: 廃止フィールドを event metadata へ書かない',
);

const resultPage = read('app/career/presentation/result/page.tsx');
check(
  !resultPage.includes('scenario') && !resultPage.includes('getFormatLabel'),
  'result page: 廃止フィールドを表示しない',
);

// ════════════════════════════════════════════════════════════════════
section('F. 後方互換 — 旧ログの表示が壊れない');

// presentationType は新旧すべての履歴が必ず持ち、ラベル解決の唯一の入力になる。
check(
  CAREER_PRESENTATION_NEW_SESSION_TYPE === 'real',
  '新規セッションの presentationType は固定値 real（旧 scenario 既定値の legacyType と同値）',
);
check(
  resultPage.includes('getPresentationModeConfig(r.presentationType)'),
  'result page: 履歴ラベルは presentationType から解決する（旧ログも新ログも同じ経路）',
);

console.log(`\n${fails === 0 ? '✅ PASS' : `❌ FAIL (${fails})`}`);
process.exit(fails === 0 ? 0 : 1);
