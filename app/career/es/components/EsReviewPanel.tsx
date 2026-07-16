'use client';

// PASSAI 就活版 — ES添削結果の表示パネル（[id] エディタ／詳細で再利用）
//
// CareerEsReview（/api/career/es-review の出力）を表示する。
// 表示順: 総合スコア / ランク / 総評 → 6軸スコア → 良かった点 → 改善点 →
//         不足している要素 → 採用担当視点コメント → 優先改善。
// AI は本文の代筆・完成例を返さない方針のため、完成例（rewriteExample）は表示しない。

import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import type { CareerEsReview } from '@/types/careerEs';

const RANK_STYLE: Record<CareerEsReview['rank'], string> = {
  S: 'bg-amber-100 text-amber-800 ring-amber-300',
  A: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  B: 'bg-blue-100 text-blue-800 ring-blue-300',
  C: 'bg-slate-100 text-slate-700 ring-slate-300',
  D: 'bg-rose-100 text-rose-800 ring-rose-300',
};

const BREAKDOWN_LABELS: Array<[keyof CareerEsReview['breakdown'], string]> = [
  ['logic', '論理性'],
  ['specificity', '具体性'],
  ['originality', 'オリジナリティ'],
  ['readability', '読みやすさ'],
  ['persuasion', '説得力'],
  ['companyFit', '企業適合性'],
];

export function EsReviewPanel({ review }: { review: CareerEsReview }) {
  return (
    <div>
      {/* 総合スコア / ランク / 総評 */}
      <Card variant="soft" padding="md" className="mb-4">
        <div className="flex items-center gap-4 mb-3">
          <div>
            <p className="text-[11px] text-slate-500 mb-0.5">総合スコア</p>
            <p className="text-3xl font-bold text-slate-900 leading-none">
              {review.overallScore}
              <span className="text-base text-slate-400"> / 100</span>
            </p>
          </div>
          <span
            className={`inline-flex h-12 w-12 items-center justify-center rounded-full text-xl font-bold ring-2 ${RANK_STYLE[review.rank]}`}
            title="ランク"
          >
            {review.rank}
          </span>
        </div>
        {review.overallComment ? (
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
            {review.overallComment}
          </p>
        ) : (
          <p className="text-sm text-slate-400">—</p>
        )}
      </Card>

      {/* 6軸スコア */}
      <Section title="6軸スコア">
        <div className="flex flex-col gap-2.5">
          {BREAKDOWN_LABELS.map(([key, label]) => (
            <ScoreBar key={key} label={label} score={review.breakdown[key]} />
          ))}
        </div>
      </Section>

      <ListSection title="良かった点" items={review.strengths} />
      <ListSection title="改善点" items={review.improvements} ordered />
      <ListSection title="不足している要素" items={review.missingElements} />
      <ListSection title="採用担当視点コメント" items={review.recruiterComments} tone="recruiter" />
      <ListSection title="優先的に直すこと" items={review.priorityActions} ordered />
    </div>
  );
}

function ScoreBar({ label, score }: { label: string; score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-slate-600">{label}</span>
        <span className="text-xs font-semibold text-slate-800">{score}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden">
        <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ListSection({
  title,
  items,
  ordered = false,
  tone = 'default',
}: {
  title: string;
  items: string[];
  ordered?: boolean;
  tone?: 'default' | 'recruiter';
}) {
  const itemClass =
    tone === 'recruiter'
      ? 'text-sm text-slate-800 leading-relaxed'
      : 'text-sm text-slate-700 leading-relaxed';
  return (
    <Section title={title}>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">—</p>
      ) : ordered ? (
        <ol className="list-decimal pl-5 space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className={itemClass}>
              {item}
            </li>
          ))}
        </ol>
      ) : (
        <ul className="list-disc pl-5 space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className={itemClass}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card variant="soft" padding="md" className="mb-4">
      <h2 className="text-sm font-bold text-slate-900 mb-2">{title}</h2>
      {children}
    </Card>
  );
}
