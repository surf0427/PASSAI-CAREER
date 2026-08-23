/*
 * scripts/career-consultation-action-gate-qa.ts
 *
 * PASSAI CAREER — 就活相談AI の「次アクション導線」が **到達できない機能を勧めない**
 * ことを固定する QA（決定的・外部 I/O 無し）。
 *
 * 背景（この QA が生まれた defect）:
 *   /career/matching と /career/gd は公開ゲートを持ち、server flag が OFF のとき
 *   segment layout が notFound() を返す（本番の /career/matching は 404）。
 *   一方 consultation の system prompt は feature 許可リストに `matching` を含めており、
 *   AI が `feature:'matching'` を返すと client（ActionItem）が
 *   actionFeatureHref() の結果をそのまま LinkButton にして描画していた。
 *   結果、**有料ユーザーが相談AIの推薦ボタンを押すと 404 に着地**していた。
 *
 * 固定する契約:
 *   [UNIT]   isCareerConsultationActionFeatureReachable の全 feature × gate 組合せ。
 *   [UNIT]   normalizeRecommendedActions 相当の filter 意味論（gate OFF はアクションごと落とす）。
 *   [STATIC] route が **server flag**（NEXT_PUBLIC_* ではない）を読み、gates を
 *            normalizeResult へ渡していること。
 *   [STATIC] app/career/<seg>/layout.tsx が notFound() を持つ（＝ gate 付き）segment を
 *            指す action feature が、必ず reachability 判定の対象になっていること。
 *            → 将来 gate 付き segment が増えても、この QA が漏れを落とす。
 *
 * 実行: npx tsx scripts/career-consultation-action-gate-qa.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import {
  CAREER_CONSULTATION_ACTION_FEATURES,
  actionFeatureHref,
  isCareerConsultationActionFeatureReachable,
  type CareerConsultationFeatureGates,
} from '../lib/careerConsultation/actionLinks';
import type { CareerConsultationActionFeature } from '../types/careerConsultation';

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name);
  }
}

// ── [UNIT] 到達可能性の全組合せ ───────────────────────────────────────
const GATED: readonly CareerConsultationActionFeature[] = ['matching', 'gd'];

for (const feature of CAREER_CONSULTATION_ACTION_FEATURES) {
  const allOn: CareerConsultationFeatureGates = { matching: true, gd: true };
  const allOff: CareerConsultationFeatureGates = { matching: false, gd: false };
  check(
    `${feature}: gate ON なら到達可能`,
    isCareerConsultationActionFeatureReachable(feature, allOn) === true,
  );
  const expectedWhenOff = !GATED.includes(feature);
  check(
    `${feature}: gate OFF のとき ${expectedWhenOff ? '到達可能のまま' : '到達不可'}`,
    isCareerConsultationActionFeatureReachable(feature, allOff) === expectedWhenOff,
  );
}

// gate は互いに独立（片方 OFF がもう片方を巻き込まない）。
check(
  'matching OFF は gd を巻き込まない',
  isCareerConsultationActionFeatureReachable('gd', { matching: false, gd: true }) === true,
);
check(
  'gd OFF は matching を巻き込まない',
  isCareerConsultationActionFeatureReachable('matching', { matching: true, gd: false }) === true,
);

// ── [UNIT] filter 意味論（gate OFF はアクションごと落とす）─────────────
type Action = { label: string; feature?: CareerConsultationActionFeature };
function filterActions(
  actions: Action[],
  gates: CareerConsultationFeatureGates,
): Action[] {
  return actions.filter(
    (a) => !a.feature || isCareerConsultationActionFeatureReachable(a.feature, gates),
  );
}

{
  const actions: Action[] = [
    { label: 'ESを書く', feature: 'es' },
    { label: 'マッチングを実行する', feature: 'matching' },
    { label: 'GD練習をする', feature: 'gd' },
    { label: 'feature 無しの助言' },
  ];
  const kept = filterActions(actions, { matching: false, gd: true });
  check('matching OFF: matching アクションが落ちる', !kept.some((a) => a.feature === 'matching'));
  check('matching OFF: 他は残る', kept.length === 3);
  check('feature 無しのアクションは常に残る', kept.some((a) => a.feature === undefined));

  const keptAllOn = filterActions(actions, { matching: true, gd: true });
  check('全 gate ON なら 1 件も落ちない', keptAllOn.length === actions.length);
}

// ── [STATIC] route が server flag を読み gates を渡している ──────────────
{
  const routePath = path.join(ROOT, 'app/api/career/consultation/route.ts');
  const src = readFileSync(routePath, 'utf8');

  check(
    'route: matching の server flag を import している',
    src.includes("from '@/lib/careerMatchingGate/flags.server'"),
  );
  check(
    'route: GD の server flag を import している',
    src.includes("from '@/lib/careerGdGate/flags.server'"),
  );
  check(
    'route: NEXT_PUBLIC_* の gate は読まない（server flag が最終権限）',
    !/NEXT_PUBLIC_CAREER_(COMPANY_MATCHING|GD)_ENABLED/.test(src),
  );
  check(
    'route: gates を normalizeResult へ渡している',
    /normalizeResult\(\s*JSON\.parse\(extractJson\(raw\)\),\s*actionGates\s*\)/.test(src),
  );
  check(
    'route: reachability 判定を normalize 内で使っている',
    src.includes('isCareerConsultationActionFeatureReachable'),
  );
}

// ── [STATIC] gate 付き segment を指す feature は必ず判定対象 ────────────
//
// app/career/<seg>/layout.tsx が notFound() を持つ segment は「公開ゲートあり」。
// その segment を href に持つ action feature が GATED に含まれていなければ、
// その feature の CTA は gate OFF 時に 404 を出す（＝ 今回直した defect の再発）。
{
  for (const feature of CAREER_CONSULTATION_ACTION_FEATURES) {
    const href = actionFeatureHref(feature);
    if (!href || !href.startsWith('/career/')) continue;
    const segment = href.split('/')[2] ?? '';
    if (!segment) continue;
    const layoutPath = path.join(ROOT, 'app/career', segment, 'layout.tsx');
    if (!existsSync(layoutPath)) continue;
    const gatedLayout = readFileSync(layoutPath, 'utf8').includes('notFound()');
    if (!gatedLayout) continue;
    check(
      `gate 付き segment /career/${segment} を指す feature '${feature}' は reachability 判定の対象`,
      GATED.includes(feature),
    );
  }
}

console.log(`\ncareer-consultation-action-gate-qa: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
