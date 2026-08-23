'use client';

// PASSAI CAREER — 自己分析レーダーチャート（pure SVG・依存追加なし）。
//
// ★ 重要（誤読防止）:
//   自己分析には **既存の数値評価が存在しない**（career_self_analysis_results.result は
//   すべてテキスト / 配列で、score も評価軸も持たない）。
//   そのため本チャートは点数を描いていない。最新の自己分析結果が各領域を
//   **何件言語化できているか（件数）** を描く。点数を捏造しないための設計であり、
//   軸も CareerSelfAnalysisResult の実在 field と 1:1（lib/careerMyPageProgress/progress.ts）。
//
//   - 目盛は件数のまま（100 点換算などしない）。
//   - viewBox + w-full で mobile でも横にはみ出さない。

import type { CareerSelfUnderstandingDimension } from '@/lib/careerMyPageProgress/types';

// 軸ラベル（「ガクチカ候補 5」など）が左右にはみ出さない幅を確保する。
const VIEW_W = 400;
const VIEW_H = 300;
const CX = 200;
const CY = 148;
const R = 86;
const LABEL_R = R + 24;

const RING_STEPS = [0.25, 0.5, 0.75, 1];
const FILL_COLOR = '#2563eb'; // brand-600
const GRID_COLOR = '#e2e8f0'; // slate-200
const LABEL_COLOR = '#475569'; // slate-600
const TICK_COLOR = '#94a3b8'; // slate-400

type Point = { x: number; y: number };

function polar(angleRad: number, radius: number): Point {
  return { x: CX + radius * Math.cos(angleRad), y: CY + radius * Math.sin(angleRad) };
}

function polygon(points: readonly Point[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

export default function SelfAnalysisRadarChart({
  dimensions,
}: {
  dimensions: readonly CareerSelfUnderstandingDimension[];
}) {
  const n = dimensions.length;
  if (n < 3) return null; // 3 軸未満はレーダーとして成立しない。

  // 目盛の上限は実データの最大件数に合わせる（最低 4 件分。形が潰れないようにするため）。
  const maxCount = dimensions.reduce((max, d) => Math.max(max, d.count), 0);
  const scaleMax = Math.max(4, maxCount);

  // 真上（-90°）始まりで時計回り。
  const angles = dimensions.map((_, i) => (-Math.PI / 2) + (2 * Math.PI * i) / n);
  const outer = angles.map((a) => polar(a, R));
  const valuePoints = angles.map((a, i) => polar(a, (R * dimensions[i].count) / scaleMax));

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="w-full h-auto max-w-sm mx-auto"
      role="img"
      aria-label={`自己分析の領域別の言語化件数（最大 ${scaleMax} 件）`}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* 同心リング */}
      {RING_STEPS.map((step) => (
        <polygon
          key={step}
          points={polygon(angles.map((a) => polar(a, R * step)))}
          fill="none"
          stroke={GRID_COLOR}
          strokeWidth={1}
        />
      ))}

      {/* 各軸の放射線 */}
      {outer.map((p, i) => (
        <line key={dimensions[i].key} x1={CX} y1={CY} x2={p.x} y2={p.y} stroke={GRID_COLOR} strokeWidth={1} />
      ))}

      {/* 実データの多角形 */}
      <polygon points={polygon(valuePoints)} fill={FILL_COLOR} fillOpacity={0.16} stroke={FILL_COLOR} strokeWidth={2} />
      {valuePoints.map((p, i) => (
        <circle key={dimensions[i].key} cx={p.x} cy={p.y} r={3} fill={FILL_COLOR}>
          <title>{`${dimensions[i].label} ${dimensions[i].count}件`}</title>
        </circle>
      ))}

      {/* 目盛の単位（点数ではなく件数であることを図の中でも明示する）。
          多角形と重ならないよう左下の余白に置く。 */}
      <text x={10} y={VIEW_H - 10} fontSize={10} fill={TICK_COLOR}>
        目盛: 最大 {scaleMax}件
      </text>

      {/* 軸ラベル（件数つき） */}
      {angles.map((a, i) => {
        const p = polar(a, LABEL_R);
        const cos = Math.cos(a);
        const anchor = Math.abs(cos) < 0.25 ? 'middle' : cos > 0 ? 'start' : 'end';
        return (
          <text
            key={dimensions[i].key}
            x={p.x}
            y={p.y + 4}
            textAnchor={anchor}
            fontSize={11}
            fill={LABEL_COLOR}
          >
            {dimensions[i].label}
            <tspan fill={TICK_COLOR}>{` ${dimensions[i].count}`}</tspan>
          </text>
        );
      })}
    </svg>
  );
}
