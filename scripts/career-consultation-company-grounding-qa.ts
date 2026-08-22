/*
 * scripts/career-consultation-company-grounding-qa.ts
 *
 * PASSAI CAREER — 相談AI: Company Data Spine の grounding boundary 契約 QA（dev-only）。
 *
 * 背景:
 *   従来の consultation 注意書きは「ここに無い事実を補って **断定** しない」という書き方で、
 *   モデルが「〜として知られています」「一般的に」「〜のような企業では」に逃げて
 *   Spine に無い企業固有事実を混ぜてくる escape hatch が実 AI probe で再現していた。
 *   本 QA は「表現の強さではなく出典の有無で線を引く」規約が prompt に入り続けることを固定する。
 *
 * 検証項目:
 *   [A] consultation の注意書きが「断定のみ禁止」で終わっていない
 *   [B] ヘッジ付き補完（〜として知られています / 一般的に / おそらく / 〜のような企業では）を明示禁止
 *   [C] 未提供の事実は「手元の情報では確認できない」+ 不足情報 + 確認行動へ回す規約がある
 *   [D] 就活一般の知識は禁止していない（過剰抑制の防止）
 *   [E] 提供事実 × 本人価値観の解釈は許可、そこから新事実を作るのは禁止、と書き分けている
 *   [F] 本規約は consultation purpose にだけ適用され、他 purpose の注意書きは byte 不変
 *   [G] cachedPrefix は不変（規約は dynamic な Company block 内にある）
 *   [H] response schema 不変
 *
 * 厳守: production の純関数を読むだけ。外部 AI / 実 DB / network 非接続。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-consultation-company-grounding-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
import { buildCompanyOfficialContext, type FactRow } from '@/lib/careerCompanyOfficial/projection';
import { renderCompanyOfficialForPurpose } from '@/lib/careerContextRenderers/companyOfficialContext';
import {
  buildConsultationSystemBlocks,
  type ConsultationSystemPromptInput,
} from '@/app/api/career/consultation/consultationPrompt';

const cast = <T>(v: unknown): T => v as T;
const ROOT = process.cwd();
const NOW = '2026-08-22T00:00:00.000Z';

let fail = 0;
const check = (ok: boolean, label: string, detail?: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) fail += 1;
};

const READY: CompanyOfficialReadResult = cast({
  status: 'ready',
  data: buildCompanyOfficialContext({
    companyId: 'cmp_qa',
    displayName: 'サンプル株式会社',
    rows: [
      { factKey: 'legalName', factGroup: 'identity', factValue: { value: 'サンプル株式会社' }, sourceUrl: 'https://example.com/', sourceType: 'official_site', extractionMethod: 'html_structured', fetchedAt: '2026-08-01T00:00:00.000Z' },
      { factKey: 'businessDescription', factGroup: 'business', factValue: { value: '精密機器の製造・販売' }, sourceUrl: 'https://example.com/', sourceType: 'official_site', extractionMethod: 'llm_extraction', fetchedAt: '2026-08-01T00:00:00.000Z' },
      { factKey: 'overseasPresence', factGroup: 'business', factValue: { value: '海外複数地域で事業を展開' }, sourceUrl: 'https://example.com/', sourceType: 'official_site', extractionMethod: 'llm_extraction', fetchedAt: '2026-08-01T00:00:00.000Z' },
    ] as FactRow[],
    nowIso: NOW,
  }),
});

const baseInput = (companyOfficialBlock: string): ConsultationSystemPromptInput => ({
  profile: cast({ name: '田中 太郎', preferences: [{ university: '早稲田大学', faculty: '商学部' }] }),
  activity: null,
  values: cast({ selections: { priorities: ['海外に関われる'] } }),
  crossFeature: cast({
    selfAnalysisHistory: [], esHistory: [], interviewHistory: [], presentationHistory: [],
    companyResearch: [], gd: [], gdRoom: [], matching: [],
  }),
  companyOfficialBlock,
  eventSignalsBlock: '',
});

function main(): void {
  console.log('career-consultation-company-grounding-qa');
  console.log('');

  const block = renderCompanyOfficialForPurpose('consultation', READY);
  check(block.used && block.text !== '', 'consultation block が生成される');
  const note = block.text;

  // ── [A][B] 断定だけで終わらない / ヘッジ付き補完も禁止 ────────────────
  console.log('[A][B] 断定のみ禁止で終わらせず、ヘッジ付き補完も禁止している');
  check(/断定だけの話ではなく|断定だけの話ではありません/.test(note), '[A] 「断定だけの話ではない」と明示している');
  for (const hedge of ['として知られています', '一般的に', 'おそらく', 'のような企業では']) {
    check(note.includes(hedge), `[B] ヘッジ表現を名指しで禁止 | ${hedge}`);
  }
  check(/弱めても同じく禁止/.test(note), '[B] 「弱めても同じく禁止」と書いてある');
  check(/一般知識から補わない/.test(note), '[B] 一般知識からの補完を禁止している');
  check(
    /この block・本人のメモ・この会話で本人が話した範囲だけ/.test(note),
    '許可される出典を 3 つに限定している（block / 本人メモ / 会話）',
  );
  for (const domain of ['勤務地・異動', '配属', 'カルチャー', '採用実態', '選考の進み方', '数値']) {
    check(note.includes(domain), `補完されやすい領域を名指ししている | ${domain}`);
  }
  console.log('');

  // ── [C] 未提供は unknown 扱い + 確認行動 ────────────────────────────
  console.log('[C] 未提供の事実は unknown 扱いにして確認行動へ回す');
  check(note.includes('手元の情報では確認できない'), '[C] unknown の言い回しを指定している');
  check(note.includes('不足情報'), '[C] 不足情報フィールドへ回す規約がある');
  check(/何を誰に確認するか/.test(note), '[C] 確認行動（誰に何を）へ繋げる規約がある');
  check(/存在しない情報源は挙げない/.test(note), '[C] 架空の情報源を挙げない規約がある');
  console.log('');

  // ── [D][E] 過剰抑制の防止 ──────────────────────────────────────────
  console.log('[D][E] 一般知識と解釈は残す（何も言わない AI にしない）');
  check(/就活一般の知識/.test(note) && /従来どおり使えます/.test(note), '[D] 就活一般の知識は許可と明記');
  check(/面接一般の観点|志望動機の作り方|確認すべき論点/.test(note), '[D] 許可される一般知識の例が入っている');
  check(/相性を解釈するのも歓迎/.test(note), '[E] 事実 × 本人の軸の解釈は許可と明記');
  check(/その解釈から\n?\s*新しい企業事実を作らない|新しい企業事実を作らない/.test(note), '[E] 解釈から新事実を作るのは禁止と明記');
  check(/海外配属が多い、は不可|海外で事業展開している/.test(note), '[E] 解釈と新事実の境界を具体例で示している');
  console.log('');

  // ── [F] 他 purpose 非波及 ─────────────────────────────────────────
  console.log('[F] consultation 以外の注意書きは byte 不変');
  const src = readFileSync(join(ROOT, 'lib/careerContextRenderers/companyOfficialContext.ts'), 'utf-8');
  for (const other of ['interview_practice', 'es_review', 'es_deep_dive', 'presentation_feedback', 'gd_feedback', 'company_research_review']) {
    const t = renderCompanyOfficialForPurpose(other, READY).text;
    check(!t.includes('として知られています'), `[F] ${other} の注意書きに consultation 規約が漏れていない`);
    check(!t.includes('就活一般の知識'), `[F] ${other} に consultation 固有文言が無い`);
  }
  // 各 purpose が専用 note を持ち続けていること（共通 note へ統合されていない）。
  for (const name of ['USAGE_NOTE_COMPANY_RESEARCH', 'USAGE_NOTE_INTERVIEW', 'USAGE_NOTE_ES_REVIEW', 'USAGE_NOTE_ES_DEEP_DIVE', 'USAGE_NOTE_PRESENTATION', 'USAGE_NOTE_GD', 'USAGE_NOTE_CONSULTATION']) {
    check(src.includes(`const ${name}: readonly string[] = [`), `purpose 別 note が独立している | ${name}`);
  }
  console.log('');

  // ── [G][H] cachedPrefix / schema ───────────────────────────────────
  console.log('[G][H] Prompt Cache / response schema');
  const withCompany = buildConsultationSystemBlocks(baseInput(block.text));
  const without = buildConsultationSystemBlocks(baseInput(''));
  check(withCompany.cachedPrefix === without.cachedPrefix, '[G] cachedPrefix は Company block の有無で byte 不変');
  check(!withCompany.cachedPrefix.includes('として知られています'), '[G] grounding 規約は cachedPrefix に入らない（dynamic 側）');
  check(withCompany.dynamicSuffix.includes('手元の情報では確認できない'), '[G] grounding 規約は dynamicSuffix に載る');
  const route = readFileSync(join(ROOT, 'app/api/career/consultation/route.ts'), 'utf-8');
  for (const field of ['currentStatusSummary', 'answer', 'keyInsights', 'recommendedActions', 'missingInformation', 'followUpQuestions']) {
    check(route.includes(field), `[H] response schema 維持 | ${field}`);
  }
  check((route.match(/anthropic\.messages\.create/g) ?? []).length === 1, '[H] AI 呼び出しは 1 本のまま');
  console.log('');

  console.log(fail === 0 ? 'career-consultation-company-grounding-qa: ALL PASS' : `career-consultation-company-grounding-qa: ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
