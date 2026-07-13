/*
 * scripts/career-personal-memory-runtime-canary-report.ts
 *
 * PASSAI CAREER — P16-I-X: runtime canary report generator（dev-only・offline）。
 *
 * Evidence Validator の結果から P16-I 最終報告の草案（markdown）を生成する。evidence 未入力・不完全を
 * 「実行済み」と誤認させる文章を生成しない。secret/PII/URL/token/UUID/payload 本文を出力しない。
 *
 * 使い方:
 *   自己テスト（QA）:  npx tsx scripts/career-personal-memory-runtime-canary-report.ts
 *   実 evidence 報告:   npx tsx scripts/career-personal-memory-runtime-canary-report.ts --file <path.json>
 */

import { readFileSync } from 'node:fs';
import { validateEvidence, scanSensitive, type ValidationResult } from './career-personal-memory-runtime-canary-evidence';

const yn = (v: unknown): string => (v === true ? 'yes' : v === false ? 'no' : v === undefined || v === null ? '—' : String(v));
const g = (o: unknown, p: string): unknown => p.split('.').reduce<unknown>((c, s) => (c && typeof c === 'object' ? (c as Record<string, unknown>)[s] : undefined), o);

export function generateReport(evidence: unknown): string {
  const res: ValidationResult = validateEvidence(evidence);
  const executed = res.verdict.startsWith('PASS') || res.verdict.startsWith('CONDITIONAL');
  const L: string[] = [];
  L.push('# P16-I Runtime Canary — Report (auto-draft)');
  L.push('');
  L.push(`**VERDICT: ${res.verdict}**`);
  if (!executed) {
    L.push('');
    L.push('> ⚠️ この evidence では runtime canary は **実行済みと確認できない**。以下は入力済み metadata のみの要約であり、');
    L.push('> canary 完了・row parity 成立を主張しない。');
  }
  L.push('');
  const row = (n: string, v: string) => L.push(`- ${n}: ${v}`);
  L.push('## 1. 実行環境'); row('environment', yn(g(evidence, 'general.environmentLabel'))); row('date', yn(g(evidence, 'general.executionDate'))); row('operatorConfirmation', yn(g(evidence, 'general.operatorConfirmation')));
  L.push('## 2. DDL preflight'); row('ddlPreflightPassed', yn(g(evidence, 'general.ddlPreflightPassed'))); row('careerDedicatedSupabase', yn(g(evidence, 'general.careerDedicatedSupabaseConfirmed')));
  L.push('## 3. RLS metadata'); row('rlsEnabled', yn(g(evidence, 'general.rlsEnabled'))); row('ownerPoliciesPresent', yn(g(evidence, 'general.ownerPoliciesPresent'))); row('anonPublicPolicyAbsent', yn(g(evidence, 'general.anonPublicPolicyAbsent')));
  L.push('## 4. Phase A（master OFF baseline）'); row('masterFlag', yn(g(evidence, 'phaseA.masterFlag'))); row('sourceSaveSucceeded', yn(g(evidence, 'phaseA.sourceSaveSucceeded'))); row('rowBefore/After', `${yn(g(evidence, 'phaseA.rowCountBefore'))}/${yn(g(evidence, 'phaseA.rowCountAfter'))}`); row('uiError', yn(g(evidence, 'phaseA.uiError')));
  L.push('## 5. Phase B（gate 設定）'); row('masterFlag', yn(g(evidence, 'phaseB.masterFlag'))); row('userAllowlistCount', yn(g(evidence, 'phaseB.userAllowlistCount'))); row('sectionAllowlist', yn(g(evidence, 'phaseB.sectionAllowlist')));
  L.push('## 6. Phase C（initial write）'); row('rowCount', yn(g(evidence, 'phaseC.rowCount'))); row('sectionKey', yn(g(evidence, 'phaseC.sectionKey'))); row('schemaVersion', yn(g(evidence, 'phaseC.schemaVersion'))); row('status', yn(g(evidence, 'phaseC.status'))); row('revisionPresent', yn(g(evidence, 'phaseC.revisionPresent'))); row('payloadSizeBytes', yn(g(evidence, 'phaseC.payloadSizeBytes'))); row('duplicateCount', yn(g(evidence, 'phaseC.duplicateCount'))); row('otherSectionCount', yn(g(evidence, 'phaseC.otherSectionCount')));
  L.push('## 7. Phase D（unchanged replay）'); row('rowCount', yn(g(evidence, 'phaseD.rowCount'))); row('revisionChanged', yn(g(evidence, 'phaseD.revisionShortBefore') !== g(evidence, 'phaseD.revisionShortAfter'))); row('repositoryUpsertCountObservable', yn(g(evidence, 'phaseD.repositoryUpsertCountObservable')));
  L.push('## 8. Phase E（Source 変更）'); row('changedFieldCategory', yn(g(evidence, 'phaseE.changedFieldCategory'))); row('piiFreeChangeConfirmed', yn(g(evidence, 'phaseE.piiFreeChangeConfirmed'))); row('revisionChanged', yn(g(evidence, 'phaseE.revisionShortBefore') !== g(evidence, 'phaseE.revisionShortAfter'))); row('rowCount', yn(g(evidence, 'phaseE.rowCount')));
  L.push('## 9. Phase F（read-back）'); row('executionStatus', yn(g(evidence, 'phaseF.executionStatus'))); row('adapterFresh', yn(g(evidence, 'phaseF.adapterFresh'))); row('adapterUsable', yn(g(evidence, 'phaseF.adapterUsable')));
  L.push('## 10. Phase G（shutdown）'); row('masterFlag', yn(g(evidence, 'phaseG.masterFlag'))); row('rollbackDeploymentCompleted', yn(g(evidence, 'phaseG.rollbackDeploymentCompleted'))); row('rowUpdatedAfterShutdown', yn(g(evidence, 'phaseG.rowUpdatedAfterShutdown')));
  L.push('## 11. row parity'); row('Phase C rowCount', yn(g(evidence, 'phaseC.rowCount'))); row('Phase D rowCount', yn(g(evidence, 'phaseD.rowCount'))); row('Phase E rowCount', yn(g(evidence, 'phaseE.rowCount')));
  L.push('## 12. revision parity');
  {
    const ce = g(evidence, 'phaseC.expectedRevisionShort'); const cs = g(evidence, 'phaseC.storedRevisionShort');
    row('C expected==stored (prefix<=20)', ce !== undefined && ce !== null && cs !== undefined && cs !== null ? yn(ce === cs) : '—');
  }
  row('D unchanged→不変', yn(g(evidence, 'phaseD.revisionShortBefore') === g(evidence, 'phaseD.revisionShortAfter'))); row('E changed→変化', yn(g(evidence, 'phaseE.revisionShortBefore') !== g(evidence, 'phaseE.revisionShortAfter')));
  L.push('## 13. duplicate 確認'); row('C/D/E duplicateCount', `${yn(g(evidence, 'phaseC.duplicateCount'))}/${yn(g(evidence, 'phaseD.duplicateCount'))}/${yn(g(evidence, 'phaseE.duplicateCount'))}`);
  L.push('## 14. 他 section 非作成'); row('C/D/E otherSectionCount', `${yn(g(evidence, 'phaseC.otherSectionCount'))}/${yn(g(evidence, 'phaseD.otherSectionCount'))}/${yn(g(evidence, 'phaseE.otherSectionCount'))}`);
  L.push('## 15. UI / Source 非影響'); row('uiError (A/C/E/G)', `${yn(g(evidence, 'phaseA.uiError'))}/${yn(g(evidence, 'phaseC.uiError'))}/${yn(g(evidence, 'phaseE.uiError'))}/${yn(g(evidence, 'phaseG.postShutdownUiError'))}`);
  L.push('## 16. secret / PII 非出力'); row('sensitive findings in evidence', String(scanSensitive(evidence).length));
  L.push('## 17. production read 未配線'); row('productionReadStillDisconnected', yn(g(evidence, 'phaseG.productionReadStillDisconnected')));
  L.push('## 18. prompt / Orchestrator 未接続'); row('prompt/orchestrator disconnected', `${yn(g(evidence, 'phaseG.promptStillDisconnected'))}/${yn(g(evidence, 'phaseG.orchestratorStillDisconnected'))}`);
  L.push('## 19. HOLD'); if (res.holds.length) res.holds.forEach((h) => L.push(`- ${h}`)); else L.push('- （なし）');
  L.push('## 20. 総合判定'); L.push(`- ${res.verdict}`); res.reasons.forEach((r) => L.push(`  - ${r}`));
  if (!executed) L.push('- ⚠️ runtime canary は COMPLETED 扱いにしない。');
  return L.join('\n');
}

