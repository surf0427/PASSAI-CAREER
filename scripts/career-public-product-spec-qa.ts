/*
 * scripts/career-public-product-spec-qa.ts
 *
 * PASSAI CAREER — **公開仕様と実挙動の一致**を固定する QA（dev-only / 実 DB・実 Stripe 非接続）。
 *
 * 対象は Release Candidate Audit の残り 3 件を 1 つの整合単位として見たもの:
 *   P2-1  Pricing が feature flag OFF の機能を提供機能として約束していた
 *   P2-2  GD に page gate が無く、flag OFF でも画面だけ 200（API だけ 404）だった
 *   P2-4  1 日の利用上限が購入前にどこにも開示されていなかった
 *
 * 不変条件（これが崩れたら公開仕様が実挙動から乖離している）:
 *   [A] 商品 — PASSAI CAREER / ¥3,000 / 単一プラン
 *   [B] 提供機能 — Pricing は server flag から導出し、OFF の機能を約束しない
 *   [C] page gate — GD / 企業マッチングは flag OFF なら segment ごと 404
 *   [D] 利用上限 — 10/10/10/8/5/5/5 を quota の正本から引いて購入前に開示
 *   [E] 文言 — 「ログインなし」等の stale copy が到達可能な画面に残っていない
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-public-product-spec-qa.ts
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAREER_BASIC_DAILY_LIMITS,
  CAREER_DAILY_QUOTA_FEATURES,
  getCareerDailyLimit,
  type CareerDailyQuotaFeature,
} from '../lib/careerQuota/limits';
import { CAREER_QUOTA_ANCHORS } from '../lib/careerQuota/anchors';
import {
  CAREER_PRICING_DISPLAY_AMOUNT,
  CAREER_PRICING_FEATURES,
  CAREER_PRICING_PRODUCT_NAME,
  CAREER_PRICING_QUOTA_HEADING,
  CAREER_PRICING_QUOTA_NOTE,
  CAREER_PRICING_SUMMARY,
  selectAvailableCareerPricingFeatures,
} from '../app/career/pricing/pricingDisplay';
import {
  CAREER_PUBLIC_MONTHLY_PRICE_LABEL,
  CAREER_PUBLIC_PLAN_COUNT,
  CAREER_PUBLIC_PRICE_JPY,
  CAREER_PUBLIC_PRODUCT_NAME,
} from '../lib/careerPricing';
import { evalCareerGdFlag } from '../lib/careerGdGate/flag';
import { evalCareerCompanyMatchingFlag } from '../lib/careerMatchingGate/flag';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** コメント行を除いた実コードだけを検査対象にする（説明コメントの旧文言は許容）。 */
const codeOf = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const PRICING_PAGE = 'app/career/pricing/page.tsx';
const PRICING_DISPLAY = 'app/career/pricing/pricingDisplay.ts';
const GD_LAYOUT = 'app/career/gd/layout.tsx';
const MATCHING_LAYOUT = 'app/career/matching/layout.tsx';

