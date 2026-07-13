/**
 * Company Knowledge (Layer 5) — provenance / confidence / freshness（P17-A §6.4）。
 *
 * - official / company_provided / user_experience / inferred_summary を区別する。
 * - user experience を企業の確定事実へ変換しない（confidence へ反映するだけ）。
 * - observedPeriod を必須化し freshness を分類する（stale は available に出さない）。
 * - confidence は根拠（corroboration / evidenceKind / freshness）を伴う。
 * - 単一投稿を general trend として扱わない（singleReport フラグ）。
 *
 * pure・決定論。confidence の重みは PROVISIONAL（法務・実データ未確認）。
 */

import { FRESHNESS_POLICY, MIN_CORROBORATION_FOR_TREND, type FreshnessPolicy } from './policy';
import type {
  CompanyEvidenceKind,
  ConfidenceBasis,
  FreshnessClassification,
} from '@/types/careerCompanyKnowledge';

/**
 * observedPeriod（'2026' / '2026-05' / '2026-spring'）から粗い年月を取り出す。
 * 解釈できない場合は null（→ freshness unknown）。
 */
export function parseObservedPeriod(observedPeriod: string): { year: number; month: number } | null {
  if (typeof observedPeriod !== 'string') return null;
  const s = observedPeriod.trim().toLowerCase();
  const ym = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (ym) {
    const year = Number(ym[1]);
    const month = Math.min(12, Math.max(1, Number(ym[2])));
    return { year, month };
  }
  const seasonMap: Record<string, number> = { spring: 4, summer: 7, autumn: 10, fall: 10, winter: 1 };
  const ys = /^(\d{4})[-\s]?(spring|summer|autumn|fall|winter)$/.exec(s);
  if (ys) return { year: Number(ys[1]), month: seasonMap[ys[2]] ?? 6 };
  const yOnly = /^(\d{4})$/.exec(s);
  if (yOnly) return { year: Number(yOnly[1]), month: 6 }; // 年のみは年央として扱う
  return null;
}

/** observedPeriod と now(ISO) から freshness を分類する（pure）。 */
export function classifyFreshness(
  observedPeriod: string,
  nowIso: string,
  policy: FreshnessPolicy = FRESHNESS_POLICY,
): FreshnessClassification {
  const parsed = parseObservedPeriod(observedPeriod);
  if (!parsed) return 'unknown';
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return 'unknown';
  const elapsedMonths =
    (now.getUTCFullYear() - parsed.year) * 12 + (now.getUTCMonth() + 1 - parsed.month);
  if (elapsedMonths < 0) return 'unknown'; // 未来日付は信用しない
  if (elapsedMonths <= policy.freshWithinMonths) return 'fresh';
  if (elapsedMonths <= policy.agingWithinMonths) return 'aging';
  return 'stale';
}

const EVIDENCE_BASE_CONFIDENCE: Record<CompanyEvidenceKind, number> = {
  official: 0.9,
  company_provided: 0.8,
  user_experience: 0.5, // 体験談は控えめ（事実保証にしない）
  inferred_summary: 0.4,
};

const FRESHNESS_ADJUST: Record<FreshnessClassification, number> = {
  fresh: 0,
  aging: -0.1,
  stale: -0.25,
  unknown: -0.15,
};

/**
 * confidence を根拠付きで算出する（pure・決定論・PROVISIONAL 重み）。
 * corroboration が多いほど加点。単一投稿は singleReport=true（trend 表示に使わせない）。
 */
export function computeConfidenceBasis(input: {
  evidenceKind: CompanyEvidenceKind;
  corroborationCount: number; // 独立裏付け件数（本人含む総数）
  freshness: FreshnessClassification;
}): ConfidenceBasis {
  const base = EVIDENCE_BASE_CONFIDENCE[input.evidenceKind] ?? 0.4;
  const n = Number.isFinite(input.corroborationCount) ? Math.max(0, Math.floor(input.corroborationCount)) : 0;
  const corroborationBoost = Math.min(0.2, Math.max(0, n - 1) * 0.1);
  const freshnessAdj = FRESHNESS_ADJUST[input.freshness] ?? -0.15;
  const raw = base + corroborationBoost + freshnessAdj;
  const value = Math.min(0.98, Math.max(0.05, Number(raw.toFixed(4))));
  return {
    value,
    corroborationCount: n,
    evidenceKind: input.evidenceKind,
    freshness: input.freshness,
    singleReport: n < MIN_CORROBORATION_FOR_TREND,
  };
}
