/*
 * scripts/career-data-spine-l4-shadow-evidence-validator.ts
 *
 * PASSAI CAREER — Layer 4 shadow evidence validator（P17-E §9）。
 *
 * 実 DB へ接続しない。operator が保存した evidence JSON を読み、PASS / STOP / INCOMPLETE を判定する。
 *
 * 使い方:
 *   npx tsx scripts/career-data-spine-l4-shadow-evidence-validator.ts path/to/evidence.json
 *   cat evidence.json | npx tsx scripts/career-data-spine-l4-shadow-evidence-validator.ts
 */

import { readFileSync } from 'node:fs';
import { validateShadowEvidence } from '@/lib/careerAggregate/shadowEvidence';

function readInput(): string {
  const argPath = process.argv[2];
  if (argPath) return readFileSync(argPath, 'utf8');
  try {
    return readFileSync(0, 'utf8'); // stdin
  } catch {
    return '';
  }
}

const raw = readInput().trim();
if (raw === '') {
  console.error('INCOMPLETE — evidence 入力がありません（path 引数 or stdin）。');
  process.exit(2);
}

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch {
  console.error('STOP — evidence JSON を parse できません。');
  process.exit(1);
}

// 配列（複数 run）にも対応。
const items = Array.isArray(parsed) ? parsed : [parsed];
let worst: 'PASS' | 'INCOMPLETE' | 'STOP' = 'PASS';
for (const item of items) {
  const { verdict, reasons } = validateShadowEvidence(item);
  console.log(`${verdict} — ${reasons.join(', ')}`);
  if (verdict === 'STOP') worst = 'STOP';
  else if (verdict === 'INCOMPLETE' && worst !== 'STOP') worst = 'INCOMPLETE';
}

console.log(`\nVERDICT: ${worst}`);
process.exit(worst === 'PASS' ? 0 : worst === 'INCOMPLETE' ? 2 : 1);
