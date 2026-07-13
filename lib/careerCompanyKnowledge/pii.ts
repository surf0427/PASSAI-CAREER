/**
 * Company Knowledge (Layer 5) — deterministic offline PII / confidentiality scanner（P17-B §6）。
 *
 * 外部 AI / 外部 moderation API を使わない決定的 pattern policy。
 * **完全な PII 判定を達成したとは主張しない**（安全側 false positive を許容する契約）。
 *
 * fail-closed:
 *   - not_scanned / scan_failed / suspected / confirmed は publish 不可。
 *   - confidentiality unknown / medium / high / prohibited は publish 不可。
 *   - clean かつ low のみ publishable。
 *   - findings は raw 全文を保持せず redacted marker のみ（shared projection へ raw を渡さない）。
 *
 * scanner interface と deterministic 実装を分離する。
 */

import type {
  ConfidentialityLevel,
  PiiFinding,
  PiiFindingKind,
  PiiScanResult,
  PiiScanStateExpanded,
} from '@/types/careerCompanyKnowledge';

export interface PiiScanner {
  scan(text: string): PiiScanResult;
}

type Rule = {
  kind: PiiFindingKind;
  re: RegExp;
  severity: PiiFinding['severity'];
};

// deterministic ルール（安全側で検出。raw は保持しない）。
const RULES: readonly Rule[] = [
  { kind: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, severity: 'confirmed' },
  { kind: 'phone', re: /(?:0\d{1,4}-\d{1,4}-\d{3,4}|\b0\d{9,10}\b)/, severity: 'confirmed' },
  { kind: 'application_id', re: /(応募ID|受付番号|application[_\s]?id)\s*[:：]?\s*\S+/i, severity: 'confirmed' },
  { kind: 'url_identifier', re: /https?:\/\/\S*(?:id=|token=|user=|\/u\/)\S*/i, severity: 'suspected' },
  { kind: 'name_label', re: /(氏名|お名前|担当者名)\s*[:：]\s*\S+/, severity: 'suspected' },
  { kind: 'university_plus_name', re: /(大学|大学院)[^\s、。]{0,12}(さん|氏|様)/, severity: 'suspected' },
  { kind: 'employee_name', re: /(社員|人事担当)\s*[:：]?\s*\S+(さん|氏|様)/, severity: 'suspected' },
  { kind: 'interviewer_name', re: /(面接官|面接担当)\s*[:：]?\s*\S+(さん|氏|様)/, severity: 'suspected' },
  { kind: 'confidential_marker', re: /(内部限定|転載禁止|口外禁止|社外秘|confidential|non-?disclosure|nda)/i, severity: 'confirmed' },
];

function classifyConfidentiality(findings: readonly PiiFinding[]): ConfidentialityLevel {
  if (findings.some((f) => f.kind === 'confidential_marker')) return 'prohibited';
  if (findings.some((f) => f.severity === 'confirmed')) return 'high';
  if (findings.length > 0) return 'medium';
  return 'low';
}

function classifyState(findings: readonly PiiFinding[]): PiiScanStateExpanded {
  if (findings.some((f) => f.severity === 'confirmed')) return 'confirmed';
  if (findings.length > 0) return 'suspected';
  return 'clean';
}

/** clean かつ low のみ publishable（それ以外は fail-closed）。 */
export function isPiiResultPublishable(result: PiiScanResult): boolean {
  return result.state === 'clean' && result.confidentiality === 'low';
}

/** 決定的 offline scanner を作る（pure・raw を保持しない）。 */
export function createDeterministicPiiScanner(): PiiScanner {
  return {
    scan(text: string): PiiScanResult {
      if (typeof text !== 'string') {
        // 入力異常は scan_failed（fail-closed）。
        return { state: 'scan_failed', confidentiality: 'unknown', findings: [], publishable: false };
      }
      const findings: PiiFinding[] = [];
      for (const rule of RULES) {
        if (rule.re.test(text)) {
          findings.push({
            kind: rule.kind,
            excerptHint: `[redacted:${rule.kind}]`, // raw を残さない
            severity: rule.severity,
          });
        }
      }
      const state = classifyState(findings);
      const confidentiality = classifyConfidentiality(findings);
      const result: PiiScanResult = {
        state,
        confidentiality,
        findings,
        publishable: false,
      };
      return { ...result, publishable: isPiiResultPublishable(result) };
    },
  };
}

/** not_scanned / scan_failed を明示するための fail-closed 既定。 */
export function notScannedResult(): PiiScanResult {
  return { state: 'not_scanned', confidentiality: 'unknown', findings: [], publishable: false };
}
export function scanFailedResult(): PiiScanResult {
  return { state: 'scan_failed', confidentiality: 'unknown', findings: [], publishable: false };
}

// ── 既存 ContributionModeration（P17-A）へのマッピング（後方互換の橋渡し）─────
import type { ContributionModeration } from '@/types/careerCompanyKnowledge';

/** expanded PII result → 既存 moderation の piiScan / confidentiality field へ写像。 */
export function toModerationFields(result: PiiScanResult): Pick<ContributionModeration, 'piiScan' | 'confidentiality'> {
  const piiScan: ContributionModeration['piiScan'] =
    result.state === 'clean' ? 'clean' : result.state === 'not_scanned' ? 'not_scanned' : 'pii_detected';
  const confidentiality: ContributionModeration['confidentiality'] =
    result.confidentiality === 'low'
      ? 'low'
      : result.confidentiality === 'prohibited'
        ? 'restricted'
        : result.confidentiality === 'unknown'
          ? 'unknown'
          : 'elevated'; // medium / high
  return { piiScan, confidentiality };
}
