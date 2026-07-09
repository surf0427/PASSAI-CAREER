/*
 * scripts/career-presentation-es-render-golden-qa.ts
 *
 * PASSAI CAREER — presentation ES block render + useCareerContext gate の golden（P7-E→P7-F 更新）。
 *
 * P7-F でこの harness は「現状 cap なし固定」から「presentation strict summary（cap 済み）固定」へ更新。
 *   - render は production の renderPresentationEsSummary(buildPresentationEsSummary(...)) を **直接** 使う
 *     （lib/careerMemory/presentationEs が両関数を export しているため、忠実複製ではなく本物で drift 検知）。
 *   - gate（useCareerContext）は実 export の buildPresentationBaseSystem を呼んで検証する。
 *
 * 何を守るか（P7-F）:
 *   - useCareerContext === true のときだけ ES block が出る（gate）。
 *   - useCareerContext !== true のとき es があっても prompt に出ない（block 0）。
 *   - render が headline/gakuchika/selfPr/motivation の 4 field・現状順序・ラベル。
 *   - gakuchika/selfPr/motivation が **300 字 cap**、headline が 80 字 cap（heavy で truncate される）。
 *   - typical は cap 未満で無損失（… truncate が起きない）。
 *   - 未 render field（appealPoints / … / jobType）が出ない。
 *   - ES block が「参考情報（発表の主役ではない）」である現状ラベル・文脈。
 *
 * 厳守（P7-F）:
 *   - production の純関数（buildPresentationEsSummary / renderPresentationEsSummary /
 *     buildPresentationBaseSystem）を **読むだけ**。
 *   - route / prompt 文面 / AI schema / DB / Supabase / env / secret 非接続。
 *   - presentation 専用。matching / interview / consultation は扱わない。
 *
 * 使い方:
 *   npx tsx scripts/career-presentation-es-render-golden-qa.ts            # golden と比較（既定）
 *   npx tsx scripts/career-presentation-es-render-golden-qa.ts --update   # 現在の出力を golden に上書き
 * 終了コード: 全ケース golden 一致 & 全 assertion PASS → 0 / いずれか不一致・FAIL → 1。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CareerEsResult } from '@/types/careerEs';
import {
  buildPresentationEsSummary,
  renderPresentationEsSummary,
  PRESENTATION_ES_GAKUCHIKA_CAP,
  PRESENTATION_ES_SELFPR_CAP,
  PRESENTATION_ES_MOTIVATION_CAP,
} from '@/lib/careerMemory/presentationEs';
import { buildPresentationBaseSystem } from '@/app/api/career/presentation/presentationPrompt';

const GOLDEN_DIR = join(process.cwd(), 'scripts/fixtures/presentation-es-render');
const UPDATE = process.argv.includes('--update') || process.env.UPDATE === '1';

const rep = (base: string, n: number) => base.repeat(Math.ceil(n / base.length)).slice(0, n);

// full CareerEsResult fixture（未使用 field も full で持たせ、summary で落ちることを検証する）。
function makeEs(gLen: number, sLen: number, mLen: number): CareerEsResult {
  return {
    headline: '一言でいうと挑戦を続ける人間です',
    gakuchika: rep('学生時代に力を入れたことは長期インターンでの新規事業開発であり課題を構造化して', gLen),
    selfPr: rep('私の強みは課題を構造化し周囲を巻き込みながら粘り強く実行しやり切る力です', sLen),
    motivation: rep('貴社を志望する理由は事業の社会的意義と成長環境に強く共感しているためで', mLen),
    appealPoints: ['論理的思考力', '実行力', 'リーダーシップ', '傾聴力'],
    interviewQuestions: ['なぜその選択を?', '困難は?', '学びは?', '次にどう活かす?'],
    improvements: ['数値を入れる', '一文を短く', '結論を先に'],
    answer: rep('設問への回答本文です', 300),
    question: '学生時代に力を入れたことを教えてください（400字）',
    charLimit: 400,
    companyName: '株式会社サンプル',
    selectionType: 'main',
    industry: 'IT・通信',
    jobType: 'エンジニア',
  };
}

// production line 228-230 と同じ gate: useCtx=true のときだけ summary を render。
function presentationEsBlock(es: CareerEsResult | null, useCtx: boolean | undefined): string {
  return useCtx === true ? renderPresentationEsSummary(buildPresentationEsSummary(es)) : '';
}

const ES_HEADING = '# 参考: 直近の ES ドラフト（発表の主役ではない）';
const REF_GUARD_HEADING = '# 参考情報の扱い（重要）';

type Case = { name: string; es: CareerEsResult | null; useCtx: boolean | undefined };
const CASES: Case[] = [
  // typical: 全 field cap 未満 → 無損失（… truncate 無し）。
  { name: 'typical', es: makeEs(150, 150, 150), useCtx: true },
  // heavy: gakuchika/selfPr/motivation が cap 超過 → 300 字で truncate される固定。
  { name: 'heavy', es: makeEs(420, 400, 380), useCtx: true },
  // gate off: es があっても block 空（0 byte golden）。
  { name: 'use-context-false', es: makeEs(150, 150, 150), useCtx: false },
];

const goldenPath = (name: string) => join(GOLDEN_DIR, `${name}.txt`);

const FORBIDDEN_SUBSTRINGS = [
  '論理的思考力', // appealPoints
  'なぜその選択を', // interviewQuestions
  '数値を入れる', // improvements
  '設問への回答本文', // answer
  '株式会社サンプル', // companyName
  'IT・通信', // industry
];

let failures = 0;
const note = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) failures++;
};

// presentation base system を最小 input で組む（route が受け取る summary を渡す）。
function realPrompt(es: CareerEsResult | null, useCtx: boolean | undefined): string {
  return buildPresentationBaseSystem({
    es: buildPresentationEsSummary(es),
    config: useCtx === undefined ? null : { useCareerContext: useCtx },
    theme: 'テストお題',
  });
}

if (UPDATE && !existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

for (const c of CASES) {
  const block = presentationEsBlock(c.es, c.useCtx);
  const path = goldenPath(c.name);

  // 1) golden 比較 / 更新（use-context-false は空文字 golden = ES block が出ない固定）
  if (UPDATE) {
    writeFileSync(path, block, 'utf8');
    console.log(`📝 wrote golden | ${c.name} (${block.length} chars)`);
  } else if (!existsSync(path)) {
    note(false, `golden 欠落 | ${c.name}（--update で生成）`);
  } else {
    const golden = readFileSync(path, 'utf8');
    note(golden === block, `golden 一致 | ${c.name} (${block.length} chars)`);
    if (golden !== block) {
      console.log(`   golden: ${JSON.stringify(golden)}`);
      console.log(`   actual: ${JSON.stringify(block)}`);
    }
  }

  const prompt = realPrompt(c.es, c.useCtx);
  const summary = c.useCtx === true ? buildPresentationEsSummary(c.es) : null;

  if (c.useCtx === true) {
    // 4 field が現状順序で出る（キャッチコピー→ガクチカ→自己PR→志望動機）
    const iHeadline = block.indexOf('- キャッチコピー:');
    const iGaku = block.indexOf('- ガクチカ:');
    const iSelfPr = block.indexOf('- 自己PR:');
    const iMot = block.indexOf('- 志望動機:');
    note(
      iHeadline >= 0 && iGaku > iHeadline && iSelfPr > iGaku && iMot > iSelfPr,
      `4 field が現状順序で出る | ${c.name}`,
    );
    note(iGaku >= 0, `gakuchika が render される（presentation は残す）| ${c.name}`);
    // summary shape は 4 key のみ
    const keys = summary ? Object.keys(summary).sort() : [];
    note(
      JSON.stringify(keys) === JSON.stringify(['gakuchika', 'headline', 'motivation', 'selfPr']),
      `summary keys が 4 つのみ | ${c.name} | ${JSON.stringify(keys)}`,
    );
    // cap 検証（… を含め cap+1 以下）
    if (summary) {
      note(summary.gakuchika.length <= PRESENTATION_ES_GAKUCHIKA_CAP + 1, `gakuchika cap | ${c.name} | ${summary.gakuchika.length}`);
      note(summary.selfPr.length <= PRESENTATION_ES_SELFPR_CAP + 1, `selfPr cap | ${c.name} | ${summary.selfPr.length}`);
      note(summary.motivation.length <= PRESENTATION_ES_MOTIVATION_CAP + 1, `motivation cap | ${c.name} | ${summary.motivation.length}`);
    }
    for (const bad of FORBIDDEN_SUBSTRINGS) {
      note(!block.includes(bad), `未 render 字句が出ない | ${c.name} | "${bad}"`);
    }
    // DRIFT check: 実 base prompt に見出し・参考情報ガード・render 出力が逐語で含まれる。
    note(prompt.includes(ES_HEADING), `実 prompt に ES 見出し（参考情報ラベル）が出る | ${c.name}`);
    note(prompt.includes(REF_GUARD_HEADING), `実 prompt に参考情報の扱い注記が出る | ${c.name}`);
    note(prompt.includes(block), `実 prompt に render 出力が逐語一致で含まれる（drift 検知）| ${c.name}`);
  } else {
    note(block === '', `useCareerContext≠true では ES block が空 | ${c.name}`);
    note(!prompt.includes(ES_HEADING), `実 prompt に ES 見出しが出ない（gate off）| ${c.name}`);
  }
}

// typical は cap 未満で無損失（… truncate が起きない）
const typical = buildPresentationEsSummary(makeEs(150, 150, 150))!;
note(
  !typical.gakuchika.endsWith('…') && !typical.selfPr.endsWith('…') && !typical.motivation.endsWith('…'),
  'typical は cap 未満で無損失（truncate されない）',
);
// heavy は実際に truncate（… suffix）が起きる（cap が効いている証跡）
const heavy = buildPresentationEsSummary(makeEs(420, 400, 380))!;
note(
  heavy.gakuchika.endsWith('…') && heavy.selfPr.endsWith('…') && heavy.motivation.endsWith('…'),
  'heavy で gakuchika/selfPr/motivation が truncate される',
);

// gate: useCareerContext undefined（既定）でも ES block は出ない
note(presentationEsBlock(makeEs(150, 150, 150), undefined) === '', 'useCareerContext 未指定 → ES block 空');
note(!realPrompt(makeEs(150, 150, 150), undefined).includes(ES_HEADING), '既定（config=null）では実 prompt に ES 見出しが出ない');

// es=null + useCareerContext=true → block なし・実 prompt に見出しなし
note(presentationEsBlock(null, true) === '', 'es=null（useCtx=true）→ ES block 空');
note(!realPrompt(null, true).includes(ES_HEADING), 'es=null（useCtx=true）→ 実 prompt に ES 見出しなし');

console.log('');
console.log(failures === 0 ? 'ALL_PASS' : `FAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
