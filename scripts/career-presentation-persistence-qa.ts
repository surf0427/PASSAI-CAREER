/*
 * scripts/career-presentation-persistence-qa.ts
 *
 * PASSAI CAREER — 発表途中の文字起こし保全 QA（dev-only 常設・決定的）。
 *
 * 目的（Production Readiness Audit P1-2 の回帰ガード）:
 *   発表中の transcript が React state だけに存在し、リロード / タブ復帰 /
 *   モバイルのバックグラウンド破棄で消えていた問題を、二度と作らないよう固定する。
 *
 *   1. canonical storage helper（upsertPresentationSession）で in_progress の
 *      transcript / durationSec を保存・復元できること（round-trip）。
 *   2. session ページが「復元 → debounce 保存 → 離脱時 flush → 完了後は書かない」
 *      という契約で実装されていること（センチネル）。
 *   3. 評価完了フロー（completed / result 追記）を壊していないこと。
 *
 *   外部 AI 非実行・Supabase 非接続（localStorage を in-memory stub で再現する）。
 *
 * 使い方: npx tsx scripts/career-presentation-persistence-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── localStorage stub（storage helper を実行するため import より前に置く）──
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}
const memory = new MemoryStorage();
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = memory;

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  upsertPresentationSession,
  getInProgressPresentationSession,
  loadPresentationSessions,
  appendPresentationResult,
  loadPresentationResults,
  savePresentationSessions,
  savePresentationResults,
} = require('@/app/career/presentation/presentationStorage') as typeof import('@/app/career/presentation/presentationStorage');
/* eslint-enable @typescript-eslint/no-require-imports */

import type {
  CareerPresentationResult,
  CareerPresentationSession,
} from '@/types/careerPresentation';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};
const section = (t: string) => console.log(`\n── ${t} ──`);

const baseSession = (): CareerPresentationSession => ({
  id: 'sess-1',
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  status: 'in_progress',
  presentationType: 'real',
  mode: 'voice',
  config: { companyName: 'テスト株式会社', jobType: '営業' },
  theme: '自分の強みを3分で',
  timeLimitSec: 180,
  durationSec: 0,
  transcript: '',
});

// ════════════════════════════════════════════════════════════════════
section('A. in-progress transcript の保存 → 復元（round-trip）');

memory.clear();
savePresentationSessions([]);
savePresentationResults([]);

const s0 = baseSession();
upsertPresentationSession(s0);
check(getInProgressPresentationSession()?.transcript === '', '開始直後は空の文字起こし');

// 発表中の debounce 保存に相当する書き込み。
upsertPresentationSession({
  ...s0,
  transcript: 'まず結論から申し上げます。',
  durationSec: 12,
  updatedAt: '2026-08-18T00:00:12.000Z',
});
upsertPresentationSession({
  ...s0,
  transcript: 'まず結論から申し上げます。私の強みは巻き込み力です。',
  durationSec: 31,
  updatedAt: '2026-08-18T00:00:31.000Z',
});

// ★ リロード相当（state を捨てて localStorage から読み直す）。
const restored = getInProgressPresentationSession();
check(
  restored?.transcript === 'まず結論から申し上げます。私の強みは巻き込み力です。',
  'リロード後も文字起こしが復元される（P1-2 の中核）',
);
check(restored?.durationSec === 31, 'リロード後も経過時間が復元される');
check(restored?.status === 'in_progress', '復元されたセッションは in_progress のまま');
check(restored?.theme === s0.theme, 'お題は保持される');
check(restored?.config?.companyName === 'テスト株式会社', 'config（選考文脈）は保持される');
check(loadPresentationSessions().length === 1, 'debounce 保存で行が増殖しない（id upsert）');

// ════════════════════════════════════════════════════════════════════
section('B. 評価完了フローの回帰（completed / result 追記を壊していない）');

const completed: CareerPresentationSession = {
  ...(restored as CareerPresentationSession),
  status: 'completed',
  durationSec: 45,
  transcript: 'まず結論から申し上げます。私の強みは巻き込み力です。以上です。',
  updatedAt: '2026-08-18T00:00:45.000Z',
};
upsertPresentationSession(completed);

