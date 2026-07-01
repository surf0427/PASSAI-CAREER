'use client';

// PASSAI 就活版 — マルチGD 本格評価の詳細表示（STEP-GD-16 共有コンポーネント）。
// room の finished 結果画面（app/career/gd/room/[roomId]）と GD履歴 view（/career/gd/view）で共用する。
// 表示: 総合スコア/ランク/6軸レーダー/企業コミュ適性/強み・課題・改善/良かった発言/マッチングヒント/ランキング。

import { Card } from '@/components/ui/Card';
import { CAREER_GD_EVAL_AXIS_LABELS, CAREER_GD_EVAL_AXIS_ORDER } from './gdRoles';
import type {
  CareerGdEvaluation,
  CareerGdRankingEntry,
  CareerGdMatchingHints,
  GdCompanyGrade,
} from '@/types/careerGd';

export const GD_GRADE_STYLE: Record<GdCompanyGrade, string> = {
  S: 'bg-amber-100 text-amber-800',
  A: 'bg-blue-100 text-blue-800',
  B: 'bg-emerald-100 text-emerald-800',
  C: 'bg-slate-100 text-slate-700',
  D: 'bg-rose-100 text-rose-700',
};

export function GdEvaluationDetail({
  evaluation,
  ranking,
  matchingHints,
  selfParticipantId,
}: {
  evaluation: CareerGdEvaluation;
  ranking: CareerGdRankingEntry[];
  matchingHints: CareerGdMatchingHints;
  selfParticipantId: string;
}) {
  const ev = evaluation;

  if (!ev.scored) {
    return (
      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-sm font-bold text-slate-800 mb-1">今回は採点できませんでした</p>
        <p className="text-xs text-slate-500 leading-relaxed mb-2">
          {ev.unscoredReason ?? '発言が十分に確認できませんでした。'}
        </p>
        {ev.improvements.length > 0 && <EvalList title="次回に向けて" items={ev.improvements} />}
      </Card>
    );
  }

  return (
    <>
      {/* 総合スコア + ランク + 6軸レーダー */}
      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">GD能力評価</p>
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex items-center gap-4 shrink-0">
            <div className="text-center">
              <p className="text-[10px] text-slate-400">総合スコア</p>
              <p className="text-3xl font-bold text-slate-800 tabular-nums leading-none">{ev.overallScore}</p>
              <p className="text-[10px] text-slate-400">/ 100</p>
            </div>
            <div className="text-center">
              <p className="text-[10px] text-slate-400 mb-0.5">ランク</p>
              <span className={`inline-flex h-11 w-11 items-center justify-center rounded-full text-xl font-bold ${GD_GRADE_STYLE[ev.rank]}`}>
                {ev.rank}
              </span>
            </div>
          </div>
          <div className="flex-1 min-w-0 flex justify-center">
            <AxisRadar axisScores={ev.axisScores} />
          </div>
        </div>
        <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
          {CAREER_GD_EVAL_AXIS_ORDER.map((k) => (
            <li key={k} className="flex items-center justify-between text-xs">
              <span className="text-slate-500">{CAREER_GD_EVAL_AXIS_LABELS[k]}</span>
              <span className="font-semibold text-slate-700 tabular-nums">{ev.axisScores[k]}</span>
            </li>
          ))}
        </ul>
        {ev.overallComment && (
          <p className="mt-3 text-xs text-slate-600 leading-relaxed border-t border-slate-100 pt-3">{ev.overallComment}</p>
        )}
      </Card>

      {/* 企業コミュニケーション適性 */}
      <Card variant="soft" padding="md" className="mb-4">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-1">企業コミュニケーション適性</p>
            <p className="text-xs text-slate-500 leading-relaxed">会議・顧客折衝・チーム業務での立ち回りとの相性の目安です。</p>
          </div>
          <span className={`ml-3 shrink-0 inline-flex h-11 w-11 items-center justify-center rounded-full text-xl font-bold ${GD_GRADE_STYLE[ev.companyCommunicationGrade]}`}>
            {ev.companyCommunicationGrade}
          </span>
        </div>
      </Card>

      {/* 強み・課題・改善・良かった発言 */}
      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">フィードバック</p>
        {ev.strengths.length > 0 && <EvalList title="強み" items={ev.strengths} />}
        {ev.weaknesses.length > 0 && <EvalList title="課題" items={ev.weaknesses} />}
        {ev.improvements.length > 0 && <EvalList title="改善のヒント" items={ev.improvements} />}
        {ev.goodQuotes.length > 0 && (
          <div className="mb-1 mt-1">
            <p className="text-xs font-bold text-slate-600 mb-1">良かった発言</p>
            <ul className="flex flex-col gap-1.5">
              {ev.goodQuotes.map((q, i) => (
                <li key={i} className="text-xs text-slate-600 leading-relaxed border-l-2 border-emerald-300 pl-2">
                  「{q}」
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* マッチングヒント */}
      {matchingHints.hints.length > 0 && (
        <Card variant="soft" padding="md" className="mb-4">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">就活マッチングのヒント</p>
          <ul className="flex flex-col gap-1.5">
            {matchingHints.hints.map((h, i) => (
              <li key={i} className="text-xs text-slate-600 leading-relaxed flex gap-1.5">
                <span className="text-blue-400">▹</span>
                <span>{h}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
            ※ あくまで傾向であり、向き不向きを断定するものではありません。
          </p>
        </Card>
      )}

      {/* ランキング（スコア順・全員共有） */}
      {ranking.length > 0 && (
        <Card variant="soft" padding="md" className="mb-4">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">総合スコア順（参加者内）</p>
          <ul className="flex flex-col gap-1.5">
            {ranking.map((r) => (
              <li key={r.participantId} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="w-6 text-center font-bold text-slate-400">{r.rank}</span>
                  <span className={`font-semibold truncate ${r.participantId === selfParticipantId ? 'text-blue-700' : 'text-slate-700'}`}>
                    {r.displayName}
                    {r.participantId === selfParticipantId && '（あなた）'}
                  </span>
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-slate-500 tabular-nums">{r.overallScore}</span>
                  <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${GD_GRADE_STYLE[r.grade]}`}>
                    {r.grade}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
            ※ 詳細なフィードバックはご本人のみに表示されます。
          </p>
        </Card>
      )}
    </>
  );
}

// 6軸レーダーチャート（SVG・スマホ対応。viewBox でスケール）。
function AxisRadar({ axisScores }: { axisScores: CareerGdEvaluation['axisScores'] }) {
  const size = 180;
  const c = size / 2;
  const maxR = 66;
  const keys = CAREER_GD_EVAL_AXIS_ORDER;
  const pointAt = (i: number, r: number) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / keys.length;
    return [c + r * Math.cos(angle), c + r * Math.sin(angle)] as const;
  };
  const gridRings = [0.25, 0.5, 0.75, 1];
  const dataPoints = keys.map((k, i) => pointAt(i, (Math.min(100, Math.max(0, axisScores[k])) / 100) * maxR));
  const dataPath = dataPoints.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-[200px] max-w-full" role="img" aria-label="6軸評価レーダーチャート">
      {gridRings.map((ring, ri) => (
        <polygon
          key={ri}
          points={keys.map((_, i) => pointAt(i, maxR * ring).map((n) => n.toFixed(1)).join(',')).join(' ')}
          fill="none"
          stroke="#e2e8f0"
          strokeWidth={1}
        />
      ))}
      {keys.map((_, i) => {
        const [x, y] = pointAt(i, maxR);
        return <line key={i} x1={c} y1={c} x2={x} y2={y} stroke="#e2e8f0" strokeWidth={1} />;
      })}
      <polygon points={dataPath} fill="rgba(37,99,235,0.18)" stroke="#2563eb" strokeWidth={1.5} />
      {keys.map((k, i) => {
        const [x, y] = pointAt(i, maxR + 12);
        return (
          <text key={k} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="fill-slate-500" fontSize={9}>
            {CAREER_GD_EVAL_AXIS_LABELS[k]}
          </text>
        );
      })}
    </svg>
  );
}

function EvalList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="text-xs font-bold text-slate-600 mb-1">{title}</p>
      <ul className="list-disc pl-4 text-xs text-slate-600 leading-relaxed flex flex-col gap-0.5">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
