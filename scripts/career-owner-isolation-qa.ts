/*
 * scripts/career-owner-isolation-qa.ts
 *
 * PASSAI CAREER — canonical storage の所有者隔離（account switch）QA。
 *
 * 背景（修正した defect）:
 *   career の canonical は端末 localStorage だが、キーが全アカウント共通だった。
 *   A → logout → B login の端末で A のデータが B に見え、さらに backfillCareerOnce が
 *   **A のデータを B の userId で Supabase へ upload** し得た。RLS は user_id=B の書き込みを
 *   正当と見なすため RLS では防げない（client 側に所有者境界が無いことが原因）。
 *
 * 検証項目（§27 の Case 1–10 に対応）:
 *   1. guest 単独
 *   2. guest → 初回 member login（legacy claim）
 *   3. member 通常利用（自分の名前空間だけを読み書き）
 *   4. A logout → A 再ログイン（自分のデータが戻る）
 *   5. A logout → B login（A のデータが B から見えない）
 *   6. backfill payload の所有者（A の行が B の payload に 0 件）
 *   7. restore（B local + B remote のみ。A local が混ざらない）
 *   8. A / B 同一端末で両方の名前空間が独立に残る
 *   9. 所有者切替の通知（in-memory view が読み直せる）
 *  10. legacy global key の安全な移行方針（帰属不明なら移さない）
 *   +  キー登録漏れ検出（storage module の実キーと registry の突き合わせ）
 *
 * 使い方: npx tsx scripts/career-owner-isolation-qa.ts
 * 終了コード: 全 assertion pass → 0 / 1 件でも失敗 → 1。
 */

// ── 最小 localStorage / window polyfill（既存 storage QA と同方式・import より前に置く）──
const store = new Map<string, string>();
const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
g.window = {};
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
};
// @supabase/ssr の createBrowserClient は cookie 経由で session を持つ。実 DB へは
// 一切繋がない（下で env をダミーにし fetch を差し替える）が、生成自体は通す必要がある。
(g as { document?: unknown }).document = { cookie: '' };
// ★ 実 Supabase へ接続しないためのダミー env。実プロジェクトの URL/key は使わない。
process.env.NEXT_PUBLIC_CAREER_SUPABASE_URL = 'http://127.0.0.1:9/qa-fake';
process.env.NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY = 'qa-fake-anon-key';

import { readFileSync } from 'node:fs';

import {
  CAREER_GUEST_OWNER,
  careerStorageKeyFor,
  getCareerStorageOwner,
  resetCareerStorageOwnerCacheForTest,
  setCareerStorageOwner,
  subscribeCareerStorageOwner,
} from '@/lib/careerStorage/owner';
import {
  CAREER_LEGACY_CLAIM_EXCLUDED_KEYS,
  CAREER_OWNED_STORAGE_KEYS,
} from '@/lib/careerStorage/keys';
import {
  claimLegacyCareerDataOnce,
  countOtherCareerAccountsOnDevice,
} from '@/lib/careerStorage/legacyClaim';
import { loadEsLogs, saveEsLogs } from '@/app/career/es/esStorage';
import {
  loadInterviewResults,
  saveInterviewResults,
} from '@/app/career/interview/interviewStorage';
import {
  loadSelfAnalysisLogs,
  saveSelfAnalysisLogs,
} from '@/app/career/self-analysis/selfAnalysisStorage';
import type { CareerEsLog } from '@/types/careerEs';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

function resetDevice(): void {
  store.clear();
  resetCareerStorageOwnerCacheForTest();
  setCareerStorageOwner(null);
}

function esLog(id: string): CareerEsLog {
  return { id, createdAt: '2026-08-01T00:00:00.000Z', userInput: '', result: {} as CareerEsLog['result'] };
}

function ids(logs: { id: string }[]): string {
  return logs.map((l) => l.id).sort().join(',');
}

/** backfill が実際に読む loader（lib/repository/careerBackfill.ts と同じ入口）。 */
function backfillPayloadForCurrentOwner() {
  return {
    es: loadEsLogs(),
    interview: loadInterviewResults(),
    selfAnalysis: loadSelfAnalysisLogs(),
  };
}

// ── Case 1: guest 単独 ──────────────────────────────────────────────

