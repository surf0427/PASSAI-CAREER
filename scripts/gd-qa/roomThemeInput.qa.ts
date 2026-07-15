// PASSAI 就活版 — GD テーマ入力検証の決定的 QA（登録済み・再実行可能）。
//
// 実行:  npx tsx scripts/gd-qa/roomThemeInput.qa.ts
// 対象:  lib/careerGd/roomThemeInput.ts（parseRoomThemeInput / isThemeConfirmed）
// 目的:  修正1（テーマ設定ステップ）で作成時に確定テーマを保存する検証ロジックの回帰防止。
//        外部 AI・DB・env 非依存の純ロジックのみ。

import { parseRoomThemeInput, isThemeConfirmed } from '../../lib/careerGd/roomThemeInput';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name);
  }
}

// ── 空 / 欠落は reject（テーマ未確定の部屋を作らない） ──
check('null rejected', parseRoomThemeInput(null).ok === false);
check('non-object rejected', parseRoomThemeInput('x').ok === false);
check('missing title rejected', parseRoomThemeInput({ description: 'x' }).ok === false);
check('missing description rejected', parseRoomThemeInput({ title: 'x' }).ok === false);
check('whitespace title rejected', parseRoomThemeInput({ title: '   ', description: 'x' }).ok === false);
check('whitespace description rejected', parseRoomThemeInput({ title: 'x', description: '  ' }).ok === false);

// ── 手動テーマの正規化 ──
{
  const r = parseRoomThemeInput({
    title: '  働き方  ',
    description: 'リモートか出社か',
    format: 'free',
    constraints: ['a', '  ', 'b'],
  });
  check('valid ok', r.ok === true);
  check('title trimmed', r.ok && r.theme.title === '働き方');
  check('constraints filtered', r.ok && JSON.stringify(r.theme.constraints) === JSON.stringify(['a', 'b']));
  check('format kept', r.ok && r.theme.format === 'free');
}

// ── format 正規化 ──
{
  const bad = parseRoomThemeInput({ title: 't', description: 'd', format: 'bogus' });
  check('bad format -> free', bad.ok && bad.theme.format === 'free');
  const good = parseRoomThemeInput({ title: 't', description: 'd', format: 'case' });
  check('case format kept', good.ok && good.theme.format === 'case');
  const abs = parseRoomThemeInput({ title: 't', description: 'd', format: 'abstract' });
  check('abstract format kept', abs.ok && abs.theme.format === 'abstract');
}

// ── constraints 空なら key を付けない ──
{
  const r = parseRoomThemeInput({ title: 't', description: 'd', format: 'free' });
  check('no constraints key when empty', r.ok && !('constraints' in r.theme));
  const r2 = parseRoomThemeInput({ title: 't', description: 'd', constraints: ['   ', ''] });
  check('all-blank constraints omitted', r2.ok && !('constraints' in r2.theme));
}

// ── 長さ上限 ──
check('title too long rejected', parseRoomThemeInput({ title: 'x'.repeat(200), description: 'd' }).ok === false);
check('description too long rejected', parseRoomThemeInput({ title: 't', description: 'y'.repeat(3000) }).ok === false);
{
  const r = parseRoomThemeInput({
    title: 't',
    description: 'd',
    constraints: Array.from({ length: 20 }, (_, i) => `c${i}`),
  });
  check('constraints capped at 8', r.ok && (r.theme.constraints?.length ?? 0) <= 8);
  const long = parseRoomThemeInput({ title: 't', description: 'd', constraints: ['z'.repeat(500)] });
  check('constraint item truncated', long.ok && (long.theme.constraints?.[0].length ?? 0) <= 300);
}

// ── isThemeConfirmed（UI ガード・start 判定と共通） ──
check('confirmed true', isThemeConfirmed({ title: 't', description: 'd', format: 'free' }) === true);
check('confirmed false null', isThemeConfirmed(null) === false);
check('confirmed false undefined', isThemeConfirmed(undefined) === false);
check('confirmed false empty title', isThemeConfirmed({ title: '', description: 'd', format: 'free' }) === false);
check('confirmed false empty desc', isThemeConfirmed({ title: 't', description: '', format: 'free' }) === false);

console.log(`\nroomThemeInput QA: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
