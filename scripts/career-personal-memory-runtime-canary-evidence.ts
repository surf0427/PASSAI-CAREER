/*
 * scripts/career-personal-memory-runtime-canary-evidence.ts
 *
 * PASSAI CAREER — P16-I-X: runtime canary evidence validator（dev-only・offline）。
 *
 * 人間オペレータが Operator Packet に沿って Phase A〜G を実施した後の **metadata-only evidence JSON** を読み、
 * P16-I の判定を自動化する。実 Supabase / network / env 参照なし。never-throw・evidence 内容を dump しない。
 *
 * 使い方:
 *   自己テスト（QA）:  npx tsx scripts/career-personal-memory-runtime-canary-evidence.ts
 *   実 evidence 判定:   npx tsx scripts/career-personal-memory-runtime-canary-evidence.ts --file <path.json>
 */

import { readFileSync } from 'node:fs';
import { CAREER_PERSONAL_MEMORY_SCHEMA_VERSION } from '@/lib/careerMemory/persistence/schema';

export type Verdict =
  | 'PASS — P16-I RUNTIME CANARY COMPLETED'
  | 'CONDITIONAL PASS — RUNTIME CANARY COMPLETED WITH HOLDS'
  | 'INCOMPLETE — REQUIRED EVIDENCE MISSING'
  | 'STOP — SAFETY OR CORRECTNESS FAILURE';

export type ValidationResult = { verdict: Verdict; reasons: string[]; holds: string[] };

// evidence に **絶対に現れてはいけない** field 名（exact・lowercase）。size 等の正当 field を誤検知しない。
const FORBIDDEN_KEYS = new Set([
  'payload', 'payloadbody', 'sourcebody', 'source', 'profile', 'activity', 'values',
  'userid', 'user_id', 'uuid', 'email', 'mail', 'token', 'accesstoken', 'refreshtoken',
  'cookie', 'jwt', 'apikey', 'anonkey', 'servicerolekey', 'url', 'supabaseurl',
  'connectionstring', 'name', 'university', 'phone', 'address',
]);
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const JWT_RE = /eyJ[A-Za-z0-9_-]{20,}/;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;
const URL_RE = /(https?:\/\/|postgres(ql)?:\/\/)/i;

// 機微 field/値の検出（見つかった場所の path のみ返す。値は返さない）。
export function scanSensitive(obj: unknown, path = '$', out: string[] = []): string[] {
  if (out.length > 50) return out;
  if (Array.isArray(obj)) { obj.forEach((v, i) => scanSensitive(v, `${path}[${i}]`, out)); return out; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) out.push(`${path}.${k}: forbidden field`);
      scanSensitive(v, `${path}.${k}`, out);
    }
    return out;
  }
  if (typeof obj === 'string') {
    if (EMAIL_RE.test(obj)) out.push(`${path}: email-like value`);
    if (JWT_RE.test(obj)) out.push(`${path}: jwt-like value`);
    if (UUID_RE.test(obj)) out.push(`${path}: uuid-like value`);
    if (URL_RE.test(obj)) out.push(`${path}: url-like value`);
    if (/revisionshort$/i.test(path) && obj.length > 24) out.push(`${path}: revisionShort too long (possible leak)`);
  }
  return out;
}

function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const present = (v: unknown) => v !== undefined && v !== null;

