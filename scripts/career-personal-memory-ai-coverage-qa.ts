/*
 * scripts/career-personal-memory-ai-coverage-qa.ts
 *
 * PASSAI CAREER — Layer 2 Personal Memory × Career AI **coverage** QA（常設 harness）。
 *
 * 固定する契約:
 *   C1  inventory        : 全 Career AI call が manifest に存在する（新 route を足すと FAIL する）。
 *   C2  no dead contract : renderer allowlist を持つ purpose には必ず live callsite がある（逆も真）。
 *   C3  consultation     : route → seam → renderer → final prompt に到達する。
 *   C4  ES               : es-review / es deep / es organize が到達する。
 *   C5  GD policy        : gd_* は **意図的に非接続**（allowlist にも callsite にも無い）。
 *   C6  presentation     : evaluate / qa は接続、theme は非接続。useCareerContext=false は I/O ゼロ。
 *   C7  self-analysis    : 自己参照ループ回避のため非接続（allowlist にも callsite にも無い）。
 *   C8  matching         : Layer 2 が入らない（既存 PII 契約の非回帰）。
 *   C9  PII              : 全接続 purpose で氏名 / mail / 電話 / 住所が block に出ない。
 *   C10 token cap        : 全接続 purpose で total cap を超えない。
 *   C11 fallback         : Memory の失敗（missing / stale / malformed / DB error / source error）でも
 *                          prompt を構築できる（AI route を落とさない）。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-personal-memory-ai-coverage-qa.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { CAREER_CONTEXT_PURPOSES, type CareerContextPurpose } from '@/lib/careerContext/purpose';
import {
  personalMemorySectionsForPurpose,
  renderPersonalMemoryForPurpose,
  PERSONAL_MEMORY_TOTAL_MAX_CHARS,
} from '@/lib/careerMemory/personalMemoryPromptContext';
import { projectSectionFromSource } from '@/lib/careerMemory/persistence/sourceProjection';
import { resolvePersonalMemoryForPurpose } from '@/app/api/career/resolvePersonalMemoryContext';
import type { PersonalMemoryReadOutcome } from '@/lib/careerMemory/persistence/personalMemoryReadServer.server';
import {
  EMPTY_CAREER_SOURCE_BUNDLE,
  type CareerSourceBundle,
} from '@/lib/careerSourceData/types';
import type { CareerPersonalMemorySection } from '@/lib/careerMemory/persistence/schema';

const ROOT = process.cwd();
let failures = 0;
function check(ok: boolean, name: string, detail = ''): void {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

// ─────────────────────────────────────────────────────────────────
// AI call manifest — 「Layer 2 を使う / 使わない」を **明示的に** 宣言する単一の表。
//   layer2:
//     'wired'   … Layer 2 を prompt へ載せる（live callsite が必要）。
//     'policy_off' … 設計判断として使わない（allowlist にも callsite にも現れてはいけない）。
// ─────────────────────────────────────────────────────────────────
type AiCall = {
  /** AI を呼ぶ route（repo-relative）。 */
  route: string;
  /** その AI call が使う Context purpose（orchestrator を通らないものは null）。 */
  purpose: CareerContextPurpose | null;
  layer2: 'wired' | 'policy_off';
  /** Layer 2 を解決する module（wired のみ）。 */
  resolver?: string;
  reason: string;
};

