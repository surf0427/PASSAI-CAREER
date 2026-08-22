/*
 * scripts/career-consultation-prompt-cache-qa.ts
 *
 * PASSAI CAREER — 相談AI Prompt Cache 境界の構造 QA（dev-only・外部AI非実行）。
 *
 * 目的:
 *   相談AI（/api/career/consultation）の system prompt を Anthropic Prompt Caching 用に
 *   「静的 cached prefix」と「動的 suffix」へ分割した際、
 *     (1) AI へ渡る prompt text の **意味内容が一切変わっていない**こと（flatten byte parity）
 *     (2) cached prefix に **ユーザー固有データが 1 byte も混入していない**こと
 *   を、fixture 横断で決定的に検証する。
 *
 * 検証項目:
 *   [A] cached prefix は静的のみ（fixture が変わっても cachedPrefix は完全一致）
 *   [B] User Data Spine（profile / activity / values）が cached prefix に無い
 *   [C] Personal Memory / crossFeature 履歴が cached prefix に無い
 *   [D] Event Signal block が cached prefix に無い
 *   [E] 会話履歴・今回のユーザー発話は system 側に一切載らない（route は messages にのみ載せる）
 *   [F] flatten parity: cachedPrefix + separator + dynamicSuffix === buildConsultationSystemPrompt
 *   [G] cached prefix が cache 最小長（sonnet 系 1024 token）を十分に超える分量である
 *   [H] route 配線: system は block 配列 / cache_control は block 1 のみ / messages 側は不変
 *
 * 厳守: production の純関数を読むだけ。外部 AI 非実行・実データ非参照・DB / Supabase / env / secret 非接続。
 *   日時・乱数・不安定 key 順を持ち込まない。
 *
 * 使い方: npx tsx scripts/career-consultation-prompt-cache-qa.ts
 * 終了コード: 全 PASS → 0 / 1 件でも FAIL → 1
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CompanyResearchSnapshot } from '@/types/careerCompanyResearch';
import { normalizeCompanyResearchSnapshot } from '@/lib/careerCompanyResearch/context';
import { normalizeMatchingConsultationSnapshot } from '@/lib/careerMatching/consultationContext';
import {
  normalizeSelfAnalysisHistory,
  normalizeEsHistory,
  normalizeInterviewHistory,
} from '@/lib/careerConsultation/historySnapshots';
import { resolveConsultationEventSignalsBlock } from '@/lib/careerMemory/renderEventSignals';
import type { CareerEventSignalSummary } from '@/lib/careerMemory/eventSignals';
import type { CareerPersonalMemorySection } from '@/lib/careerMemory/persistence/schema';
import type { ConsultationCrossFeatureInput } from '@/lib/careerMemory/renderers/consultationCrossFeature';
import {
  buildConsultationSystemPrompt,
  buildConsultationSystemBlocks,
  type ConsultationSystemPromptInput,
} from '@/app/api/career/consultation/consultationPrompt';

const cast = <T>(v: unknown): T => v as T;
const ROOT = process.cwd();
const SEPARATOR = '\n\n';

let fail = 0;
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) fail += 1;
};

// ── fixtures（決定的・normalizer 経由で route と同一 shape） ───────────────────
const nn = <T>(arr: (T | null)[]): T[] => arr.filter((x): x is T => x !== null);

const emptyCf = (): ConsultationCrossFeatureInput => ({
  selfAnalysisHistory: [], esHistory: [], interviewHistory: [], presentationHistory: [],
  companyResearch: [], gd: [], gdRoom: [], matching: [],
});

// cached prefix に絶対に現れてはいけない「ユーザー固有の目印」文字列。
// 各 marker は「cachedPrefix に無い」だけでなく「dynamicSuffix には出る」ことも同時に検証する
// （render されない文字列で assertion が空振りするのを防ぐ）。
const USER_DATA_MARKERS = [
  '東京大学', '工学部', 'IT・ソフトウェア',           // profile（User Data Spine）
  '研究テーマは半導体',                              // activity
  '裁量の大きさを最優先', '転勤が多い会社は避けたい',   // values
  'サンプル0株式会社',                               // 企業研究メモ（本人が保存した内容）
  '強み0', 'ガク0', 'oc0',                           // 自己分析 / 面接 履歴
];

const profilePii = cast<CareerProfileInput>({
  name: '山田太郎',
  preferences: [{ university: '東京大学', faculty: '工学部' }],
  targetIndustries: ['IT・ソフトウェア'], jobHuntingStatus: '選考中',
});
const activityRich = cast<CareerActivityInput>({
  academics: { seminar: '研究テーマは半導体' },
});
const valuesRich = cast<CareerValuesInput>({
  selections: { priorities: ['裁量の大きさを最優先'] },
  overallNote: '転勤が多い会社は避けたい',
});
const crossRich = (): ConsultationCrossFeatureInput => ({
  ...emptyCf(),
  selfAnalysisHistory: normalizeSelfAnalysisHistory([
    { createdAt: '2026-07-01', summary: '所感', careerDirection: '方向', strengths: ['強み0'], weaknesses: ['弱0'], recommendedIndustries: ['IT'], recommendedJobs: ['eng'], companySelectionCriteria: ['裁量'], gakuchikaIdeas: ['ガク0'] },
  ]),
  esHistory: normalizeEsHistory([
    { createdAt: '2026-06-01', companyName: 'Co0', question: 'q0', headline: 'h0', gakuchika: 'g0', selfPr: 'p0', motivation: 'm0', appealPoints: ['ap0'] },
  ]),
  interviewHistory: normalizeInterviewHistory([
    { createdAt: '2026-05-01', mode: 'real', overallComment: 'oc0', strengths: ['s0'], improvements: ['imp0'], deepDiveTopics: ['dt0'], nextActions: ['na0'], companyFit: 'fit0' },
  ]),
  companyResearch: nn<CompanyResearchSnapshot>([
    normalizeCompanyResearchSnapshot({ logId: 'log0', companyName: 'サンプル0株式会社', industry: 'IT・通信', interestLevel: 'high', updatedAt: '2026-07-01T00:00:00.000Z', verifiedResearchTextPreview: '抜粋0', fitSummary: '適合0' }),
  ]),
  matching: nn([
    normalizeMatchingConsultationSnapshot({ createdAt: '2025-12-01', careerType: 'タイプ0', recommendedIndustries: ['IT'], recommendedJobs: ['eng'], developmentAreas: ['定量化'], nextSteps: ['次'], topCompanies: [{ company: '会社0', matchScore: 80, readinessScore: 60, matchReasons: ['理由'], attentionPoints: ['注意'], avoidanceHits: [] }] }),
  ]),
});

const MEMORY_MARKER = 'メモリー由来の一貫強み';
const personalMemoryRich: readonly CareerPersonalMemorySection[] = [
  cast({
    sectionKey: 'self_analysis',
    schemaVersion: 1,
    payload: {
      meta: { feature: 'self_analysis', sourceCount: 2, latestAt: '2026-07-01' },
      latest: [{
        createdAt: '2026-07-01', summary: '所感', careerDirection: '方向',
        strengths: [MEMORY_MARKER], weaknesses: [], valueKeywords: [], strengthKeywords: [],
        recommendedIndustries: [], recommendedJobs: [], companySelectionCriteria: [],
        gakuchikaIdeas: [], nextActions: [],
      }],
    },
  }),
];

// Event Signal block は production resolver で生成する（本 QA は Event Signal 実装を変更しない）。
const eventSignalBlock = resolveConsultationEventSignalsBlock(
  true,
  cast<CareerEventSignalSummary>({
    version: 1, windowDays: 30,
    recentFeatures: ['es', 'interview'],
    featureUsage: { es: 'often' },
    activeAreaCount: 2,
    lastActivityRecency: 'within_3d',
  }),
);

type Fixture = { name: string; input: ConsultationSystemPromptInput };
const FIXTURES: Fixture[] = [
  {
    name: 'empty',
    input: { profile: null, activity: null, values: null, crossFeature: emptyCf(), eventSignalsBlock: '' },
  },
  {
    name: 'profile-only',
    input: { profile: profilePii, activity: null, values: null, crossFeature: emptyCf(), eventSignalsBlock: '' },
  },
  {
    name: 'all-context',
    input: {
      profile: profilePii, activity: activityRich, values: valuesRich,
      crossFeature: crossRich(), eventSignalsBlock: eventSignalBlock,
    },
  },
  {
    // Personal Memory は bridge dedupe（bridge wins）があるため、crossFeature 空の fixture で通電させる。
    name: 'personal-memory',
    input: {
      profile: null, activity: null, values: null,
      crossFeature: emptyCf(), eventSignalsBlock: '',
      personalMemory: personalMemoryRich,
    },
  },
];

console.log('career-consultation-prompt-cache-qa');
console.log('');

const built = FIXTURES.map((f) => ({ ...f, blocks: buildConsultationSystemBlocks(f.input) }));

// ── [F] flatten parity ─────────────────────────────────────────────────────
console.log('[F] flatten parity（cachedPrefix + separator + dynamicSuffix === flat builder）');
for (const b of built) {
  const flat = buildConsultationSystemPrompt(b.input);
  check(b.blocks.cachedPrefix + SEPARATOR + b.blocks.dynamicSuffix === flat, `flatten byte 一致 | ${b.name}`);
}
console.log('');

// ── [A] cached prefix は fixture 非依存（＝全ユーザー共通・完全静的） ──────────
console.log('[A] cached prefix は全 fixture で完全一致（静的である証明）');
const prefix0 = built[0].blocks.cachedPrefix;
for (const b of built.slice(1)) {
  check(b.blocks.cachedPrefix === prefix0, `cachedPrefix identical | ${b.name}`);
}
check(prefix0.startsWith('あなたは新卒就活専門のキャリアメンター'), 'cachedPrefix は司令塔 persona で始まる');
check(prefix0.includes('今回の機能: 就活相談'), 'cachedPrefix に共通基盤の機能ラベルが入る');
check(prefix0.includes('【就活相談】'), 'cachedPrefix に機能別指示が入る');
console.log('');

// ── [B][C][D] cached prefix にユーザー固有データが無い ────────────────────────
console.log('[B][C][D] cached prefix にユーザー固有データが混入しない');
const richSuffix = built[2].blocks.dynamicSuffix;
for (const marker of USER_DATA_MARKERS) {
  check(
    !prefix0.includes(marker) && richSuffix.includes(marker),
    `cachedPrefix に無く dynamicSuffix に有る | ${marker}`,
  );
}
const memorySuffix = built[3].blocks.dynamicSuffix;
check(
  !prefix0.includes(MEMORY_MARKER) && memorySuffix.includes(MEMORY_MARKER),
  `cachedPrefix に無く dynamicSuffix に有る | Personal Memory（${MEMORY_MARKER}）`,
);
for (const header of ['# 学生プロフィール', '# 活動・経験', '# 就活軸']) {
  check(!prefix0.includes(header), `cachedPrefix に User Data Spine section が無い | ${header}`);
}
check(eventSignalBlock !== '', 'Event Signal fixture が非空（検証が空振りしない）');
check(!prefix0.includes(eventSignalBlock), 'cachedPrefix に Event Signal block が無い');
console.log('');

// 分割で情報を落としていない・並び順を変えていないことの裏取り。
console.log('[B-2] dynamicSuffix 側の構造（脱落なし・出力形式は末尾のまま）');
check(richSuffix.startsWith('# 学生プロフィール\n'), 'dynamicSuffix は User Data Spine section から始まる');
check(richSuffix.includes(eventSignalBlock), 'dynamicSuffix に Event Signal block が出る');
check(richSuffix.includes('# 出力形式（厳守）'), 'dynamicSuffix に出力形式が出る');
check(richSuffix.trimEnd().endsWith('"priority":"high"}'), '出力形式が system prompt の末尾のまま（並び順不変）');
console.log('');

// ── [G] cache 最小長 ───────────────────────────────────────────────────────
console.log('[G] cached prefix の分量（Anthropic の最小 cacheable prefix = sonnet 系 1024 token）');
const prefixChars = prefix0.length;
const prefixBytes = Buffer.byteLength(prefix0, 'utf-8');
// 日本語主体の prompt では 1 token あたり概ね 1 文字前後。3000 文字を安全側の下限に置く。
check(prefixChars >= 3000, `cachedPrefix 文字数 >= 3000（実測 ${prefixChars} chars / ${prefixBytes} bytes）`);
console.log('');

// ── [E][H] route 配線の静的検証 ────────────────────────────────────────────
console.log('[E][H] route 配線（system block 配列 / cache_control 位置 / messages 不変）');
const route = readFileSync(join(ROOT, 'app/api/career/consultation/route.ts'), 'utf-8');
check(/system: systemBlocks,/.test(route), 'route は system に block 配列を渡す');
check((route.match(/cache_control: \{ type: 'ephemeral' \}/g) ?? []).length === 1, 'cache_control は 1 箇所のみ（block 1 = 静的 prefix）');
check(/text: systemParts\.cachedPrefix,\n\s+cache_control/.test(route), 'cache_control が付くのは cachedPrefix block');
check(/\{ type: 'text', text: systemParts\.dynamicSuffix \}/.test(route), 'dynamicSuffix block に cache_control は付かない');
check(/messages: \[\.\.\.history, \{ role: 'user', content: message \}\]/.test(route), '会話履歴と今回発話は messages 側のまま（system へ移していない）');
check(!/system: systemPrompt/.test(route), '旧 string system 渡しは残っていない');
for (const field of ['currentStatusSummary', 'answer', 'keyInsights', 'recommendedActions', 'missingInformation', 'followUpQuestions']) {
  check(route.includes(field), `response schema 維持 | ${field}`);
}
console.log('');

console.log(fail === 0 ? 'career-consultation-prompt-cache-qa: ALL PASS' : `career-consultation-prompt-cache-qa: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
