/*
 * scripts/career-mirror-write-ordering-qa.ts
 *
 * PASSAI CAREER — Layer 1 mirror write ordering / stale-write QA（hardening 2026-08-14 / `D-S3`）。
 *   dev-only・DI fake・実 Supabase 非接続。
 *
 * ★ 本 QA の目的は「安全である」と主張することではなく、
 *   **実際の write 契約を正確に pin し、過大主張を防ぐ** こと。
 *   防げているものは防げていると、防げていないものは防げていないと固定する。
 *
 * W1 normal forward write        — 直列化しても通常の前進 write は通る
 * W2 stale device write          — ★別端末の stale write は **防げない**（mirror が巻き戻る）ことを pin
 * W3 concurrent write            — 同一端末の同時 write は直列化され重ならない
 * W4 delayed network response    — ★遅延応答で古い payload が最後に適用されない（D-S3 で修正済み）
 * W5 multi-device reopen         — 単一レコード系は上書き / 履歴系は client_id merge であることを pin
 *
 * さらに:
 *   [S1] 実 writer が直列化キューを通っている（静的 guard・回帰防止）
 *   [S2] 履歴系 upsert は行を削除しない（set が縮まない）ことをコード契約として pin
 *   [S3] mirror が巻き戻っても **read 側は veto される**（write 整合性 ≠ read 安全性の分離）
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-mirror-write-ordering-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  enqueueLatestMirrorWrite,
  mirrorWriteKey,
  __resetMirrorWriteQueueForTest,
} from '@/lib/careerSourceData/mirrorWriteQueue';
import { computeSourceSyncRevisions } from '@/lib/careerSourceSync/revision';
import {
  parseSourceSyncSignal,
  serializeSourceSyncSignal,
  verifySourceSync,
  allSourcesVerified,
} from '@/lib/careerSourceSync/signal';
import {
  EMPTY_CAREER_SOURCE_BUNDLE,
  emptySourceStatuses,
  type CareerSourceBundle,
} from '@/lib/careerSourceData/types';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const UID = '11111111-1111-1111-1111-111111111111';
const OTHER = '99999999-9999-9999-9999-999999999999';
const KEY = mirrorWriteKey('career_profiles', UID);

/** 遅延を制御できる fake mirror（適用順を記録する）。 */
function makeFakeMirror() {
  const applied: string[] = [];
  let value = 'rev0';
  const write = (payload: string, delayMs: number) => async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    value = payload;
    applied.push(payload);
  };
  return { write, applied, get current() { return value; } };
}