// 判定の中核（never-throw・sanitized reason のみ）。
export function validateEvidence(raw: unknown): ValidationResult {
  const reasons: string[] = [];
  const holds: string[] = [];
  const stop = (r: string): ValidationResult => ({ verdict: 'STOP — SAFETY OR CORRECTNESS FAILURE', reasons: [r], holds });
  const incomplete = (r: string): ValidationResult => ({ verdict: 'INCOMPLETE — REQUIRED EVIDENCE MISSING', reasons: [r], holds });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return incomplete('evidence is not an object');

  // 0) 機微データ混入 → STOP
  const sensitive = scanSensitive(raw);
  if (sensitive.length) return stop(`sensitive data present (${sensitive.length} finding(s)): ${sensitive.slice(0, 5).join('; ')}`);

  // 1) 明白な安全/正しさ失敗（値が入っていて悪い） → STOP（confirmation gate 前でも拾う）
  const g = (p: string) => get(raw, p);
  if (g('phaseA.masterFlag') === 'OFF' && isNum(g('phaseA.rowCountBefore')) && isNum(g('phaseA.rowCountAfter')) && (g('phaseA.rowCountAfter') as number) > (g('phaseA.rowCountBefore') as number)) return stop('master OFF baseline で row 更新');
  if (g('phaseA.uiError') === true || g('phaseC.uiError') === true || g('phaseE.uiError') === true || g('phaseG.postShutdownUiError') === true) return stop('UI error 検出');
  if (g('phaseC.sourceSaveSucceeded') === false || g('phaseE.sourceSaveSucceeded') === false) return stop('Source 保存失敗');
  if (present(g('phaseB.userAllowlistCount')) && g('phaseB.userAllowlistCount') !== 1) return stop('user allowlist count が 1 以外');
  {
    const secs = g('phaseB.sectionAllowlist');
    if (Array.isArray(secs) && secs.some((s) => s !== 'base')) return stop('section allowlist に base 以外を含む');
  }
  for (const p of ['phaseC.rowCount', 'phaseD.rowCount', 'phaseE.rowCount']) if (isNum(g(p)) && (g(p) as number) > 1) return stop(`${p} > 1（row 重複）`);
  for (const p of ['phaseC.duplicateCount', 'phaseD.duplicateCount', 'phaseE.duplicateCount']) if (isNum(g(p)) && (g(p) as number) > 0) return stop(`${p} > 0（duplicate）`);
  for (const p of ['phaseC.otherSectionCount', 'phaseD.otherSectionCount', 'phaseE.otherSectionCount']) if (isNum(g(p)) && (g(p) as number) > 0) return stop(`${p} > 0（他 section 作成）`);
  if (present(g('phaseC.schemaVersion')) && g('phaseC.schemaVersion') !== CAREER_PERSONAL_MEMORY_SCHEMA_VERSION) return stop('schema version 不一致');
  if (present(g('phaseC.status')) && g('phaseC.status') !== 'fresh') return stop('Phase C status が fresh でない');
  if (isNum(g('phaseC.payloadSizeBytes')) && isNum(g('phaseC.payloadSizeLimit')) && (g('phaseC.payloadSizeBytes') as number) >= (g('phaseC.payloadSizeLimit') as number)) return stop('payload size 上限超過');
  if (g('phaseC.revisionPresent') === false) return stop('Phase C revision 欠損');
  // Phase D: unchanged replay で revision 変化 → STOP
  if (present(g('phaseD.revisionShortBefore')) && present(g('phaseD.revisionShortAfter')) && g('phaseD.revisionShortBefore') !== g('phaseD.revisionShortAfter')) return stop('unchanged replay で revision 変化');
  // Phase E: source 変更で revision 不変 → STOP
  if (present(g('phaseE.revisionShortBefore')) && present(g('phaseE.revisionShortAfter')) && g('phaseE.revisionShortBefore') === g('phaseE.revisionShortAfter')) return stop('Source 変更後も revision 不変');
  if (g('phaseG.rowUpdatedAfterShutdown') === true) return stop('shutdown 後も row 更新');
  if (g('phaseG.productionReadStillDisconnected') === false) return stop('production read 接続を検出');
  if (g('phaseG.promptStillDisconnected') === false) return stop('prompt 接続を検出');
  if (g('phaseG.orchestratorStillDisconnected') === false) return stop('Orchestrator 接続を検出');
  if (typeof g('phaseF.holdReason') === 'string' && /23505|retry storm|unexplained/i.test(String(g('phaseF.holdReason')))) return stop('DB error / retry storm の兆候');

  // 2) 未確定（operator 未確認 or 必須欠損）→ INCOMPLETE
  if (g('general.operatorConfirmation') !== true) return incomplete('general.operatorConfirmation !== true');
  const requiredNonNull = [
    'general.careerDedicatedSupabaseConfirmed', 'general.ddlPreflightPassed', 'general.rlsEnabled',
    'general.ownerPoliciesPresent', 'general.anonPublicPolicyAbsent',
    'phaseA.sourceSaveSucceeded', 'phaseA.rowCountBefore', 'phaseA.rowCountAfter',
    'phaseB.userAllowlistCount', 'phaseC.sourceSaveSucceeded', 'phaseC.rowCount', 'phaseC.schemaVersion',
    'phaseC.status', 'phaseC.revisionPresent', 'phaseC.payloadSizeBytes', 'phaseC.duplicateCount', 'phaseC.otherSectionCount',
    'phaseD.rowCount', 'phaseD.duplicateCount', 'phaseD.otherSectionCount',
    'phaseE.piiFreeChangeConfirmed', 'phaseE.sourceSaveSucceeded', 'phaseE.rowCount', 'phaseE.duplicateCount', 'phaseE.otherSectionCount',
    'phaseG.rollbackDeploymentCompleted', 'phaseG.rowUpdatedAfterShutdown',
    'phaseG.productionReadStillDisconnected', 'phaseG.promptStillDisconnected', 'phaseG.orchestratorStillDisconnected',
  ];
  const missing = requiredNonNull.filter((p) => !present(g(p)));
  if (missing.length) return incomplete(`missing required fields: ${missing.join(', ')}`);

  // 3) 確認系 false → STOP（ここまで来れば operator 確定済み）
  if (g('general.careerDedicatedSupabaseConfirmed') !== true) return stop('CAREER 専用 Supabase 未確認');
  if (g('general.ddlPreflightPassed') !== true) return stop('DDL metadata 不一致');
  if (g('general.rlsEnabled') !== true) return stop('RLS disabled');
  if (g('general.ownerPoliciesPresent') !== true) return stop('owner policy 不足');
  if (g('general.anonPublicPolicyAbsent') !== true) return stop('anon/public policy 存在');
  if (g('phaseA.masterFlag') !== 'OFF') return stop('Phase A で master flag が OFF でない');
  if (g('phaseA.sourceSaveSucceeded') !== true) return stop('Phase A Source 保存失敗');
  if ((g('phaseA.rowCountAfter') as number) !== (g('phaseA.rowCountBefore') as number)) return stop('Phase A で row が変化');
  if ((g('phaseC.rowCount') as number) !== 1) return stop('Phase C row count != 1');
  if (g('phaseC.sectionKey') !== 'base') return stop('Phase C section != base');
  if (g('phaseC.sourceSaveSucceeded') !== true) return stop('Phase C Source 保存失敗');
  if ((g('phaseD.rowCount') as number) !== 1) return stop('Phase D row count != 1');
  if (g('phaseE.piiFreeChangeConfirmed') !== true) return stop('Phase E PII-free 変更未確認');
  if ((g('phaseE.rowCount') as number) !== 1) return stop('Phase E row count != 1');
  if (g('phaseG.masterFlag') !== 'OFF') return stop('Phase G master flag が OFF でない');
  if (g('phaseG.rollbackDeploymentCompleted') !== true) return stop('rollback deployment 失敗');

  // 4) allowed holds（C-3。未検証なら CONDITIONAL 止まり）。PASS には isolated env での明示検証 flag が必要。
  const readBackDone = g('phaseF.executionStatus') === 'DONE' && g('phaseF.adapterFresh') === true && g('phaseF.adapterUsable') === true && g('phaseF.payloadRoundTripConfirmed') === true;
  if (!readBackDone) holds.push('real-row read adapter (Phase F): HOLD');
  if (g('phaseD.repositoryUpsertCountObservable') !== true) holds.push('repository upsert count: NOT OBSERVABLE');
  if (g('general.nonOwnerRlsRuntimeVerified') !== true) holds.push('non-owner RLS runtime denial: HOLD (isolated env)');
  if (g('general.isolatedConcurrencyVerified') !== true) holds.push('DB concurrency (23505 / same-revision): HOLD (isolated env)');

  // 5) 必須 parity は満たす。holds が皆無（read-back DONE + upsert observable + isolated env 検証済）→ PASS。
  //    単一 user canary では isolated env flag が無く holds が残る＝現実的には CONDITIONAL。
  if (holds.length === 0) {
    return { verdict: 'PASS — P16-I RUNTIME CANARY COMPLETED', reasons: ['all mandatory parity + read-back + isolated-env checks verified'], holds };
  }
  return { verdict: 'CONDITIONAL PASS — RUNTIME CANARY COMPLETED WITH HOLDS', reasons: ['mandatory parity verified; some checks HOLD'], holds };
}