const AI_CALLS: AiCall[] = [
  // ── wired ────────────────────────────────────────────────────
  {
    route: 'app/api/career/consultation/route.ts',
    purpose: 'consultation',
    layer2: 'wired',
    resolver: 'app/api/career/consultation/route.ts',
    reason: '司令塔。bridge が履歴を出せなかった分だけ Memory が埋める（dedupe: bridge wins）。',
  },
  {
    route: 'app/api/career/es-review/route.ts',
    purpose: 'es_review',
    layer2: 'wired',
    resolver: 'app/api/career/es-review/route.ts',
    reason: '添削は本人の内省との整合が中核。過去 ES 企業は志望動機の使い回し検出に使う。',
  },
  {
    route: 'app/api/career/es/deep/route.ts',
    purpose: 'es_review',
    layer2: 'wired',
    resolver: 'app/api/career/es/resolveFallbackContext.ts',
    reason: '深掘り質問の方向付け。背景 context builder（es_review policy 借用）経由で受け取る。',
  },
  {
    route: 'app/api/career/es/organize/route.ts',
    purpose: 'es_review',
    layer2: 'wired',
    resolver: 'app/api/career/es/resolveFallbackContext.ts',
    reason: '材料整理の背景 context。deep と同一 builder を共有する。',
  },
  {
    route: 'app/api/career/interview/start/route.ts',
    purpose: 'interview_practice',
    layer2: 'wired',
    resolver: 'app/api/career/interview/resolvePersonalMemory.ts',
    reason: '既存（不変）。質問生成に本人の志望軸・経験・自己分析・過去 ES を使う。',
  },
  {
    route: 'app/api/career/interview/turn/route.ts',
    purpose: 'interview_practice',
    layer2: 'wired',
    resolver: 'app/api/career/interview/resolvePersonalMemory.ts',
    reason: '既存（不変）。深掘りの方向付けに start と同じ policy を共有する。',
  },
  {
    route: 'app/api/career/interview/complete/route.ts',
    purpose: 'interview_practice',
    layer2: 'wired',
    resolver: 'app/api/career/interview/resolvePersonalMemory.ts',
    reason: '既存（不変）。最終評価も start / turn と同一 builder・同一 policy を共有する。',
  },
  {
    route: 'app/api/career/company-research/route.ts',
    purpose: 'company_research_review',
    layer2: 'wired',
    resolver: 'app/api/career/company-research/route.ts',
    reason: '既存（不変）。企業事実は Company Data Spine が権威。Memory は観点調整のみ。',
  },
  {
    route: 'app/api/career/presentation/evaluate/route.ts',
    purpose: 'presentation_feedback',
    layer2: 'wired',
    resolver: 'app/api/career/presentation/evaluate/route.ts',
    reason: '面接の長期傾向が発表改善に直結。useCareerContext=false では解決自体を行わない。',
  },
  {
    route: 'app/api/career/presentation/qa/route.ts',
    purpose: 'presentation_feedback',
    layer2: 'wired',
    resolver: 'app/api/career/presentation/qa/route.ts',
    reason: '想定問答も同じ policy。useCareerContext=false では解決自体を行わない。',
  },

  // ── policy_off（設計判断としての NO。未実装ではない） ─────────
  {
    route: 'app/api/career/presentation/theme/route.ts',
    purpose: 'presentation_feedback',
    layer2: 'policy_off',
    reason: 'お題生成。個人 Memory は不要で、テーマを本人の過去へ引き寄せる副作用の方が大きい。',
  },
  {
    route: 'app/api/career/gd/feedback/route.ts',
    purpose: 'gd_feedback',
    layer2: 'policy_off',
    reason:
      '採点根拠は transcript のみという明示契約。context budget も唯一 2000 char と最小で、'
      + 'gdCrossFeature が既に Layer 1 から自己分析を描画している。',
  },
  {
    route: 'app/api/career/gd/turn/route.ts',
    purpose: 'gd_feedback',
    layer2: 'policy_off',
    reason: 'AI 参加者の発話生成。他人がいる議論に本人の個人 Memory を混ぜるのは用途的に誤り。',
  },
  {
    route: 'app/api/career/gd/theme/route.ts',
    purpose: 'gd_feedback',
    layer2: 'policy_off',
    reason: 'お題生成。個人 Memory 不要。',
  },
  {
    route: 'app/api/career/gd/room/[roomId]/ai-turn/route.ts',
    purpose: null,
    layer2: 'policy_off',
    reason: '複数人 room の AI 発話。他参加者に見える出力へ個人 Memory を持ち込まない。',
  },
  {
    route: 'app/api/career/self-analysis/route.ts',
    purpose: 'self_analysis',
    layer2: 'policy_off',
    reason:
      'route が過去自己分析ログ全件 + coverage を Layer 1 から既に付与している。Layer 2 は同じログの'
      + '要約なので、注入すると過去結論が二重計上され anchoring / 自己参照ループになる。',
  },
  {
    route: 'app/api/career/self-analysis/question/route.ts',
    purpose: 'self_analysis_deep_dive',
    layer2: 'policy_off',
    reason: '深掘り質問も同じ自己参照リスク。Layer 1 の過去ログ + coverage のみが正しい。',
  },
  {
    route: 'app/api/career/matching/route.ts',
    purpose: 'matching',
    layer2: 'policy_off',
    reason: '既存 PII 契約（氏名除外 pilot）と deferral を維持する。scope 外。',
  },
  {
    route: 'app/api/career/es/materials/route.ts',
    purpose: null,
    layer2: 'policy_off',
    reason: '材料候補の抽出。orchestrator を通らず、本人が選ぶ材料が主役。',
  },
  {
    route: 'app/api/career/company-research/extract/route.ts',
    purpose: null,
    layer2: 'policy_off',
    reason: '貼り付けテキストからの抽出。本人 Memory は不要（企業テキストが主役）。',
  },
];

