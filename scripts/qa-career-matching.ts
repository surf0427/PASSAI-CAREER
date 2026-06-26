/*
 * scripts/qa-career-matching.ts
 *
 * 就活版 企業マッチング 決定的スコアリングエンジン（lib/careerMatching）の回帰テスト。
 * AI は呼ばない。production code は import のみ。
 *
 * 使い方:  npx tsx scripts/qa-career-matching.ts
 * 終了コード: 全 PASS → 0 / 1 件でも FAIL → 1
 *
 * 確認すること（依頼の QA 項目）:
 *   1. 同じ入力で同じスコアになる（決定的）
 *   2. avoidances キャップが効く（減点ではなく上限）
 *   3. priorities で重みが変わる
 *   4. 欠損データで落ちない
 *   5. readiness（選考準備度）に合否保証の表現がない
 *   6. AI 由来 score が総合点に直接使われていない
 *   7. シミュレーション・不足優先度が機能する（おまけ）
 */

import {
  runCareerMatch,
  deriveMatchWeights,
  simulateChanges,
  buildMeasuredReadiness,
  mergeReadinessSignals,
  READINESS_DISCLAIMER,
  CAREER_MATCHING_SCHEMA_VERSION,
  MATCH_AXES,
  SUCCESS_AXES,
  type EngineInput,
  type CompanyEngineInput,
  type ScoreSignal,
  type MatchProfile,
  type MeasuredReadinessInput,
} from '../lib/careerMatching';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── テスト用ビルダー ──
function matchSignals(value: number, overrides: Record<string, number> = {}): ScoreSignal[] {
  return MATCH_AXES.map((axis) => ({
    key: `match:${axis}`,
    value: overrides[axis] ?? value,
    present: true,
    source: 'ai_inferred' as const,
    rationale: 'test',
  }));
}

function successSignals(value: number): ScoreSignal[] {
  return SUCCESS_AXES.map((axis) => ({
    key: `success:${axis}`,
    value,
    present: true,
    source: 'ai_inferred' as const,
    rationale: 'test',
  }));
}

function readinessSignals(map: Record<string, { value: number; present?: boolean; source?: ScoreSignal['source'] }>): ScoreSignal[] {
  return Object.entries(map).map(([key, v]) => ({
    key: `readiness:${key}`,
    value: v.value,
    present: v.present ?? true,
    source: v.source ?? 'ai_inferred',
    rationale: 'test',
  }));
}

function makeCompany(name: string, opts: Partial<CompanyEngineInput> = {}): CompanyEngineInput {
  return {
    company: name,
    matchSignals: opts.matchSignals ?? matchSignals(70),
    readinessSignals:
      opts.readinessSignals ??
      readinessSignals({ es: { value: 70 }, interview: { value: 60 }, gakuchika: { value: 65, source: 'measured' } }),
    successSignals: opts.successSignals ?? successSignals(70),
    barTier: opts.barTier ?? 'B',
    companyFlags: opts.companyFlags ?? [],
    matchReasons: opts.matchReasons ?? ['テスト理由'],
    strengthsUsed: opts.strengthsUsed ?? [],
    attentionPoints: opts.attentionPoints ?? [],
    nextActions: opts.nextActions ?? [],
  };
}

function profile(priorities: string[] = [], avoidances: string[] = []): MatchProfile {
  return {
    matchWeights: deriveMatchWeights(priorities),
    avoidances,
    schemaVersion: CAREER_MATCHING_SCHEMA_VERSION,
  };
}

// ── 1. 決定的（同入力→同出力） ──
console.log('1. 決定的');
{
  const input: EngineInput = {
    profile: profile(['年収が高い']),
    companies: [makeCompany('A社'), makeCompany('B社', { matchSignals: matchSignals(50) })],
  };
  const r1 = JSON.stringify(runCareerMatch(input));
  const r2 = JSON.stringify(runCareerMatch(input));
  check('同じ入力で完全に同じ出力', r1 === r2);
}