// ── CLI / self-test ──
function loadFile(path: string): unknown { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { __parse_error: (e as Error).name }; } }

function selfTest(): number {
  let f = 0;
  const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) f++; };
  const good = (): Record<string, unknown> => ({
    general: { operatorConfirmation: true, careerDedicatedSupabaseConfirmed: true, ddlPreflightPassed: true, rlsEnabled: true, ownerPoliciesPresent: true, anonPublicPolicyAbsent: true, environmentLabel: 'preview', executionDate: '2026-07-12' },
    phaseA: { masterFlag: 'OFF', sourceSaveSucceeded: true, uiError: false, rowCountBefore: 0, rowCountAfter: 0 },
    phaseB: { masterFlag: 'ON', userAllowlistCount: 1, sectionAllowlist: ['base'], deploymentCompleted: true, deploymentHealthy: true },
    phaseC: { sourceSaveSucceeded: true, uiError: false, rowCount: 1, sectionKey: 'base', schemaVersion: 1, status: 'fresh', revisionPresent: true, revisionShort: 'v1:content:aaaa0001', payloadSizeBytes: 900, payloadSizeLimit: 32768, duplicateCount: 0, otherSectionCount: 0 },
    phaseD: { sourceSaveSucceeded: true, uiError: false, rowCount: 1, revisionShortBefore: 'v1:content:aaaa0001', revisionShortAfter: 'v1:content:aaaa0001', duplicateCount: 0, otherSectionCount: 0, repositoryUpsertCountObservable: false },
    phaseE: { piiFreeChangeConfirmed: true, sourceSaveSucceeded: true, uiError: false, rowCount: 1, revisionShortBefore: 'v1:content:aaaa0001', revisionShortAfter: 'v1:content:bbbb0002', duplicateCount: 0, otherSectionCount: 0, changedFieldCategory: 'targetIndustries' },
    phaseF: { executionStatus: 'RUNTIME_HOLD', holdReason: 'no safe runner' },
    phaseG: { masterFlag: 'OFF', rollbackDeploymentCompleted: true, rowUpdatedAfterShutdown: false, productionReadStillDisconnected: true, promptStillDisconnected: true, orchestratorStillDisconnected: true },
  });
  const clone = (o: Record<string, unknown>) => JSON.parse(JSON.stringify(o)) as Record<string, unknown>;

  check(validateEvidence(good()).verdict.startsWith('CONDITIONAL'), 'good evidence (single-user canary) → CONDITIONAL');
  {
    const full = clone(good());
    (full.phaseD as Record<string, unknown>).repositoryUpsertCountObservable = true;
    (full.phaseF as Record<string, unknown>) = { executionStatus: 'DONE', adapterFresh: true, adapterUsable: true, schemaSupported: true, statusUsable: true, payloadRoundTripConfirmed: true };
    // isolated env の検証 flag が無い単一 user canary → PASS ではなく CONDITIONAL（正直な設計）
    check(validateEvidence(full).verdict.startsWith('CONDITIONAL'), 'read-back DONE + observable でも isolated-env 未検証 → CONDITIONAL');
    // isolated env で concurrency / non-owner RLS も検証済 → PASS 到達可能
    (full.general as Record<string, unknown>).nonOwnerRlsRuntimeVerified = true;
    (full.general as Record<string, unknown>).isolatedConcurrencyVerified = true;
    check(validateEvidence(full).verdict.startsWith('PASS'), 'isolated env で全検証済 → PASS 到達可能');
  }
  { const b = clone(good()); delete (b.phaseC as Record<string, unknown>).rowCount; check(validateEvidence(b).verdict.startsWith('INCOMPLETE'), 'missing phaseC.rowCount → INCOMPLETE'); }
  { const b = clone(good()); (b.general as Record<string, unknown>).operatorConfirmation = false; check(validateEvidence(b).verdict.startsWith('INCOMPLETE'), 'operatorConfirmation false → INCOMPLETE'); }
  { const b = clone(good()); (b.phaseC as Record<string, unknown>).rowCount = 2; check(validateEvidence(b).verdict.startsWith('STOP'), 'rowCount 2 → STOP'); }
  { const b = clone(good()); (b.phaseB as Record<string, unknown>).userAllowlistCount = 2; check(validateEvidence(b).verdict.startsWith('STOP'), 'allowlist count 2 → STOP'); }
  { const b = clone(good()); (b.phaseB as Record<string, unknown>).sectionAllowlist = ['base', 'es']; check(validateEvidence(b).verdict.startsWith('STOP'), 'section allowlist に es → STOP'); }
  { const b = clone(good()); (b.phaseA as Record<string, unknown>).rowCountAfter = 1; check(validateEvidence(b).verdict.startsWith('STOP'), 'master OFF で row 増 → STOP'); }
  { const b = clone(good()); (b.phaseD as Record<string, unknown>).revisionShortAfter = 'v1:content:zzzz9999'; check(validateEvidence(b).verdict.startsWith('STOP'), 'unchanged replay で revision 変化 → STOP'); }
  { const b = clone(good()); (b.phaseE as Record<string, unknown>).revisionShortAfter = 'v1:content:aaaa0001'; check(validateEvidence(b).verdict.startsWith('STOP'), 'source 変更で revision 不変 → STOP'); }
  { const b = clone(good()); (b.general as Record<string, unknown>).rlsEnabled = false; check(validateEvidence(b).verdict.startsWith('STOP'), 'RLS disabled → STOP'); }
  { const b = clone(good()); (b.phaseG as Record<string, unknown>).rowUpdatedAfterShutdown = true; check(validateEvidence(b).verdict.startsWith('STOP'), 'shutdown 後 row 更新 → STOP'); }
  { const b = clone(good()); (b.phaseG as Record<string, unknown>).promptStillDisconnected = false; check(validateEvidence(b).verdict.startsWith('STOP'), 'prompt 接続 → STOP'); }
  { const b = clone(good()); (b.phaseC as Record<string, unknown>).operatorEmail = 'a@b.com'; check(validateEvidence(b).verdict.startsWith('STOP'), 'email 値混入 → STOP (sensitive)'); }
  { const b = clone(good()); (b.phaseC as Record<string, unknown>).payload = { x: 1 }; check(validateEvidence(b).verdict.startsWith('STOP'), 'payload field 混入 → STOP (sensitive)'); }
  { const b = clone(good()); (b.phaseC as Record<string, unknown>).revisionShort = '0000aaaa-0000-4000-8000-000000000001'; check(validateEvidence(b).verdict.startsWith('STOP'), 'revisionShort に UUID → STOP (sensitive)'); }
  // never-throw on garbage
  check(validateEvidence(null).verdict.startsWith('INCOMPLETE'), 'null → INCOMPLETE (never-throw)');
  check(validateEvidence('x').verdict.startsWith('INCOMPLETE'), 'string → INCOMPLETE (never-throw)');
  check(validateEvidence({ __parse_error: 'SyntaxError' }).verdict.startsWith('INCOMPLETE'), 'parse-error object → INCOMPLETE');

  console.log('');
  console.log(f === 0 ? 'career-personal-memory-runtime-canary-evidence-qa: ALL PASS' : `career-personal-memory-runtime-canary-evidence-qa: ${f} FAIL`);
  return f;
}

function mainCli() {
  const fileArg = process.argv.indexOf('--file');
  if (fileArg >= 0 && process.argv[fileArg + 1]) {
    const res = validateEvidence(loadFile(process.argv[fileArg + 1]));
    console.log(`VERDICT: ${res.verdict}`);
    console.log(`reasons: ${res.reasons.join(' | ')}`);
    if (res.holds.length) console.log(`holds: ${res.holds.join(' | ')}`);
    process.exit(res.verdict.startsWith('STOP') ? 2 : 0);
  }
  process.exit(selfTest() === 0 ? 0 : 1);
}

// 直接実行時のみ CLI/self-test を走らせる（他 script から import しても副作用なし）。
if ((process.argv[1] ?? '').endsWith('career-personal-memory-runtime-canary-evidence.ts')) mainCli();
