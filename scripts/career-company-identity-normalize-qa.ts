/*
 * scripts/career-company-identity-normalize-qa.ts
 *
 * PASSAI CAREER — `normalizeCompanyName` の P0 修復に対する regression QA。
 *
 * 何を守るか:
 *   N-1 語中の法人格語で企業名を壊さない（substring 除去バグの再発防止）
 *   N-2 別法人が同一 normalized token へ潰れない（誤 merge の防止）
 *   N-3 同一法人の表記ゆれは収束する（Sony / ソニー / ソニー株式会社）
 *   N-4 冪等（normalize(normalize(x)) === normalize(x)）
 *   N-5 script を跨がない（transliteration を実装しない）
 *   N-6 既存 QA が固定していた挙動を壊さない
 *
 * ★ この QA が赤のまま global auto registration を有効化してはいけない。
 *   career_company_master は append-only で、誤って merge された行を in-app で訂正できない。
 *
 * 使い方: npx tsx scripts/career-company-identity-normalize-qa.ts
 */

import { normalizeCompanyName } from '../lib/careerCompanyKnowledge/identity';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const n = normalizeCompanyName;

// ════════════════════════════════════════════════════════════════════
console.log('[N-1] 語中の法人格語で企業名を壊さない（P0 バグの再発防止）');

// 旧実装: 'inc' を substring 除去 → 'Lincoln' → 'loln' / 'Principal' → 'pripal'。
check('N-1a Lincoln が壊れない', n('Lincoln') === 'lincoln', `got "${n('Lincoln')}"`);
check('N-1b Principal が壊れない', n('Principal') === 'principal', `got "${n('Principal')}"`);
check(
  'N-1c Lincoln Electric が壊れない',
  n('Lincoln Electric') === 'lincoln electric',
  `got "${n('Lincoln Electric')}"`,
);
check('N-1d Incorporated を含む単語（Incentive）', n('Incentive') === 'incentive', `got "${n('Incentive')}"`);
check('N-1e Corporate を含む単語（Corporate Bank）は語頭が corp ではない', n('Corporate Bank') === 'corporate bank', `got "${n('Corporate Bank')}"`);
check('N-1f 語中の ltd（Altdorf）', n('Altdorf') === 'altdorf', `got "${n('Altdorf')}"`);
check('N-1g 日本語: 日本ハムが壊れない', n('日本ハム') === '日本ハム', `got "${n('日本ハム')}"`);
check(
  'N-1h 日本語: 語中に「会社」を含む名称が壊れない',
  n('会社四季報オンライン') === '会社四季報オンライン',
  `got "${n('会社四季報オンライン')}"`,
);

// ════════════════════════════════════════════════════════════════════
console.log('[N-2] 別法人が同一 token へ潰れない（誤 merge の防止）');

check(
  'N-2a 株式会社ABC != 有限会社ABC',
  n('株式会社ABC') !== n('有限会社ABC'),
  `${n('株式会社ABC')} / ${n('有限会社ABC')}`,
);
check(
  'N-2b 株式会社ABC != 合同会社ABC',
  n('株式会社ABC') !== n('合同会社ABC'),
  `${n('株式会社ABC')} / ${n('合同会社ABC')}`,
);
check(
  'N-2c 有限会社ABC != 合同会社ABC',
  n('有限会社ABC') !== n('合同会社ABC'),
  `${n('有限会社ABC')} / ${n('合同会社ABC')}`,
);
check(
  'N-2d ABC Inc. != ABC LLC',
  n('ABC Inc.') !== n('ABC LLC'),
  `${n('ABC Inc.')} / ${n('ABC LLC')}`,
);
check(
  'N-2e 一般社団法人ABC != 株式会社ABC',
  n('一般社団法人ABC') !== n('株式会社ABC'),
  `${n('一般社団法人ABC')} / ${n('株式会社ABC')}`,
);
check(
  'N-2f 学校法人ABC != 医療法人ABC',
  n('学校法人ABC') !== n('医療法人ABC'),
  `${n('学校法人ABC')} / ${n('医療法人ABC')}`,
);
// 部分一致は別企業（既存 A-3 の思想）。
check('N-2g トヨタ != トヨタ自動車株式会社', n('トヨタ') !== n('トヨタ自動車株式会社'));

