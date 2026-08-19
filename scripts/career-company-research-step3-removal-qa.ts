/**
 * PASSAI CAREER — 企業分析 Step 3「内容を確認・修正する」手動フロー廃止の QA。
 *
 * 証明したいこと:
 *   A. 手動確認 UI（Step 3 / 確認 textarea / 「AIに添削してもらう」/ 「まとめる」）が存在しない。
 *   B. 分析対象本文は素材から **決定論的に** 合成される（AI call ゼロ・実関数を実行して確認）。
 *   C. 既存素材が 1 つも欠けずに合成本文へ到達する。
 *   D. AI call が増えていない（client の fetch 先は extract と company-research の 2 本のみ）。
 *   E. Company Data Spine → 企業分析 prompt の経路と budget が後退していない。
 *   F. review / fitAnalysis / interviewContextSummary と persistence contract が維持されている。
 */
import { readFileSync } from 'node:fs';
import {
  combineSources,
  combineFileExtracts,
  hasAnyMaterial,
} from '../app/career/company-research/researchText';
import type { CareerCompanyResearchFile } from '../types/careerCompanyResearch';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
}
const read = (p: string) => readFileSync(p, 'utf-8');

const DO = read('app/career/company-research/do/page.tsx');
const ROUTE = read('app/api/career/company-research/route.ts');
const RENDERER = read('lib/careerContextRenderers/companyOfficialContext.ts');

// ── A. 手動確認 UI の不在 ────────────────────────────────────────────
console.log('\n[A] Step 3 手動確認 UI が存在しない');
for (const s of [
  '内容を確認・修正する（添削対象）',
  'ここに入れたテキストだけがAI添削の対象になります',
  'ここに、確認済みの企業研究テキストをまとめます',
  '企業名と、確認欄のテキストを入力するとAI添削できます。',
  'AIに添削してもらう',
  '素材を下の確認欄にまとめる',
  'consolidateToVerified',
  'changeVerifiedText',
  'setVerifiedResearchText',
]) {
  check(`A 「${s}」が do ページに無い`, !DO.includes(s));
}
check('A step={3} の StepCard が無い', !DO.includes('step={3}'));
check('A step={1} / step={2} は残っている', DO.includes('step={1}') && DO.includes('step={2}'));

console.log('\n[A2] 新しい CTA が企業分析として明示されている');
check('A2 CTA が「企業分析する →」', DO.includes("'企業分析する →'"));
check('A2 再実行 CTA が「もう一度企業分析する」', DO.includes("'もう一度企業分析する'"));
check('A2 loading 文言が「分析中…」', DO.includes("'分析中…'"));
check('A2 do ページに「添削」表記が残っていない', !DO.includes('添削'));

