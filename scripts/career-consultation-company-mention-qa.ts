/*
 * scripts/career-consultation-company-mention-qa.ts
 *
 * PASSAI CAREER — 相談AI: 自由文企業名 → Company Master 辞書照合 → Identity resolver の契約 QA。
 *
 * 検証項目:
 *   [A] 今回の発話だけで 1 社 resolve（保存データゼロでも届く）
 *   [B] 今回の発話だけで 2 社 resolve（出現順）
 *   [C] 構造化候補との companyId dedupe（「任天堂」と「任天堂株式会社」を 2 社にしない）
 *   [D] 今回の発話の企業が構造化候補より優先される
 *   [E] Master に無い企業は resolve しない（勝手に登録しない）
 *   [F] ambiguous（同名 alias が別企業に跨る）は resolve しない
 *   [G] 企業名の無い一般相談では 0 社 + 辞書 hit 0
 *   [H] 「会社 / 銀行 / グループ / 企業 / データ」等の一般語で誤発火しない
 *   [I] 最大 3 社
 *   [J] Spine が使えない企業（facts 0）は prompt へ入らない
 *   [K] Company block は dynamicSuffix のみ
 *   [L] cachedPrefix は不変
 *   [M] AI 呼び出しを増やしていない（静的検証）
 *   [N] response schema 不変（静的検証）
 *
 * 厳守: 実 DB / 実 network / 実 AI に触れない（辞書 loader / official loader は DI）。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-consultation-company-mention-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
import { buildCompanyOfficialContext, type FactRow } from '@/lib/careerCompanyOfficial/projection';
import {
  detectCompanyMentions,
  buildMentionTokens,
  MIN_MENTION_TOKEN_LENGTH,
  type CompanyMentionDictionaryEntry,
} from '@/lib/careerCompanyIdentity/mentionMatch';
import type { CompanyMentionDictionary } from '@/lib/careerCompanyIdentity/mentionDictionary.server';
import {
  collectConsultationCompanyCandidates,
  selectConsultationCompanyTargets,
  resolveConsultationCompanyMentions,
  resolveConsultationCompanyOfficial,
  CONSULTATION_COMPANY_MAX,
  CONSULTATION_COMPANY_TOTAL_MAX_BYTES,
} from '@/app/api/career/consultation/resolveCompanyOfficial';
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

// ── 辞書 fixture（実 DB の master をそのまま模した形）───────────────────────
const entry = (companyId: string, displayName: string, normalizedName: string, aliases: string[] = []): CompanyMentionDictionaryEntry => ({
  companyId,
  displayName,
  tokens: buildMentionTokens({ displayName, normalizedName, aliases }),
});

const NINTENDO = entry('cmp_nin', '任天堂株式会社', '任天堂');
const FASTRETAIL = entry('cmp_fr', '株式会社ファーストリテイリング', 'ファーストリテイリング');
const AJINOMOTO = entry('cmp_aji', '味の素株式会社', '味の素');
const NTTDATA = entry('cmp_ntt', '株式会社NTTデータ', 'nttデータ');
const SMBC = entry('cmp_smbc', '株式会社三井住友銀行', '三井住友銀行');
const MITSUI = entry('cmp_mitsui', '三井物産株式会社', '三井物産');
const HITACHI = entry('cmp_hitachi', '株式会社日立製作所', '日立製作所');

const DICT: CompanyMentionDictionaryEntry[] = [NINTENDO, FASTRETAIL, AJINOMOTO, NTTDATA, SMBC, MITSUI, HITACHI];

function makeDictLoader(entries: CompanyMentionDictionaryEntry[]) {
  let calls = 0;
  const load = async (): Promise<CompanyMentionDictionary> => {
    calls += 1;
    return { entries, truncated: false, queries: 2 };
  };
  return { load, calls: () => calls };
}

// ── 公式情報 fixture ─────────────────────────────────────────────────────
const readyFor = (displayName: string): CompanyOfficialReadResult => {
  const rows: FactRow[] = [
    { factKey: 'legalName', factGroup: 'identity', factValue: { value: displayName }, sourceUrl: 'https://example.com/a', sourceType: 'official_site', extractionMethod: 'html_structured', fetchedAt: '2026-08-01T00:00:00.000Z' },
    { factKey: 'businessDescription', factGroup: 'business', factValue: { value: `${displayName}の事業内容（原文抜粋）` }, sourceUrl: 'https://example.com/a', sourceType: 'official_site', extractionMethod: 'llm_extraction', fetchedAt: '2026-08-01T00:00:00.000Z' },
    { factKey: 'recruitingOverview', factGroup: 'recruiting', factValue: { value: `${displayName}の採用方針（原文抜粋）` }, sourceUrl: 'https://example.com/a', sourceType: 'official_site', extractionMethod: 'llm_extraction', fetchedAt: '2026-08-01T00:00:00.000Z' },
  ];
  return cast<CompanyOfficialReadResult>({
    status: 'ready',
    data: buildCompanyOfficialContext({ companyId: `cmp_${displayName}`, displayName, rows, nowIso: NOW }),
  });
};
const NO_FACTS = cast<CompanyOfficialReadResult>({ status: 'unavailable', reason: 'no_facts' });

function makeOfficialLoader(map: Record<string, CompanyOfficialReadResult>) {
  const calls: string[] = [];
  const load = async (q: { companyId?: string | null; companyName?: string | null }) => {
    const key = (q.companyName ?? q.companyId ?? '') as string;
    calls.push(key);
    return map[key] ?? NO_FACTS;
  };
  return { load, calls };
}

const baseInput = (companyOfficialBlock: string): ConsultationSystemPromptInput => ({
  profile: cast({ name: '田中 太郎', preferences: [{ university: '早稲田大学', faculty: '商学部' }] }),
  activity: null,
  values: cast({ selections: { priorities: ['海外で働ける'] } }),
  crossFeature: cast({
    selfAnalysisHistory: [], esHistory: [], interviewHistory: [], presentationHistory: [],
    companyResearch: [], gd: [], gdRoom: [], matching: [],
  }),
  companyOfficialBlock,
  eventSignalsBlock: '',
});

async function main(): Promise<void> {
  console.log('career-consultation-company-mention-qa');
  console.log('');

  // ── [A][B] 今回の発話だけで resolve ──────────────────────────────────
  console.log('[A][B] 保存データゼロ・今回の発話だけで企業を解決する');
  const dict = makeDictLoader(DICT);
  {
    const { mentions } = await resolveConsultationCompanyMentions('味の素って自分に合いそう？', dict.load);
    check(mentions.length === 1 && mentions[0].companyId === 'cmp_aji', '[A] 1 社 resolve', JSON.stringify(mentions));
  }
  {
    const { mentions } = await resolveConsultationCompanyMentions(
      '任天堂とファーストリテイリングなら自分にはどっちが合う？', dict.load);
    check(mentions.length === 2, '[B] 2 社 resolve', JSON.stringify(mentions.map((m) => m.displayName)));
    check(mentions[0]?.companyId === 'cmp_nin' && mentions[1]?.companyId === 'cmp_fr', '[B] 出現順で並ぶ');
  }
  {
    // 法人格つき表記でも同じ companyId へ収束する。
    const a = await resolveConsultationCompanyMentions('任天堂株式会社について教えて', dict.load);
    const b = await resolveConsultationCompanyMentions('株式会社ファーストリテイリングってどう？', dict.load);
    check(a.mentions[0]?.companyId === 'cmp_nin', '法人格つき（任天堂株式会社）でも解決');
    check(b.mentions[0]?.companyId === 'cmp_fr', '法人格が前置（株式会社〜）でも解決');
  }
  {
    // 保存データが完全に空でも target まで通る（本タスクの主目的）。
    const { mentions } = await resolveConsultationCompanyMentions(
      '任天堂と味の素なら、今の自分にはどっちが合ってる？', dict.load);
    const targets = selectConsultationCompanyTargets({
      message: '任天堂と味の素なら、今の自分にはどっちが合ってる？',
      history: [], mentions, candidates: [],
    });
    check(targets.length === 2, '[A] structured candidates 空でも 2 社 target', JSON.stringify(targets));
  }
  console.log('');

  // ── [C][D] 構造化候補との統合 ───────────────────────────────────────
  console.log('[C][D] 構造化候補との dedupe / 優先順位');
  {
    const candidates = collectConsultationCompanyCandidates({
      targetCompanies: ['任天堂株式会社'],
      companyResearch: [{ companyName: '任天堂株式会社', companyId: 'cmp_nin' }],
      esHistory: [{ companyName: '任天堂株式会社' }],
    });
    const message = '任天堂の志望動機ってどう作ればいい？';
    const { mentions } = await resolveConsultationCompanyMentions(message, dict.load);
    const targets = selectConsultationCompanyTargets({ message, history: [], mentions, candidates });
    check(targets.length === 1 && targets[0].companyId === 'cmp_nin', '[C] companyId 単位で 1 社に集約', JSON.stringify(targets));
  }
  {
    // 今回の発話は味の素。保存済み志望企業（任天堂）を target へ引き込まない。
    const candidates = collectConsultationCompanyCandidates({
      targetCompanies: ['任天堂株式会社'], companyResearch: null, esHistory: null,
    });
    const message = '味の素の志望動機がうまく作れない';
    const { mentions } = await resolveConsultationCompanyMentions(message, dict.load);
    const targets = selectConsultationCompanyTargets({ message, history: [], mentions, candidates });
    check(targets.length === 1 && targets[0].companyId === 'cmp_aji', '[D] 今回の発話の企業が優先される', JSON.stringify(targets));
  }
  console.log('');

  // ── [E][F] unknown / ambiguous ─────────────────────────────────────
  console.log('[E][F] 辞書に無い企業 / 曖昧な企業');
  {
    const { mentions } = await resolveConsultationCompanyMentions('任天堂とOpenAIならどっち？', dict.load);
    check(mentions.length === 1 && mentions[0].companyId === 'cmp_nin', '[E] 既知 1 社のみ resolve（未知は作らない）', JSON.stringify(mentions));
  }
  {
    const { mentions } = await resolveConsultationCompanyMentions('OpenAIとAnthropicならどっち？', dict.load);
    check(mentions.length === 0, '[E] 未知企業だけなら 0 社');
  }
  {
    // 同じ alias を 2 社が持つ = ambiguous → 解決しない。
    const ambDict = makeDictLoader([
      entry('cmp_x', 'エックス商事株式会社', 'エックス商事', ['さくら']),
      entry('cmp_y', 'ワイ物産株式会社', 'ワイ物産', ['さくら']),
      NINTENDO,
    ]);
    const { mentions } = await resolveConsultationCompanyMentions('さくらってどんな会社？', ambDict.load);
    check(mentions.length === 0, '[F] ambiguous は resolve しない（曖昧なら使わない）', JSON.stringify(mentions));
  }
  {
    // longest match wins: 「三井住友銀行」を「三井物産」や短い語で食わない。
    const hits = detectCompanyMentions('三井住友銀行とNTTデータならどっち？', DICT);
    check(
      hits.length === 2 && hits[0].companyId === 'cmp_smbc' && hits[1].companyId === 'cmp_ntt',
      'longest match wins（三井住友銀行が別企業に食われない）',
      JSON.stringify(hits.map((h) => h.matchedToken)),
    );
  }
  console.log('');

  // ── [G][H] false positive 防止 ─────────────────────────────────────
  console.log('[G][H] 一般語・一般相談で誤発火しない');
  for (const msg of [
    '面接で話が長くなる',
    '会社選びで迷ってる',
    'グループ面接って何？',
    '銀行業界に興味がある',
    '自己分析ってどうやればいい？',
    '第一志望落ちてやる気が出ない',
    '株式会社って何が違うの？',
    'データ分析の仕事に興味がある',
    '企業研究のやり方を教えて',
  ]) {
    const { mentions } = await resolveConsultationCompanyMentions(msg, dict.load);
    const targets = selectConsultationCompanyTargets({ message: msg, history: [], mentions, candidates: [] });
    check(mentions.length === 0 && targets.length === 0, `mention 0 / target 0 | ${msg}`, JSON.stringify(mentions));
  }
  check(MIN_MENTION_TOKEN_LENGTH >= 3, '短すぎる token は照合対象にしない（下限 3 文字）');
  {
    // ASCII token は語境界を要求する（everyone の one に当たらない）。
    const asciiDict = [entry('cmp_one', 'ONE株式会社', 'one')];
    check(detectCompanyMentions('everyone should apply', asciiDict).length === 0, 'ASCII token は語境界を要求する');
    check(detectCompanyMentions('one って会社どう？', asciiDict).length === 1, 'ASCII token も境界が立てば拾う');
  }
  {
    // 企業名を含む雑談は company context を要求しない。
    const msg = '任天堂のゲームを昨日やった';
    const { mentions } = await resolveConsultationCompanyMentions(msg, dict.load);
    const targets = selectConsultationCompanyTargets({ message: msg, history: [], mentions, candidates: [] });
    check(mentions.length === 1 && targets.length === 0, '企業名が出ても相談意図が無ければ target 0', JSON.stringify(targets));
  }
  console.log('');

  // ── [I] 最大社数 ───────────────────────────────────────────────────
  console.log('[I] 社数上限');
  {
    const msg = '任天堂とファーストリテイリングと味の素とNTTデータならどれが合う？';
    const { mentions } = await resolveConsultationCompanyMentions(msg, dict.load);
    check(mentions.length === CONSULTATION_COMPANY_MAX, `mention は最大 ${CONSULTATION_COMPANY_MAX} 社`, String(mentions.length));
    const targets = selectConsultationCompanyTargets({ message: msg, history: [], mentions, candidates: [] });
    check(targets.length <= CONSULTATION_COMPANY_MAX, `target も最大 ${CONSULTATION_COMPANY_MAX} 社`);
  }
  console.log('');

  // ── [J][K][L] Spine 可否と prompt 到達 ──────────────────────────────
  console.log('[J][K][L] Company Spine 可否 / prompt 位置 / cachedPrefix 不変');
  {
    const msg = '任天堂と味の素なら、今の自分にはどっちが合ってる？';
    const { mentions } = await resolveConsultationCompanyMentions(msg, dict.load);
    const targets = selectConsultationCompanyTargets({ message: msg, history: [], mentions, candidates: [] });
    const official = makeOfficialLoader({ '任天堂株式会社': readyFor('任天堂株式会社'), '味の素株式会社': readyFor('味の素株式会社') });
    const resolved = await resolveConsultationCompanyOfficial(targets, NOW, official.load);
    const withCompany = buildConsultationSystemBlocks(baseInput(resolved.block));
    const without = buildConsultationSystemBlocks(baseInput(''));
    check(resolved.rendered.length === 2, '2 社の公式情報が render される');
    check(withCompany.dynamicSuffix.includes(resolved.block), '[K] Company block は dynamicSuffix に到達');
    check(!withCompany.cachedPrefix.includes('任天堂') && !withCompany.cachedPrefix.includes('味の素'), '[K] cachedPrefix に企業名が入らない');
    check(withCompany.cachedPrefix === without.cachedPrefix, '[L] cachedPrefix は Company block の有無で byte 不変');
    check(Buffer.byteLength(resolved.block, 'utf-8') <= CONSULTATION_COMPANY_TOTAL_MAX_BYTES, `[budget] 総枠 ${CONSULTATION_COMPANY_TOTAL_MAX_BYTES}B 以内`, String(Buffer.byteLength(resolved.block, 'utf-8')));
  }
  {
    // Master にいるが facts 0 の企業（DOMAIN_UNVERIFIED 等）は prompt へ入れない。
    const msg = '三井住友銀行って自分に合いそう？';
    const { mentions } = await resolveConsultationCompanyMentions(msg, dict.load);
    const targets = selectConsultationCompanyTargets({ message: msg, history: [], mentions, candidates: [] });
    const official = makeOfficialLoader({});
    const resolved = await resolveConsultationCompanyOfficial(targets, NOW, official.load);
    check(mentions.length === 1, 'identity は resolve される');
    check(resolved.block === '' && resolved.skipped.length === 1, '[J] facts 0 なら prompt へ入らない（相談は継続）');
  }
  console.log('');

  // ── [M][N] 静的検証 ────────────────────────────────────────────────
  console.log('[M][N] AI call / response schema の不変');
  {
    const route = readFileSync(join(ROOT, 'app/api/career/consultation/route.ts'), 'utf-8');
    check((route.match(/anthropic\.messages\.create/g) ?? []).length === 1, '[M] consultation の AI 呼び出しは 1 本のまま');
    check(/resolveConsultationCompanyMentions\(message\)/.test(route), 'route が mention resolver を通す');
    for (const field of ['currentStatusSummary', 'answer', 'keyInsights', 'recommendedActions', 'missingInformation', 'followUpQuestions']) {
      check(route.includes(field), `[N] response schema 維持 | ${field}`);
    }
    const mention = readFileSync(join(ROOT, 'lib/careerCompanyIdentity/mentionMatch.ts'), 'utf-8');
    const dictionary = readFileSync(join(ROOT, 'lib/careerCompanyIdentity/mentionDictionary.server.ts'), 'utf-8');
    check(!/anthropic|messages\.create|openai/i.test(mention + dictionary), '[M] mention 経路に AI 呼び出しが無い');
    check(!/getCareerServiceRoleSupabaseClient/.test(dictionary), '辞書 read に service role client を使わない');
    check(/buildCompanyResolveResult/.test(readFileSync(join(ROOT, 'app/api/career/consultation/resolveCompanyOfficial.ts'), 'utf-8')), '最終権限は既存 identity resolver');
  }
  console.log('');

  console.log(fail === 0 ? 'career-consultation-company-mention-qa: ALL PASS' : `career-consultation-company-mention-qa: ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
