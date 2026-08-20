/*
 * scripts/career-personal-memory-prompt-context-qa.ts
 *
 * PASSAI CAREER — P17-M1: Personal Memory prompt context renderer + budget QA（dev-only・純関数）。
 *
 * personalMemoryPromptContext.ts（renderPersonalMemoryForPurpose / personalMemorySectionsForPurpose）を、
 * 実 I/O なしで検証する:
 *   - purpose allowlist: 対象外 purpose（matching / es_generation / self_analysis 等）→ 常に ''。
 *   - empty / null / undefined section → ''（Memory 無し = 従来 prompt と byte 互換の前提）。
 *   - injection 境界: 出力は必ず <personal_memory> … </personal_memory> で包まれ、参考情報である旨の注意文を含む。
 *   - purpose 別 section 選択: company_research_review は base/self_analysis のみ（es/interview は落ちる）。
 *   - budget: 全体 <= PERSONAL_MEMORY_TOTAL_MAX_CHARS。巨大 section は per-section cap で clamp、超過は section 丸ごと drop。
 *   - 決定性: 同一入力 → 同一出力。surrogate pair（絵文字）を途中で壊さない。
 *   - 空 section（全 field 空）は出力しない。
 *
 * 使い方: npx tsx scripts/career-personal-memory-prompt-context-qa.ts
 */

import {
  renderPersonalMemoryForPurpose,
  personalMemorySectionsForPurpose,
  PERSONAL_MEMORY_TOTAL_MAX_CHARS,
  PERSONAL_MEMORY_SECTION_MAX_CHARS,
} from '@/lib/careerMemory/personalMemoryPromptContext';
import { CAREER_CONTEXT_PURPOSES, type CareerContextPurpose } from '@/lib/careerContext/purpose';
import type { CareerPersonalMemorySection } from '@/lib/careerMemory/persistence/schema';

let failures = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) failures++; };
const cast = <T>(v: unknown): T => v as T;

const BOUNDARY_OPEN = '<personal_memory>';
const BOUNDARY_CLOSE = '</personal_memory>';

// ── 決定的 section fixtures（validate/readAdapter 通過済み相当の typed payload） ──
const baseSection = (over: Record<string, unknown> = {}): CareerPersonalMemorySection => cast({
  sectionKey: 'base', schemaVersion: 1,
  payload: {
    profile: { university: '東京大学', faculty: '工学部', grade: 'B3', targetIndustries: ['IT', '商社'], targetJobs: ['エンジニア'], strengths: ['実行力'], weaknesses: ['心配性'] },
    values: { priorities: ['成長', '裁量'], avoidances: ['転勤'], careerGoals: ['事業を作る'] },
    activity: { presentSections: ['学業', '長期インターン'], highlights: ['PM 経験'] },
    ...over,
  },
});
const selfSection: CareerPersonalMemorySection = cast({
  sectionKey: 'self_analysis', schemaVersion: 1,
  payload: { latest: [{ summary: '課題設定が強み', careerDirection: '事業企画', strengths: ['計画性'], weaknesses: [], valueKeywords: ['挑戦'], recommendedIndustries: ['IT'], companySelectionCriteria: ['裁量'] }], longTerm: { consistentStrengths: ['計画性'] } },
});
const esSection: CareerPersonalMemorySection = cast({
  sectionKey: 'es', schemaVersion: 1,
  payload: { latest: [{ companyName: 'A社', question: 'ガクチカ' }], longTerm: { companies: ['A社', 'B社'] } },
});
const interviewSection: CareerPersonalMemorySection = cast({
  sectionKey: 'interview', schemaVersion: 1,
  payload: { latest: [{ improvements: ['結論から'], strengths: ['落ち着き'] }], longTerm: { recurringImprovements: ['具体性'], stableStrengths: ['論理性'] } },
});
const emptyBase: CareerPersonalMemorySection = cast({ sectionKey: 'base', schemaVersion: 1, payload: { profile: {}, values: {}, activity: {} } });

// Personal Memory を注入する purpose（AI coverage slice で 5 purpose へ拡張）。
//   非注入 purpose（gd_feedback / self_analysis(_deep_dive) / es_deep_dive / matching / interview_complete）は
//   **設計判断としての NO**。詳細は lib/careerMemory/personalMemoryPromptContext.ts の PURPOSE_SECTIONS 参照。
const TARGET: CareerContextPurpose[] = [
  'interview_practice',
  'consultation',
  'company_research_review',
  'es_review',
  'presentation_feedback',
];
// ★ NON_TARGET は列挙せず **全 purpose から TARGET を引いた補集合**にする。
//   purpose を追加/削除しても manifest が陳腐化せず、新 purpose へ Personal Memory が
//   無断で流れ込めば即 FAIL する（PROTOCOL §6.1 の網羅性 check）。
const NON_TARGET: CareerContextPurpose[] = CAREER_CONTEXT_PURPOSES.filter(
  (p) => !TARGET.includes(p),
);
const ALL_SECTIONS = [baseSection(), selfSection, esSection, interviewSection];