section('Case 1 — guest only');
{
  resetDevice();
  saveEsLogs([esLog('guest-1')]);
  check('1a guest は自分のデータを読める', ids(loadEsLogs()) === 'guest-1');
  check('1b guest は従来キー（互換）に書く', store.has('careerEsLogs'));
  check('1c guest owner は member ではない', getCareerStorageOwner().kind === 'guest');
}

// ── Case 2: guest → A 初回 login（legacy claim）────────────────────

section('Case 2 — guest → member 引き継ぎ');
{
  resetDevice();
  saveEsLogs([esLog('made-as-guest')]);

  setCareerStorageOwner(USER_A);
  const outcome = claimLegacyCareerDataOnce(USER_A);
  check('2a 他 account の履歴が無い端末なので claim される', outcome.kind === 'claimed');
  check('2b A は guest 時代のデータを引き継ぐ', ids(loadEsLogs()) === 'made-as-guest');
  check('2c legacy キーは移動済み（残さない）', !store.has('careerEsLogs'));
  check('2d A の名前空間キーへ入っている', store.has(`careerEsLogs::u:${USER_A}`));

  // 二重帰属の防止: A が取り込んだ後に B が login しても同じ guest data は残っていない
  setCareerStorageOwner(USER_B);
  const second = claimLegacyCareerDataOnce(USER_B);
  check('2e 同じ guest data を 2 人目が再取り込みしない', second.kind === 'skipped_no_legacy');
  check('2f B から A のデータは見えない', loadEsLogs().length === 0);
}

// ── Case 3 / 4: member 通常利用と再ログイン ─────────────────────────

section('Case 3/4 — member 通常利用・同一ユーザー再ログイン');
{
  resetDevice();
  setCareerStorageOwner(USER_A);
  saveEsLogs([esLog('a-1'), esLog('a-2')]);
  saveInterviewResults([]);
  check('3a A の書き込みは A の名前空間へ', store.has(`careerEsLogs::u:${USER_A}`));
  check('3b legacy キーを汚さない', !store.has('careerEsLogs'));

  setCareerStorageOwner(null); // logout
  check('4a logout 後 guest からは A のデータが見えない', loadEsLogs().length === 0);
  check('4b logout でも A のデータは削除されない', store.has(`careerEsLogs::u:${USER_A}`));

  setCareerStorageOwner(USER_A); // 再ログイン
  check('4c A が再ログインすると自分のデータが戻る', ids(loadEsLogs()) === 'a-1,a-2');
}

// ── Case 5 / 8: A → logout → B ─────────────────────────────────────

section('Case 5/8 — A logout → B login');
{
  resetDevice();
  setCareerStorageOwner(USER_A);
  saveEsLogs([esLog('a-1')]);
  saveInterviewResults([
    { id: 'a-iv', createdAt: '2026-08-01T00:00:00.000Z', mode: 'voice', turns: [], result: {} as never },
  ]);
  saveSelfAnalysisLogs([{ id: 'a-sa', createdAt: '2026-08-01T00:00:00.000Z', userInput: '', result: {} as never }]);

  setCareerStorageOwner(null);
  setCareerStorageOwner(USER_B);

  check('5a B に A の ES が見えない', loadEsLogs().length === 0);
  check('5b B に A の面接結果が見えない', loadInterviewResults().length === 0);
  check('5c B に A の自己分析が見えない', loadSelfAnalysisLogs().length === 0);
  check('5d B が空でも legacy/A へ fallback しない', !store.has('careerEsLogs'));

  saveEsLogs([esLog('b-1')]);
  check('8a A / B の名前空間が同一端末で独立に残る',
    store.has(`careerEsLogs::u:${USER_A}`) && store.has(`careerEsLogs::u:${USER_B}`));
  check('8b B から見えるのは B のみ', ids(loadEsLogs()) === 'b-1');

  setCareerStorageOwner(USER_A);
  check('8c A へ戻すと A のみ', ids(loadEsLogs()) === 'a-1');
}

// ── Case 6: backfill payload の所有者（最重要）──────────────────────

