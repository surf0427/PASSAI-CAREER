/*
 * scripts/career-event-callsite-contract-qa.ts
 *
 * PASSAI CAREER — 主要 8 機能（GD solo/room 含む 9 call site）の event payload 契約 静的 QA（P9-H）。
 *
 * 背景（P9-F/G で残った既知ギャップ）:
 *   各 call site が「fire-and-forget / 安定 clientEventId / 有効 enum / 本文 key 非注入」を
 *   満たすことは目視監査のみで、回帰固定が無かった。P9-H で contract test として固定する。
 *
 * 設計（脆さ回避）:
 *   - 行番号固定・全文 snapshot は使わない。manifest（file + 期待 feature/eventType）と
 *     必須 token / balanced-paren 抽出で契約を照合する。
 *   - production behavior は変更しない（読むだけ）。
 *
 * 何を守るか:
 *   1. 9 call site すべてが `void recordCareerEvent(` を使う（await していない = fire-and-forget）。
 *   2. 各 call site の feature / eventType が manifest と一致し、CAREER_EVENT_FEATURES /
 *      CAREER_EVENT_TYPES の部分集合である（enum 整合）。
 *   3. すべての call site が `clientEventId` を渡す（consultation 含む安定 ID・冪等性の前提）。
 *   4. call site の recordCareerEvent 引数に **本文 / PII key を注入していない**
 *      （userInput / prompt / response / text / body / answer / 氏名 / join code など）。
 *
 * 使い方: npx tsx scripts/career-event-callsite-contract-qa.ts
 * 終了コード: 全 assertion PASS → 0 / いずれか FAIL → 1。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CAREER_EVENT_FEATURES, CAREER_EVENT_TYPES } from '@/types/careerEvents';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// call site の manifest（label / 相対パス / 期待 feature / 期待 eventType）。
//
// ★ NEXT-1（Data Spine 2026-08-14）: ESトレーニング再設計で `app/career/es/run/page.tsx` が廃止され、
//   ES は new（起票）/ draft（初回添削）/ [id]（再添削）の 3 call site へ分割された。自己分析は
//   `run/page.tsx` から `finalizeSummary.ts`（完了時の canonical 保存点）へ移動した。
//   manifest を現構造へ追随させる（assertion は削っていない。むしろ [6] で「manifest 網羅性」を追加した）。
const CALL_SITES = [
  { label: 'matching', file: 'app/career/matching/page.tsx', feature: 'matching', eventType: 'matching_run' },
  { label: 'consultation', file: 'app/career/consultation/page.tsx', feature: 'consultation', eventType: 'consultation_asked' },
  { label: 'interview', file: 'app/career/interview/session/page.tsx', feature: 'interview', eventType: 'feature_completed' },
  { label: 'es_new', file: 'app/career/es/new/page.tsx', feature: 'es', eventType: 'feature_started' },
  { label: 'es_draft_review', file: 'app/career/es/draft/[draftId]/page.tsx', feature: 'es', eventType: 'ai_generated' },
  { label: 'es_log_review', file: 'app/career/es/[id]/page.tsx', feature: 'es', eventType: 'ai_generated' },
  { label: 'presentation', file: 'app/career/presentation/session/page.tsx', feature: 'presentation', eventType: 'feature_completed' },
  { label: 'company_research', file: 'app/career/company-research/do/page.tsx', feature: 'company_research', eventType: 'company_researched' },
  { label: 'self_analysis', file: 'app/career/self-analysis/finalizeSummary.ts', feature: 'self_analysis', eventType: 'ai_generated' },
  { label: 'gd_solo', file: 'app/career/gd/session/page.tsx', feature: 'gd', eventType: 'feature_completed' },
  { label: 'gd_room', file: 'app/career/gd/room/[roomId]/page.tsx', feature: 'gd', eventType: 'feature_completed' },
] as const;

// 主要 8 機能（feature 単位の網羅性。call site 数は feature ごとに 1 とは限らない）。
const EXPECTED_FEATURES = [
  'matching', 'consultation', 'interview', 'es', 'presentation',
  'company_research', 'self_analysis', 'gd',
] as const;

// recordCareerEvent 引数へ現れてはならない本文 / PII の object key（`key:` 形で検査）。
const FORBIDDEN_KEYS = [
  'userInput', 'prompt', 'response', 'text', 'body', 'content', 'answer',
  'question', 'transcript', 'message', 'memo', 'note', 'comment', 'summary',
  'description', 'reason', 'name', 'email', 'university', 'companyName',
  'joinCode', 'roomTitle', 'participantName', 'displayName', 'topic',
];

// `recordCareerEvent(` 直後から balanced paren で呼び出し全文を切り出す（引数 object を含む）。
function extractCall(src: string): string | null {
  const marker = 'recordCareerEvent(';
  const start = src.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  const from = start + marker.length - 1; // '(' の位置
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

// ── 0. グローバル: await recordCareerEvent が存在しない ────────────────
console.log('[0] fire-and-forget（await 不使用）');
{
  let anyAwait = false;
  for (const cs of CALL_SITES) {
    const src = readFileSync(join(process.cwd(), cs.file), 'utf8');
    if (/await\s+recordCareerEvent\s*\(/.test(src)) anyAwait = true;
  }
  check('どの call site も await recordCareerEvent を使わない', !anyAwait);
}

// ── 1〜4. 各 call site の契約 ──────────────────────────────────────
const foundFeatures = new Set<string>();
const foundEventTypes = new Set<string>();

for (const cs of CALL_SITES) {
  console.log(`[${cs.label}] ${cs.file}`);
  const src = readFileSync(join(process.cwd(), cs.file), 'utf8');

  check(`${cs.label}: void recordCareerEvent(`, /void\s+recordCareerEvent\s*\(/.test(src));

  const call = extractCall(src);
  check(`${cs.label}: recordCareerEvent 呼び出しを抽出できる`, call !== null);
  if (!call) continue;

  check(`${cs.label}: feature: '${cs.feature}'`, new RegExp(`feature:\\s*'${cs.feature}'`).test(call));
  check(`${cs.label}: eventType: '${cs.eventType}'`, new RegExp(`eventType:\\s*'${cs.eventType}'`).test(call));
  check(`${cs.label}: feature ∈ CAREER_EVENT_FEATURES`, (CAREER_EVENT_FEATURES as readonly string[]).includes(cs.feature));
  check(`${cs.label}: eventType ∈ CAREER_EVENT_TYPES`, (CAREER_EVENT_TYPES as readonly string[]).includes(cs.eventType));
  check(`${cs.label}: clientEventId を渡す`, /clientEventId\s*:/.test(call));

  foundFeatures.add(cs.feature);
  foundEventTypes.add(cs.eventType);

  // 本文 / PII key を object key として注入していないこと（`key:` パターン）。
  const injected = FORBIDDEN_KEYS.filter((k) => new RegExp(`\\b${k}\\s*:`).test(call));
  check(`${cs.label}: 本文/PII key 非注入`, injected.length === 0, injected.length ? `injected=${injected.join(',')}` : undefined);
}

// ── 5. 集合整合（call site 側 ⊆ enum） ────────────────────────────
console.log('[5] enum 部分集合');
{
  for (const f of foundFeatures) {
    check(`feature "${f}" ⊆ CAREER_EVENT_FEATURES`, (CAREER_EVENT_FEATURES as readonly string[]).includes(f));
  }
  for (const t of foundEventTypes) {
    check(`eventType "${t}" ⊆ CAREER_EVENT_TYPES`, (CAREER_EVENT_TYPES as readonly string[]).includes(t));
  }
  for (const f of EXPECTED_FEATURES) {
    check(`主要機能 "${f}" の call site が manifest にある`, CALL_SITES.some((c) => c.feature === f));
  }
  check('GD は solo/room の 2 経路が feature=gd で存在', CALL_SITES.filter((c) => c.feature === 'gd').length === 2);
  check('ES は new/draft/[id] の 3 経路が feature=es で存在', CALL_SITES.filter((c) => c.feature === 'es').length === 3);
}

// ── 6. manifest 網羅性（stale manifest の再発防止） ─────────────────
//   app/ 配下で recordCareerEvent( を呼ぶ実 call site 集合と manifest が **完全一致** すること。
//   これにより「機能が移動して manifest が古くなる」（NEXT-1 の原因）が次回は自動検知される。
console.log('[6] manifest 網羅性（実 call site 集合 === manifest）');
{
  const APP_DIR = join(process.cwd(), 'app');
  const actual = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        walk(abs);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const src = readFileSync(abs, 'utf8');
      // import 行ではなく実呼び出しのみ（`recordCareerEvent(`）。
      if (/(?:^|[^.\w])recordCareerEvent\s*\(/m.test(src)) {
        actual.add(relative(process.cwd(), abs).split(sep).join('/'));
      }
    }
  };
  walk(APP_DIR);
  const declared = new Set<string>(CALL_SITES.map((c) => c.file));
  const missing = [...actual].filter((f) => !declared.has(f)).sort();
  const stale = [...declared].filter((f) => !actual.has(f)).sort();
  check('manifest 未登録の call site が無い', missing.length === 0, missing.join(','));
  check('manifest に存在しない / event を送らない stale entry が無い', stale.length === 0, stale.join(','));
}

console.log('');
if (failures === 0) {
  console.log('career-event-callsite-contract-qa: ALL PASS');
  process.exit(0);
} else {
  console.error(`career-event-callsite-contract-qa: ${failures} FAIL`);
  process.exit(1);
}