// ════════════════════════════════════════════════════════════════════
console.log('[N-3] 同一法人の表記ゆれは収束する');

check('N-3a ソニー == ソニー株式会社', n('ソニー') === n('ソニー株式会社'), `${n('ソニー')} / ${n('ソニー株式会社')}`);
check('N-3b ソニー == 株式会社ソニー', n('ソニー') === n('株式会社ソニー'));
check('N-3c ソニー == ソニー（株）', n('ソニー') === n('ソニー（株）'), `${n('ソニー')} / ${n('ソニー（株）')}`);
check('N-3d ソニー == ソニー㈱（NFKC 互換文字）', n('ソニー') === n('ソニー㈱'), `${n('ソニー')} / ${n('ソニー㈱')}`);
check('N-3e ソニー == ソニー 株式会社（空白あり）', n('ソニー') === n('ソニー 株式会社'));
check('N-3f Sony == SONY（大小）', n('Sony') === n('SONY'));
check('N-3g Sony == Sony Inc.', n('Sony') === n('Sony Inc.'), `${n('Sony')} / ${n('Sony Inc.')}`);
check('N-3h Sony == Sony Corporation', n('Sony') === n('Sony Corporation'));
check('N-3i Nintendo == Nintendo Co., Ltd.', n('Nintendo') === n('Nintendo Co., Ltd.'));
check('N-3j 全角英数の吸収（ＳＯＮＹ == sony）', n('ＳＯＮＹ') === n('Sony'), `${n('ＳＯＮＹ')} / ${n('Sony')}`);
check(
  'N-3k 有限会社の表記ゆれ（有限会社ABC == ABC(有)）',
  n('有限会社ABC') === n('ABC(有)'),
  `${n('有限会社ABC')} / ${n('ABC(有)')}`,
);

// ════════════════════════════════════════════════════════════════════
console.log('[N-4] 冪等（既存コードが正規化済み文字列を再度通すため必須）');

const IDEMPOTENCY_SAMPLES = [
  'ソニー株式会社',
  '株式会社ABC',
  '有限会社ABC',
  '合同会社テスト',
  'ABC LLC',
  'Nintendo Co., Ltd.',
  'Lincoln',
  '一般社団法人日本ABC協会',
  '',
  '株式会社',
  'Inc',
];
for (const sample of IDEMPOTENCY_SAMPLES) {
  const once = n(sample);
  const twice = n(once);
  check(
    `N-4 冪等: "${sample || '(空)'}"`,
    once === twice,
    `once="${once}" twice="${twice}"`,
  );
}

// ════════════════════════════════════════════════════════════════════
console.log('[N-5] script を跨がない（transliteration を実装しない）');

check('N-5a 任天堂 != Nintendo', n('任天堂') !== n('Nintendo'));
check('N-5b ソニー != Sony', n('ソニー') !== n('Sony'));
check('N-5c 任天堂 != ニンテンドー', n('任天堂') !== n('ニンテンドー'));

// ════════════════════════════════════════════════════════════════════
console.log('[N-6] 既存 QA が固定していた挙動の維持');

check('N-6a トヨタ自動車株式会社 == トヨタ自動車', n('トヨタ自動車株式会社') === n('トヨタ自動車'));
check('N-6b 任天堂 == 任天堂株式会社', n('任天堂') === n('任天堂株式会社'));
check('N-6c 空文字 → 空', n('') === '');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
check('N-6d 非 string → 空（never-throw）', n(null as any) === '' && n(undefined as any) === '');
check('N-6e 法人格のみの入力は空（core を空にしない＝除去しない）', n('株式会社') === '株式会社', `got "${n('株式会社')}"`);

// ════════════════════════════════════════════════════════════════════
console.log('[N-7] 決定論（同じ入力 → 同じ出力）');
{
  const samples = ['ソニー株式会社', '有限会社ABC', 'ABC LLC Inc'];
  const ok = samples.every((s) => {
    const first = n(s);
    for (let i = 0; i < 5; i += 1) if (n(s) !== first) return false;
    return true;
  });
  check('N-7a 反復呼び出しで結果が変わらない', ok);
}

console.log('');
if (failures > 0) {
  console.error(`normalize QA: ${failures} FAILED`);
  process.exit(1);
}
console.log('normalize QA: ALL PASS');
