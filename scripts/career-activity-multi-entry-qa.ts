/*
 * scripts/career-activity-multi-entry-qa.ts
 *
 * PASSAI CAREER — 活動整理「趣味・特技 / 表彰・実績」複数項目化の決定論 QA（dev-only harness）。
 *
 * 目的:
 *   ⑬ hobbies / ⑭ awards を単一テキスト（string）から複数カード（HobbyEntry[] / AwardEntry[]）へ
 *   移行した変更について、以下を最小 localStorage polyfill 上で決定論的に検証する。外部 AI・DB 非接続。
 *     1. 保存/読み込み: 複数項目の round-trip・削除の永続化・空カードを保存しない
 *     2. legacy 互換: 旧 string 形式が 1 件目のカードへ畳み込まれ、データが消えない
 *     3. 成績・受賞歴(academics.academicAwards): UI からは削除したが保存値は保持される（GPA も維持）
 *     4. Data Spine: normalizeCareerActivityContext → formatCareerActivityForPrompt まで
 *        新旧どちらの形状でも到達し、legacy string では出力が従来と byte 一致すること
 *     5. 自己分析の入力カバレッジ棚卸し（buildCoverageInventory）が新形状でも「趣味・特技」を検出すること
 *
 * 使い方: npx tsx scripts/career-activity-multi-entry-qa.ts
 * 終了コード: 全 assertion pass → 0 / 失敗 → 1。
 *
 * 注: safeStorage は window/localStorage を関数呼び出し時に lazily read するため、
 *     import 後に globals を差し込んでから storage 関数を呼べば良い。
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
  loadActivityData,
  saveActivityData,
  clearActivityData,
  normalizeCareerActivity,
  hasAnyActivity,
} from '@/app/career/activity/activityStorage';
import {
  emptyCareerActivity,
  newHobbyEntry,
  newAwardEntry,
  type CareerActivity,
} from '@/types/careerActivity';
import { normalizeCareerActivityContext } from '@/lib/careerAi/context';
import { formatCareerActivityForPrompt } from '@/lib/careerContext/activity';
import { buildCoverageInventory } from '@/lib/careerSelfAnalysis/pastLogSummary';
import type { CareerActivityInput } from '@/lib/careerAi/types';

// 旧スキーマ（string 形式）の入力を型を通して渡すためのキャスト（read-time 互換の検証用）。
const legacy = (v: unknown): CareerActivityInput => v as CareerActivityInput;

const STORAGE_KEY = 'careerActivityData';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}\n         actual  : ${a}\n         expected: ${e}`);
  }
}
// clearActivityData は dedup gate（lastSavedJson）も同時にリセットするため reset に使う。
function reset() {
  clearActivityData();
  store.clear();
}
function seedRaw(raw: unknown) {
  store.set(STORAGE_KEY, JSON.stringify(raw));
}
function hobby(name: string): CareerActivity['hobbies'][number] {
  return { ...newHobbyEntry(), name };
}
function award(title: string): CareerActivity['awards'][number] {
  return { ...newAwardEntry(), title };
}

console.log('# 1. 複数項目の保存 / 再読込 / 削除');
{
  reset();
  const base = emptyCareerActivity();
  const saved: CareerActivity = {
    ...base,
    hobbies: [hobby('写真'), hobby('フルマラソン'), hobby('料理')],
    awards: [award('全国大会3位'), award('学内ビジネスコンテスト優勝'), award('社内MVP')],
  };
  saveActivityData(saved);

  const reloaded = loadActivityData();
  eq(
    '趣味・特技が 3 件そのまま復元される',
    reloaded?.hobbies.map((h) => h.name),
    ['写真', 'フルマラソン', '料理'],
  );
  eq(
    '表彰・実績が 3 件そのまま復元される',
    reloaded?.awards.map((a) => a.title),
    ['全国大会3位', '学内ビジネスコンテスト優勝', '社内MVP'],
  );
  check(
    'カードの id が保存 → 再読込で保持される（React キーが安定）',
    reloaded?.hobbies[0].id === saved.hobbies[0].id,
  );

  // 2 件目を削除 → 保存 → 再読込。復活しないこと。
  const afterRemove: CareerActivity = {
    ...saved,
    hobbies: saved.hobbies.filter((h) => h.name !== 'フルマラソン'),
    awards: saved.awards.filter((a) => a.title !== '社内MVP'),
  };
  saveActivityData(afterRemove);
  const reloaded2 = loadActivityData();
  eq('削除した趣味が再読込で復活しない', reloaded2?.hobbies.map((h) => h.name), [
    '写真',
    '料理',
  ]);
  eq('削除した表彰が再読込で復活しない', reloaded2?.awards.map((a) => a.title), [
    '全国大会3位',
    '学内ビジネスコンテスト優勝',
  ]);
}

console.log('# 2. 空カードを保存しない（＋追加直後の空行）');
{
  reset();
  const withBlank: CareerActivity = {
    ...emptyCareerActivity(),
    hobbies: [hobby('写真'), newHobbyEntry(), hobby('   ')],
    awards: [newAwardEntry()],
  };
  saveActivityData(withBlank);
  const reloaded = loadActivityData();
  eq('空/空白のみの趣味カードは保存されない', reloaded?.hobbies.map((h) => h.name), [
    '写真',
  ]);
  eq('空の表彰カードは保存されない', reloaded?.awards, []);

  // 空カードしか無い状態は「未入力」と判定されること（readiness を誤って true にしない）。
  reset();
  saveActivityData({ ...emptyCareerActivity(), hobbies: [newHobbyEntry()] });
  check('空カードだけなら hasAnyActivity は false', !hasAnyActivity(loadActivityData()));
}

console.log('# 3. legacy（旧 string 形式）互換');
{
  reset();
  seedRaw({
    hobbies: '写真とマラソン',
    awards: '全国大会3位、社内MVP',
    academics: { gpa: '3.4', academicAwards: '学内発表会 優秀賞', seminar: '経済ゼミ' },
  });
  const migrated = loadActivityData();
  eq('旧 string の趣味が 1 件目のカードへ畳み込まれる', migrated?.hobbies.map((h) => h.name), [
    '写真とマラソン',
  ]);
  eq('旧 string の表彰が 1 件目のカードへ畳み込まれる', migrated?.awards.map((a) => a.title), [
    '全国大会3位、社内MVP',
  ]);
  check('legacy データで落ちない（読み込み結果が非 null）', migrated !== null);

  // 空文字 string は破棄（空カードを作らない）。
  eq('空 string の legacy は空配列になる', normalizeCareerActivity({ hobbies: '', awards: '  ' }).hobbies, []);
  // 想定外の型でも落ちない。
  eq('数値など想定外の型でも空配列', normalizeCareerActivity({ hobbies: 42 }).hobbies, []);
}

console.log('# 4. 成績・受賞歴（legacy）と GPA の保持');
{
  reset();
  seedRaw({
    academics: { gpa: '3.4', academicAwards: '学内発表会 優秀賞', seminar: '経済ゼミ' },
  });
  const loaded = loadActivityData();
  eq('GPA は維持される', loaded?.academics.gpa, '3.4');
  eq(
    '旧 成績・受賞歴 の保存値は破棄されない（awards へ機械変換もしない）',
    loaded?.academics.academicAwards,
    '学内発表会 優秀賞',
  );
  eq('旧 成績・受賞歴 は 表彰・実績 へ勝手に移動しない', loaded?.awards, []);

  // 保存し直しても値が落ちないこと（autosave 経路の回帰）。
  saveActivityData(loaded!);
  eq('再保存後も 成績・受賞歴 が残る', loadActivityData()?.academics.academicAwards, '学内発表会 優秀賞');
}

console.log('# 5. Data Spine（AI コンテキスト正規化 → prompt 整形）');
{
  // 新形状: 1 カード = 1 行。
  const ctxNew = normalizeCareerActivityContext({
    hobbies: [hobby('写真'), hobby('フルマラソン')],
    awards: [award('全国大会3位'), award('社内MVP')],
  });
  eq('趣味が 1 カード = 1 行で Data Spine へ到達', ctxNew.hobbies, ['写真', 'フルマラソン']);
  eq('表彰が 1 カード = 1 行で Data Spine へ到達', ctxNew.awards, ['全国大会3位', '社内MVP']);

  // 空カード（サーバ側 jsonb は未正規化で届きうる）は行にしない。
  const ctxBlank = normalizeCareerActivityContext({
    hobbies: [newHobbyEntry(), hobby('写真')],
    awards: [newAwardEntry()],
  });
  eq('空カードは prompt 行にならない', ctxBlank.hobbies, ['写真']);
  eq('空カードのみなら空セクション', ctxBlank.awards, []);

  // legacy 形状: 従来と同じ 1 行（出力互換）。
  const ctxLegacy = normalizeCareerActivityContext(
    legacy({ hobbies: '写真とマラソン', awards: '全国大会3位、社内MVP' }),
  );
  eq('legacy string は従来通り 1 行', ctxLegacy.hobbies, ['写真とマラソン']);
  eq('legacy string(表彰) は従来通り 1 行', ctxLegacy.awards, ['全国大会3位、社内MVP']);

  // 未入力は空配列（空セクションとして出力されない）。
  const ctxEmpty = normalizeCareerActivityContext(emptyCareerActivity());
  eq('未入力の趣味は空配列', ctxEmpty.hobbies, []);
  eq('未入力の表彰は空配列', ctxEmpty.awards, []);

  // prompt 整形: セクション見出しと各項目が独立行として残る。
  const rendered = formatCareerActivityForPrompt(ctxNew);
  check('prompt に「■ 趣味・特技」セクションが出る', rendered.includes('■ 趣味・特技'));
  check('prompt に「■ 表彰・実績」セクションが出る', rendered.includes('■ 表彰・実績'));
  check('各項目が独立行になる（写真）', rendered.includes('  - 写真'));
  check('各項目が独立行になる（フルマラソン）', rendered.includes('  - フルマラソン'));
  check('各項目が独立行になる（社内MVP）', rendered.includes('  - 社内MVP'));

  // legacy の prompt 出力が変更前と byte 一致すること。
  const renderedLegacy = formatCareerActivityForPrompt(ctxLegacy);
  eq(
    'legacy の prompt 出力は従来と byte 一致',
    renderedLegacy,
    '■ 趣味・特技\n  - 写真とマラソン\n■ 表彰・実績\n  - 全国大会3位、社内MVP',
  );

  // legacy 成績・受賞歴 は学業セクションに残り続ける（既存ユーザーの prompt が痩せない）。
  const ctxAcademics = normalizeCareerActivityContext(
    legacy({ academics: { gpa: '3.4', academicAwards: '学内発表会 優秀賞' } }),
  );
  eq('legacy 成績・受賞歴 は学業セクションに残る', ctxAcademics.academics, [
    'GPA: 3.4',
    '成績・受賞歴: 学内発表会 優秀賞',
  ]);
}

console.log('# 6. 自己分析の入力カバレッジ棚卸し');
{
  const invNew = buildCoverageInventory({ hobbies: [hobby('写真')] }, null);
  check('新形状で「趣味・特技」が棚卸しに載る', invNew.activities.includes('趣味・特技'));

  const invLegacy = buildCoverageInventory(legacy({ hobbies: '写真' }), null);
  check('legacy string でも「趣味・特技」が棚卸しに載る', invLegacy.activities.includes('趣味・特技'));

  const invBlank = buildCoverageInventory({ hobbies: [newHobbyEntry()] }, null);
  check('空カードだけなら棚卸しに載らない', !invBlank.activities.includes('趣味・特技'));

  const invEmpty = buildCoverageInventory({ hobbies: [] }, null);
  check('未入力なら棚卸しに載らない', !invEmpty.activities.includes('趣味・特技'));
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll assertions passed.');
