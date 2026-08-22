/*
 * scripts/career-consultation-company-context-qa.ts
 *
 * PASSAI CAREER — 相談AI × Company Data Spine A 層（公式情報）接続の構造 QA（dev-only・外部AI非実行）。
 *
 * 検証項目:
 *   [A] 企業が論点でない相談では resolver を呼ばない（DB query ゼロ）
 *   [B] 単一企業の相談 → 1 社だけ対象になる
 *   [C] 企業比較 → 2 社（メッセージ中の登場順で決定的）
 *   [D] 同一企業が複数ソースに現れても dedupe（companyId を持つ方へ昇格）
 *   [E] 未登録 / 曖昧 / read 失敗 → block '' で相談は継続（fail-open）
 *   [F] disabled / unavailable は prompt へ入らない（「情報が無い」を負の事実として書かない）
 *   [G] Company block は dynamicSuffix にのみ入る（cachedPrefix には入らない）
 *   [H] cachedPrefix は Company block の有無で 1 byte も変わらない（Prompt Cache 不変）
 *   [I] Company block なしのときは従来 prompt と byte 互換
 *   [J] prompt 到達: block が dynamicSuffix 内で base の後・crossFeature の前に置かれる
 *   [K] token budget: 1 社上限 / 総枠 / 超過社の drop
 *
 * 厳守: production の関数を読むだけ。外部 AI 非実行・実 DB 非接続（loader は DI で差し替え）。
 *   日時・乱数・不安定 key 順を持ち込まない。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-consultation-company-context-qa.ts
 * 終了コード: 全 PASS → 0 / 1 件でも FAIL → 1
 */

import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
import { buildCompanyOfficialContext, type FactRow } from '@/lib/careerCompanyOfficial/projection';
import { renderCompanyOfficialForPurpose } from '@/lib/careerContextRenderers/companyOfficialContext';
import {
  collectConsultationCompanyCandidates,
  consultationNeedsCompanyContext,
  selectConsultationCompanyTargets,
  resolveConsultationCompanyOfficial,
  CONSULTATION_COMPANY_MAX,
  CONSULTATION_COMPANY_TOTAL_MAX_BYTES,
} from '@/app/api/career/consultation/resolveCompanyOfficial';
import {
  buildConsultationSystemBlocks,
  buildConsultationSystemPrompt,
  type ConsultationSystemPromptInput,
} from '@/app/api/career/consultation/consultationPrompt';

const cast = <T>(v: unknown): T => v as T;
const NOW = '2026-08-22T00:00:00.000Z';
const SEPARATOR = '\n\n';

let fail = 0;
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) fail += 1;
};

// ── 決定的 fixture（本番 projection を通して CompanyOfficialContext を作る） ──────
const FACT_SPEC: ReadonlyArray<{ key: string; group: string; value: string }> = [
  { key: 'legalName', group: 'identity', value: '' },
  { key: 'businessDescription', group: 'business', value: '家庭用レジャー機器の製造・販売' },
  { key: 'desiredCandidateProfile', group: 'recruiting', value: '自ら考えて動ける人。ものづくりへの強い関心。' },
  { key: 'organizationalCulture', group: 'recruiting', value: '長期育成型。腰を据えて取り組む風土。' },
  { key: 'workingStyle', group: 'recruiting', value: '原則出社。京都本社勤務が中心。' },
  { key: 'recruitingOverview', group: 'recruiting', value: '新卒総合職・技術職を通年で募集。' },
  { key: 'overseasPresence', group: 'business', value: '米国・欧州・アジアに販売子会社。' },
  { key: 'employeeCount', group: 'scale', value: '連結 8,666 名' },
  { key: 'foundedYear', group: 'identity', value: '昭和22年11月' },
  { key: 'headquartersAddress', group: 'identity', value: '京都市南区上鳥羽鉾立町11-1' },
];

