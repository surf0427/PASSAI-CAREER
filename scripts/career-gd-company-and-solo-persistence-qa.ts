/*
 * scripts/career-gd-company-and-solo-persistence-qa.ts
 *
 * PASSAI CAREER — GD の Company Data Spine 到達性 / ソロ GD persistence QA
 * （dev-only 常設・決定的）。
 *
 * 目的:
 *   1) GD は既定で **企業未指定の一般練習**（generic path）であることを維持したまま、
 *      企業ターゲットが渡されたときには Company Data Spine A 層へ到達できることを固定する。
 *      ★ 修正前は room.theme に企業 field が無く、かつ parseRoomThemeInput が未知 key を
 *        落としていたため、値を渡しても正規化で消え、A 層へ **構造的に到達不能**だった。
 *   2) ソロ GD の評価履歴が ES / 面接 / プレゼンと同じ
 *      「localStorage canonical + Supabase mirror + restore」に揃っていることを固定する。
 *
 *   ★ 本 QA が禁止したい退行:
 *     - GD に企業指定を **必須化**してしまう（一般 GD が壊れる）。
 *     - parseRoomThemeInput が再び企業 field を落とす。
 *     - ソロ GD の mirror / restore 配線が外れる。
 *     - マルチ GD（career_gd_room_results / hydrate / scored=false / goodQuotes 検証）へ
 *       不用意に触る。
 *
 * 厳守:
 *   production の純関数・純データを読むだけ。外部 AI 非実行・実データ非参照・DB/Supabase 非接続。
 *
 * 使い方: npx tsx scripts/career-gd-company-and-solo-persistence-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRoomThemeInput } from '@/lib/careerGd/roomThemeInput';
import { gdUsesCompanyOfficial } from '@/app/api/career/gd/resolveCompanyOfficial';
import { buildGdSpinePrompt } from '@/app/api/career/gd/gdSpinePrompt';
import type {
  CompanyOfficialContext,
  CompanyOfficialReadResult,
} from '@/types/careerCompanyOfficial';

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const codeOnly = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

const BASE_THEME = {
  title: 'リモートワークと出社、これからの働き方',
  description: '望ましい働き方についてチームの結論をまとめてください。',
  format: 'free' as const,
};

// ════════════════════════════════════════════════════════════════════
// A. 企業ターゲットが theme 正規化を **生き残る**（旧: ここで消えていた）
// ════════════════════════════════════════════════════════════════════
console.log('\n# A. parseRoomThemeInput が企業ターゲットを保持する');

{
  // A-1 企業なし（既定）= generic。企業 field は付かない。
  const generic = parseRoomThemeInput(BASE_THEME);
  check(generic.ok, 'A-1 企業指定なしのテーマが従来どおり通る');
  if (generic.ok) {
    check(
      generic.theme.companyName === undefined && generic.theme.companyId === undefined,
      'A-1b ★ 企業指定なしでは companyName / companyId が付かない（一般 GD のまま）',
    );
  }

  // A-2 ★ 企業ターゲットありなら保持される（修正の核心）。
  const withCompany = parseRoomThemeInput({
    ...BASE_THEME,
    companyName: '  テスト株式会社  ',
    companyId: '  cmp_123  ',
  });
  check(withCompany.ok, 'A-2 企業ターゲット付きテーマが通る');
  if (withCompany.ok) {
    check(
      withCompany.theme.companyName === 'テスト株式会社',
      'A-2b ★ companyName が正規化を生き残る（trim 済み）',
    );
    check(withCompany.theme.companyId === 'cmp_123', 'A-2c ★ companyId が正規化を生き残る');
  }

  // A-3 companyId 単独は持たせない（企業名の無い ID は使えない）。
  const idOnly = parseRoomThemeInput({ ...BASE_THEME, companyId: 'cmp_123' });
  check(
    idOnly.ok && idOnly.theme.companyId === undefined && idOnly.theme.companyName === undefined,
    'A-3 companyId 単独は破棄される（interview の target 不変条件と同じ）',
  );

  // A-4 長さ上限で bound される。
  const long = parseRoomThemeInput({
    ...BASE_THEME,
    companyName: 'あ'.repeat(500),
    companyId: 'x'.repeat(500),
  });
  check(
    long.ok && (long.theme.companyName?.length ?? 0) <= 120 && (long.theme.companyId?.length ?? 0) <= 64,
    'A-4 companyName / companyId が長さ上限で bound される',
  );

  // A-5 空文字・非文字列は「企業指定なし」に倒れる（必須化しない）。
  const empty = parseRoomThemeInput({ ...BASE_THEME, companyName: '   ', companyId: 42 });
  check(
    empty.ok && empty.theme.companyName === undefined,
    'A-5 空文字 / 非文字列は企業指定なしに倒れる（generic path を壊さない）',
  );
}

// ════════════════════════════════════════════════════════════════════
// B. company-target path と generic path が両方成立する
// ════════════════════════════════════════════════════════════════════
console.log('\n# B. company-target / generic の 2 経路');

{
  // B-1 判定関数: 企業なし → 読みに行かない（I/O ゼロ）。
  check(
    gdUsesCompanyOfficial(null) === false &&
      gdUsesCompanyOfficial(undefined) === false &&
      gdUsesCompanyOfficial({ companyName: null, companyId: null }) === false &&
      gdUsesCompanyOfficial({ companyName: '  ', companyId: '' }) === false,
    'B-1 企業ターゲット無し → Company Data Spine を読まない（generic path）',
  );
  // B-2 企業あり → 読みに行く。
  check(
    gdUsesCompanyOfficial({ companyName: 'テスト株式会社' }) === true &&
      gdUsesCompanyOfficial({ companyId: 'cmp_1' }) === true,
    'B-2 企業ターゲット有り → Company Data Spine を読む（company-target path）',
  );

  // B-3 ★ Spine block: 企業なしなら company block が出ない＝従来と byte 互換。
  const genericParts = buildGdSpinePrompt(null, null);
  check(
    genericParts.block === '' && genericParts.reached.companyOfficial === false,
    'B-3 ★ generic path では Spine block が空（従来 prompt と byte 完全一致）',
  );

  // B-4 ★ 企業公式情報が実データを持つとき company block が実際に prompt へ到達する。
  //     （renderer が purpose allowlist / budget / provenance を強制する経路をそのまま通す）
  const fact = (factKey: string, displayValue: string, factGroup: string) =>
    ({
      factKey,
      factGroup,
      displayValue,
      unit: null,
      asOf: null,
      sourceUrl: 'https://example.com/about',
      sourceType: 'official_site',
      fetchedAt: '2026-08-01T00:00:00.000Z',
      freshness: 'fresh',
      extractionMethod: 'structured',
    }) as unknown as CompanyOfficialContext['facts'][number];

  const companyRead: CompanyOfficialReadResult = {
    status: 'ready',
    data: {
      companyId: 'cmp_qa' as CompanyOfficialContext['companyId'],
      displayName: 'QAテスト株式会社',
      facts: [
        fact('businessDescription', '法人向けソフトウェアの開発・提供', 'profile'),
        fact('desiredCandidateProfile', '自ら課題を定義して動ける人', 'recruiting'),
      ],
      groups: [],
      sourceUrls: ['https://example.com/about'],
      oldestFetchedAt: '2026-08-01T00:00:00.000Z',
      newestFetchedAt: '2026-08-01T00:00:00.000Z',
    },
  };

  const companyParts = buildGdSpinePrompt(null, companyRead);
  check(
    companyParts.reached.companyOfficial === true && companyParts.block !== '',
    'B-4 ★ company-target path で公式情報 block が prompt へ到達する（旧: 構造的に到達不能）',
  );
  if (companyParts.reached.companyOfficial) {
    check(
      companyParts.block.includes('QAテスト株式会社'),
      'B-4b 公式情報 block に企業名が含まれる',
    );
    check(
      companyParts.block.includes('法人向けソフトウェア'),
      'B-4c 公式情報 block に fact が含まれる',
    );
  }
}

// ════════════════════════════════════════════════════════════════════
// C. 配線の静的検査（route が受け口を実際に使っている）
// ════════════════════════════════════════════════════════════════════
console.log('\n# C. GD route の企業ターゲット配線');

{
  const soloSrc = codeOnly(read('app/api/career/gd/feedback/route.ts'));
  // C-1 ★ ソロ評価が resolveGdCompanyOfficial を呼ぶ（旧: null 固定でハードコードされていた）。
  check(
    soloSrc.includes('resolveGdCompanyOfficial'),
    'C-1 ★ ソロ GD 評価が resolveGdCompanyOfficial を呼ぶ',
  );
  check(
    !/buildGdSpinePrompt\(\s*spineCtx\s*,\s*null\s*\)/.test(soloSrc),
    'C-1b ★ buildGdSpinePrompt(spineCtx, null) のハードコードが残っていない',
  );

  const resultSrc = codeOnly(read('app/api/career/gd/room/[roomId]/result/route.ts'));
  // C-2 room result 側は従来どおり theme から企業ターゲットを取る。
  check(
    /gdCompanyTarget\(/.test(resultSrc) && resultSrc.includes('resolveGdCompanyOfficial'),
    'C-2 room result が theme 由来の企業ターゲットで A 層を解決する',
  );

  // C-3 GD は企業指定を必須化していない（THEME_REQUIRED 等の企業必須エラーが無い）。
  const themeInputSrc = read('lib/careerGd/roomThemeInput.ts');
  check(
    !/companyName を入力してください|企業名を入力してください|COMPANY_REQUIRED/.test(themeInputSrc),
    'C-3 ★ GD が企業指定を必須化していない（一般 GD 練習として成立し続ける）',
  );
}

// ════════════════════════════════════════════════════════════════════
// D. ソロ GD persistence（localStorage canonical + mirror + restore）
// ════════════════════════════════════════════════════════════════════
console.log('\n# D. ソロ GD の durable persistence');

{
  const mirrorSrc = read('lib/supabase/careerGdSolo.ts');
  // D-1 既存 repository パターンの再利用（独自同期を作らない）。
  check(
    mirrorSrc.includes('getCareerBrowserSupabaseClient') &&
      mirrorSrc.includes('onConflict: "user_id,client_id"'),
    'D-1 既存 mirror パターン（browser client / natural key upsert）を再利用している',
  );
  // D-2 never-throw（best-effort）。
  check(
    /catch \(err\)[\s\S]*devWarn/.test(mirrorSrc),
    'D-2 mirror が never-throw（DDL 未適用でも GD を止めない）',
  );
  // D-3 read boundary を 2 つ作らず localStorage と同じ normalizer を通す。
  check(
    mirrorSrc.includes('normalizeCareerGdResult'),
    'D-3 mirror 読み取りが localStorage と同じ normalizer を共有する',
  );

  // D-4 保存サイト（ソロ GD 完了）で mirror へ書いている。
  const sessionSrc = codeOnly(read('app/career/gd/session/page.tsx'));
  check(
    sessionSrc.includes('upsertCareerGdSoloResultsToSupabase'),
    'D-4 ソロ GD 完了時に Supabase mirror へ upsert する',
  );
  check(
    /appendGdResult\(result\)/.test(sessionSrc),
    'D-4b localStorage canonical への追記は維持されている',
  );

  // D-5 favorite トグルも mirror へ伝播する（mirror が古いまま残らない）。
  const viewSrc = codeOnly(read('app/career/gd/view/page.tsx'));
  check(
    viewSrc.includes('upsertCareerGdSoloResultsToSupabase'),
    'D-5 favorite トグルが mirror へ伝播する',
  );

  // D-6 restore に配線されている。
  const restoreSrc = read('lib/repository/careerRestore.ts');
  check(
    restoreSrc.includes('listCareerGdSoloResultsFromSupabase') &&
      restoreSrc.includes('careerGdSoloResultsRestore'),
    'D-6 ★ restoreCareerOnce がソロ GD 履歴を復元する',
  );
  check(
    /mergeById\(loadGdResults\(\), remote\)/.test(restoreSrc),
    'D-6b restore が id merge（local 優先）で他機能と同じ方式',
  );
  // D-7 backfill flag key が型に登録されている。
  check(
    read('lib/repository/backfillFlag.ts').includes("'careerGdSoloResultsRestore'"),
    'D-7 restore の feature key が BackfillFeature に登録されている',
  );

  // D-8 DDL が用意されている（適用は operator）。
  const ddl = read('supabase/career_gd_solo_results_apply.sql');
  check(
    ddl.includes('CREATE TABLE IF NOT EXISTS career_gd_solo_results') &&
      ddl.includes('career_gd_solo_results_natural_key UNIQUE (user_id, client_id)'),
    'D-8 DDL が既存 career_* と同じ natural key で用意されている',
  );
  check(
    ddl.includes('ENABLE ROW LEVEL SECURITY') && ddl.includes('auth.uid() = user_id'),
    'D-8b DDL が owner 判定の RLS を張る',
  );
  // SQL コメント（-- 行）を除いた実 statement だけを見る。
  const ddlCode = ddl
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');
  check(
    !/DROP TABLE|TRUNCATE/i.test(ddlCode),
    'D-8c DDL に破壊的操作（DROP / TRUNCATE）が含まれない',
  );
}

// ════════════════════════════════════════════════════════════════════
// E. マルチ GD の既存安全処理を壊していない
// ════════════════════════════════════════════════════════════════════
console.log('\n# E. マルチ GD 非退行');

{
  const multiSrc = read('app/api/career/gd/room/roomFeedback.ts');
  check(/export function verifyQuotes/.test(multiSrc), 'E-1 goodQuotes の原文照合が維持されている');
  const resultSrc = read('app/api/career/gd/room/[roomId]/result/route.ts');
  check(/unscoredEvaluation\(/.test(resultSrc), 'E-2 scored=false（採点不能）処理が維持されている');
  check(
    resultSrc.includes('career_gd_room_results'),
    'E-3 マルチ GD の書き込み先テーブルが変わっていない',
  );
  const soloMirrorCode = codeOnly(read('lib/supabase/careerGdSolo.ts'));
  check(
    soloMirrorCode.includes('career_gd_solo_results') &&
      !soloMirrorCode.includes('career_gd_room_results'),
    'E-4 ★ ソロ mirror がマルチのテーブルを再利用していない（2 系統を混ぜない）',
  );
  // E-5 GD kill switch が全 route に残っている（ソロ feedback 含む）。
  check(
    codeOnly(read('app/api/career/gd/feedback/route.ts')).includes('requireCareerGdEnabled'),
    'E-5 GD kill switch がソロ評価 route に残っている',
  );
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : `❌ ${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
