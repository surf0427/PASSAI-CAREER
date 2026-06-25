// PASSAI 就活版 — スコアリングエンジンの統合（純粋関数）。
// 3スコア + キャップ + 不足優先度 + ロードマップ + 順位付けを 1 社ずつ計算し、ランキングする。
// AI/UI/route 非依存。同じ EngineInput なら必ず同じ CompanyScore[]。

import { applyAvoidanceCaps } from './caps';
import { analyzeGaps, buildRoadmap } from './roadmap';
import { scoreMatch } from './scoreMatch';
import { scoreReadiness } from './scoreReadiness';
import { scoreSuccess } from './scoreSuccess';
import type { CompanyEngineInput, CompanyScore, EngineInput, MatchProfile } from './types';

// 1 社分の全スコアを計算する。
export function scoreCompany(profile: MatchProfile, company: CompanyEngineInput): CompanyScore {
  const matchRaw = scoreMatch(profile, company);
  const { total: cappedTotal, appliedCaps } = applyAvoidanceCaps(
    matchRaw.total,
    profile.avoidances,
    company.companyFlags,
  );

  const readiness = scoreReadiness(company);
  const success = scoreSuccess(company);
  const gaps = analyzeGaps(company);
  const roadmap = buildRoadmap(gaps);

  return {
    company: company.company,
    match: { ...matchRaw, total: cappedTotal },
    matchUncapped: matchRaw.total,
    appliedCaps,
    readiness,
    success,
    barTier: company.barTier,
    gaps,
    roadmap,
    matchReasons: company.matchReasons,
    strengthsUsed: company.strengthsUsed,
    attentionPoints: company.attentionPoints,
    nextActions: company.nextActions,
  };
}

// マッチ度（キャップ適用後）降順で順位付け。同値は準備度→入力順で安定ソート（決定的）。
export function rankCompanies(scores: CompanyScore[]): CompanyScore[] {
  return scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      if (b.s.match.total !== a.s.match.total) return b.s.match.total - a.s.match.total;
      if (b.s.readiness.total !== a.s.readiness.total) return b.s.readiness.total - a.s.readiness.total;
      return a.i - b.i;
    })
    .map(({ s }) => s);
}

// エンジン本体: 全社を計算してランキングする。
export function runCareerMatch(input: EngineInput): CompanyScore[] {
  const scored = input.companies.map((c) => scoreCompany(input.profile, c));
  return rankCompanies(scored);
}
