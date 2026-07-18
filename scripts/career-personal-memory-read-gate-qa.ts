/*
 * scripts/career-personal-memory-read-gate-qa.ts
 *
 * PASSAI CAREER — P17-M1: Personal Memory READ gate（pure evaluator）default-deny QA（dev-only）。
 *
 * readGate.ts の純粋判定を、実 env / Supabase / I/O を使わず検証する:
 *   - master flag: true/1/yes（trim・大小無視）→ ON。未設定 / 空 / その他 / 非文字列 → OFF（default OFF）。
 *   - canary allowlist: parseCanaryUserIds を共有（不正 UUID 1 件 / cap 超過 / 非文字列 → 設定全体 deny）。
 *   - evaluate: master ON かつ config valid かつ userId が exact 一致のときだけ allow。それ以外は全 deny。
 *   - substring 非一致（allowlist の一部前方一致で通らない）。userId 空 / null / undefined は deny。
 *   - 静的: readGate.ts が env / Supabase / client 生成を import しない（pure・server env は config.server が担う）。
 *
 * 使い方: npx tsx scripts/career-personal-memory-read-gate-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evalPersonalMemoryReadEnabled,
  buildPersonalMemoryReadGateConfig,
  evaluatePersonalMemoryReadGate,
} from '@/lib/careerMemory/persistence/readGate';
import { CAREER_CANARY_MAX_USER_IDS } from '@/lib/careerMemory/persistence/canaryGate';

let failures = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) failures++; };

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const U3 = '33333333-3333-3333-3333-333333333333';

function main() {
  console.log('[1] master flag 判定（default OFF / fail-closed）');
  for (const on of ['true', '1', 'yes', 'TRUE', ' Yes ', 'YES']) {
    check(evalPersonalMemoryReadEnabled(on) === true, `master "${on}" → ON`);
  }
  for (const off of ['false', '0', 'no', '', ' ', 'enabled', 'on', undefined, null, 1, true, {}]) {
    check(evalPersonalMemoryReadEnabled(off as unknown) === false, `master ${JSON.stringify(off)} → OFF`);
  }

  console.log('[2] config build: allowlist parse（不正は設定全体 deny）');
  {
    const ok = buildPersonalMemoryReadGateConfig('true', `${U1},${U2}`);
    check(ok.enabled && ok.valid && ok.userIds.length === 2, '正常 2 UUID → valid');
    const dupe = buildPersonalMemoryReadGateConfig('true', `${U1}, ${U1}`);
    check(dupe.valid && dupe.userIds.length === 1, '重複 UUID → 1 件へ dedupe');
    const bad = buildPersonalMemoryReadGateConfig('true', `${U1},not-a-uuid`);
    check(bad.enabled === true && bad.valid === false && bad.userIds.length === 0, '不正 UUID 1 件混入 → 設定全体 invalid（userIds 空）');
    const empty = buildPersonalMemoryReadGateConfig('true', '');
    check(empty.valid === true && empty.userIds.length === 0, '空 allowlist → valid だが誰も許可しない');
    const unset = buildPersonalMemoryReadGateConfig('true', undefined);
    check(unset.valid === true && unset.userIds.length === 0, '未設定 allowlist → valid だが空');
    const nonStr = buildPersonalMemoryReadGateConfig('true', 123 as unknown);
    check(nonStr.valid === false, '非文字列 allowlist → invalid');
    const overCap = buildPersonalMemoryReadGateConfig(
      'true',
      Array.from({ length: CAREER_CANARY_MAX_USER_IDS + 1 }, (_, i) => `${i.toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`).join(','),
    );
    check(overCap.valid === false, `cap(${CAREER_CANARY_MAX_USER_IDS}) 超過 → invalid`);
  }

  console.log('[3] evaluate: master ON かつ valid かつ exact 一致のみ allow');
  const cfg = buildPersonalMemoryReadGateConfig('true', `${U1},${U2}`);
  check(evaluatePersonalMemoryReadGate(U1, cfg) === true, 'allowlist 内 U1 → allow');
  check(evaluatePersonalMemoryReadGate(U2, cfg) === true, 'allowlist 内 U2 → allow');
  check(evaluatePersonalMemoryReadGate(U3, cfg) === false, 'allowlist 外 U3 → deny');

  console.log('[4] master OFF / config invalid / allowlist 空 → 全 deny');
  check(evaluatePersonalMemoryReadGate(U1, buildPersonalMemoryReadGateConfig('false', `${U1}`)) === false, 'master OFF → deny（allowlist 内でも）');
  check(evaluatePersonalMemoryReadGate(U1, buildPersonalMemoryReadGateConfig('true', `${U1},bad`)) === false, 'config invalid → deny');
  check(evaluatePersonalMemoryReadGate(U1, buildPersonalMemoryReadGateConfig('true', '')) === false, 'allowlist 空 → deny');

  console.log('[5] userId 空/null/undefined → deny・substring 非一致');
  check(evaluatePersonalMemoryReadGate('', cfg) === false, 'userId 空 → deny');
  check(evaluatePersonalMemoryReadGate(null, cfg) === false, 'userId null → deny');
  check(evaluatePersonalMemoryReadGate(undefined, cfg) === false, 'userId undefined → deny');
  check(evaluatePersonalMemoryReadGate(U1.slice(0, 8), cfg) === false, 'userId が prefix 一部 → deny（exact のみ）');
  check(evaluatePersonalMemoryReadGate(` ${U1} `, cfg) === false, 'userId に空白 → deny（正規化しない・server 検証値を渡す前提）');

  console.log('[6] 決定性: 同一入力 → 同一判定');
  check(
    evaluatePersonalMemoryReadGate(U1, cfg) === evaluatePersonalMemoryReadGate(U1, cfg) &&
    evaluatePersonalMemoryReadGate(U3, cfg) === evaluatePersonalMemoryReadGate(U3, cfg),
    'deterministic',
  );

  console.log('[7] static: readGate.ts は env / Supabase / client 生成を import しない（pure）');
  {
    const src = readFileSync(join(process.cwd(), 'lib/careerMemory/persistence/readGate.ts'), 'utf8');
    check(!/process\.env|createClient|getCareer\w*SupabaseClient|serverClient|browserClient|'server-only'/.test(src), 'readGate に env/Supabase/client/server-only の混入なし');
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    check(importLines.every((l) => /'\.\/canaryGate'/.test(l)), 'readGate の import は canaryGate（同層 parser 再利用）のみ');
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-read-gate-qa: ALL PASS' : `career-personal-memory-read-gate-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