function selfTest(): number {
  let f = 0;
  const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) f++; };
  const complete = {
    general: { operatorConfirmation: true, careerDedicatedSupabaseConfirmed: true, ddlPreflightPassed: true, rlsEnabled: true, ownerPoliciesPresent: true, anonPublicPolicyAbsent: true, environmentLabel: 'preview', executionDate: '2026-07-12' },
    phaseA: { masterFlag: 'OFF', sourceSaveSucceeded: true, uiError: false, rowCountBefore: 0, rowCountAfter: 0 },
    phaseB: { masterFlag: 'ON', userAllowlistCount: 1, sectionAllowlist: ['base'], deploymentCompleted: true, deploymentHealthy: true },
    phaseC: { sourceSaveSucceeded: true, uiError: false, rowCount: 1, sectionKey: 'base', schemaVersion: 1, status: 'fresh', revisionPresent: true, revisionShort: 'v1:content:aaaa0001', payloadSizeBytes: 900, payloadSizeLimit: 32768, duplicateCount: 0, otherSectionCount: 0 },
    phaseD: { sourceSaveSucceeded: true, uiError: false, rowCount: 1, revisionShortBefore: 'v1:content:aaaa0001', revisionShortAfter: 'v1:content:aaaa0001', duplicateCount: 0, otherSectionCount: 0, repositoryUpsertCountObservable: false },
    phaseE: { piiFreeChangeConfirmed: true, sourceSaveSucceeded: true, uiError: false, rowCount: 1, revisionShortBefore: 'v1:content:aaaa0001', revisionShortAfter: 'v1:content:bbbb0002', duplicateCount: 0, otherSectionCount: 0, changedFieldCategory: 'targetIndustries' },
    phaseF: { executionStatus: 'RUNTIME_HOLD', holdReason: 'no safe runner' },
    phaseG: { masterFlag: 'OFF', rollbackDeploymentCompleted: true, rowUpdatedAfterShutdown: false, productionReadStillDisconnected: true, promptStillDisconnected: true, orchestratorStillDisconnected: true },
  };
  const rc = generateReport(complete);
  check(rc.includes('CONDITIONAL PASS'), 'complete evidence → CONDITIONAL verdict in report');
  check(/## 1\./.test(rc) && /## 20\./.test(rc), '20 セクションを含む');
  check(!/COMPLETED 扱いにしない/.test(rc), 'executed 時は誤否定文を出さない');

  const blank = { general: { operatorConfirmation: false } };
  const rb = generateReport(blank);
  check(rb.includes('INCOMPLETE'), 'blank → INCOMPLETE verdict');
  check(rb.includes('実行済みと確認できない') && rb.includes('COMPLETED 扱いにしない'), 'blank → 実行済み誤認させない明示');
  check(!/PASS — P16-I RUNTIME CANARY COMPLETED/.test(rb), 'blank report は COMPLETED を主張しない');

  // sensitive → STOP verdict、かつ report 出力自体に機微値が漏れない
  const secret = JSON.parse(JSON.stringify(complete)) as Record<string, unknown>;
  (secret.phaseC as Record<string, unknown>).revisionShort = 'a@b.com';
  const rs = generateReport(secret);
  check(rs.includes('STOP'), 'sensitive → STOP verdict');
  check(scanSensitive(secret).length > 0, 'sensitive scan が検出');

  // report 出力全体に URL/JWT/postgres が無い
  check(!/eyJ[A-Za-z0-9_-]{20,}|postgres(ql)?:\/\/|https?:\/\/[a-z0-9]{16,}\.supabase\./i.test(rc + rb), 'report 出力に secret パターンなし');

  console.log('');
  console.log(f === 0 ? 'career-personal-memory-runtime-canary-report-qa: ALL PASS' : `career-personal-memory-runtime-canary-report-qa: ${f} FAIL`);
  return f;
}

function mainCli() {
  const fileArg = process.argv.indexOf('--file');
  if (fileArg >= 0 && process.argv[fileArg + 1]) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(process.argv[fileArg + 1], 'utf8')); } catch { parsed = null; }
    console.log(generateReport(parsed));
    process.exit(0);
  }
  process.exit(selfTest() === 0 ? 0 : 1);
}

if ((process.argv[1] ?? '').endsWith('career-personal-memory-runtime-canary-report.ts')) mainCli();
