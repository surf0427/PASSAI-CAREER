// PASSAI 就活版 — 改善シミュレーション基盤（純粋関数・LLM 非使用）。
//
// 「SPI を改善したら」「英語を追加したら」順位・各スコアがどう変わるかを、
// エンジン（runCareerMatch）の再実行だけで算出する。MVP は土台（型 + 関数）のみ。
//
// changes は全社の同一シグナルキーに適用する（本人側の能力改善はどの企業にも効くため）。

import { runCareerMatch } from './engine';
import type {
  CompanyEngineInput,
  CompanyScore,
  EngineInput,
  ScoreSignal,
  SimulationChange,
  SimulationInput,
  SimulationResult,
} from './types';

function applyChangesToSignals(signals: ScoreSignal[], changes: SimulationChange[]): ScoreSignal[] {
  const byKey = new Map(changes.map((c) => [c.key, c.toValue]));
  const next = signals.map((s) =>
    byKey.has(s.key)
      ? { ...s, value: byKey.get(s.key) as number, present: true, source: 'user_input' as const }
      : { ...s },
  );
  // 既存に無いキー（未着手シグナルの新規追加）も反映する。
  for (const change of changes) {
    if (!next.some((s) => s.key === change.key)) {
      next.push({
        key: change.key,
        value: change.toValue,
        present: true,
        source: 'user_input',
        rationale: 'シミュレーション入力',
      });
    }
  }
  return next;
}

function applyChangesToCompany(company: CompanyEngineInput, changes: SimulationChange[]): CompanyEngineInput {
  return {
    ...company,
    matchSignals: applyChangesToSignals(company.matchSignals, changes),
    readinessSignals: applyChangesToSignals(company.readinessSignals, changes),
    successSignals: applyChangesToSignals(company.successSignals, changes),
  };
}

function byCompany(scores: CompanyScore[]): Map<string, CompanyScore> {
  return new Map(scores.map((s) => [s.company, s]));
}

function rankIndex(scores: CompanyScore[]): Map<string, number> {
  return new Map(scores.map((s, i) => [s.company, i + 1]));
}

// 改善案を適用して before/after を比較する。
export function simulateChanges(input: SimulationInput): SimulationResult {
  const before = runCareerMatch(input.base);

  const afterInput: EngineInput = {
    profile: input.base.profile,
    companies: input.base.companies.map((c) => applyChangesToCompany(c, input.changes)),
  };
  const after = runCareerMatch(afterInput);

  const beforeRank = rankIndex(before);
  const afterRank = rankIndex(after);
  const beforeByName = byCompany(before);
  const afterByName = byCompany(after);

  const companies = input.base.companies.map((c) => c.company);

  const rankingDelta = companies.map((name) => ({
    company: name,
    from: beforeRank.get(name) ?? 0,
    to: afterRank.get(name) ?? 0,
  }));

  const scoreDelta = companies.map((name) => {
    const b = beforeByName.get(name);
    const a = afterByName.get(name);
    return {
      company: name,
      match: (a?.match.total ?? 0) - (b?.match.total ?? 0),
      readiness: (a?.readiness.total ?? 0) - (b?.readiness.total ?? 0),
      success: (a?.success.total ?? 0) - (b?.success.total ?? 0),
    };
  });

  return { before, after, rankingDelta, scoreDelta };
}