section('Case 6 — backfill payload ownership');
{
  resetDevice();
  setCareerStorageOwner(USER_A);
  saveEsLogs([esLog('a-1'), esLog('a-2')]);
  saveInterviewResults([
    { id: 'a-iv', createdAt: '2026-08-01T00:00:00.000Z', mode: 'voice', turns: [], result: {} as never },
  ]);
  saveSelfAnalysisLogs([{ id: 'a-sa', createdAt: '2026-08-01T00:00:00.000Z', userInput: '', result: {} as never }]);

  // B が login。backfill は「現在の所有者の canonical」だけを読む。
  setCareerStorageOwner(USER_B);
  const payload = backfillPayloadForCurrentOwner();
  const all = [...payload.es, ...payload.interview, ...payload.selfAnalysis];
  check('6a B の backfill payload に A の行が 0 件', all.length === 0, `got ${ids(all)}`);
  check('6b A の行が 1 件も混ざらない（id 突き合わせ）',
    !all.some((r) => r.id.startsWith('a-')));

  // B 自身のデータを作ると B の分だけが payload になる
  saveEsLogs([esLog('b-1')]);
  const payload2 = backfillPayloadForCurrentOwner();
  check('6c B の payload は B の行のみ',
    ids(payload2.es) === 'b-1' && !ids(payload2.es).includes('a-'));
}

// ── Case 7: restore の merge 相手 ──────────────────────────────────

section('Case 7 — restore merge boundary');
{
  resetDevice();
  setCareerStorageOwner(USER_A);
  saveEsLogs([esLog('a-local')]);

  setCareerStorageOwner(USER_B);
  // restore は `loadEsLogs()`（＝現所有者の local）と remote を merge して保存する。
  // ここでは careerRestore.ts と同じ形（mergeById 相当）を loader 越しに再現する。
  const bLocalBefore = loadEsLogs();
  const bRemote = [esLog('b-remote')];
  const merged = [...bLocalBefore, ...bRemote.filter((r) => !bLocalBefore.some((l) => l.id === r.id))];
  saveEsLogs(merged);

  check('7a restore の local 側に A が入らない', !ids(bLocalBefore).includes('a-local'));
  check('7b restore 後も B は B のみ', ids(loadEsLogs()) === 'b-remote');
  setCareerStorageOwner(USER_A);
  check('7c A の canonical は restore に巻き込まれていない', ids(loadEsLogs()) === 'a-local');
}

// ── Case 9: 所有者切替の通知（in-memory 隔離）──────────────────────

section('Case 9 — owner change notification');
{
  resetDevice();
  let notified = 0;
  const unsubscribe = subscribeCareerStorageOwner(() => {
    notified++;
  });
  setCareerStorageOwner(USER_A);
  check('9a 所有者確定で通知される', notified === 1);
  setCareerStorageOwner(USER_A);
  check('9b 同じ所有者では通知しない（無駄な再読込を作らない）', notified === 1);
  setCareerStorageOwner(USER_B);
  check('9c 別 account へ切替で通知される', notified === 2);
  setCareerStorageOwner(null);
  check('9d logout でも通知される', notified === 3);
  unsubscribe();
  setCareerStorageOwner(USER_A);
  check('9e unsubscribe 後は通知しない', notified === 3);
}

// ── Case 10: legacy global key の安全な移行方針 ────────────────────