// ── PII fixture ──────────────────────────────────────────────────
const PII_NAME = '山田太郎';
const PII_EMAIL = 'taro.yamada@example.com';
const PII_PHONE = '090-1234-5678';
const PII_ADDRESS = '東京都千代田区1-2-3';

const BUNDLE: CareerSourceBundle = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  profile: {
    name: PII_NAME, email: PII_EMAIL, phone: PII_PHONE, address: PII_ADDRESS,
    grade: 'B3', graduationYear: '2028年卒',
    preferences: [{ university: 'PASSAI大学', faculty: '経済学部' }],
    targetIndustries: ['コンサル'], targetJobs: ['戦略コンサルタント'],
    targetCompanies: ['ゼータ総研'], jobHuntingStatus: '本選考にエントリー中',
    preferredLocations: ['東京'],
  } as unknown as CareerSourceBundle['profile'],
  activity: {
    updatedAt: '2026-08-01T00:00:00.000Z',
    focusedActivities: [{ title: '学園祭実行委員長' }],
  } as unknown as CareerSourceBundle['activity'],
  values: {
    selections: {
      priorities: ['成長環境がある'], avoidances: ['残業が多い'], industries: ['コンサル'],
      jobTypes: ['企画'], workStyles: ['リモート'], companyTypes: ['ベンチャー'],
      careerGoals: ['専門性を高めたい'], culturePreferences: ['フラット'],
    },
    notes: {
      priorities: '', avoidances: '', industries: '', jobTypes: '',
      workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '',
    },
    overallNote: '',
  } as unknown as CareerSourceBundle['values'],
  selfAnalysisLogs: [{
    id: 'sa-1', createdAt: '2026-08-03T00:00:00.000Z', userInput: '',
    result: {
      summary: '課題を構造化して考えるタイプ', careerDirection: '課題解決型で専門性を積む',
      strengths: ['構造化思考'], weaknesses: ['完璧主義'], valueKeywords: ['誠実さ'],
      recommendedIndustries: ['コンサル'], companySelectionCriteria: ['裁量の大きさ'],
      nextActions: ['ケース面接の練習'],
    },
  }] as unknown as CareerSourceBundle['selfAnalysisLogs'],
  esLogs: [{
    id: 'es-1', createdAt: '2026-08-04T00:00:00.000Z',
    companyName: '株式会社アルファ', question: 'ガクチカを教えてください',
    result: { answer: '' },
  }] as unknown as CareerSourceBundle['esLogs'],
  interviewResults: [{
    id: 'iv-1', createdAt: '2026-08-05T00:00:00.000Z', mode: 'real',
    result: {
      overallComment: '結論から話せている', strengths: ['論理性'],
      improvements: ['具体性が不足'], deepDiveTopics: ['役割の詳細'],
      nextActions: ['数字を添える'], companyFit: '',
    },
  }] as unknown as CareerSourceBundle['interviewResults'],
};

function allSections(): CareerPersonalMemorySection[] {
  return (['base', 'self_analysis', 'es', 'interview'] as const)
    .map((k) => projectSectionFromSource(k, BUNDLE)?.section)
    .filter(Boolean) as CareerPersonalMemorySection[];
}

/** DI: loader を差し替えて failure mode を再現する。 */
function fakeLoader(
  outcome: Partial<PersonalMemoryReadOutcome> & { throws?: boolean },
): never {
  return (async () => {
    if (outcome.throws) throw new Error('boom');
    return {
      sections: outcome.sections ?? [],
      meta: {
        gate: 'allowed',
        read: 'ok',
        sectionCount: outcome.sections?.length ?? 0,
        readDurationMs: 1,
        sourceRead: 'ok',
        origins: {},
        vetoed: {},
        ...(outcome.meta ?? {}),
      },
    };
  }) as never;
}

// ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('=== career-personal-memory-ai-coverage-qa ===');

  const WIRED = AI_CALLS.filter((c) => c.layer2 === 'wired');
  const WIRED_PURPOSES = [...new Set(WIRED.map((c) => c.purpose).filter(Boolean))] as CareerContextPurpose[];

  // ── C1: AI inventory ──────────────────────────────────────────
  console.log('\n[C1] AI call inventory');
  {
    for (const c of AI_CALLS) {
      check(existsSync(join(ROOT, c.route)), `manifest の route が実在する: ${c.route}`);
      check(c.reason.trim().length > 10, `${c.route}: policy 理由が書かれている`);
    }
    // 実 repo を走査し、AI を呼ぶ route が manifest から漏れていないこと（新 route で FAIL する）。
    const declared = new Set(AI_CALLS.map((c) => c.route));
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (e.name !== 'route.ts') continue;
        const src = readFileSync(full, 'utf8');
        // LLM 呼び出しの実体（anthropic / openai client）を持つ route だけを対象にする。
        if (!/from '@\/lib\/ai'|anthropic\.|openai\./.test(src)) continue;
        found.push(full.slice(ROOT.length + 1));
      }
    };
    walk(join(ROOT, 'app/api/career'));
    const missing = found.filter((f) => !declared.has(f));
    check(
      missing.length === 0,
      `AI を呼ぶ全 route が manifest に宣言されている（未宣言 ${missing.length} 件）`,
      missing.join(', '),
    );
    console.log(`        detected AI routes: ${found.length} / declared: ${AI_CALLS.length}`);
  }

  // ── C2: no dead contract ──────────────────────────────────────
  console.log('\n[C2] no dead contract（allowlist ⇔ live callsite）');
  {
    for (const purpose of CAREER_CONTEXT_PURPOSES) {
      const allowed = personalMemorySectionsForPurpose(purpose).length > 0;
      const wired = WIRED_PURPOSES.includes(purpose);
      check(
        allowed === wired,
        `${purpose}: renderer allowlist(${allowed}) と live wiring(${wired}) が一致`,
      );
    }
    // wired purpose には実際に resolver / extras 受け渡しがある。
    for (const c of WIRED) {
      const src = read(c.resolver!);
      check(
        /resolvePersonalMemoryForPurpose\(|loadPersonalMemorySectionsForPrompt\(/.test(src),
        `${c.resolver}: Layer 2 loader を呼ぶ`,
      );
    }
  }

  // ── C3: consultation reachability ─────────────────────────────
  console.log('\n[C3] consultation reachability');
  {
    const route = read('app/api/career/consultation/route.ts');
    const prompt = read('app/api/career/consultation/consultationPrompt.ts');
    check(/resolvePersonalMemoryForPurpose\(\{[\s\S]{0,200}?purpose: 'consultation'/.test(route), 'route: seam を purpose=consultation で呼ぶ');
    check(/consultationBridgePresence\(crossFeature\)/.test(route), 'route: bridge presence を renderer 同一実装で判定');
    check(/personalMemory,/.test(route), 'route: 解決結果を prompt builder へ渡す');
    check(/personalMemory: input\.personalMemory/.test(prompt), 'prompt: orchestrator extras へ渡す');
    check(/orchestrated\.personalMemoryContext/.test(prompt), 'prompt: personalMemoryContext を結合する');
    // 位置: base / crossFeature の **後**、Event Signal の **前**。
    //   ★ コメント中の言及に引きずられないよう、行コメントを除去してから索引を取る。
    const promptCode = prompt.replace(/\/\/.*$/gm, '');
    const iBase = promptCode.indexOf('orchestrated.systemPrompt');
    const iCross = promptCode.indexOf('orchestrated.crossFeatureContext');
    const iMem = promptCode.indexOf('orchestrated.personalMemoryContext');
    const iSig = promptCode.indexOf('input.eventSignalsBlock');
    check(iBase < iCross && iCross < iMem && iMem < iSig, 'prompt: base < crossFeature < personalMemory < eventSignal の順');
    // 実 render が最終 prompt に載ること。
    const block = renderPersonalMemoryForPurpose('consultation', allSections()).block;
    check(block.startsWith('<personal_memory>') && block.length > 0, 'renderer: consultation で block が生成される');
  }

  // ── C4: ES reachability ───────────────────────────────────────
  console.log('\n[C4] ES reachability');
  {
    const review = read('app/api/career/es-review/route.ts');
    check(/purpose: 'es_review'/.test(review), 'es-review: seam を purpose=es_review で呼ぶ');
    check(/personalMemory\.length > 0 \? \{ personalMemory \} : \{\}/.test(review), 'es-review: extras へ渡す');
    check(/orchestrated\.personalMemoryContext/.test(review), 'es-review: systemPrompt へ結合');
    const fb = read('app/api/career/es/resolveFallbackContext.ts');
    check(/purpose: 'es_review'/.test(fb), 'es deep/organize: 共有 builder が seam を呼ぶ');
    check(/orchestrated\.personalMemoryContext/.test(fb), 'es deep/organize: 背景 block へ結合');
    for (const rel of ['app/api/career/es/deep/route.ts', 'app/api/career/es/organize/route.ts']) {
      check(/resolveEsFallbackContextBlock\(/.test(read(rel)), `${rel}: 共有 builder を通る`);
    }
    const block = renderPersonalMemoryForPurpose('es_review', allSections()).block;
    check(block.includes('株式会社アルファ'), 'renderer: es_review に過去 ES 設問メタが載る');
    check(!/大学|学部|志望業界/.test(block), 'renderer: es_review に base（Layer 1 と重複）が載らない');
  }

  // ── C5: GD policy ─────────────────────────────────────────────
  console.log('\n[C5] GD policy = 非接続（設計判断）');
  {
    check(personalMemorySectionsForPurpose('gd_feedback').length === 0, 'gd_feedback: allowlist 空');
    check(renderPersonalMemoryForPurpose('gd_feedback', allSections()).block === '', 'gd_feedback: block が出ない');
    for (const rel of [
      'app/api/career/gd/feedback/route.ts',
      'app/api/career/gd/turn/route.ts',
      'app/api/career/gd/theme/route.ts',
      'app/api/career/gd/gdSpinePrompt.ts',
      'app/api/career/gd/room/[roomId]/ai-turn/route.ts',
    ]) {
      const src = read(rel).replace(/\/\/.*$/gm, '');
      check(!/personalMemory|PersonalMemory/.test(src), `${rel}: Personal Memory を参照しない`);
    }
  }

  // ── C6: presentation policy ───────────────────────────────────
  console.log('\n[C6] presentation policy');
  {
    for (const rel of ['app/api/career/presentation/evaluate/route.ts', 'app/api/career/presentation/qa/route.ts']) {
      const src = read(rel);
      check(/purpose: 'presentation_feedback'/.test(src), `${rel}: seam を呼ぶ`);
      check(/enabled: usePersonalMemory/.test(src), `${rel}: useCareerContext=false では解決しない`);
      check(/config\?\.useCareerContext === true/.test(src), `${rel}: gate は config.useCareerContext`);
      check(/personalMemory,/.test(src), `${rel}: builder へ渡す`);
    }
    const theme = read('app/api/career/presentation/theme/route.ts').replace(/\/\/.*$/gm, '');
    check(!/personalMemory/.test(theme), 'presentation/theme: Personal Memory を渡さない（お題生成）');
    const prompt = read('app/api/career/presentation/presentationPrompt.ts');
    check(/orchestrated\.personalMemoryContext/.test(prompt), 'presentationPrompt: block を結合');
    const pCode = prompt.replace(/\/\/.*$/gm, '');
    const iCross = pCode.indexOf('orchestrated.crossFeatureContext');
    const iMem = pCode.indexOf('orchestrated.personalMemoryContext');
    check(iCross >= 0 && iCross < iMem, 'presentationPrompt: crossFeature の後に personalMemory');
    const block = renderPersonalMemoryForPurpose('presentation_feedback', allSections()).block;
    check(block.includes('面接'), 'renderer: presentation に面接の長期傾向が載る');
    check(!/大学|学部/.test(block), 'renderer: presentation に base が載らない');
    // enabled=false は I/O ゼロ（loader を一切呼ばない）。
    let called = 0;
    const out = await resolvePersonalMemoryForPurpose({
      purpose: 'presentation_feedback',
      presence: {},
      enabled: false,
      loadSections: (async () => { called += 1; return { sections: [], meta: {} as never }; }) as never,
    });
    check(called === 0 && out.length === 0, 'enabled=false → loader を呼ばず空配列（I/O ゼロ）');
  }

  // ── C7: self-analysis policy ──────────────────────────────────
  console.log('\n[C7] self-analysis policy = 非接続（自己参照ループ回避）');
  {
    for (const p of ['self_analysis', 'self_analysis_deep_dive'] as const) {
      check(personalMemorySectionsForPurpose(p).length === 0, `${p}: allowlist 空`);
      check(renderPersonalMemoryForPurpose(p, allSections()).block === '', `${p}: block が出ない`);
    }
    for (const rel of [
      'app/api/career/self-analysis/route.ts',
      'app/api/career/self-analysis/question/route.ts',
      'app/api/career/self-analysis/deepDivePrompt.ts',
      'lib/careerSelfAnalysis/summaryPrompt.ts',
    ]) {
      const src = read(rel).replace(/\/\/.*$/gm, '');
      check(!/personalMemory|PersonalMemory/.test(src), `${rel}: Personal Memory を参照しない`);
    }
  }

  // ── C8: matching remains excluded ─────────────────────────────
  console.log('\n[C8] matching は除外のまま');
  {
    check(personalMemorySectionsForPurpose('matching').length === 0, 'matching: allowlist 空');
    check(renderPersonalMemoryForPurpose('matching', allSections()).block === '', 'matching: block が出ない');
    const src = read('app/api/career/matching/route.ts').replace(/\/\/.*$/gm, '');
    check(!/personalMemory|PersonalMemory/.test(src), 'matching route: Personal Memory を参照しない');
  }

  // ── C9: PII ───────────────────────────────────────────────────
  console.log('\n[C9] PII（全接続 purpose）');
  {
    const sections = allSections();
    for (const purpose of WIRED_PURPOSES) {
      const block = renderPersonalMemoryForPurpose(purpose, sections).block;
      for (const [label, v] of [['氏名', PII_NAME], ['mail', PII_EMAIL], ['電話', PII_PHONE], ['住所', PII_ADDRESS]] as const) {
        check(!block.includes(v), `${purpose}: block に${label}が出ない`);
      }
    }
  }

  // ── C10: token cap ────────────────────────────────────────────
  console.log('\n[C10] token cap');
  {
    const sections = allSections();
    for (const purpose of WIRED_PURPOSES) {
      const r = renderPersonalMemoryForPurpose(purpose, sections);
      // 本文は total cap 以内。境界（header/footer）を足しても運用上限に収まる。
      const bodyChars = r.meta.renderedChars;
      check(
        bodyChars <= PERSONAL_MEMORY_TOTAL_MAX_CHARS + 400,
        `${purpose}: block ${bodyChars} char が cap 内`,
        String(bodyChars),
      );
      console.log(`        ${purpose}: sections=${r.meta.sectionCount} chars=${bodyChars}`);
    }
  }

  // ── C11: fallback ─────────────────────────────────────────────
  console.log('\n[C11] fallback（Memory 失敗でも prompt を構築できる）');
  {
    const cases: Array<{ label: string; loader: never }> = [
      { label: 'missing（section 0）', loader: fakeLoader({ sections: [] }) },
      { label: 'stale/veto（omitted）', loader: fakeLoader({ sections: [], meta: { read: 'empty' } as never }) },
      { label: 'DB error', loader: fakeLoader({ sections: [], meta: { read: 'error' } as never }) },
      { label: 'source error', loader: fakeLoader({ sections: [], meta: { sourceRead: 'error' } as never }) },
      { label: 'loader throw', loader: fakeLoader({ throws: true }) },
    ];
    for (const purpose of WIRED_PURPOSES) {
      for (const c of cases) {
        const sections = await resolvePersonalMemoryForPurpose({
          purpose, presence: {}, loadSections: c.loader,
        });
        const block = renderPersonalMemoryForPurpose(purpose, sections).block;
        check(
          Array.isArray(sections) && sections.length === 0 && block === '',
          `${purpose} / ${c.label}: 空配列 → block '' （従来 prompt と byte 互換）`,
        );
      }
    }
    // malformed section が混じっても renderer が落ちない。
    const malformed = [
      null, undefined, 'x',
      { sectionKey: 'unknown', schemaVersion: 1, payload: {} },
      { sectionKey: 'es', schemaVersion: 1, payload: null },
    ] as unknown as CareerPersonalMemorySection[];
    for (const purpose of WIRED_PURPOSES) {
      const r = renderPersonalMemoryForPurpose(purpose, malformed);
      check(typeof r.block === 'string', `${purpose}: malformed section でも never-throw`);
    }
    // 共有 seam が userId を引数で受け取らない（owner scope 迂回の構造的防止）。
    const seam = read('app/api/career/resolvePersonalMemoryContext.ts');
    check(!/userId/.test(seam.replace(/\/\/.*$/gm, '')), 'seam: userId を引数で受け取らない（server auth + RLS が唯一の権威）');
    check(!/console\.(log|info|warn|error)\(/.test(seam), 'seam: console 出力なし（本文非ログ）');
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-personal-memory-ai-coverage-qa: ALL PASS'
      : `career-personal-memory-ai-coverage-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
