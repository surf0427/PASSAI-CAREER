/*
 * Blind pairwise quality judge for the MODEL A/B.
 *
 * The judge sees ONLY the fixture input and two anonymised outputs. It never sees
 * model names, latency, cost, token counts, or which arm produced which output.
 * Both presentation orders are run for every pair to cancel position bias.
 *
 * Judge model is stronger than either candidate (claude-opus-5).
 *
 * Usage: npx tsx --tsconfig tsconfig.realtime-test.json scripts/_model_ab_tmp/judge-ab.ts <ab.json>
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { anthropic, extractJson } from '@/lib/ai';
import { CASES } from './fixtures';

const JUDGE_MODEL = 'claude-opus-5';

const DIMS = [
  'personalization', 'grounding', 'specificity',
  'consistency', 'actionability', 'careerRelevance',
] as const;

const COUNTS = ['unsupportedClaims', 'directExperienceReferences', 'evidenceLinkedConclusions', 'genericStatements'] as const;

type Row = {
  caseId: string; arm: string; run: number; schemaValid: boolean;
  result?: Record<string, unknown>;
};

const SYSTEM = [
  'あなたは新卒就活支援サービス（PASSAI CAREER）の品質評価者です。',
  '同一ユーザーの入力に対して生成された2つの自己分析結果（AとB）を比較評価します。',
  'どちらがどの生成系で作られたかは伏せられています。**内容のみ**で判断してください。',
  '',
  '厳守:',
  '- 長い方が良いとは限りません。単位長さあたりの有用な情報量（情報密度）で評価してください。',
  '- 短くても、本人固有の事実に紐づき具体的で実行可能なら高評価にしてください。',
  '- 長くても、一般論・言い換えの繰り返し・根拠のない断定が多ければ低評価にしてください。',
  '',
  '# 採点ルーブリック（各1〜5）',
  'personalization: 5=本人の実際の経験・価値観・行動・文脈に明確に沿う / 3=部分的に個別化されているが一般的な助言も多い / 1=ほぼ誰にでも当てはまる',
  'grounding:       5=結論が入力中の根拠に一貫して紐づく / 3=根拠のあるものと弱いものが混在 / 1=根拠のない主張が大半',
  'specificity:     5=具体的な区別・例・有用な詳細がある / 3=妥当だが大まか / 1=一般的・抽象的',
  'consistency:     5=各フィールドが一貫した人物像を補強 / 3=軽微な矛盾や断絶 / 1=重大な矛盾',
  'actionability:   5=明確で有用な次の一手と実務的な判断がある / 3=有用だが実行方法が曖昧 / 1=実行価値がほぼ無い',
  'careerRelevance: 5=業界職種探索・応募・面接・意思決定に直接使える / 3=部分的に就活特化 / 1=ほぼ一般的な自己啓発',
  '',
  '# カウント項目（A/Bそれぞれ整数で）',
  'unsupportedClaims:          入力に根拠が無いのに断定している箇所の件数（少ないほど良い）',
  'directExperienceReferences: 入力にある具体的な経験・出来事・発言に直接言及している箇所の件数',
  'evidenceLinkedConclusions:  「根拠→結論」の形で明示的に紐づいている結論の件数',
  'genericStatements:          その人固有でなく、就活生一般に当てはまる記述の件数',
  '',
  '# 総合選好（どちらを実ユーザーに見せたいか）',
  'preference は次のいずれか: "A_clearly" | "A_slightly" | "equal" | "B_slightly" | "B_clearly"',
  '',
  '出力は次のJSONのみ（前後に説明文やコードブロック記号を付けない）:',
  '{',
  '  "A": {"personalization":n,"grounding":n,"specificity":n,"consistency":n,"actionability":n,"careerRelevance":n,"unsupportedClaims":n,"directExperienceReferences":n,"evidenceLinkedConclusions":n,"genericStatements":n},',
  '  "B": {"personalization":n,"grounding":n,"specificity":n,"consistency":n,"actionability":n,"careerRelevance":n,"unsupportedClaims":n,"directExperienceReferences":n,"evidenceLinkedConclusions":n,"genericStatements":n},',
  '  "preference": "A_clearly|A_slightly|equal|B_slightly|B_clearly",',
  '  "reason": "1〜2文",',
  '  "heavyDepthNote": "HEAVYケースのときのみ: 複数経験・対話・過去サマリを使えているかを1文で。それ以外は空文字"',
  '}',
].join('\n');

function inputDigest(caseId: string): string {
  const c = CASES.find((x) => x.id === caseId)!;
  return JSON.stringify(
    {
      profile: c.input.profile, activity: c.input.activity, values: c.input.values,
      userInput: c.input.userInput, conversation: c.input.conversation,
      pastSummaries: c.input.pastSummaries,
    },
    null, 1,
  );
}

async function judgePair(caseId: string, a: unknown, b: unknown) {
  const user = [
    '# ユーザーの入力（自己分析の材料）',
    inputDigest(caseId),
    '', '# 出力A', JSON.stringify(a, null, 1),
    '', '# 出力B', JSON.stringify(b, null, 1),
    '', `（このケースの識別子: ${caseId}）`,
    '上記を比較し、指定のJSONのみを出力してください。',
  ].join('\n');

  const msg = await anthropic.messages.create({
    model: JUDGE_MODEL, max_tokens: 3000, system: SYSTEM,
    messages: [{ role: 'user', content: user }],
  } as never);
  const t = msg.content.find((x) => x.type === 'text');
  return JSON.parse(extractJson(t && t.type === 'text' ? t.text : ''));
}

const FLIP: Record<string, string> = {
  A_clearly: 'B_clearly', A_slightly: 'B_slightly', equal: 'equal',
  B_slightly: 'A_slightly', B_clearly: 'A_clearly',
};

async function main() {
  const rows: Row[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const out: unknown[] = [];

  const agg: Record<string, Record<string, number[]>> = {
    sonnet: Object.fromEntries([...DIMS, ...COUNTS].map((d) => [d, []])),
    haiku: Object.fromEntries([...DIMS, ...COUNTS].map((d) => [d, []])),
  };
  const prefTally: Record<string, number> = {
    sonnet_clearly: 0, sonnet_slightly: 0, equal: 0, haiku_slightly: 0, haiku_clearly: 0,
  };

  for (const c of CASES) {
    // Pair run-by-run so each comparison uses independent generations.
    const s = rows.filter((r) => r.caseId === c.id && r.arm === 'sonnet' && r.schemaValid && r.result);
    const h = rows.filter((r) => r.caseId === c.id && r.arm === 'haiku' && r.schemaValid && r.result);
    const n = Math.min(s.length, h.length);
    if (n === 0) { console.log(`${c.id}: SKIP (no comparable schema-valid pair)`); continue; }

    for (let i = 0; i < n; i++) {
      for (const order of ['sonnetA', 'haikuA'] as const) {
        const A = order === 'sonnetA' ? s[i].result : h[i].result;
        const B = order === 'sonnetA' ? h[i].result : s[i].result;
        const v = await judgePair(c.id, A, B);
        const sSlot = order === 'sonnetA' ? 'A' : 'B';
        const hSlot = order === 'sonnetA' ? 'B' : 'A';
        for (const d of [...DIMS, ...COUNTS]) {
          agg.sonnet[d].push(v[sSlot][d]);
          agg.haiku[d].push(v[hSlot][d]);
        }
        // Normalise preference to sonnet/haiku terms.
        const p: string = order === 'sonnetA' ? v.preference : FLIP[v.preference];
        const key = p === 'equal' ? 'equal'
          : p.startsWith('A_') ? `sonnet_${p.slice(2)}` : `haiku_${p.slice(2)}`;
        prefTally[key] = (prefTally[key] ?? 0) + 1;
        out.push({ caseId: c.id, pair: i + 1, order, verdict: v, normalisedPreference: p });
        console.log(`${c.id.padEnd(7)} pair${i + 1} ${order.padEnd(8)} pref->${key.padEnd(16)} ${String(v.reason).slice(0, 110)}`);
      }
    }
  }

  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  console.log('\nDIMENSION MEANS (1-5)');
  console.log('dimension'.padEnd(28) + 'sonnet'.padStart(9) + 'haiku'.padStart(9) + 'delta'.padStart(9));
  for (const d of DIMS) {
    const a = mean(agg.sonnet[d]), b = mean(agg.haiku[d]);
    console.log(d.padEnd(28) + a.toFixed(2).padStart(9) + b.toFixed(2).padStart(9) + (b - a).toFixed(2).padStart(9));
  }
  const oS = mean(DIMS.flatMap((d) => agg.sonnet[d])), oH = mean(DIMS.flatMap((d) => agg.haiku[d]));
  console.log('-'.repeat(55));
  console.log('OVERALL (6 dims)'.padEnd(28) + oS.toFixed(2).padStart(9) + oH.toFixed(2).padStart(9) + (oH - oS).toFixed(2).padStart(9));
  console.log('\nCOUNTS (per output)');
  for (const d of COUNTS) {
    const a = mean(agg.sonnet[d]), b = mean(agg.haiku[d]);
    console.log(d.padEnd(28) + a.toFixed(2).padStart(9) + b.toFixed(2).padStart(9) + (b - a).toFixed(2).padStart(9));
  }
  console.log('\nHEAD-TO-HEAD PREFERENCE (normalised, both orders)');
  for (const [k, v] of Object.entries(prefTally)) console.log(`  ${k.padEnd(18)} ${v}`);

  writeFileSync(process.env.JUDGE_OUT ?? '/tmp/judge-ab.json', JSON.stringify({ out, agg, prefTally }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