const factsFor = (name: string, n: number): CompanyOfficialReadResult => {
  const rows: FactRow[] = FACT_SPEC.slice(0, n).map((f, i) => ({
    factKey: f.key,
    factGroup: f.group,
    factValue: { value: f.key === 'legalName' ? name : f.value },
    sourceUrl: `https://example.com/${encodeURIComponent(name)}/${i}`,
    sourceType: 'official_site',
    extractionMethod: 'html_structured',
    fetchedAt: '2026-08-01T00:00:00.000Z',
  }));
  const data = buildCompanyOfficialContext({
    companyId: `cmp_${encodeURIComponent(name)}`,
    displayName: name,
    rows,
    nowIso: NOW,
  });
  return cast<CompanyOfficialReadResult>({ status: 'ready', data });
};

const A = '任天堂株式会社';
const B = 'ソニーグループ株式会社';
const C = '株式会社カプコン';

const READY_A = factsFor(A, 10);
const READY_B = factsFor(B, 10);
const READY_C = factsFor(C, 10);
const MISSING = cast<CompanyOfficialReadResult>({ status: 'unavailable', reason: 'no_company' });
const NO_FACTS = cast<CompanyOfficialReadResult>({ status: 'unavailable', reason: 'no_facts' });
const DISABLED = cast<CompanyOfficialReadResult>({ status: 'disabled', reason: 'flag_off' });

/** loader の DI + 呼び出し回数の spy。 */
function makeLoader(map: Record<string, CompanyOfficialReadResult>, fallback = MISSING) {
  const calls: string[] = [];
  const load = async (q: { companyId?: string | null; companyName?: string | null }) => {
    const key = (q.companyName ?? q.companyId ?? '') as string;
    calls.push(key);
    return map[key] ?? fallback;
  };
  return { load, calls };
}

const baseInput = (companyOfficialBlock: string): ConsultationSystemPromptInput => ({
  profile: cast({
    name: '田中 太郎',
    preferences: [{ university: '早稲田大学', faculty: '商学部' }],
    targetCompanies: [A, B],
  }),
  activity: null,
  values: cast({ selections: { priorities: ['裁量の大きさ'] } }),
  crossFeature: cast({
    selfAnalysisHistory: [], esHistory: [], interviewHistory: [], presentationHistory: [],
    companyResearch: [], gd: [], gdRoom: [], matching: [],
  }),
  companyOfficialBlock,
  eventSignalsBlock: '',
});