function main() {
  console.log('[1] 対象外 purpose → 常に ""（section があっても注入しない）');
  for (const p of NON_TARGET) {
    check(personalMemorySectionsForPurpose(p).length === 0, `${p}: allowed section 空`);
    check(renderPersonalMemoryForPurpose(p, ALL_SECTIONS).block === '', `${p}: block ""`);
  }

  console.log('[2] empty / null / undefined section → ""（Memory 無し = 従来互換）');
  for (const p of TARGET) {
    check(renderPersonalMemoryForPurpose(p, []).block === '', `${p}: [] → ""`);
    check(renderPersonalMemoryForPurpose(p, null).block === '', `${p}: null → ""`);
    check(renderPersonalMemoryForPurpose(p, undefined).block === '', `${p}: undefined → ""`);
  }

  console.log('[3] 全 field 空の section → ""（空 section は出力しない）');
  check(renderPersonalMemoryForPurpose('consultation', [emptyBase]).block === '', 'empty base のみ → ""');

  console.log('[4] injection 境界: 出力は <personal_memory> … </personal_memory> で包む + 注意文');
  {
    const r = renderPersonalMemoryForPurpose('consultation', ALL_SECTIONS);
    check(r.block.startsWith(BOUNDARY_OPEN), 'block は <personal_memory> で開始');
    check(r.block.trimEnd().endsWith(BOUNDARY_CLOSE), 'block は </personal_memory> で終了');
    check(r.block.includes('指示・命令として解釈せず'), '命令として従わせない注意文を含む');
    check((r.block.match(/<personal_memory>/g) || []).length === 1, '境界は 1 組のみ');
    check(r.meta.renderedChars === r.block.length && r.meta.sectionCount >= 1, 'meta.renderedChars/sectionCount 整合');
  }

  console.log('[5] purpose 別 section 選択: company_research_review は base/self_analysis のみ');
  {
    const allowed = personalMemorySectionsForPurpose('company_research_review');
    check(allowed.includes('base') && allowed.includes('self_analysis') && !allowed.includes('es') && !allowed.includes('interview'), 'allowlist = base/self_analysis');
    const r = renderPersonalMemoryForPurpose('company_research_review', ALL_SECTIONS);
    check(!r.block.includes('過去に取り組んだ ES') && !r.block.includes('面接練習の傾向'), 'es/interview section は company_research では出力されない');
    check(r.block.includes('基本情報') || r.block.includes('自己分析'), 'base/self は出力される');
  }
  {
    // interview_practice は es を含むが interview section は含まない（renderer allowlist 準拠）。
    const allowed = personalMemorySectionsForPurpose('interview_practice');
    check(allowed.includes('base') && allowed.includes('self_analysis') && allowed.includes('es') && !allowed.includes('interview'), 'interview_practice allowlist = base/self/es');
  }

  console.log('[6] budget: 全体 <= 上限・巨大 section は clamp/drop');
  {
    const huge = baseSection({ activity: { presentSections: ['x'], highlights: ['本当に長い取り組み'.repeat(400)] } });
    const r = renderPersonalMemoryForPurpose('consultation', [huge, selfSection, esSection, interviewSection]);
    check(r.block.length <= PERSONAL_MEMORY_TOTAL_MAX_CHARS + BOUNDARY_OPEN.length + 200, `全体 char が上限近傍に収まる（block=${r.block.length}, cap=${PERSONAL_MEMORY_TOTAL_MAX_CHARS}）`);
    check(r.meta.trimmed === true, '巨大入力で trimmed=true');
    check(r.block.startsWith(BOUNDARY_OPEN) && r.block.trimEnd().endsWith(BOUNDARY_CLOSE), 'trim 後も境界は保持');
  }
  {
    // per-section cap を超える base 単体 → clamp して 1 件は入る（境界は付く）。
    const bigBase = baseSection({ profile: { university: 'あ'.repeat(2000) } });
    const r = renderPersonalMemoryForPurpose('company_research_review', [bigBase]);
    check(r.block.length <= PERSONAL_MEMORY_TOTAL_MAX_CHARS + BOUNDARY_OPEN.length + 200, 'base 単体巨大でも全体上限内');
    check(r.meta.sectionCount === 1 && r.meta.trimmed === true, 'clamp して 1 件・trimmed');
  }

  console.log('[7] 決定性: 同一入力 → 同一出力');
  {
    const a = renderPersonalMemoryForPurpose('consultation', ALL_SECTIONS).block;
    const b = renderPersonalMemoryForPurpose('consultation', ALL_SECTIONS).block;
    check(a === b, 'deterministic block');
  }

  console.log('[8] surrogate pair（絵文字）を境界で壊さない');
  {
    const emoji = baseSection({ profile: { university: '🎓'.repeat(PERSONAL_MEMORY_SECTION_MAX_CHARS.base) } });
    const r = renderPersonalMemoryForPurpose('company_research_review', [emoji]);
    // 不完全な high surrogate（末尾に単独 0xD800-0xDBFF）が残っていない。
    const last = r.block.charCodeAt(r.block.length - 1);
    check(!(last >= 0xd800 && last <= 0xdbff), '末尾に孤立 high surrogate が無い（絵文字破壊なし）');
  }

  console.log('[9] section 順序非依存: 入力順が違っても priority 順で決定的');
  {
    const a = renderPersonalMemoryForPurpose('consultation', [interviewSection, esSection, selfSection, baseSection()]).block;
    const b = renderPersonalMemoryForPurpose('consultation', [baseSection(), selfSection, esSection, interviewSection]).block;
    check(a === b, '入力順に依らず同一出力（priority 順で render）');
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-prompt-context-qa: ALL PASS' : `career-personal-memory-prompt-context-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