section('Case 10 — legacy global key policy');
{
  // 10-1: 他 account の career 利用履歴がある端末 → 移行しない
  resetDevice();
  saveEsLogs([esLog('ambiguous')]); // legacy（guest キー）
  store.set(
    'supabaseBackfill',
    JSON.stringify({ [USER_A]: { careerEs: { version: 1, at: '2026-08-01T00:00:00.000Z' } } }),
  );
  setCareerStorageOwner(USER_B);
  const ambiguous = claimLegacyCareerDataOnce(USER_B);
  check('10a 他 account 履歴がある端末では claim しない', ambiguous.kind === 'skipped_ambiguous');
  check('10b 帰属不明 legacy は B に見えない', loadEsLogs().length === 0);
  check('10c 帰属不明 legacy は削除もしない', store.has('careerEsLogs'));
  check('10d 他 account 数を数えられる', countOtherCareerAccountsOnDevice(USER_B) === 1);

  // 10-2: 受験版 feature しか無い userId は career 所有者として数えない
  resetDevice();
  saveEsLogs([esLog('exam-only-device')]);
  store.set(
    'supabaseBackfill',
    JSON.stringify({ [USER_A]: { tutor: { version: 1, at: '2026-08-01T00:00:00.000Z' } } }),
  );
  setCareerStorageOwner(USER_B);
  check('10e 受験版のみの userId は career account として数えない',
    countOtherCareerAccountsOnDevice(USER_B) === 0);
  check('10f そのため claim できる', claimLegacyCareerDataOnce(USER_B).kind === 'claimed');

  // 10-3: 既に自分の名前空間がある場合は上書きしない
  resetDevice();
  setCareerStorageOwner(USER_A);
  saveEsLogs([esLog('mine')]);
  store.set('careerEsLogs', JSON.stringify([esLog('legacy')]));
  check('10g 自分の名前空間がある場合は claim しない',
    claimLegacyCareerDataOnce(USER_A).kind === 'skipped_already_owned');
  check('10h 既存データは上書きされない', ids(loadEsLogs()) === 'mine');

  // 10-4: ES draft は移行対象外（guest draft を member 側で見えなくしない）
  resetDevice();
  store.set('careerEsDrafts', JSON.stringify([{ id: 'd1', ownerId: null }]));
  store.set('careerEsLogs', JSON.stringify([esLog('log1')]));
  setCareerStorageOwner(USER_A);
  const claimed = claimLegacyCareerDataOnce(USER_A);
  check('10i draft は移行対象から除外される',
    claimed.kind === 'claimed' && !claimed.keys.includes('careerEsDrafts'));
  check('10j guest draft は guest 側に残る', store.has('careerEsDrafts'));
}

// ── 登録漏れ検出（storage module の実キー vs registry）──────────────

section('key registry coverage');
{
  const FILES = [
    'app/career/profile/profileStorage.ts',
    'app/career/activity/activityStorage.ts',
    'app/career/values/careerValuesStorage.ts',
    'app/career/self-analysis/selfAnalysisStorage.ts',
    'app/career/es/esStorage.ts',
    'app/career/es/esDraftStorage.ts',
    'app/career/interview/interviewStorage.ts',
    'app/career/presentation/presentationStorage.ts',
    'app/career/matching/matchingStorage.ts',
    'app/career/company-research/companyResearchStorage.ts',
    'app/career/consultation/consultationStorage.ts',
    'app/career/gd/gdStorage.ts',
    'app/career/gd/gdRoomLogStorage.ts',
    'app/career/company/applicationStorage.ts',
    'app/career/company/companyDirectory.ts',
  ];
  const used = new Set<string>();
  for (const f of FILES) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/careerStorageKey\('([^']+)'\)/g)) used.add(m[1]);
  }
  const registry = new Set<string>(CAREER_OWNED_STORAGE_KEYS);
  const missing = [...used].filter((k) => !registry.has(k));
  const stale = [...registry].filter((k) => !used.has(k));
  check('R1 storage module の全キーが registry にある', missing.length === 0, missing.join(','));
  check('R2 registry に未使用キーが無い', stale.length === 0, stale.join(','));
  check('R3 除外キーは registry の部分集合',
    CAREER_LEGACY_CLAIM_EXCLUDED_KEYS.every((k) => registry.has(k)));

  // guest キーは従来どおり（既存 QA harness / 互換のため）
  check('R4 guest キーは suffix 無し（従来互換）',
    careerStorageKeyFor(CAREER_GUEST_OWNER, 'careerEsLogs') === 'careerEsLogs');
  check('R5 member キーは guest / UUID と衝突しない',
    careerStorageKeyFor({ kind: 'member', userId: USER_A }, 'careerEsLogs') ===
      `careerEsLogs::u:${USER_A}`);
}

// ── raw localStorage 直アクセスが career に無いこと ────────────────

section('central seam');
{
  const src = FILE_SOURCES();
  const offenders = src.filter(([, body]) => /localStorage\.(get|set|remove)Item/.test(body));
  check('S1 career の storage module は safeStorage 経由のみ（直アクセス無し）',
    offenders.length === 0, offenders.map(([f]) => f).join(','));
}