async function main() {
  console.log('[W1] normal forward write — 直列化しても前進 write は通る');
  {
    __resetMirrorWriteQueueForTest();
    const m = makeFakeMirror();
    await enqueueLatestMirrorWrite(KEY, m.write('rev10', 0));
    check(m.current === 'rev10', `mirror = rev10（got ${m.current}）`);
    check(m.applied.join(',') === 'rev10', '1 回だけ適用される');
  }

  console.log('[W3] concurrent write — 同一端末の write は直列化され重ならない');
  {
    __resetMirrorWriteQueueForTest();
    let inFlight = 0;
    let maxInFlight = 0;
    const run = (ms: number) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
    };
    await Promise.all([
      enqueueLatestMirrorWrite(KEY, run(20)),
      enqueueLatestMirrorWrite(KEY, run(5)),
      enqueueLatestMirrorWrite(KEY, run(1)),
    ]);
    check(maxInFlight === 1, `同時実行が 1 を超えない（max=${maxInFlight}）`);
  }

  console.log('[W4] ★ delayed network response — 古い payload が最後に適用されない');
  {
    __resetMirrorWriteQueueForTest();
    const m = makeFakeMirror();
    // rev10 は遅い、rev11 は速い。直列化前は「rev11 → rev10」の順で適用され巻き戻っていた。
    const p1 = enqueueLatestMirrorWrite(KEY, m.write('rev10', 30));
    const p2 = enqueueLatestMirrorWrite(KEY, m.write('rev11', 1));
    await Promise.all([p1, p2]);
    check(m.current === 'rev11', `★ 最終状態が最新 payload（got ${m.current}）`);
    check(
      m.applied[m.applied.length - 1] === 'rev11',
      `最後に適用されたのが rev11（applied=${m.applied.join(',')}）`,
    );
  }

  console.log('[W4b] coalescing — 待機中の古い全文書 write は最新へ畳まれる');
  {
    __resetMirrorWriteQueueForTest();
    const m = makeFakeMirror();
    const p1 = enqueueLatestMirrorWrite(KEY, m.write('revA', 20)); // 実行開始
    const p2 = enqueueLatestMirrorWrite(KEY, m.write('revB', 0));  // 待機
    const p3 = enqueueLatestMirrorWrite(KEY, m.write('revC', 0));  // revB を supersede
    await Promise.all([p1, p2, p3]);
    check(m.current === 'revC', `最終状態 = revC（got ${m.current}）`);
    check(!m.applied.includes('revB'), 'superseded な revB は実行されない（無駄な write を出さない）');
    check(m.applied.join(',') === 'revA,revC', `適用順 = revA,revC（got ${m.applied.join(',')}）`);
  }

  console.log('[W4c] user 分離 — 別 user の write を coalesce しない');
  {
    __resetMirrorWriteQueueForTest();
    const a = makeFakeMirror();
    const b = makeFakeMirror();
    await Promise.all([
      enqueueLatestMirrorWrite(mirrorWriteKey('career_profiles', UID), a.write('userA', 5)),
      enqueueLatestMirrorWrite(mirrorWriteKey('career_profiles', OTHER), b.write('userB', 0)),
    ]);
    check(a.current === 'userA' && b.current === 'userB', '別 user は独立に適用される');
    check(mirrorWriteKey('career_profiles', UID) !== mirrorWriteKey('career_profiles', OTHER), 'key が user を含む');
  }

  console.log('[W4d] never-throw — run が throw しても後続を止めない');
  {
    __resetMirrorWriteQueueForTest();
    const m = makeFakeMirror();
    const p1 = enqueueLatestMirrorWrite(KEY, async () => { throw new Error('network boom'); });
    const p2 = enqueueLatestMirrorWrite(KEY, m.write('after-error', 0));
    await Promise.all([p1, p2]);
    check(m.current === 'after-error', 'throw 後も後続 write が実行される');
  }

  console.log('[W2 / W5] ★ 別端末の stale write は防げない（現契約を正確に pin する）');
  {
    // 実 writer は無条件 upsert（precondition なし）。別端末が古い全文書を送れば mirror は巻き戻る。
    for (const rel of [
      'lib/supabase/careerProfile.ts',
      'lib/supabase/careerActivity.ts',
      'lib/supabase/careerValues.ts',
    ]) {
      const code = readFileSync(join(ROOT, rel), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      // 「conditional write（compare-and-set）が無い」ことを明示的に pin する。
      const hasPrecondition = /\.lt\(|\.gt\(|\.match\(\s*\{[^}]*updated_at|source_seq/.test(code);
      check(
        !hasPrecondition,
        `${rel}: server 側 compare-and-set は **未実装**（D-S3 の既知限界として pin）`,
      );
      check(/onConflict:\s*"user_id"/.test(code), `${rel}: 単一レコード系は user_id upsert（last-writer-wins）`);
    }
    console.log('  info  → 別端末 stale write による mirror 巻き戻りは構造的には防げていない。');
    console.log('  info  → read 安全性は D-S1 veto が独立に担保する（下の [S3] で実証）。');
  }

  console.log('[S1] 静的 guard: 単一レコード系 writer が直列化キューを通っている');
  {
    for (const rel of [
      'lib/supabase/careerProfile.ts',
      'lib/supabase/careerActivity.ts',
      'lib/supabase/careerValues.ts',
    ]) {
      const code = readFileSync(join(ROOT, rel), 'utf8');
      check(/enqueueLatestMirrorWrite\(/.test(code), `${rel}: 直列化キュー経由`);
      check(/mirrorWriteKey\(TABLE, userId\)/.test(code), `${rel}: key に user を含める`);
    }
    // 履歴系は coalescing を使っていない（レコード取りこぼし防止）。
    for (const rel of [
      'lib/supabase/careerSelfAnalysis.ts',
      'lib/supabase/careerEs.ts',
      'lib/supabase/careerInterview.ts',
    ]) {
      const code = readFileSync(join(ROOT, rel), 'utf8');
      check(!/enqueueLatestMirrorWrite\(/.test(code), `${rel}: 履歴系に coalescing を使わない`);
    }
  }

  console.log('[S2] 履歴系 upsert は行を削除しない（set が縮まない）');
  {
    for (const rel of [
      'lib/supabase/careerSelfAnalysis.ts',
      'lib/supabase/careerEs.ts',
      'lib/supabase/careerInterview.ts',
    ]) {
      const code = readFileSync(join(ROOT, rel), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      check(/onConflict:\s*"user_id,client_id"/.test(code), `${rel}: per-record upsert（client_id 単位）`);
      check(!/\.delete\(\)/.test(code), `${rel}: 履歴 upsert 経路に delete が無い（行集合は縮まない）`);
    }
  }

  console.log('[S3] ★ write 整合性 ≠ read 安全性: mirror が巻き戻っても read は veto される');
  {
    // 端末は rev11 を持っているが、mirror は別端末の stale write で rev10 へ巻き戻った状況。
    const deviceCurrent: CareerSourceBundle = {
      ...EMPTY_CAREER_SOURCE_BUNDLE,
      values: {
        selections: { priorities: ['成長'], avoidances: [], industries: [], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] },
        notes: { priorities: '', avoidances: '', industries: '', jobTypes: '', workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '' },
        overallNote: 'NEW',
      },
    } as unknown as CareerSourceBundle;
    const mirrorRolledBack: CareerSourceBundle = {
      ...EMPTY_CAREER_SOURCE_BUNDLE,
      values: {
        selections: { priorities: ['安定'], avoidances: [], industries: [], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] },
        notes: { priorities: '', avoidances: '', industries: '', jobTypes: '', workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '' },
        overallNote: 'OLD',
      },
    } as unknown as CareerSourceBundle;

    const statuses = emptySourceStatuses();
    for (const k of Object.keys(statuses) as (keyof typeof statuses)[]) statuses[k] = 'ok';
    const signal = parseSourceSyncSignal(
      serializeSourceSyncSignal(computeSourceSyncRevisions(deviceCurrent, ['values'])),
    );
    const verification = verifySourceSync(
      signal,
      computeSourceSyncRevisions(mirrorRolledBack, ['values']),
      statuses,
    );
    check(verification.values === 'mismatch', 'mirror 巻き戻り → sync verdict = mismatch');
    check(!allSourcesVerified(verification, ['values']), '→ server context / Memory は使われない（read 安全）');
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-mirror-write-ordering-qa: ALL PASS'
      : `career-mirror-write-ordering-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
