'use client';

// PASSAI CAREER — マイページ成長グラフの折れ線（pure SVG）。
//
// 設計:
//   - 依存追加なし。本機能のためだけに recharts / chart.js を入れない
//     （受験版 app/mypage/ScoreLineChart.tsx と同じ判断。ただし component は流用せず
//      就活版の UI 語彙で独立させる — 既存方針「受験版 component を流用しない」）。
//   - y 軸は 0〜100 固定。ES / 面接 / プレゼンの既存スコアが 3 機能とも 0〜100 のため、
//     換算せずそのまま置く。
//   - x 軸は **実施順（1 回目・2 回目 …）の等間隔**。日付間隔ではなく回数で並べる
//     （「前回の自分と比べてどうか」を見る画面のため）。日付は各点の tooltip に出す。
//   - 1 点だけでも壊れない（中央に単独ドット）。0 点はそもそも呼び出し側が描画しない。
//   - viewBox + w-full で mobile でも横にはみ出さない。

import type { CareerGrowthPoint } from '@/lib/careerMyPageProgress/types';

const VIEW_W = 600;
const VIEW_H = 200;
const PAD_LEFT = 34;
const PAD_RIGHT = 44; // 末尾の値ラベル分
const PAD_TOP = 14;
const PAD_BOTTOM = 26;
const PLOT_W = VIEW_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = VIEW_H - PAD_TOP - PAD_BOTTOM;

const Y_TICKS = [0, 50, 100];
const LINE_COLOR = '#2563eb'; // brand-600
const GRID_COLOR = '#e2e8f0'; // slate-200
const AXIS_TEXT = '#94a3b8'; // slate-400

function yOf(score: number): number {
  return PAD_TOP + PLOT_H * (1 - score / 100);
}

function xOf(index: number, count: number): number {
  if (count <= 1) return PAD_LEFT + PLOT_W / 2;
  return PAD_LEFT + (PLOT_W * index) / (count - 1);
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** x 軸ラベルを出す点の index（多いときは間引いて重ならないようにする）。 */
function tickIndexes(count: number): number[] {
  if (count <= 6) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil(count / 5);
  const picked = new Set<number>();
  for (let i = 0; i < count; i += step) picked.add(i);
  picked.add(count - 1);
  return [...picked].sort((a, b) => a - b);
}

export default function GrowthLineChart({
  points,
  ariaLabel,
}: {
  points: readonly CareerGrowthPoint[];
  ariaLabel: string;
}) {
  const count = points.length;
  if (count === 0) return null;

  const coords = points.map((p, i) => ({ point: p, x: xOf(i, count), y: yOf(p.score) }));
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const last = coords[count - 1];
  const ticks = tickIndexes(count);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="w-full h-auto"
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* y 軸グリッドと目盛（0 / 50 / 100） */}
      {Y_TICKS.map((tick) => (
        <g key={tick}>
          <line
            x1={PAD_LEFT}
            x2={PAD_LEFT + PLOT_W}
            y1={yOf(tick)}
            y2={yOf(tick)}
            stroke={GRID_COLOR}
            strokeWidth={1}
          />
          <text x={PAD_LEFT - 8} y={yOf(tick) + 4} textAnchor="end" fontSize={11} fill={AXIS_TEXT}>
            {tick}
          </text>
        </g>
      ))}

      {/* 折れ線（2 点以上のときだけ引く） */}
      {count >= 2 && <path d={path} fill="none" stroke={LINE_COLOR} strokeWidth={2} strokeLinejoin="round" />}

      {/* 各点。tooltip（title）に「N 回目・スコア・日付」を出す。 */}
      {coords.map((c) => (
        <circle key={c.point.id} cx={c.x} cy={c.y} r={4} fill={LINE_COLOR}>
          <title>{`${c.point.attempt}回目 ${c.point.score}点 ${formatDate(c.point.completedAt)}`}</title>
        </circle>
      ))}

      {/* 最新値のラベル */}
      <text x={last.x + 10} y={last.y + 4} fontSize={12} fontWeight={600} fill={LINE_COLOR}>
        {last.point.score}
      </text>

      {/* x 軸ラベル（回数） */}
      {ticks.map((i) => (
        <text
          key={points[i].id}
          x={xOf(i, count)}
          y={VIEW_H - 6}
          textAnchor="middle"
          fontSize={11}
          fill={AXIS_TEXT}
        >
          {points[i].attempt}回目
        </text>
      ))}
    </svg>
  );
}
