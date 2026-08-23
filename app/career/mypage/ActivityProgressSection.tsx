'use client';

// PASSAI CAREER — マイページ「練習・作成の進度」。
//
// 各機能を **ユーザー視点で何回やったか** だけを出す。ランキング・偏差値・他ユーザー比較・
// 達成バッジのような存在しない指標は置かない（見せたいのは自分の積み上げだけ）。
//
// 回数の単位（何を 1 回と数えるか）は lib/careerMyPageProgress/progress.ts に集約している
// （途中 draft・進行中セッション・同一 id の重複行は数に入らない）。

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import type { CareerMyPageActivityProgress } from '@/lib/careerMyPageProgress/types';

const ITEMS: readonly {
  key: keyof CareerMyPageActivityProgress;
  label: string;
  href: string;
  unit: string;
}[] = [
  { key: 'selfAnalysisCount', label: '自己分析', href: '/career/self-analysis', unit: '回' },
  { key: 'esCount', label: 'ES作成', href: '/career/es', unit: '件' },
  { key: 'interviewCount', label: '面接練習', href: '/career/interview', unit: '回' },
  { key: 'presentationCount', label: 'プレゼン', href: '/career/presentation', unit: '回' },
];

export default function ActivityProgressSection({
  activity,
}: {
  activity: CareerMyPageActivityProgress;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-brand-600 mb-3 px-1">練習・作成の進度</h2>
      <Card variant="default" padding="md">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {ITEMS.map((item) => {
            const count = activity[item.key];
            return (
              <div key={item.key} className="rounded-xl bg-slate-50 px-3 py-3">
                <dt className="text-xs text-slate-600">{item.label}</dt>
                <dd className="mt-1 flex items-baseline gap-1">
                  <span className="text-xl font-semibold text-slate-900 tabular-nums">{count}</span>
                  <span className="text-xs text-slate-500">{item.unit}</span>
                </dd>
                {count === 0 && (
                  <Link
                    href={item.href}
                    className="mt-1 inline-block text-xs text-brand-600 hover:text-brand-700 transition-colors"
                  >
                    はじめる →
                  </Link>
                )}
              </div>
            );
          })}
        </dl>
      </Card>
    </section>
  );
}