function FILE_SOURCES(): [string, string][] {
  const files = [
    'app/career/es/esStorage.ts',
    'app/career/interview/interviewStorage.ts',
    'app/career/presentation/presentationStorage.ts',
    'app/career/self-analysis/selfAnalysisStorage.ts',
    'app/career/gd/gdStorage.ts',
  ];
  return files.map((f) => [f, readFileSync(f, 'utf8')] as [string, string]);
}

// ── Case 6b: 実 backfillCareerOnce の送信 payload を捕捉して所有者を検証 ──────
//
// §28: 「B の画面に A が見えない」だけでは不十分。**実際に Supabase へ送られる行**に
// A のデータが 1 件も含まれないことを固定する。
// 実 orchestration（lib/repository/careerBackfill.ts）→ 実 mirror module → 実 row mapper
// を通し、HTTP 層（fetch）で body を捕捉する。実 DB へは接続しない（ダミー env + stub fetch）。

async function runBackfillPayloadCase(): Promise<void> {
  section('Case 6b — 実 backfill の送信 payload 所有者検証');
  {
    type Captured = { url: string; body: string };
    const captured: Captured[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      captured.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;

    try {
      const { backfillCareerOnce } = await import('@/lib/repository/careerBackfill');

      resetDevice();
      // A が同じ端末で作った canonical
      setCareerStorageOwner(USER_A);
      saveEsLogs([esLog('a-secret-1'), esLog('a-secret-2')]);
      saveSelfAnalysisLogs([
        { id: 'a-secret-sa', createdAt: '2026-08-01T00:00:00.000Z', userInput: '', result: {} as never },
      ]);

      // B が login して backfill が走る
      setCareerStorageOwner(USER_B);
      saveEsLogs([esLog('b-own-1')]);
      captured.length = 0;
      await backfillCareerOnce({ userId: USER_B });

      const allBodies = captured.map((c) => c.body).join('\n');
      check('6b-1 backfill が実際に送信を行った（no-op ではない）', captured.length > 0);
      check('6b-2 送信 payload に A の行が 1 件も含まれない',
        !allBodies.includes('a-secret'), `captured ${captured.length} requests`);
      check('6b-3 送信 payload の user_id は B のみ',
        allBodies.includes(USER_B) && !allBodies.includes(USER_A));
      check('6b-4 B 自身の行はちゃんと送られる', allBodies.includes('b-own-1'));

      // 名前空間導入前の legacy（共有キー）が端末に残っていても、B として upload しない
    //   ＝ 修正前の defect（共有キーを現ユーザーの行として upload）そのものを固定する。
    resetDevice();
    store.set(
      'careerEsLogs',
      JSON.stringify([{ id: 'legacy-not-mine', createdAt: '2026-08-01T00:00:00.000Z', userInput: '', result: {} }]),
    );
    store.set(
      'supabaseBackfill',
      JSON.stringify({ [USER_A]: { careerEs: { version: 1, at: '2026-08-01T00:00:00.000Z' } } }),
    );
    setCareerStorageOwner(USER_B);
    claimLegacyCareerDataOnce(USER_B); // 帰属不明なので移行されない
    captured.length = 0;
    await backfillCareerOnce({ userId: USER_B });
    const legacyBodies = captured.map((c) => c.body).join('\n');
    check('6b-6 帰属不明 legacy を B として upload しない',
      !legacyBodies.includes('legacy-not-mine'));

    // 逆向き: A で backfill すれば A の行だけが出る
    resetDevice();
    setCareerStorageOwner(USER_A);
    saveEsLogs([esLog('a-secret-1')]);
    setCareerStorageOwner(USER_B);
    saveEsLogs([esLog('b-own-1')]);
      setCareerStorageOwner(USER_A);
      captured.length = 0;
      await backfillCareerOnce({ userId: USER_A });
      const aBodies = captured.map((c) => c.body).join('\n');
      check('6b-5 A の backfill は A の行のみ（B が混ざらない）',
        aBodies.includes('a-secret') && !aBodies.includes('b-own-1'));
    } finally {
      globalThis.fetch = realFetch;
    }
  }

}

runBackfillPayloadCase()
  .catch((err) => {
    failures++;
    console.error('  FAIL Case 6b が例外で中断', err);
  })
  .finally(() => {
    console.log(`\n結果: PASS ${passes} / FAIL ${failures}`);
    process.exit(failures > 0 ? 1 : 0);
  });