check(getInProgressPresentationSession() === null, '完了後は in_progress セッションが無い');
check(loadPresentationSessions()[0].status === 'completed', 'セッションは completed になる');
check(loadPresentationSessions().length === 1, '完了で行が増えない（同 id を置換）');

const resultLog: CareerPresentationResult = {
  id: completed.id,
  createdAt: '2026-08-18T00:00:46.000Z',
  presentationType: completed.presentationType,
  config: completed.config,
  mode: completed.mode,
  theme: completed.theme,
  timeLimitSec: completed.timeLimitSec,
  durationSec: completed.durationSec,
  transcript: completed.transcript,
  result: {
    totalScore: 72,
    rank: 'B',
    overallComment: '',
    axes: [],
    goodPoints: [],
    improvements: [],
    priorityImprovements: [],
    nextPractice: [],
    expectedQuestions: [],
    improvedStructure: [],
    passLikelihood: '',
    companyFit: '',
    interviewerConcerns: [],
  },
};
appendPresentationResult(resultLog);
check(loadPresentationResults().length === 1, '評価結果が履歴へ追記される');
check(loadPresentationResults()[0].transcript === completed.transcript, '確定 transcript が結果に残る');

// ════════════════════════════════════════════════════════════════════
section('C. 中断 → 再開（別セッションが混ざらない）');

memory.clear();
savePresentationSessions([]);
const older: CareerPresentationSession = { ...baseSession(), id: 'old', transcript: '古い発表' };
upsertPresentationSession(older);
const newer: CareerPresentationSession = { ...baseSession(), id: 'new', transcript: '新しい発表' };
upsertPresentationSession(newer);
check(
  getInProgressPresentationSession()?.id === 'new',
  '中断中セッションが複数あっても最新を再開する',
);
check(
  getInProgressPresentationSession()?.transcript === '新しい発表',
  '再開時に別セッションの文字起こしを拾わない',
);

// ════════════════════════════════════════════════════════════════════
section('D. session ページの実装契約（センチネル）');

const page = read('app/career/presentation/session/page.tsx');

check(
  /useState<string>\(\(\) => session\?\.transcript \?\? ''\)/.test(page),
  '初期 transcript を in_progress セッションから復元している',
);
check(
  /useState<number>\(\(\) => session\?\.durationSec \?\? 0\)/.test(page),
  '初期 elapsed を in_progress セッションから復元している',
);
check(page.includes('DRAFT_SAVE_DEBOUNCE_MS'), 'debounce 定数が定義されている');
check(
  /setTimeout\(persistDraft, DRAFT_SAVE_DEBOUNCE_MS\)/.test(page),
  '文字起こしの保存は debounce される（write 連打しない）',
);
check(
  page.includes("window.addEventListener('pagehide', flush)"),
  'pagehide で未保存分を flush する（モバイルのタブ破棄対策）',
);
check(
  page.includes("document.addEventListener('visibilitychange', flush)"),
  'visibilitychange で未保存分を flush する（アプリ切替対策）',
);
check(
  /finishedRef\.current = true;\s*\n\s*upsertPresentationSession\(completed\)/.test(page),
  '完了確定後は draft を書かない門が completed 書き込みの直前にある',
);
check(
  /if \(finishedRef\.current \|\| !session\) return;/.test(page),
  'persistDraft は完了後 no-op（completed を in_progress で上書きしない）',
);
check(
  page.includes('upsertPresentationSession') && !page.includes('localStorage.setItem'),
  'canonical helper のみを使う（専用ストレージを作っていない）',
);

// ★ 発表中の draft を Supabase へ毎回送っていないこと（mirror は評価確定時のみ）。
const draftBlock = page.slice(page.indexOf('const persistDraft'), page.indexOf('const handleEvaluate'));
check(
  !draftBlock.includes('upsertCareerPresentationSessionsToSupabase'),
  'draft 保存では Supabase へ送らない（mirror は評価確定時の 1 回だけ）',
);

// ════════════════════════════════════════════════════════════════════
console.log(`\n${fails === 0 ? '✅ PASS' : `❌ FAIL (${fails})`}`);
process.exit(fails === 0 ? 0 : 1);
