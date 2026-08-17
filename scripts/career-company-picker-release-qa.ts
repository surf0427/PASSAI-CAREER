/*
 * scripts/career-company-picker-release-qa.ts
 *
 * PASSAI CAREER — 初回リリース版 CompanyPicker（free-text UX）の常設 QA。
 *
 * 何を守るか:
 *   Company Identity は初回リリース対象外（server flag `CAREER_COMPANY_IDENTITY_ENABLED` は
 *   OFF 固定）。ユーザーには **企業名を入力するだけのフォーム**として見せ、Identity 系 UI
 *   （ひも付け CTA / 候補選択 / 企業登録 / 最近使った企業 / 利用不可メッセージ）を一切
 *   露出しない。この状態が将来うっかり解ける事故を検出するのが目的。
 *
 * ★ grep ではなく **実際に render した HTML** を検査する。文言や class を書き換えても、
 *   「ユーザーに何が見えるか」という本質だけを固定できるため脆くない。
 *
 * P1  企業名 input が描画される（free-text 入力手段が生きている）
 * P2  label / required / placeholder / hint という通常フォームの体裁が保たれる
 * P3  Identity 系 UI が 1 つも描画されない（CTA / 登録 / 候補 / 最近使った企業 / 利用不可）
 * P4  Identity 用語がユーザー可視テキストに出ない（企業DB / company_id / ひも付け 等）
 * P5  companyId 付きの既存データを渡しても crash せず、free-text として編集可能に描画される
 *     （＝「登録済み企業」バッジで入力欄が消えない・後方互換）
 * P6  内部資産は温存されている（props contract / handler / server 資産を消していない）
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-company-picker-release-qa.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CompanyPicker } from '@/components/career/CompanyPicker';

const ROOT = process.cwd();

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const noop = () => {};

console.log('\n== CompanyPicker 初回リリース（free-text UX）QA ==\n');

// ── P1/P2: 通常フォームとして成立しているか ───────────────────────────
console.log('[P1-P2] free-text フォーム');

const plain = renderToStaticMarkup(
  createElement(CompanyPicker, {
    value: { companyName: '' },
    onChange: noop,
    label: '企業名',
    required: true,
    placeholder: '例: 〇〇株式会社',
    hint: 'この企業を受ける想定で深掘りします。',
  }),
);

check('P1 企業名 input が描画される', /<input/i.test(plain));
check('P2 label が描画される', plain.includes('企業名'));
check('P2 required マークが描画される', plain.includes('*'));
check('P2 placeholder が描画される', plain.includes('例: 〇〇株式会社'));
check('P2 hint が描画される', plain.includes('この企業を受ける想定で深掘りします。'));

// ── P3: Identity 系 UI が出ないこと ───────────────────────────────────
console.log('\n[P3] Identity UI 非表示');

// 「最近使った企業」は localStorage directory 由来。Node には window が無いため
// safeStorage は空を返す＝この QA では常に空になる。したがって chip の非表示は
// 「directory があっても出ない」ことまでは保証しない → P6 の静的 guard で補完する。
const identityMarkers: Array<[string, string]> = [
  ['ひも付け CTA', '登録済み企業とひも付ける'],
  ['CTA 補足文', 'ひも付けなくてもこのまま進めます'],
  ['最近使った企業', '最近使った企業'],
  ['候補選択（ambiguous）', '候補が複数あります'],
  ['近い企業 suggestion', '近い企業が見つかりました'],
  ['企業登録ボタン', 'として登録する'],
  ['登録済みバッジ', '登録済み企業'],
  ['利用不可メッセージ', '企業の登録機能は現在利用できません'],
  ['ログイン要求文言', 'ログインが必要'],
];
for (const [label, marker] of identityMarkers) {
  check(`P3 ${label} が描画されない`, !plain.includes(marker), marker);
}

// ── P4: Identity 用語がユーザー可視テキストに出ない ────────────────────
console.log('\n[P4] Identity 用語');

for (const word of ['企業DB', '企業マスタ', 'company_id', 'companyId', 'Company Identity', 'canonical']) {
  check(`P4 "${word}" がユーザー可視 HTML に出ない`, !plain.includes(word));
}

// ── P5: 既存 companyId 付きデータの後方互換 ───────────────────────────
console.log('\n[P5] 後方互換（companyId 付き既存データ）');

const linkedHtml = renderToStaticMarkup(
  createElement(CompanyPicker, {
    value: { companyId: 'cmp_00000000-0000-4000-8000-000000000000', companyName: '株式会社リクルート' },
    onChange: noop,
  }),
);

check('P5 crash せず描画される', linkedHtml.length > 0);
check('P5 企業名が表示される', linkedHtml.includes('株式会社リクルート'));
check(
  'P5 input が残る（「登録済み企業」バッジで入力欄が消えない）',
  /<input/i.test(linkedHtml),
);
check('P5 登録済みバッジが出ない', !linkedHtml.includes('登録済み企業'));
check('P5 「変更する」が出ない', !linkedHtml.includes('変更する'));
check(
  'P5 companyId が HTML へ漏れない',
  !linkedHtml.includes('cmp_00000000-0000-4000-8000-000000000000'),
);

// ── P6: 内部資産の温存（削除していないこと）────────────────────────────
console.log('\n[P6] 内部資産 温存');

const picker = read('components/career/CompanyPicker.tsx');

check(
  'P6 gate 定数が存在し default OFF',
  /const IDENTITY_UI_ENABLED:\s*boolean\s*=\s*false/.test(picker),
);
check('P6 companyId props contract を維持', picker.includes('companyId?: string'));
check('P6 resolve handler を削除していない', picker.includes('resolveCompanyByName'));
check('P6 register handler を削除していない', picker.includes('registerCompanyByName'));
check('P6 directory 連携を削除していない', picker.includes('touchCompanyInDirectory'));
// gate が Identity 領域を実際に囲っているかを **JSX の位置**で確かめる。
// 散文（コメント）ではなくコード上のアンカーを使う（コメント文言の変更で壊れないように）。
{
  const gateOpen = picker.indexOf('{IDENTITY_UI_ENABLED && (');
  const gatedAnchors: Array<[string, string]> = [
    ['ひも付け CTA', 'onClick={handleSearch}'],
    ['最近使った企業 chip', '{recent.map('],
    ['候補選択（ambiguous）', '{search.candidates.map('],
    ['企業登録ボタン', 'handleRegister(search.name)'],
    ['利用不可メッセージ', "search.kind === 'unavailable'"],
  ];
  check('P6 gate 開始位置が存在する', gateOpen !== -1);
  for (const [label, anchor] of gatedAnchors) {
    const at = picker.indexOf(anchor);
    check(
      `P6 ${label} が gate 配下にある（定数を true にすれば復帰する）`,
      gateOpen !== -1 && at > gateOpen,
      `anchor=${anchor} at=${at} gate=${gateOpen}`,
    );
  }
}

const preservedServerAssets = [
  'lib/careerCompanySpine/flags.server.ts',
  'lib/careerCompanyIdentity/gate.server.ts',
  'lib/careerCompanyIdentity/repository.server.ts',
  'lib/careerCompanyIdentity/resolution.ts',
  'lib/careerCompanyKnowledge/identity.ts',
  'app/api/career/company/resolve/route.ts',
  'app/api/career/company/register/route.ts',
  'app/api/career/company/lookup/route.ts',
  'app/career/company/companyDirectory.ts',
  'app/career/company/companyClient.ts',
  'supabase/career_company_identity_apply.sql',
];
for (const rel of preservedServerAssets) {
  check(`P6 温存: ${rel}`, existsSync(join(ROOT, rel)));
}
check(
  'P6 server flag は依然 code default OFF',
  read('lib/careerCompanySpine/flags.server.ts').includes(
    "process.env.CAREER_COMPANY_IDENTITY_ENABLED === 'true'",
  ),
);
check(
  'P6 normalizeCompanyName を温存（正規化は今回修正しない）',
  read('lib/careerCompanyKnowledge/identity.ts').includes('export function normalizeCompanyName'),
);

// ── P7: Company Identity segment が route として到達不能 ────────────────
// CompanyPicker を伏せても、企業ページ本体（/career/company 配下）が route として
// 生きていると「行き止まりページ」が公開されたまま残る。segment gate で塞ぐ。
// 企業マッチング（app/career/matching/layout.tsx）と同じ形であることも固定する。
console.log('\n[P7] Company Identity segment gate');

{
  const layoutPath = 'app/career/company/layout.tsx';
  check('P7 segment gate（layout.tsx）が存在する', existsSync(join(ROOT, layoutPath)));

  const layout = existsSync(join(ROOT, layoutPath)) ? read(layoutPath) : '';
  check(
    'P7 server-only flag で判定している（UI flag / NEXT_PUBLIC_ を使わない）',
    layout.includes('isCompanyIdentityEnabled') &&
      layout.includes('@/lib/careerCompanySpine/flags.server') &&
      !layout.includes('NEXT_PUBLIC_'),
  );
  check('P7 flag OFF で notFound()（描画へ進ませない）', layout.includes('notFound()'));
  check(
    'P7 既定は塞ぐ側（!enabled で notFound。ON のときだけ children）',
    /if\s*\(\s*!\s*isCompanyIdentityEnabled\(\)\s*\)\s*notFound\(\)/.test(layout),
  );
  check(
    'P7 配下 3 ページを温存している（消さずに塞ぐ）',
    existsSync(join(ROOT, 'app/career/company/page.tsx')) &&
      existsSync(join(ROOT, 'app/career/company/new/page.tsx')) &&
      existsSync(join(ROOT, 'app/career/company/[companyId]/page.tsx')),
  );
  // ★ 同居する非 route module は Phase 1 の free-text flow が import し続ける。
  //   segment gate は routing だけを塞ぎ、これらを巻き込まないこと。
  check(
    'P7 同居 module（Application Context / directory / client）を消していない',
    existsSync(join(ROOT, 'app/career/company/applicationStorage.ts')) &&
      existsSync(join(ROOT, 'app/career/company/companyDirectory.ts')) &&
      existsSync(join(ROOT, 'app/career/company/companyClient.ts')),
  );
}

// ── P8: Phase 1 の企業入力が companyId を要求しない ─────────────────────
// free-text だけで完走できることを、各機能の submit ゲートで固定する。
console.log('\n[P8] free-text だけで完走できる');

check(
  'P8 ES は companyName のみ必須（companyId を見ない）',
  (() => {
    const s = read('lib/careerEs/esSettings.ts');
    return s.includes("errors.companyName = '企業名を入力してください'") && !s.includes('companyId');
  })(),
);
check(
  // 面接 target は基本情報 4 項目（企業名/業界/職種/選考種別）を必須にしたが、
  // ★ P8 の主題は「Company Identity（companyId）を必須にしていない」こと。
  //   free-text の企業名だけで完走できる不変条件が保たれているかを見る。
  'P8 面接 target は companyId を必須にしていない（free-text の企業名で進める）',
  (() => {
    // 行コメントを落として実コードだけを見る（「companyId は必須にしない」という
    // 説明コメントを誤検知しないため）。
    const codeOnly = (src: string) =>
      src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
    const page = codeOnly(read('app/career/interview/target/page.tsx'));
    const canProceed = /const canProceed =[\s\S]*?\n  \}\);/.exec(page)?.[0] ?? '';
    // 必須判定は共有純関数（isInterviewTargetComplete）へ一本化済み。gate へ渡すのは
    // companyName / industry / jobType / selectionType の 4 項目だけで、companyId は含まない。
    const predicate =
      /export function isInterviewTargetComplete[\s\S]*?\n\}/.exec(
        codeOnly(read('app/career/interview/interviewModes.ts')),
      )?.[0] ?? '';
    return (
      canProceed.includes('isInterviewTargetComplete(') &&
      canProceed.includes('companyName') &&
      !canProceed.includes('companyId') &&
      // 述語側も companyId を見ていない（free-text の企業名だけで完走できる）。
      predicate.includes('companyName') &&
      !predicate.includes('companyId')
    );
  })(),
);
check(
  'P8 企業研究は companyName + 研究テキストだけで添削へ進める',
  read('app/career/company-research/do/page.tsx').includes(
    "const canReview = companyName.trim() !== '' && verifiedResearchText.trim() !== ''",
  ),
);
check(
  'P8 プレゼン target は companyId を必須にしていない',
  !/canProceed[\s\S]{0,240}companyId/.test(read('app/career/presentation/target/page.tsx')),
);

// ── 結果 ──────────────────────────────────────────────────────────────
console.log(
  failures === 0
    ? '\n✅ ALL PASS — CompanyPicker は free-text UX に縮退し、内部資産は温存されている\n'
    : `\n❌ ${failures} FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