// ── 2. avoidances キャップ ──
console.log('2. avoidances キャップ');
{
  const high = matchSignals(95);
  const noCap: EngineInput = {
    profile: profile([], []),
    companies: [makeCompany('転勤あり社', { matchSignals: high, companyFlags: ['nationwide_transfer'] })],
  };
  const withCap: EngineInput = {
    profile: profile([], ['全国転勤がある']),
    companies: [makeCompany('転勤あり社', { matchSignals: high, companyFlags: ['nationwide_transfer'] })],
  };
  const a = runCareerMatch(noCap)[0];
  const b = runCareerMatch(withCap)[0];
  check('キャップ無しでは高得点（>70）', a.match.total > 70, `total=${a.match.total}`);
  check('避けたい条件該当で上限70に制限', b.match.total <= 70, `total=${b.match.total}`);
  check('キャップ前のマッチ度は保持される（説明用）', b.matchUncapped > 70, `uncapped=${b.matchUncapped}`);
  check('appliedCaps が説明として返る', b.appliedCaps.length === 1 && b.appliedCaps[0].label === '全国転勤がある');
  check('減点ではなくキャップ（同一フラグ非該当なら満点近い）', a.match.total !== b.match.total);
}

// ── 3. priorities で重みが変わる ──
console.log('3. priorities で重みが変わる');
{
  // 待遇が高く他が低い企業。年収重視のユーザーほどマッチ度が上がるはず。
  const compHeavy = matchSignals(40, { compensation: 95 });
  const company = makeCompany('高待遇社', { matchSignals: compHeavy });
  const withComp = runCareerMatch({ profile: profile(['年収が高い', 'ボーナスが高い']), companies: [company] })[0];
  const without = runCareerMatch({ profile: profile([]), companies: [company] })[0];
  check('年収重視の重みでマッチ度が上がる', withComp.match.total > without.match.total, `comp=${withComp.match.total} base=${without.match.total}`);
  const w = deriveMatchWeights(['年収が高い']);
  check('compensation 軸の重みが基準1.0より大きい', w['match:compensation'] > 1.0, `w=${w['match:compensation']}`);
}

// ── 4. 欠損データで落ちない ──
console.log('4. 欠損データで落ちない');
{
  let threw = false;
  let out;
  try {
    out = runCareerMatch({
      profile: profile([]),
      companies: [
        makeCompany('空社', { matchSignals: [], readinessSignals: [], successSignals: [] }),
      ],
    })[0];
  } catch {
    threw = true;
  }
  check('空シグナルでも例外を投げない', !threw);
  check('総合点は有限値（0）になる', !!out && Number.isFinite(out.match.total) && out.match.total === 0, `total=${out?.match.total}`);
  check('欠損時は確信度 low', !!out && out.match.confidence === 'low');
  check('SPI 欠損でも準備度が算出される', !!out && Number.isFinite(out.readiness.total));
}

// ── 5. readiness に合否保証の表現がない ──
console.log('5. 合否保証の不在');
{
  check('注記が「保証するものではありません」を含む', READINESS_DISCLAIMER.includes('保証するものではありません'));
  check('注記が「内定可能性」と断定していない', !READINESS_DISCLAIMER.includes('内定可能性'));
  const out = runCareerMatch({ profile: profile([]), companies: [makeCompany('X社')] })[0];
  const json = JSON.stringify(out);
  check('企業スコアに「必ず内定」等の保証表現がない', !/必ず内定|内定確実|合格保証/.test(json));
}

// ── 6. AI 由来 score が総合点に直接使われていない ──
console.log('6. AI score 非採用');
{
  // エンジン入力に細工で score=99 を混入（型外）。エンジンは signals からのみ計算するはず。
  const tampered = makeCompany('細工社', { matchSignals: matchSignals(30) }) as CompanyEngineInput & { score?: number };
  tampered.score = 99;
  const out = runCareerMatch({ profile: profile([]), companies: [tampered] })[0];
  check('混入した score=99 は総合点に反映されない', out.match.total !== 99, `total=${out.match.total}`);
  // signals が全て value=30・絶対評価なので total は 30 付近（重み均等）になるはず。
  check('総合点は signals から決定的に算出される（~30）', out.match.total >= 28 && out.match.total <= 32, `total=${out.match.total}`);
  // signals が無ければ 0（AI 総合点が漏れていれば 0 にならない）。
  const empty = runCareerMatch({ profile: profile([]), companies: [makeCompany('無signal社', { matchSignals: [] })] })[0];
  check('match signals 無し → total=0（AI 総合点の漏れ無し）', empty.match.total === 0);
}

