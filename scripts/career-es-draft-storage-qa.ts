/*
 * scripts/career-es-draft-storage-qa.ts
 *
 * PASSAI CAREER — ES 作成中ドラフト storage の決定論 QA（dev-only harness）。
 *
 * 目的:
 *   deep モードの途中離脱→再開のための draft ストア（careerEsDrafts）が、
 *   owner 境界・schemaVersion 破棄・fail-safe parse・削除条件・正式ログ分離を満たすことを、
 *   最小 localStorage polyfill 上で決定論的に検証する。外部 AI・DB 非接続。
 *
 * 使い方: npx tsx scripts/career-es-draft-storage-qa.ts
 * 終了コード: 全 assertion pass → 0 / 失敗 → 1。
 *
 * 注: safeStorage は window/localStorage を関数呼び出し時に lazily read するため、
 *     import 後に globals を差し込んでから storage 関数を呼べば良い（module eval は localStorage 非依存）。
 */

// ── 最小 localStorage / window polyfill ──
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

import {
  loadEsDrafts,
  loadEsDraft,
  saveEsDraft,
  deleteEsDraft,
} from '@/app/career/es/esDraftStorage';
import { ES_DRAFT_SCHEMA_VERSION, type CareerEsDraft } from '@/types/careerEs';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}
function reset() {
  store.clear();
}
function makeDraft(over: Partial<CareerEsDraft>): CareerEsDraft {
  return {
    id: 'd1',
    schemaVersion: ES_DRAFT_SCHEMA_VERSION,
    ownerId: null,
    mode: 'deep',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    question: '学生時代に力を入れたことは？',
    ...over,
  };
}

console.log('# round-trip + separation');
{
  reset();
  saveEsDraft(makeDraft({ id: 'd1', ownerId: 'user-A', body: '書きかけ' }));
  const got = loadEsDraft('d1', 'user-A');
  check('save→load 往復', got?.body === '書きかけ');
  check('draft は careerEsDrafts キーに保存される', store.has('careerEsDrafts'));
  check('正式ログ careerEsLogs には書かれない', !store.has('careerEsLogs'));
}

console.log('# owner 境界');
{
  reset();
  saveEsDraft(makeDraft({ id: 'a', ownerId: 'user-A' }));
  saveEsDraft(makeDraft({ id: 'b', ownerId: 'user-B' }));
  saveEsDraft(makeDraft({ id: 'g', ownerId: null }));
  check('user-A は自分の draft のみ', loadEsDrafts('user-A').map((d) => d.id).join() === 'a');
  check('user-B の draft を user-A は取得しない', loadEsDraft('b', 'user-A') === null);
  check('guest(null) は guest の draft のみ', loadEsDrafts(null).map((d) => d.id).join() === 'g');
  check('guest は member の draft を取得しない', loadEsDraft('a', null) === null);
}

console.log('# schemaVersion 不一致は破棄（fail-safe migration）');
{
  reset();
  // 旧/不正スキーマの draft を直接注入する。
  store.set(
    'careerEsDrafts',
    JSON.stringify([
      { ...makeDraft({ id: 'old', ownerId: 'user-A' }), schemaVersion: 999 },
      makeDraft({ id: 'cur', ownerId: 'user-A' }),
    ]),
  );
  const ids = loadEsDrafts('user-A').map((d) => d.id);
  check('schemaVersion 不一致は無視', !ids.includes('old'));
  check('現行スキーマは残る', ids.includes('cur'));
}

console.log('# fail-safe parse（壊れた JSON / 壊れた要素）');
{
  reset();
  store.set('careerEsDrafts', '{ this is not valid json');
  check('壊れた JSON でも例外にならず空配列', loadEsDrafts('user-A').length === 0);

  store.set(
    'careerEsDrafts',
    JSON.stringify([
      { id: 'bad', schemaVersion: ES_DRAFT_SCHEMA_VERSION, mode: 'nope', ownerId: 'user-A' },
      makeDraft({ id: 'good', ownerId: 'user-A' }),
    ]),
  );
  const ids = loadEsDrafts('user-A').map((d) => d.id);
  check('壊れた要素（mode 不正）は除去', !ids.includes('bad') && ids.includes('good'));
}

console.log('# 削除は owner を尊重');
{
  reset();
  saveEsDraft(makeDraft({ id: 'a', ownerId: 'user-A' }));
  deleteEsDraft('a', 'user-B'); // 別 owner → 消えない
  check('別 owner の delete は無効', loadEsDraft('a', 'user-A') !== null);
  deleteEsDraft('a', 'user-A'); // 正しい owner → 消える
  check('正しい owner の delete で消える', loadEsDraft('a', 'user-A') === null);
}

console.log('# 更新日時降順で返る');
{
  reset();
  saveEsDraft(makeDraft({ id: 'old', ownerId: 'u', updatedAt: '2026-07-16T00:00:00.000Z' }));
  saveEsDraft(makeDraft({ id: 'new', ownerId: 'u', updatedAt: '2026-07-16T09:00:00.000Z' }));
  check('新しい draft が先頭', loadEsDrafts('u')[0].id === 'new');
}

console.log('# ownerId 正規化（空文字→guest 扱い）');
{
  reset();
  saveEsDraft(makeDraft({ id: 'x', ownerId: '' as unknown as string }));
  check('空 ownerId は guest(null) として扱う', loadEsDraft('x', null) !== null);
}

if (failures > 0) {
  console.error(`\n✖ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\n✓ all assertions passed');
