/*
 * scripts/career-interview-es-render-golden-qa.ts
 *
 * PASSAI CAREER — interview ES block render の現状 coverage golden（P7-E 常設 harness）。
 *
 * 背景（P7-D 監査結論）:
 *   interview は ES を full `CareerEsResult` で carry し、base system prompt に
 *   `headline / gakuchika / selfPr / motivation` の 4 field を **cap なし**で render する
 *   （matching と違い gakuchika を出す）。既存 prompt golden は base prompt のみ、body-byte
 *   harness は selector≡snapshot の live 等価比較で、ES render 出力そのものは非カバー。
 *   本 harness は **現状の ES render 出力を固定**し、将来の意図しない cap/削除/順序変更を検知する。
 *
 * 何を守るか（P7-E は「削減」ではなく「現状固定」）:
 *   - ES block render が headline/gakuchika/selfPr/motivation の 4 field・現状の順序・日本語ラベル。
 *   - gakuchika が **出ている**現状（面接深掘りの一次材料）。
 *   - cap / truncate が **入っていない**現状（heavy 長文がそのまま出る）。
 *   - 未 render field（appealPoints / interviewQuestions / improvements / answer / question /
 *     charLimit / companyName / selectionType / industry / jobType）が出ない現状。
 *   - null / 空 field fallback（未提供・空はスキップ、全空なら空文字）。
 *
 * production drift 検知:
 *   render 関数はモジュール private のため、本 harness に **忠実複製**（renderEs）を置く。
 *   複製が production からズレても気付けるよう、**実 export の buildInterviewBaseSystem** を呼び、
 *   複製 render 出力が実 prompt に **逐語で含まれること**を毎回 cross-check する（DRIFT check）。
 *
 * 厳守（P7-E）:
 *   - production code は **読むだけ**（export 追加・render 変更・cap 追加・body 変更なし）。
 *   - route / prompt 文面 / AI schema / DB / Supabase / env / secret 非接続。
 *   - interview 専用。matching / presentation / consultation は扱わない。
 *
 * 使い方:
 *   npx tsx scripts/career-interview-es-render-golden-qa.ts            # golden と比較（既定）
 *   npx tsx scripts/career-interview-es-render-golden-qa.ts --update   # 現在の出力を golden に上書き
 * 終了コード: 全ケース golden 一致 & 全 assertion PASS → 0 / いずれか不一致・FAIL → 1。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CareerEsResult } from '@/types/careerEs';
import { buildInterviewBaseSystem } from '@/app/api/career/interview/interviewPrompt';

const GOLDEN_DIR = join(process.cwd(), 'scripts/fixtures/interview-es-render');
const UPDATE = process.argv.includes('--update') || process.env.UPDATE === '1';

const rep = (base: string, n: number) => base.repeat(Math.ceil(n / base.length)).slice(0, n);

// ── production 忠実複製（app/api/career/interview/interviewPrompt.ts renderEs と 1:1） ──
//   ラベル・順序・trim・空スキップ・null fallback を明示的に固定する。cap は **入れない**。
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

type Case = { name: string; es: CareerEsResult };
const CASES: Case[] = [
  // typical: 通常長。4 field すべて出る。
  { name: 'typical', es: makeEs(150, 150, 150) },
  // heavy: 長文。cap が無いのでそのまま全文出る（＝削減していないことの固定）。
  { name: 'heavy', es: makeEs(420, 400, 380) },
];

function goldenPath(name: string): string {
  return join(GOLDEN_DIR, `${name}.txt`);
}

// 未 render field 由来の distinctive な字句（base prompt にも紛れない値を選ぶ）。
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

if (UPDATE && !existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

for (const c of CASES) {
  const out = renderEs(c.es);
  const path = goldenPath(c.name);

  // 1) golden 比較 / 更新
  if (UPDATE) {
    writeFileSync(path, out, 'utf8');
    console.log(`📝 wrote golden | ${c.name} (${out.length} chars)`);
  } else if (!existsSync(path)) {
    note(false, `golden 欠落 | ${c.name}（--update で生成）`);
  } else {
    const golden = readFileSync(path, 'utf8');
    note(golden === out, `golden 一致 | ${c.name} (${out.length} chars)`);
    if (golden !== out) {
      console.log(`   golden: ${JSON.stringify(golden)}`);
      console.log(`   actual: ${JSON.stringify(out)}`);
    }
  }

  // 2) 4 field が現状の順序で出る（キャッチコピー→ガクチカ→自己PR→志望動機）
  const iHeadline = out.indexOf('- キャッチコピー:');
  const iGaku = out.indexOf('- ガクチカ:');
  const iSelfPr = out.indexOf('- 自己PR:');
  const iMot = out.indexOf('- 志望動機:');
  note(
    iHeadline >= 0 && iGaku > iHeadline && iSelfPr > iGaku && iMot > iSelfPr,
    `4 field が現状順序で出る | ${c.name} | headline<gakuchika<selfPr<motivation`,
  );

  // 3) gakuchika が **出ている**現状（interview は matching と違い gakuchika を render する）
  note(iGaku >= 0, `gakuchika が render される（現状固定）| ${c.name}`);

  // 4) cap / truncate が入っていない（… truncate suffix が無い・全文が含まれる）
  note(!out.includes('…'), `truncate（…）が入っていない | ${c.name}`);
  note(out.includes(c.es.gakuchika.trim()), `gakuchika 全文が cap されず出る | ${c.name}`);
  note(out.includes(c.es.selfPr.trim()), `selfPr 全文が cap されず出る | ${c.name}`);
  note(out.includes(c.es.motivation.trim()), `motivation 全文が cap されず出る | ${c.name}`);

  // 5) 未 render field が render 出力に出ない
  for (const bad of FORBIDDEN_SUBSTRINGS) {
    note(!out.includes(bad), `未 render 字句が出ない | ${c.name} | "${bad}"`);
  }

  // 6) DRIFT check: 実 export の base system prompt に render 出力が逐語で含まれ、見出しも出る。
  //    → 複製 render が production からズレたら、この substring assert が落ちる。
  const realPrompt = buildInterviewBaseSystem({ es: c.es });
  note(realPrompt.includes('# 直近の ES ドラフト'), `実 base prompt に ES 見出しが出る | ${c.name}`);
  note(realPrompt.includes(out), `実 base prompt に render 出力が逐語一致で含まれる（drift 検知）| ${c.name}`);
  for (const bad of FORBIDDEN_SUBSTRINGS) {
    note(!realPrompt.includes(bad), `実 base prompt にも未 render 字句が出ない | ${c.name} | "${bad}"`);
  }
}

// 7) null / 空 field fallback（現状固定）
note(renderEs(null) === '', 'null → 空文字');
note(renderEs(undefined) === '', 'undefined → 空文字');
note(
  renderEs({ ...makeEs(1, 1, 1), headline: '', gakuchika: '', selfPr: '', motivation: '' }) === '',
  '全 field 空 → 空文字',
);
const partial = renderEs({ ...makeEs(1, 1, 1), gakuchika: '', motivation: '' });
note(
  partial.includes('- キャッチコピー:') &&
    partial.includes('- 自己PR:') &&
    !partial.includes('- ガクチカ:') &&
    !partial.includes('- 志望動機:'),
  '空 field はスキップ・非空 field のみ出る',
);

// 8) es=null のとき 実 base prompt に ES 見出しが出ない（block ごと落ちる現状）
note(
  !buildInterviewBaseSystem({ es: null }).includes('# 直近の ES ドラフト'),
  'es=null のとき実 base prompt に ES 見出しが出ない',
);

console.log('');
console.log(failures === 0 ? 'ALL_PASS' : `FAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