async function main() {
console.log('career-consultation-company-context-qa');
console.log('');

// ── [A] 企業が論点でない相談 ────────────────────────────────────────────────
console.log('[A] 企業が論点でない相談 → 対象 0 社（DB query ゼロ）');
const candidates = collectConsultationCompanyCandidates({
  targetCompanies: [A, B],
  companyResearch: [{ companyName: A, companyId: 'cmp_A' }],
  esHistory: [{ companyName: B }],
});
for (const msg of [
  '面接でいつも話が長くなる',
  '自己分析ってどうやればいい？',
  '第一志望落ちてやる気が出ない',
  'GDで発言できない',
]) {
  const targets = selectConsultationCompanyTargets({ message: msg, history: [], candidates });
  check(targets.length === 0, `対象 0 社 | ${msg}`);
}
{
  const spy = makeLoader({});
  const r = await resolveConsultationCompanyOfficial([], NOW, spy.load);
  check(spy.calls.length === 0 && r.block === '', '対象 0 社なら loader を 1 度も呼ばない');
}
// 企業名が出ていても、企業を論点にしていない turn では読まない。
check(
  selectConsultationCompanyTargets({ message: `${A}のインターンで知り合った友達の話なんだけど`, history: [], candidates }).length === 0,
  '企業名が出ているだけの雑談では対象 0 社',
);
check(!consultationNeedsCompanyContext('やる気が出ない'), 'necessity 判定: 感情相談は false');
check(consultationNeedsCompanyContext(`${A}の志望動機が書けない`), 'necessity 判定: 志望動機は true');
console.log('');

// ── [B][C] 単一 / 比較 ─────────────────────────────────────────────────────
console.log('[B][C] 単一企業 / 企業比較の対象選択');
{
  const t = selectConsultationCompanyTargets({ message: `${A}の志望動機がうまく作れない`, history: [], candidates });
  check(t.length === 1 && t[0].companyName === A, '単一企業の相談 → 1 社');
  check(t[0].companyId === 'cmp_A', '企業研究メモ由来の companyId が使われる');
}
{
  const t = selectConsultationCompanyTargets({ message: `${A}と${B}ならどっちが自分に合う？`, history: [], candidates });
  check(t.length === 2 && t[0].companyName === A && t[1].companyName === B, '企業比較 → 2 社（登場順）');
  const rev = selectConsultationCompanyTargets({ message: `${B}と${A}ならどっち？`, history: [], candidates });
  check(rev[0].companyName === B && rev[1].companyName === A, '登場順が逆なら順序も逆（決定的）');
}
{
  const t = selectConsultationCompanyTargets({
    message: 'じゃあ志望動機はどう作ればいい？',
    history: [{ role: 'user', content: `${A}ってどう思う？` }, { role: 'assistant', content: '…' }],
    candidates,
  });
  check(t.length === 1 && t[0].companyName === A, '直近ユーザー発話からの follow-up も拾う');
}
console.log('');

// ── [D] dedupe ─────────────────────────────────────────────────────────────
console.log('[D] 同一企業の重複 dedupe');
{
  const dup = collectConsultationCompanyCandidates({
    targetCompanies: [A, A],
    companyResearch: [{ companyName: A, companyId: 'cmp_A' }, { companyName: A }],
    esHistory: [{ companyName: A }],
  });
  check(dup.length === 1, '同一企業名は 1 候補に集約');
  check(dup[0].companyId === 'cmp_A', 'companyId を持つソースの identity が採用される');
}
{
  const promoted = collectConsultationCompanyCandidates({
    targetCompanies: [A],
    companyResearch: [{ companyName: A, companyId: 'cmp_A' }],
    esHistory: null,
  });
  check(promoted[0].companyId === 'cmp_A', 'companyId 無し候補が後から companyId 付きへ昇格');
}
console.log('');

// ── [E][F] fallback / gate ─────────────────────────────────────────────────
console.log('[E][F] 未登録 / 事実なし / flag OFF / read 失敗 → prompt へ入れない');
{
  const spy = makeLoader({ [A]: MISSING });
  const r = await resolveConsultationCompanyOfficial([{ companyName: A, companyId: null }], NOW, spy.load);
  check(r.block === '' && r.rendered.length === 0 && r.skipped[0] === A, '未登録企業 → block 空・skipped に記録');
}
{
  const spy = makeLoader({ [A]: NO_FACTS });
  const r = await resolveConsultationCompanyOfficial([{ companyName: A, companyId: null }], NOW, spy.load);
  check(r.block === '', '事実 0 件 → block 空');
}
{
  const spy = makeLoader({ [A]: DISABLED });
  const r = await resolveConsultationCompanyOfficial([{ companyName: A, companyId: null }], NOW, spy.load);
  check(r.block === '', 'kill switch OFF（disabled）→ block 空');
}
{
  const throwing = async () => { throw new Error('boom'); };
  const r = await resolveConsultationCompanyOfficial([{ companyName: A, companyId: null }], NOW, throwing);
  check(r.block === '' && r.skipped[0] === A, 'read が throw しても never-throw（相談は継続）');
}
{
  // 一部だけ HIT する混在ケース（比較相談で片方だけ Spine にある）。
  const spy = makeLoader({ [A]: READY_A, [B]: MISSING });
  const r = await resolveConsultationCompanyOfficial(
    [{ companyName: A, companyId: null }, { companyName: B, companyId: null }], NOW, spy.load);
  check(r.rendered.length === 1 && r.rendered[0] === A && r.skipped[0] === B, '片方だけ HIT → HIT した社だけ載る');
  check(!r.block.includes(B), '未登録企業名は block に現れない（不存在の事実を書かない）');
}
check(
  !renderCompanyOfficialForPurpose('consultation', MISSING).used &&
    !renderCompanyOfficialForPurpose('consultation', DISABLED).used,
  'renderer 単体でも unavailable / disabled は必ず空 block',
);
console.log('');

// ── [G][H][I][J] prompt 到達と Prompt Cache 不変 ────────────────────────────
console.log('[G][H][I][J] prompt 到達 / cachedPrefix 不変');
const spy2 = makeLoader({ [A]: READY_A, [B]: READY_B });
const two = await resolveConsultationCompanyOfficial(
  [{ companyName: A, companyId: null }, { companyName: B, companyId: null }], NOW, spy2.load);
const withCompany = buildConsultationSystemBlocks(baseInput(two.block));
const withoutCompany = buildConsultationSystemBlocks(baseInput(''));

check(two.block !== '', '2 社分の block が生成される');
check(withCompany.dynamicSuffix.includes(two.block), '[J] Company block が dynamicSuffix に到達する');
check(!withCompany.cachedPrefix.includes(A) && !withCompany.cachedPrefix.includes(B), '[G] cachedPrefix に企業名が入らない');
check(!withCompany.cachedPrefix.includes('【公式情報'), '[G] cachedPrefix に公式情報 block が入らない');
check(withCompany.cachedPrefix === withoutCompany.cachedPrefix, '[H] cachedPrefix は Company block の有無で不変（byte 一致）');
check(withoutCompany.dynamicSuffix === buildConsultationSystemBlocks(baseInput('')).dynamicSuffix, '[I] block 無しは決定的');
check(
  withCompany.cachedPrefix + SEPARATOR + withCompany.dynamicSuffix === buildConsultationSystemPrompt(baseInput(two.block)),
  'flatten parity（block ありでも維持）',
);
{
  // 位置: base（# 学生プロフィール）の後・crossFeature / 出力形式の前。
  const d = withCompany.dynamicSuffix;
  const posProfile = d.indexOf('# 学生プロフィール');
  const posCompany = d.indexOf('【公式情報');
  const posOutput = d.indexOf('# 出力形式（厳守）');
  check(posProfile >= 0 && posCompany > posProfile && posCompany < posOutput, '[J] 位置は base の後・出力形式の前（面接 / プレゼンと同一並び）');
}
console.log('');

// ── [K] token budget ───────────────────────────────────────────────────────
console.log('[K] token budget');
{
  const one = await resolveConsultationCompanyOfficial([{ companyName: A, companyId: null }], NOW, makeLoader({ [A]: READY_A }).load);
  const bytes = Buffer.byteLength(one.block, 'utf-8');
  check(bytes > 0 && bytes <= 3400, `1 社の block は purpose budget 内（実測 ${bytes}B <= 3400B）`);
  check(one.block.split('【公式情報').length - 1 === 1, '1 社なら公式情報 block は 1 つ');
}
{
  const bytes = Buffer.byteLength(two.block, 'utf-8');
  check(bytes <= CONSULTATION_COMPANY_TOTAL_MAX_BYTES, `2 社の合計は総枠内（実測 ${bytes}B <= ${CONSULTATION_COMPANY_TOTAL_MAX_BYTES}B）`);
  check(two.block.split('【公式情報').length - 1 === 2, '2 社なら公式情報 block は 2 つ');
}
{
  const spy = makeLoader({ [A]: READY_A, [B]: READY_B, [C]: READY_C });
  const three = await resolveConsultationCompanyOfficial(
    [{ companyName: A, companyId: null }, { companyName: B, companyId: null }, { companyName: C, companyId: null }],
    NOW, spy.load);
  const bytes = Buffer.byteLength(three.block, 'utf-8');
  check(bytes <= CONSULTATION_COMPANY_TOTAL_MAX_BYTES, `3 社でも総枠を超えない（実測 ${bytes}B）`);
  check(three.rendered.length + three.skipped.length === 3, '3 社すべてが rendered / skipped のどちらかに分類される');
  check(three.rendered[0] === A, '総枠超過時は先に採用した社を削らない（後着を落とす）');
}
{
  const many = Array.from({ length: 6 }, (_, i) => ({ companyName: `会社${i}`, companyId: null }));
  const spy = makeLoader({}, READY_A);
  await resolveConsultationCompanyOfficial(many, NOW, spy.load);
  check(spy.calls.length <= CONSULTATION_COMPANY_MAX, `社数上限を超えて read しない（${spy.calls.length} <= ${CONSULTATION_COMPANY_MAX}）`);
}
console.log('');

console.log(fail === 0 ? 'career-consultation-company-context-qa: ALL PASS' : `career-consultation-company-context-qa: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
}

void main();
