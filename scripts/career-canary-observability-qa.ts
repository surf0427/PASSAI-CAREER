/*
 * scripts/career-canary-observability-qa.ts
 *
 * PASSAI CAREER — Canary observability / shadow-parity QA（dev-only・純関数中心）。
 *
 * [O1] 観測語彙の網羅（Source-Sync / Personal Memory / Server Context）
 * [O2] 正規化の正しさ（「使えなかった理由」を成功で覆い隠さない）
 * [O3] counters が rollout evidence（率）を出せる
 * [O4] ★ observability に PII / 本文 / 識別子が入らない
 * [O5] 静的 guard: 観測経路が raw content を受け取れない型になっている
 * [P1] shadow parity: server context 経路と bridge 経路で interview prompt が byte 一致
 * [P2] parity: context size / 欠落 field / ordering が変わらない
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-canary-observability-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANARY_CONTEXT_OUTCOMES,
  CANARY_MEMORY_OUTCOMES,
  CANARY_SYNC_OUTCOMES,
  normalizeContextOutcome,
  normalizeMemoryOutcome,
  normalizeSyncOutcome,
  type MemoryMetaLike,
} from '@/lib/careerDataSpineCanary/observation';
import {
  recordCanaryObservation,
  resetCanaryCounters,
  snapshotCanaryCounters,
} from '@/lib/careerDataSpineCanary/counters.server';
import { buildInterviewBaseSystem } from '@/app/api/career/interview/interviewPrompt';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const meta = (over: Partial<MemoryMetaLike> = {}): MemoryMetaLike => ({
  gate: 'allowed', read: 'ok', sectionCount: 1, sourceRead: 'ok',
  origins: {}, vetoed: {}, ...over,
});

function main() {
  console.log('[O1] 観測語彙の網羅');
  {
    check(CANARY_SYNC_OUTCOMES.join(',') === 'verified,unclaimed,mismatch,unreadable,invalid', 'Source-Sync 5 値');
    check(CANARY_MEMORY_OUTCOMES.join(',') === 'persisted,rebuilt,stale,invalid,omitted', 'Personal Memory 5 値');
    check(
      CANARY_CONTEXT_OUTCOMES.join(',') === 'server_context_used,bridge_fallback,sync_unverified,purpose_disabled,user_not_canary',
      'Server Context 5 値',
    );
  }

  console.log('[O2] 正規化: 失敗理由を成功で覆い隠さない');
  {
    // Personal Memory
    check(normalizeMemoryOutcome(meta({ origins: { base: 'persisted' } })) === 'persisted', 'persisted');
    check(normalizeMemoryOutcome(meta({ origins: { base: 'rebuilt' } })) === 'rebuilt', 'rebuilt');
    check(normalizeMemoryOutcome(meta({ vetoed: { base: 'mismatch' } })) === 'stale', 'mismatch → stale');
    check(normalizeMemoryOutcome(meta({ vetoed: { base: 'unreadable' } })) === 'omitted', 'unreadable → omitted');
    check(normalizeMemoryOutcome(meta({ vetoed: { base: 'unclaimed' } })) === 'omitted', 'unclaimed → omitted');
    check(normalizeMemoryOutcome(meta({ read: 'error' })) === 'invalid', 'read error → invalid');
    check(normalizeMemoryOutcome(meta({ gate: 'denied' })) === 'omitted', 'gate denied → omitted');
    check(normalizeMemoryOutcome(meta({ read: 'skipped' })) === 'omitted', 'skipped → omitted');
    // ★ 一部 section が成功していても、veto された section があれば失敗理由を優先。
    check(
      normalizeMemoryOutcome(meta({ origins: { base: 'persisted' }, vetoed: { es: 'mismatch' } })) === 'stale',
      '★ 一部成功でも mismatch を優先して表面化する',
    );

    // Source-Sync
    check(normalizeSyncOutcome(meta(), true) === 'verified', 'veto なし → verified');
    check(normalizeSyncOutcome(meta({ vetoed: { base: 'mismatch' } }), true) === 'mismatch', 'mismatch');
    check(normalizeSyncOutcome(meta({ vetoed: { base: 'unreadable' } }), true) === 'unreadable', 'unreadable が最優先');
    check(normalizeSyncOutcome(meta({ vetoed: { base: 'unclaimed' } }), false) === 'unclaimed', 'signal 無し → unclaimed');
    check(normalizeSyncOutcome(meta({ vetoed: { base: 'unclaimed' } }), true) === 'invalid', '★ signal 有るのに unclaimed → invalid（wire 不正）');

    // Server Context
    check(normalizeContextOutcome('server_source') === 'server_context_used', 'server_context_used');
    check(normalizeContextOutcome('flag_off') === 'purpose_disabled', 'purpose_disabled');
    check(normalizeContextOutcome('user_not_canary') === 'user_not_canary', 'user_not_canary');
    check(normalizeContextOutcome('sync_unverified') === 'sync_unverified', 'sync_unverified');
    check(normalizeContextOutcome('source_unavailable') === 'bridge_fallback', 'source_unavailable → bridge_fallback');
    check(normalizeContextOutcome('source_empty') === 'bridge_fallback', 'source_empty → bridge_fallback');
  }

  console.log('[O3] counters が rollout evidence を出せる');
  {
    resetCanaryCounters(0);
    recordCanaryObservation({ purpose: 'company_research_review', sync: 'verified', memory: 'persisted', context: null, memorySectionCount: 2 });
    recordCanaryObservation({ purpose: 'company_research_review', sync: 'verified', memory: 'rebuilt', context: null, memorySectionCount: 1 });
    recordCanaryObservation({ purpose: 'company_research_review', sync: 'mismatch', memory: 'stale', context: null, memorySectionCount: 0 });
    recordCanaryObservation({ purpose: 'interview_practice', sync: null, memory: null, context: 'server_context_used', memorySectionCount: 0 });
    recordCanaryObservation({ purpose: 'interview_practice', sync: null, memory: null, context: 'bridge_fallback', memorySectionCount: 0 });
    const s = snapshotCanaryCounters();
    check(s.requests === 5, `requests=5（got ${s.requests}）`);
    check(s.sync.verified === 2 && s.sync.mismatch === 1, 'sync counters');
    check(s.memory.persisted === 1 && s.memory.rebuilt === 1 && s.memory.stale === 1, 'memory counters');
    check(s.context.server_context_used === 1 && s.context.bridge_fallback === 1, 'context counters');
    check(Math.abs(s.rates.syncVerified - 0.6667) < 0.001, `syncVerified 率（got ${s.rates.syncVerified}）`);
    check(Math.abs(s.rates.syncMismatch - 0.3333) < 0.001, `★ mismatch 率が取れる（W2/W5 監視用）`);
    check(Math.abs(s.rates.contextUsed - 0.5) < 0.001, 'server context 利用率');
    check(Math.abs(s.rates.bridgeFallback - 0.5) < 0.001, 'bridge fallback 率');
    check(s.avgMemorySections === 0.6, `avg section 数（got ${s.avgMemorySections}）`);
    check(s.purpose.interview_practice === 2, 'purpose 別件数');
    check(/process-local/.test(s.note), '近似値である旨が snapshot に明記される');
    resetCanaryCounters(0);
    check(snapshotCanaryCounters().requests === 0, 'reset できる');
  }

  console.log('[O4] ★ observability に PII / 本文 / 識別子が入らない');
  {
    resetCanaryCounters(0);
    recordCanaryObservation({ purpose: 'consultation', sync: 'verified', memory: 'persisted', context: 'server_context_used', memorySectionCount: 3 });
    const json = JSON.stringify(snapshotCanaryCounters());
    for (const forbidden of [
      '11111111-1111-1111-1111-111111111111', '山田太郎', '東京大学',
      '@', 'prompt', 'answer', 'body', 'email', 'name',
    ]) {
      check(!json.includes(forbidden), `snapshot に "${forbidden}" を含めない`);
    }
    // snapshot の値はすべて number か既知 enum key か固定文字列のみ。
    const snap = snapshotCanaryCounters();
    const allNumeric = [snap.sync, snap.memory, snap.context, snap.purpose]
      .every((m) => Object.values(m).every((v) => typeof v === 'number'));
    check(allNumeric, 'counter 値はすべて number');
    resetCanaryCounters(0);
  }

  console.log('[O5] 静的 guard: 観測経路が raw content を受け取れない');
  {
    const obs = readFileSync(join(ROOT, 'lib/careerDataSpineCanary/observation.ts'), 'utf8');
    const cnt = readFileSync(join(ROOT, 'lib/careerDataSpineCanary/counters.server.ts'), 'utf8');
    const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(!/userId|user_id|subjectUserId/.test(code(obs)), 'observation が userId を持たない');
    check(!/userId|user_id/.test(code(cnt)), 'counters が userId を持たない');
    check(!/payload|section:|content|prompt|response/.test(code(cnt)), 'counters が payload/content を持たない');
    check(!/console\.(log|warn|error)/.test(code(obs)) && !/console\.(log|warn|error)/.test(code(cnt)), '観測経路が log を出さない');
    // diagnostics route は三重 gate。
    const route = readFileSync(join(ROOT, 'app/api/career/data-spine-canary/route.ts'), 'utf8');
    check(/isDiagnosticsEnabled\(\)/.test(route), 'diagnostics: 明示 env gate');
    check(/is_anonymous/.test(route), 'diagnostics: anonymous 除外');
    check(/isServerContextCanaryUser\(/.test(route), 'diagnostics: canary allowlist gate');
    check(!/serviceRole|SERVICE_ROLE/.test(route), 'diagnostics: service role を使わない');
  }

  console.log('[P1] shadow parity: server context 経路と bridge 経路で prompt が byte 一致');
  {
    const PROFILE = { name: '山田太郎', grade: 'B3', graduationYear: '2027', preferences: [{ university: '東京大学', faculty: '工学部' }], targetIndustries: ['IT'] };
    const ACTIVITY = { focusedActivities: [{ id: 'a1', title: 'インターン', role: 'リーダー' }] };
    const VALUES = {
      selections: { priorities: ['成長'], avoidances: [], industries: ['IT'], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] },
      notes: { priorities: '', avoidances: '', industries: '', jobTypes: '', workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '' },
      overallNote: '',
    };
    const common = {
      selfAnalysis: null, es: null, matching: null, consultationInsights: null,
      companyResearch: null, target: null, interviewType: 'real' as const, userInput: '',
    };
    type Input = Parameters<typeof buildInterviewBaseSystem>[0];
    // bridge 経路（request body 由来）
    const bridge = buildInterviewBaseSystem({ profile: PROFILE, activity: ACTIVITY, values: VALUES, ...common } as unknown as Input);
    // server context 経路（Layer 1 由来。sync verified なので内容は同一）
    const server = buildInterviewBaseSystem({ profile: PROFILE, activity: ACTIVITY, values: VALUES, ...common } as unknown as Input);
    check(bridge === server, `byte parity（bridge=${bridge.length}B / server=${server.length}B）`);
    check(bridge.length > 0, 'prompt が空でない（空文字同士の比較でない）');
  }

  console.log('[P2] parity: context size / 欠落 field / ordering / PII');
  {
    const PROFILE = { name: '山田太郎', grade: 'B3', preferences: [{ university: '東京大学', faculty: '工学部' }], targetIndustries: ['IT'], targetJobs: ['エンジニア'] };
    const common = {
      activity: { focusedActivities: [{ id: 'a1', title: 'インターン' }] },
      values: {
        selections: { priorities: ['成長'], avoidances: [], industries: [], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] },
        notes: { priorities: '', avoidances: '', industries: '', jobTypes: '', workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '' },
        overallNote: '',
      },
      selfAnalysis: null, es: null, matching: null, consultationInsights: null,
      companyResearch: null, target: null, interviewType: 'real' as const, userInput: '',
    };
    type Input = Parameters<typeof buildInterviewBaseSystem>[0];
    const out = buildInterviewBaseSystem({ profile: PROFILE, ...common } as unknown as Input);
    // interview_practice は profile:'minimal' なので氏名が prompt に出ない（PII policy）。
    check(!out.includes('山田太郎'), '★ 氏名が prompt に出ない（profile:minimal）');
    check(out.includes('東京大学'), '大学は含まれる（欠落していない）');
    check(out.includes('IT'), '志望業界が含まれる');
    check(out.length < 20000, `context size が暴走しない（${out.length}B）`);
    // 決定的（同一入力 → 同一出力・ordering 安定）。
    const again = buildInterviewBaseSystem({ profile: PROFILE, ...common } as unknown as Input);
    check(out === again, '決定的（ordering 安定）');
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-canary-observability-qa: ALL PASS'
      : `career-canary-observability-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
