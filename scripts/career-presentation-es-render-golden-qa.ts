/*
 * scripts/career-presentation-es-render-golden-qa.ts
 *
 * PASSAI CAREER — presentation ES block render + useCareerContext gate の現状 coverage golden
 *   （P7-E 常設 harness）。
 *
 * 背景（P7-D 監査結論）:
 *   presentation は ES を full `CareerEsResult` で carry し、`headline / gakuchika / selfPr /
 *   motivation` の 4 field を **cap なし**で render するが、**`useCareerContext === true` のとき
 *   だけ** ES block を出す（既定 undefined/false では es が body にあっても prompt に出ない）。
 *   本 harness は「現状の render 出力」と「gate 挙動」の両方を固定する。
 *
 * 何を守るか（P7-E は「削減」ではなく「現状固定」）:
 *   - useCareerContext === true のときだけ ES block が出る（gate）。
 *   - useCareerContext !== true のとき es があっても prompt に出ない。
 *   - ES block render が headline/gakuchika/selfPr/motivation の 4 field・現状順序・ラベル。
 *   - cap / truncate が入っていない現状（heavy 長文がそのまま出る）。
 *   - 未 render field が出ない現状。
 *   - ES block が「参考情報（発表の主役ではない）」である現状ラベル・文脈。
 *
 * production drift 検知:
 *   render/gate はモジュール private のため、本 harness に production line 228-230 の **忠実複製**
 *   （presentationEsBlock）を置く。複製が production からズレても気付けるよう、**実 export の
 *   buildPresentationBaseSystem** を呼び、gate 別に見出し/逐語一致を cross-check する（DRIFT check）。
 *
 * 厳守（P7-E）:
 *   - production code は **読むだけ**（export 追加・render 変更・cap 追加・body 変更なし）。
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
import { buildPresentationBaseSystem } from '@/app/api/career/presentation/presentationPrompt';

const GOLDEN_DIR = join(process.cwd(), 'scripts/fixtures/presentation-es-render');
const UPDATE = process.argv.includes('--update') || process.env.UPDATE === '1';

const rep = (base: string, n: number) => base.repeat(Math.ceil(n / base.length)).slice(0, n);

// ── production 忠実複製（presentationPrompt.ts renderEs と 1:1・cap なし） ──
function renderEs(result: CareerEsResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  const push = (label: string, value: string) => {
    if (value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  push('キャッチコピー', result.headline);
  push('ガクチカ', result.gakuchika);
  push('自己PR', result.selfPr);
  push('志望動機', result.motivation);
  return lines.join('\n');
}

// ── production 忠実複製（presentationPrompt.ts L228-230: gate 込みの ES block） ──
//   useCtx=true のときだけ renderEs 出力、そうでなければ ''（block ごと出さない）。
function presentationEsBlock(
  es: CareerEsResult | null | undefined,
  useCareerContext: boolean | undefined,
): string {
  const useCtx = useCareerContext === true;
  return useCtx ? renderEs(es) : '';
}

// full CareerEsResult fixture（未使用 field も full で持たせ、render に出ないことを検証する）。
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

// ES 見出し・参考情報ガードの現状文言（ラベル・文脈が変わっていないことを固定）。
const ES_HEADING = '# 参考: 直近の ES ドラフト（発表の主役ではない）';
const REF_GUARD_HEADING = '# 参考情報の扱い（重要）';

type Case = { name: string; es: CareerEsResult | null; useCtx: boolean | undefined };
const CASES: Case[] = [
  // 1) useCareerContext=true typical: 4 field すべて出る。
  { name: 'typical', es: makeEs(150, 150, 150), useCtx: true },
  // 2) useCareerContext=true heavy: 長文。cap 無しでそのまま出る（削減していない固定）。
  { name: 'heavy', es: makeEs(420, 400, 380), useCtx: true },
  // 3) useCareerContext=false: es があっても block は空（gate off の固定 → golden は空文字）。
  { name: 'use-context-false', es: makeEs(150, 150, 150), useCtx: false },
];

function goldenPath(name: string): string {
  return join(GOLDEN_DIR, `${name}.txt`);
}

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

// presentation base system を最小 input で組む（es と useCareerContext のみ変える）。
function realPrompt(es: CareerEsResult | null, useCtx: boolean | undefined): string {
  return buildPresentationBaseSystem({
    es,
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

  if (c.useCtx === true) {
    // 4 field が現状順序で出る
    const iHeadline = block.indexOf('- キャッチコピー:');
    const iGaku = block.indexOf('- ガクチカ:');
    const iSelfPr = block.indexOf('- 自己PR:');
    const iMot = block.indexOf('- 志望動機:');
    note(
      iHeadline >= 0 && iGaku > iHeadline && iSelfPr > iGaku && iMot > iSelfPr,
      `4 field が現状順序で出る | ${c.name}`,
    );
    note(iGaku >= 0, `gakuchika が render される（現状固定）| ${c.name}`);
    note(!block.includes('…'), `truncate（…）が入っていない | ${c.name}`);
    note(c.es !== null && block.includes(c.es.gakuchika.trim()), `gakuchika 全文が cap されず出る | ${c.name}`);
    for (const bad of FORBIDDEN_SUBSTRINGS) {
      note(!block.includes(bad), `未 render 字句が出ない | ${c.name} | "${bad}"`);
    }
    // DRIFT check: 実 base prompt に見出し・参考情報ガード・render 出力が逐語で含まれる。
    note(prompt.includes(ES_HEADING), `実 prompt に ES 見出し（参考情報ラベル）が出る | ${c.name}`);
    note(prompt.includes(REF_GUARD_HEADING), `実 prompt に参考情報の扱い注記が出る | ${c.name}`);
    note(prompt.includes(block), `実 prompt に render 出力が逐語一致で含まれる（drift 検知）| ${c.name}`);
  } else {
    // gate off: block は空、実 prompt に ES 見出しも render も出ない
    note(block === '', `useCareerContext≠true では ES block が空 | ${c.name}`);
    note(!prompt.includes(ES_HEADING), `実 prompt に ES 見出しが出ない（gate off）| ${c.name}`);
    note(!prompt.includes(renderEs(c.es)), `実 prompt に render 出力が出ない（gate off）| ${c.name}`);
  }
}

// 4) gate: useCareerContext undefined（既定）でも ES block は出ない
note(presentationEsBlock(makeEs(150, 150, 150), undefined) === '', 'useCareerContext 未指定 → ES block 空');
note(
  !realPrompt(makeEs(150, 150, 150), undefined).includes(ES_HEADING),
  '既定（config=null）では実 prompt に ES 見出しが出ない',
);

// 5) es=null + useCareerContext=true → block なし・実 prompt に見出しなし
note(presentationEsBlock(null, true) === '', 'es=null（useCtx=true）→ ES block 空');
note(!realPrompt(null, true).includes(ES_HEADING), 'es=null（useCtx=true）→ 実 prompt に ES 見出しなし');

// 6) 空 field fallback（renderEs 相当・cap なし現状）
note(
  renderEs({ ...makeEs(1, 1, 1), headline: '', gakuchika: '', selfPr: '', motivation: '' }) === '',
  '全 field 空 → 空文字',
);

console.log('');
console.log(failures === 0 ? 'ALL_PASS' : `FAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