// ═══════════════════════════════════════════════════════════════
console.log('[A] 商品 — PASSAI CAREER / ¥3,000 / 単一プラン');
// ═══════════════════════════════════════════════════════════════
{
  check(CAREER_PUBLIC_PRICE_JPY === 3000, 'CAREER の公開価格は 3,000 円', String(CAREER_PUBLIC_PRICE_JPY));
  check(CAREER_PUBLIC_PLAN_COUNT === 1, '単一プラン（plan count = 1）');
  check(CAREER_PUBLIC_PRODUCT_NAME === 'PASSAI CAREER', '商品名は PASSAI CAREER');
  check(CAREER_PRICING_PRODUCT_NAME === 'PASSAI CAREER', 'Pricing の商品名も PASSAI CAREER');
  check(CAREER_PRICING_DISPLAY_AMOUNT === '¥3,000', 'Pricing の表示価格は ¥3,000');
  check(
    CAREER_PUBLIC_MONTHLY_PRICE_LABEL === '月額3,000円（税込）',
    '文章表記は「月額3,000円（税込）」',
    CAREER_PUBLIC_MONTHLY_PRICE_LABEL,
  );
  // 受験版の価格・プラン名が CAREER Pricing に混入していない。
  //   ★ 説明コメント（「受験版は priceJpy: 2980 …」等の由来メモ）は描画されないので
  //     codeOf で落とし、**実際に描画されうるコード**だけを検査する。
  const pricingSrc = codeOf(read(PRICING_PAGE)) + codeOf(read(PRICING_DISPLAY));
  for (const stale of ['2,980', '2980', '4,980', '4980', 'ベーシックプラン', 'プレミアムプラン']) {
    check(!pricingSrc.includes(stale), `CAREER Pricing に受験版の「${stale}」が無い`);
  }
  // 「無制限」と読ませない。
  check(!/無制限/.test(pricingSrc), 'Pricing に「無制限」表記が無い');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[B] 提供機能 — Pricing は server flag から導出する（P2-1）');
// ═══════════════════════════════════════════════════════════════
{
  const labels = CAREER_PRICING_FEATURES.map((f) => f.label);
  check(labels.length === 7, 'カタログは 7 機能', labels.join('/'));

  // flag と機能の対応（GD / 企業マッチングだけが gate 付き）。
  const gated = CAREER_PRICING_FEATURES.filter((f) => f.gate !== null).map((f) => f.label);
  check(
    gated.length === 2 && gated.includes('GD') && gated.includes('企業マッチング'),
    'gate 付きは GD / 企業マッチングの 2 つだけ',
    gated.join('/'),
  );
  const always = CAREER_PRICING_FEATURES.filter((f) => f.gate === null).map((f) => f.label);
  for (const l of ['自己分析', '企業分析', 'ES', '面接', 'プレゼン']) {
    check(always.includes(l), `常時提供に「${l}」が含まれる`);
  }

  // ★ flag 行列（§27）— OFF の機能を確定提供として出さないこと。
  const off = selectAvailableCareerPricingFeatures({ gd: false, matching: false }).map((f) => f.label);
  check(!off.includes('GD') && !off.includes('企業マッチング'), 'OFF/OFF: GD も企業マッチングも出さない');
  check(off.length === 5, 'OFF/OFF: 常時提供の 5 機能のみ', off.join('/'));

  const gdOnly = selectAvailableCareerPricingFeatures({ gd: true, matching: false }).map((f) => f.label);
  check(gdOnly.includes('GD') && !gdOnly.includes('企業マッチング'), 'ON/OFF: GD だけ出す');

  const matchOnly = selectAvailableCareerPricingFeatures({ gd: false, matching: true }).map((f) => f.label);
  check(!matchOnly.includes('GD') && matchOnly.includes('企業マッチング'), 'OFF/ON: 企業マッチングだけ出す');

  const both = selectAvailableCareerPricingFeatures({ gd: true, matching: true }).map((f) => f.label);
  check(both.length === 7, 'ON/ON: 7 機能すべて出す');

  // Pricing ページが server flag を実際に読んでいること（client flag ではない）。
  const page = codeOf(read(PRICING_PAGE));
  check(/isCareerGdEnabled\(\)/.test(page), 'Pricing は server flag isCareerGdEnabled() を読む');
  check(
    /isCareerCompanyMatchingEnabled\(\)/.test(page),
    'Pricing は server flag isCareerCompanyMatchingEnabled() を読む',
  );
  check(
    !/NEXT_PUBLIC_CAREER_(GD|COMPANY_MATCHING)_ENABLED/.test(page),
    'Pricing は UI flag（NEXT_PUBLIC_*）を提供可否の判定に使わない',
  );
  check(!/process\.env/.test(page), 'Pricing は env を直接読まない（gate helper 経由）');
  check(
    /selectAvailableCareerPricingFeatures\(/.test(page),
    'Pricing は availability を純関数経由で解決する',
  );
  check(
    !/CAREER_PRICING_FEATURES\.map/.test(page),
    'Pricing はカタログ全集合をそのまま描画しない（必ず flag で絞る）',
  );

  // 要約文が flag 依存機能を名指ししていない。
  for (const l of ['GD', '企業マッチング']) {
    check(!CAREER_PRICING_SUMMARY.includes(l), `要約文が「${l}」を無条件に約束しない`);
  }
  check(!/すべての機能/.test(CAREER_PRICING_SUMMARY), '要約文が「すべての機能」と言い切らない');

  // 曖昧な marketing copy で残していない（提供意思の無い機能を匂わせない）。
  const displaySrc = codeOf(read(PRICING_DISPLAY));
  for (const vague of ['順次提供', '近日', 'Coming Soon', '準備中']) {
    check(!displaySrc.includes(vague), `Pricing に曖昧な予告文言「${vague}」が無い`);
  }
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[C] page gate — flag OFF なら segment ごと 404（P2-2）');
// ═══════════════════════════════════════════════════════════════
{
  // GD（今回追加）。
  check(existsSync(join(ROOT, GD_LAYOUT)), 'app/career/gd/layout.tsx が存在する');
  const gdLayout = codeOf(read(GD_LAYOUT));
  check(/isCareerGdEnabled\(\)/.test(gdLayout), 'GD layout は server flag を読む');
  check(/notFound\(\)/.test(gdLayout), 'GD layout は notFound() で閉じる');
  check(
    /flags\.server/.test(gdLayout),
    'GD layout は server-only gate module を使う（client flag ではない）',
  );
  check(
    !/NEXT_PUBLIC_/.test(gdLayout),
    'GD layout は NEXT_PUBLIC_* を読まない（UI flag が ON でも解禁しない）',
  );
  // ★ コメント内の 'use client' への言及（配下 page の説明）に引っかからないよう code だけ見る。
  check(!/use client/.test(gdLayout), 'GD layout は server component（client gate にしない）');
  check(!/useEffect|useState/.test(gdLayout), 'GD layout は client 側 hook で判定しない');

  // 企業マッチング（既存・回帰防止）。
  check(existsSync(join(ROOT, MATCHING_LAYOUT)), 'app/career/matching/layout.tsx が存在する');
  const mLayout = codeOf(read(MATCHING_LAYOUT));
  check(/isCareerCompanyMatchingEnabled\(\)/.test(mLayout), 'matching layout は server flag を読む');
  check(/notFound\(\)/.test(mLayout), 'matching layout は notFound() で閉じる');

  // ★ gate は layout 1 箇所だけ。個々の page に判定を複製していない。
  const gdPages = walkTs(join(ROOT, 'app/career/gd')).filter((f) => f.endsWith('page.tsx'));
  check(gdPages.length > 0, `GD の page を検出（${gdPages.length} 枚）`);
  const duplicated = gdPages.filter((f) =>
    /isCareerGdEnabled|requireCareerGdEnabled|notFound\(\)/.test(codeOf(readFileSync(f, 'utf8'))),
  );
  check(duplicated.length === 0, 'GD の各 page に gate を複製していない（layout 1 箇所）');

  // API 側の gate は従来どおり全 route に掛かっている（回帰防止）。
  const gdApiRoutes = walkTs(join(ROOT, 'app/api/career/gd')).filter((f) => f.endsWith('route.ts'));
  const ungated = gdApiRoutes.filter(
    (f) => !/requireCareerGdEnabled|isCareerGdEnabled|gdDisabledResponse/.test(readFileSync(f, 'utf8')),
  );
  check(
    ungated.length === 0,
    `GD API は全 route が flag gate 済み（${gdApiRoutes.length} route）`,
    ungated.map((f) => f.slice(ROOT.length + 1)).join(', '),
  );

  // flag の既定は OFF（未設定で勝手に有効化されない）。
  check(evalCareerGdFlag(undefined) === false, 'GD flag は未設定で OFF');
  check(evalCareerGdFlag('true') === true, "GD flag は 'true' でのみ ON");
  check(evalCareerGdFlag('1') === false, "GD flag は '1' を受理しない");
  check(evalCareerCompanyMatchingFlag(undefined) === false, 'Matching flag は未設定で OFF');
  check(evalCareerCompanyMatchingFlag('true') === true, "Matching flag は 'true' でのみ ON");
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[D] 利用上限 — 正本から引いて購入前に開示（P2-4）');
// ═══════════════════════════════════════════════════════════════
{
  // 商品仕様値（変更禁止）。
  const EXPECTED: Record<CareerDailyQuotaFeature, number> = {
    self_analysis: 10,
    company_research: 10,
    es: 10,
    interview: 8,
    presentation: 5,
    gd: 5,
    matching: 5,
  };
  for (const f of CAREER_DAILY_QUOTA_FEATURES) {
    check(
      CAREER_BASIC_DAILY_LIMITS[f] === EXPECTED[f],
      `上限 ${f} = ${EXPECTED[f]}`,
      String(CAREER_BASIC_DAILY_LIMITS[f]),
    );
  }

  // ★ UI ラベル → quota bucket → anchor route の対応が実装と一致している（§26）。
  //   ここが取り違うと「ES と書いて面接の上限を出す」事故になる。
  const EXPECTED_ANCHOR: Record<string, string[]> = {
    自己分析: ['app/api/career/self-analysis/route.ts'],
    企業分析: ['app/api/career/company-research/route.ts'],
    ES: ['app/api/career/es-review/route.ts'],
    面接: ['app/api/career/interview/start/route.ts'],
    プレゼン: ['app/api/career/presentation/evaluate/route.ts'],
    GD: [
      'app/api/career/gd/feedback/route.ts',
      'app/api/career/gd/room/[roomId]/result/route.ts',
    ],
    企業マッチング: ['app/api/career/matching/route.ts'],
  };
  for (const feature of CAREER_PRICING_FEATURES) {
    const anchors = CAREER_QUOTA_ANCHORS.filter((a) => a.feature === feature.quota)
      .map((a) => a.route)
      .sort();
    const expected = [...(EXPECTED_ANCHOR[feature.label] ?? [])].sort();
    check(
      anchors.length > 0 && JSON.stringify(anchors) === JSON.stringify(expected),
      `「${feature.label}」→ quota '${feature.quota}' → anchor が実装と一致`,
      anchors.join(', '),
    );
    check(
      getCareerDailyLimit(feature.quota) === EXPECTED[feature.quota],
      `「${feature.label}」の表示上限は ${EXPECTED[feature.quota]} 回`,
    );
  }

  // 就活相談AI は quota bucket を持たない → 一覧に数値を付けない（§21）。
  check(
    !(CAREER_DAILY_QUOTA_FEATURES as readonly string[]).includes('consultation'),
    '就活相談AI は quota feature ではない',
  );
  check(
    !CAREER_PRICING_FEATURES.some((f) => f.label.includes('相談')),
    'Pricing の上限一覧に就活相談AIを混ぜていない',
  );

  // Pricing が上限を **正本から** 引いている（JSX に 7 個 hardcode しない / §22）。
  const page = codeOf(read(PRICING_PAGE));
  check(/getCareerDailyLimit\(/.test(page), 'Pricing は getCareerDailyLimit() で上限を引く');
  check(
    /careerQuota\/limits/.test(page),
    'Pricing は quota の正本 module を参照する',
  );
  const displaySrc = codeOf(read(PRICING_DISPLAY));
  check(
    !/\b(10|8|5)\s*回/.test(displaySrc) && !/\b(10|8|5)\s*回/.test(page.replace(/getCareerDailyLimit\([^)]*\)}回/g, '')),
    'Pricing に上限値を直書きしていない',
  );

  // 開示の中身。
  check(CAREER_PRICING_QUOTA_HEADING.includes('1日'), '見出しが「1日の利用上限」であること');
  check(/日本時間/.test(CAREER_PRICING_QUOTA_NOTE), 'リセット時刻が日本時間で書かれている（§20）');
  check(/0:00/.test(CAREER_PRICING_QUOTA_NOTE), 'リセットは 0:00 と明記');
  check(
    !/保証|必ず.*回/.test(CAREER_PRICING_QUOTA_NOTE),
    '「毎日必ず○回保証」と読ませる表現を使わない（§24）',
  );
  check(
    /CAREER_PRICING_QUOTA_HEADING/.test(page) && /CAREER_PRICING_QUOTA_NOTE/.test(page),
    'Pricing が上限セクションを実際に描画している',
  );

  // ★ 上限一覧は feature 一覧と同じ availability policy に従う（§19）。
  check(
    (page.match(/availableFeatures\.map/g) ?? []).length === 2,
    '機能一覧と上限一覧が同じ availableFeatures を使う（policy が割れない）',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[E] 文言 — 到達可能な画面に stale copy が残っていない');
// ═══════════════════════════════════════════════════════════════
{
  const gdFiles = walkTs(join(ROOT, 'app/career/gd'));
  const staleLoginFree = gdFiles.filter((f) => /ログインなし|ログイン不要/.test(readFileSync(f, 'utf8')));
  check(
    staleLoginFree.length === 0,
    'GD 画面に「ログインなし / ログイン不要」が 0 件',
    staleLoginFree.map((f) => f.slice(ROOT.length + 1)).join(', '),
  );

  // 受験版 route への dead link（P1-3 で 404 化済み）が GD に残っていない。
  const deadLinks = gdFiles.filter((f) => /['"`]\/login\?|['"`]\/login['"`]/.test(readFileSync(f, 'utf8')));
  check(
    deadLinks.length === 0,
    'GD 画面が受験版 /login（現在 404）へリンクしていない',
    deadLinks.map((f) => f.slice(ROOT.length + 1)).join(', '),
  );

  // ログイン導線は CAREER のものを指す。
  const loginLinkFiles = gdFiles.filter((f) => /career\/login/.test(readFileSync(f, 'utf8')));
  check(loginLinkFiles.length >= 1, 'GD のログイン導線は /career/login を指す');
}

console.log('');
console.log(
  failures === 0
    ? 'career-public-product-spec-qa: ALL PASS — 公開仕様が実挙動と一致している。'
    : `career-public-product-spec-qa: ${failures} FAIL`,
);
process.exit(failures === 0 ? 0 : 1);

// ── helpers ────────────────────────────────────────────────────
function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}
