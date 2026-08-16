/*
 * scripts/career-matching-deferral-qa.ts
 *
 * PASSAI CAREER — 企業マッチング「初回リリース延期」ゲートの常設 QA。
 *
 * 何を守るか:
 *   企業マッチングは初回リリース対象外。コード・DB・型・QA は温存したまま、
 *   flag OFF（既定）で **到達不能・実行不能・AI コスト 0** であることを保証する。
 *   将来この延期状態が「気づかないうちに解けている」事故（env 未設定なのに公開される、
 *   guard が AI 呼び出しの後ろへ移動する、資産が削除される）を検出するのが目的。
 *
 * D1  env 未設定 → server flag OFF（fail-closed。これが最終権限）
 * D2  evaluator の受理値は厳密に 'true' のみ（UI 側と server 側で解釈がずれない）
 * D3  UI flag も既定 OFF
 * D4  【behavioral】flag OFF で POST /api/career/matching → 404
 * D5  【behavioral】flag OFF の POST で outbound fetch が 1 度も発生しない（＝AI コスト 0）
 * D6  【behavioral】flag ON なら guard を通過する（不正 body で 400 ＝ AI 前段には到達する）
 * D7  matching segment に server guard（layout）が存在し notFound() を呼ぶ
 * D8  UI 導線 3 箇所（home / mypage / GD 結果）が UI flag を参照している
 * D9  温存すべき資産が消えていない（engine / storage key / event / QA script）
 *
 * 設計（脆さ回避）: 行番号に依存しない。D4〜D6 は実際に route handler を呼ぶ behavioral test で、
 *   grep では守れない「guard が AI 呼び出しより前にある」ことを実行で検証する。
 *   D7〜D9 は構造の存在確認に限定し、文言や整形には依存させない。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-matching-deferral-qa.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

// route module は import 時に Anthropic client を構築する（lib/ai.ts）。
// 実 API は一切叩かないが、構築自体に key が要るのでダミーを置く。
// ★ この QA が本物の AI を呼ばないことは D5（fetch 監視）が保証する。
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-qa-dummy-not-a-real-key';

async function main(): Promise<void> {
  console.log('\n== 企業マッチング 延期ゲート QA ==\n');

  // ── D1〜D3: flag の既定値と evaluator ─────────────────────────────
  console.log('[D1-D3] flag default / evaluator');

  delete process.env.CAREER_COMPANY_MATCHING_ENABLED;
  delete process.env.NEXT_PUBLIC_CAREER_COMPANY_MATCHING_ENABLED;

  const { evalCareerCompanyMatchingFlag, isCareerCompanyMatchingUiEnabled } = await import(
    '@/lib/careerMatchingGate/flag'
  );
  const { isCareerCompanyMatchingEnabled } = await import(
    '@/lib/careerMatchingGate/flags.server'
  );

  check('D1 env 未設定 → server flag OFF', isCareerCompanyMatchingEnabled() === false);

  check('D2 evaluator: "true" のみ受理', evalCareerCompanyMatchingFlag('true') === true);
  check('D2 evaluator: 大文字/空白を許容', evalCareerCompanyMatchingFlag('  TRUE ') === true);
  check(
    'D2 evaluator: それ以外はすべて OFF',
    ['1', 'yes', 'on', '', 'false', 'True1'].every((v) => evalCareerCompanyMatchingFlag(v) === false),
  );
  check(
    'D2 evaluator: 非文字列は OFF',
    [undefined, null, 1, true, {}].every((v) => evalCareerCompanyMatchingFlag(v) === false),
  );

  check('D3 env 未設定 → UI flag OFF', isCareerCompanyMatchingUiEnabled() === false);

  // ── D4〜D6: API guard の behavioral test ──────────────────────────
  console.log('\n[D4-D6] API guard (behavioral)');

  // outbound fetch を封じる。guard が効いていれば 1 度も呼ばれない。
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    throw new Error(`unexpected outbound fetch: ${String(args[0])}`);
  }) as typeof fetch;

  try {
    const { POST } = await import('@/app/api/career/matching/route');

    // D4/D5: flag OFF。現実的な body を送っても 404 で止まり、AI へ到達しない。
    const offRes = await POST(
      new Request('http://localhost/api/career/matching', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: null, activity: null, userInput: 'テスト' }),
      }),
    );
    check('D4 flag OFF → 404', offRes.status === 404, `status=${offRes.status}`);
    check('D5 flag OFF → outbound fetch 0 回（AI コスト 0）', fetchCalls === 0, `calls=${fetchCalls}`);

    // D6: flag ON。guard を通過することを、AI を呼ばずに確認する。
    //   不正 JSON body → body parse で 400。404 でないこと＝ guard が解禁されている証拠。
    //   400 で止まるので AI 呼び出しには到達しない（fetch は引き続き 0 のまま）。
    process.env.CAREER_COMPANY_MATCHING_ENABLED = 'true';
    const onRes = await POST(
      new Request('http://localhost/api/career/matching', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      }),
    );
    check('D6 flag ON → guard 通過（404 ではない）', onRes.status !== 404, `status=${onRes.status}`);
    check('D6 flag ON → body parse へ到達（400）', onRes.status === 400, `status=${onRes.status}`);
    check('D6 AI へは未到達（fetch なお 0 回）', fetchCalls === 0, `calls=${fetchCalls}`);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.CAREER_COMPANY_MATCHING_ENABLED;
  }

  // ── D7: page route guard ─────────────────────────────────────────
  console.log('\n[D7] page route guard');

  const layoutPath = 'app/career/matching/layout.tsx';
  const hasLayout = existsSync(join(ROOT, layoutPath));
  check('D7 matching segment に layout guard が存在', hasLayout, layoutPath);
  if (hasLayout) {
    const layout = read(layoutPath);
    check('D7 layout が server flag を参照', layout.includes('isCareerCompanyMatchingEnabled'));
    check('D7 layout が notFound() を呼ぶ', layout.includes('notFound()'));
    check(
      'D7 layout は server component（use client でない）',
      !/^\s*['"]use client['"]/m.test(layout),
    );
    // layout は page.tsx / result/page.tsx の共通祖先。両方が同時に塞がることの構造的根拠。
    check(
      'D7 guard 配下に matching page が 2 つとも存在',
      existsSync(join(ROOT, 'app/career/matching/page.tsx')) &&
        existsSync(join(ROOT, 'app/career/matching/result/page.tsx')),
    );
  }

  // ── D8: UI 導線が flag を参照 ─────────────────────────────────────
  console.log('\n[D8] UI 導線');

  const uiSites: Array<[string, string]> = [
    ['Home', 'app/career/home/page.tsx'],
    ['My Page', 'app/career/mypage/mypageSummary.ts'],
    ['GD 結果', 'app/career/gd/GdSoloResultDetail.tsx'],
  ];
  for (const [label, rel] of uiSites) {
    check(
      `D8 ${label} が UI flag を参照`,
      read(rel).includes('isCareerCompanyMatchingUiEnabled'),
      rel,
    );
  }
  // UI 側が server-only flag を誤って import していないこと（client bundle で build error になる）。
  for (const [label, rel] of uiSites) {
    check(
      `D8 ${label} は server-only flag を import しない`,
      !read(rel).includes('careerMatchingGate/flags.server'),
      rel,
    );
  }

  // ── D9: 温存資産 ─────────────────────────────────────────────────
  console.log('\n[D9] 温存資産（削除禁止）');

  const preserved = [
    'lib/careerMatching/index.ts',
    'lib/careerMatching/engine.ts',
    'lib/careerMatching/roadmap.ts',
    'lib/careerMatching/simulation.ts',
    'app/career/matching/matchingStorage.ts',
    'app/career/matching/page.tsx',
    'app/career/matching/result/page.tsx',
    'app/api/career/matching/route.ts',
    'types/careerMatching.ts',
    'scripts/qa-career-matching.ts',
  ];
  for (const rel of preserved) {
    check(`D9 温存: ${rel}`, existsSync(join(ROOT, rel)));
  }
  check(
    'D9 localStorage key careerMatchingResults 温存',
    read('app/career/matching/matchingStorage.ts').includes('careerMatchingResults'),
  );
  check(
    'D9 matching event 種別 温存',
    (() => {
      const t = read('types/careerEvents.ts');
      return t.includes("'matching_run'") && t.includes("'matching'");
    })(),
  );
  check(
    'D9 career_matching_results テーブル DDL 温存',
    read('supabase/career_features_apply.sql').includes('career_matching_results'),
  );

  // ── 結果 ─────────────────────────────────────────────────────────
  console.log(
    failures === 0
      ? '\n✅ ALL PASS — 企業マッチングは延期状態で固定されている\n'
      : `\n❌ ${failures} FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