// ── B. 決定論合成（実関数を実行）─────────────────────────────────────
console.log('\n[B] 分析対象本文は決定論合成（AI call ゼロ）');
const RT = read('app/career/company-research/researchText.ts');
// コメント（設計意図の説明で /api/... を引用している）を落として実コードだけ見る。
const RT_CODE = RT.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
check('B researchText.ts の実コードに fetch / anthropic / api が無い',
  !/fetch\(|anthropic|\/api\//.test(RT_CODE));
check('B researchText.ts に import は型と CareerCompanyResearchFile のみ',
  (RT.match(/^import /gm) ?? []).length === 1 && RT.includes("import type { CareerCompanyResearchFile }"));

const file = (name: string, text: string): CareerCompanyResearchFile => ({
  id: `f-${name}`,
  fileName: name,
  fileType: 'application/pdf',
  fileSize: 1024,
  extractedText: text,
  extractionStatus: 'success',
  uploadedAt: '2026-08-19T00:00:00.000Z',
});

const MEMO = '事業は法人向けSaaS。強みは導入後の伴走支援。';
const PASTE = '採用ページ: 求める人物像は「自ら課題を定義できる人」。';
const F1 = file('会社説明会.pdf', '中期経営計画では海外売上比率30%を目標。');
const F2 = file('IR資料.png', '2026年3月期 営業利益率は12.4%。');

const combined = combineSources(MEMO, PASTE, [F1, F2]);
// 決定論: 同じ入力 → 同じ出力
check('B 同一入力で byte 一致（決定論）', combined === combineSources(MEMO, PASTE, [F1, F2]));
check('B 順序固定（メモ → 貼り付け → ファイル順）',
  combined.indexOf(MEMO) < combined.indexOf(PASTE) &&
  combined.indexOf(PASTE) < combined.indexOf(F1.extractedText) &&
  combined.indexOf(F1.extractedText) < combined.indexOf(F2.extractedText));
check('B separator は空行区切り', combined.includes('\n\n'));

// ── C. 素材の完全到達 ────────────────────────────────────────────────
console.log('\n[C] 既存素材がすべて合成本文へ到達する');
for (const [label, text] of [
  ['手入力メモ', MEMO],
  ['貼り付けテキスト', PASTE],
  ['PDF抽出テキスト', F1.extractedText],
  ['画像OCR結果', F2.extractedText],
] as const) {
  check(`C ${label} が合成本文に含まれる`, combined.includes(text));
}
check('C ファイル名も出典として残る',
  combined.includes(`【${F1.fileName}】`) && combined.includes(`【${F2.fileName}】`));
check('C 空素材は空文字（= 分析 CTA が無効化される）', combineSources('', '', []) === '');
check('C 未抽出ファイルは本文に混ざらない',
  combineSources('', '', [file('未抽出.pdf', '   ')]) === '');
check('C extractedText 側は従来どおり別立てで組まれる',
  combineFileExtracts([F1, F2]).includes(F1.extractedText) &&
  !combineFileExtracts([F1, F2]).includes(MEMO));

console.log('\n[C2] 旧ログ後方互換（確認欄に直接書かれただけのログ）');
check('C2 素材なしを検出', hasAnyMaterial('', '', []) === false);
check('C2 メモのみでも素材ありと判定', hasAnyMaterial(MEMO, '', []) === true);
check('C2 ファイル抽出のみでも素材ありと判定', hasAnyMaterial('', '', [F1]) === true);
check('C2 do ページが素材ゼロの旧ログを manualMemo へ戻す',
  DO.includes('hasAnyMaterial(log.input.manualMemo, log.input.pastedText, log.input.uploadedFiles)') &&
  DO.includes('setManualMemo(log.input.verifiedResearchText)'));

// ── D. AI call が増えていない ────────────────────────────────────────
console.log('\n[D] AI call inventory が増えていない');
const fetchTargets = [...DO.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
check('D do ページの fetch は企業分析 API 1 本のみ',
  fetchTargets.length === 1 && fetchTargets[0] === '/api/career/company-research',
  JSON.stringify(fetchTargets));
const EXTRACTION = read('app/career/company-research/extraction.ts');
const extractTargets = [...EXTRACTION.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
check('D extract API はアップロード経路にだけ残っている',
  extractTargets.length === 1 && extractTargets[0] === '/api/career/company-research/extract',
  JSON.stringify(extractTargets));
// extract 呼び出し（呼び出し形 `extractTextFromFile(`）が handleFiles の中に 1 箇所だけ、
// つまりファイル添付時にしか走らないこと（テキスト素材だけなら OCR は呼ばれない）。
const extractCalls = (DO.match(/extractTextFromFile\(/g) ?? []).length;
const beforeHandleFiles = DO.split('async function handleFiles')[0];
check('D extract 呼び出しは 1 箇所だけ', extractCalls === 1, `count=${extractCalls}`);
check('D テキスト素材だけなら extract は呼ばれない（呼び出しは handleFiles 内のみ）',
  DO.split('async function handleFiles')[1].includes('extractTextFromFile(file)') &&
  !/extractTextFromFile\(/.test(beforeHandleFiles));
check('D 企業分析 route の anthropic 呼び出しは 1 箇所のまま',
  (ROUTE.match(/anthropic\.messages\.create/g) ?? []).length === 1);

// ── E. Company Data Spine 経路 ───────────────────────────────────────
console.log('\n[E] Company Data Spine → 企業分析 prompt が維持されている');
check('E loadCompanyOfficialContext を呼んでいる', ROUTE.includes('await loadCompanyOfficialContext({'));
check('E triggerCompanyPrefetch を呼んでいる', ROUTE.includes('triggerCompanyPrefetch(companyName, req)'));
check('E buildCareerContextForPurpose(company_research_review)',
  ROUTE.includes("buildCareerContextForPurpose('company_research_review'"));
check('E companyOfficial が orchestrator へ渡る', /company:\s*companyOfficial/.test(ROUTE));
check('E companyOfficialContext が systemPrompt に入る',
  /const systemPrompt = \[[\s\S]*?orchestrated\.companyOfficialContext[\s\S]*?\]/.test(ROUTE));
check('E 企業分析 budget が後退していない（maxBytes 4600 / maxFacts 48）',
  RENDERER.includes('company_research_review: { maxBytes: 4600, maxFacts: 48 }'));

// ── F. 出力・contract の維持 ────────────────────────────────────────
console.log('\n[F] 企業分析の出力と persistence contract が維持されている');
check('F route が review / fitAnalysis / interviewContextSummary を返す',
  ROUTE.includes('return Response.json({ review, fitAnalysis, interviewContextSummary });'));
check('F verifiedResearchText は API contract として維持（required のまま）',
  ROUTE.includes("const verifiedResearchText = str(b.verifiedResearchText);") &&
  ROUTE.includes("if (verifiedResearchText === '') {"));
check('F client は合成本文を verifiedResearchText として送る',
  DO.includes('verifiedResearchText: researchText,'));
check('F 分析 gate は「企業名 + 素材」',
  DO.includes("const canAnalyze = companyName.trim() !== '' && researchText !== ''"));
check('F 空本文で送信できない（= /api/career/company-research が 400 にならない）',
  DO.includes('if (!canAnalyze || analyzing) return;'));
check('F stale 結果を保存できない（分析時テキストと一致時のみ有効）',
  DO.includes('result.sourceText === researchText') && DO.includes('const canSave = !!activeResult && canAnalyze;'));
check('F 保存する input.verifiedResearchText も合成本文',
  /input: CareerCompanyResearchInput = \{[\s\S]*?verifiedResearchText: researchText,/.test(DO));
check('F revisionHistory / Supabase mirror / event 記録は維持',
  DO.includes('revisionHistory: [revision, ...editingLog.revisionHistory]') &&
  DO.includes('upsertCareerCompanyResearchLogsToSupabase(userId, [saved])') &&
  DO.includes("feature: 'company_research'"));
check('F 結果画面へ遷移する',
  DO.includes("router.push(`/career/company-research/view?id=${encodeURIComponent(saved.id)}`)"));

// ── 結果 ────────────────────────────────────────────────────────────
console.log(
  failures === 0
    ? '\n✅ ALL PASS — Step 3 手動確認は撤去され、素材は決定論合成で企業分析 AI（1 call）へ到達している\n'
    : `\n❌ ${failures} FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