// ── 7. 不足優先度・シミュレーション ──
console.log('7. 不足優先度・シミュレーション');
{
  const company = makeCompany('成長社', {
    barTier: 'A',
    readinessSignals: readinessSignals({ es: { value: 40 }, interview: { value: 45 } }),
  });
  const out = runCareerMatch({ profile: profile([]), companies: [company] })[0];
  check('不足能力が優先度順（降順）で返る', out.gaps.length > 0 && out.gaps.every((g, i, a) => i === 0 || a[i - 1].priority >= g.priority));
  check('ロードマップが PASSAI 機能に接続される', out.roadmap.length > 0 && out.roadmap.every((s) => typeof s.feature.href === 'string'));

  const sim = simulateChanges({
    base: { profile: profile([]), companies: [company] },
    changes: [{ key: 'readiness:es', toValue: 90 }],
  });
  check('シミュレーションで準備度が上がる', sim.scoreDelta[0].readiness > 0, `delta=${sim.scoreDelta[0].readiness}`);
  check('シミュレーションは before/after を返す', sim.before.length === 1 && sim.after.length === 1);
}

// ── 8. buildMeasuredReadiness（ACL リファクタ） ──
console.log('8. buildMeasuredReadiness（ACL）');
{
  const input: MeasuredReadinessInput = {
    activity: {
      internships: [{ role: 'リーダー', quantitativeResult: '売上20%増' }],
      certifications: [{ name: 'TOEIC 850' }],
    } as MeasuredReadinessInput['activity'],
  };

  // 決定的
  const m1 = JSON.stringify(buildMeasuredReadiness(input));
  const m2 = JSON.stringify(buildMeasuredReadiness(input));
  check('同じ入力で同じ measured 出力', m1 === m2);

  const out = buildMeasuredReadiness(input);
  const byKey = new Map(out.map((s) => [s.key, s]));
  check('活動整理から gakuchika が measured で取れる', byKey.get('readiness:gakuchika')?.source === 'measured');
  check('英語系資格から english が measured', byKey.get('readiness:english')?.source === 'measured');
  check('SPI は present:false（欠損）', byKey.get('readiness:spi')?.present === false);
  check('プレゼンは present:false（欠損）', byKey.get('readiness:presentation')?.present === false);

  // 欠損入力でも落ちない
  let threw = false;
  let empty: ScoreSignal[] = [];
  try {
    empty = buildMeasuredReadiness({});
  } catch {
    threw = true;
  }
  check('空入力でも例外を投げない', !threw);
  check('空入力でも SPI/プレゼンの欠損は返る', empty.some((s) => s.key === 'readiness:spi' && !s.present));
  check('空入力では gakuchika は出ない（誤検出しない）', !empty.some((s) => s.key === 'readiness:gakuchika'));

  // measured-first: AI が同キーを返しても measured が勝つ
  const measured = buildMeasuredReadiness(input);
  const ai: ScoreSignal[] = [
    { key: 'readiness:gakuchika', value: 99, present: true, source: 'ai_inferred', rationale: 'ai' },
    { key: 'readiness:es', value: 80, present: true, source: 'ai_inferred', rationale: 'ai' },
  ];
  const merged = new Map(mergeReadinessSignals(measured, ai).map((s) => [s.key, s]));
  check('measured が AI 推測より優先される（gakuchika は measured 値）', merged.get('readiness:gakuchika')?.source === 'measured');
  check('measured が AI 値99で上書きされない', merged.get('readiness:gakuchika')?.value !== 99);
  check('measured に無いキー（es）は AI 推測で補完される', merged.get('readiness:es')?.source === 'ai_inferred');
}

console.log('');
if (failures === 0) {
  console.log('ALL PASS ✅');
  process.exit(0);
} else {
  console.log(`${failures} FAIL ❌`);
  process.exit(1);
}
