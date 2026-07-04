'use client';

// PASSAI 就活版 — マルチGD「議論全体（room 全体）」評価の表示（STEP-GD-27 共有コンポーネント）。
// 個人別 GdEvaluationDetail とは別レイヤ。finished room 結果画面で個人評価の前に表示する。
// 表示: 議論要約 / 論点整理 / 結論の明確さ / 進め方 / 良かった点 / 改善点 / 次回テーマ / 役割傾向。

import { Card } from '@/components/ui/Card';
import type { CareerGdRoomOverallEvaluation } from '@/types/careerGd';

export function GdRoomOverallDetail({ overall }: { overall: CareerGdRoomOverallEvaluation }) {
  return (
    <Card variant="soft" padding="md" className="mb-4" data-testid="gd-overall-evaluation">
      <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">議論全体の評価</p>
      {overall.summary && (
        <p className="text-sm text-slate-800 leading-relaxed mb-3">{overall.summary}</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {overall.pointOrganization && <Field label="論点整理" value={overall.pointOrganization} />}
        {overall.conclusionClarity && <Field label="結論の明確さ" value={overall.conclusionClarity} />}
        {overall.processComment && <Field label="議論の進め方" value={overall.processComment} />}
      </div>

      {overall.goodPoints.length > 0 && <ListBlock title="良かった点" items={overall.goodPoints} tone="good" />}
      {overall.improvements.length > 0 && <ListBlock title="改善点" items={overall.improvements} tone="warn" />}
      {overall.nextThemes.length > 0 && <ListBlock title="次回の練習テーマ" items={overall.nextThemes} tone="info" />}

      {overall.roleEstimates.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-bold text-slate-500 mb-1.5">役割の傾向（参考）</p>
          <ul className="flex flex-col gap-1">
            {overall.roleEstimates.map((r) => (
              <li key={r.participantId} className="text-xs text-slate-600 leading-relaxed">
                <span className="font-semibold text-slate-800">{r.displayName}</span>
                <span className="mx-1 rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                  {r.role}
                </span>
                {r.note && <span className="text-slate-500">{r.note}</span>}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] text-slate-400">
            ※ 役割の傾向は発言からの参考推定です（確定的な判定ではありません）。
          </p>
        </div>
      )}

      {overall.truncated && (
        <p className="mt-3 text-[10px] text-slate-400">
          ※ 発言量が多かったため、一部の発言を要約して評価しています。
        </p>
      )}
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold text-slate-500 mb-0.5">{label}</p>
      <p className="text-xs text-slate-700 leading-relaxed">{value}</p>
    </div>
  );
}

function ListBlock({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: 'good' | 'warn' | 'info';
}) {
  const dot = tone === 'good' ? 'text-emerald-500' : tone === 'warn' ? 'text-amber-500' : 'text-blue-500';
  return (
    <div className="mt-3">
      <p className="text-[11px] font-bold text-slate-500 mb-1">{title}</p>
      <ul className="flex flex-col gap-1">
        {items.map((it, i) => (
          <li key={i} className="text-xs text-slate-700 leading-relaxed flex gap-1.5">
            <span className={dot} aria-hidden>
              ・
            </span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
