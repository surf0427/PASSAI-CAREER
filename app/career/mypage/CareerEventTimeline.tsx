'use client';

/**
 * マイページ「最近の利用履歴」セクション（P9-B pilot）。
 *
 *   - career_user_events を **本人（owner-scoped）** で読み戻す初の read path。
 *   - 表示は feature / event_type の enum ラベル・score band・短ラベル・allowlist metadata のみ
 *     （lib/careerEvents/timeline.ts の純変換を経由。本文・PII は構造的に出ない）。
 *   - AI prompt / context / body / CareerMemorySnapshot / BaseMemorySummary には接続しない。
 *   - guest / env 未設定 / fetch error でも mypage 本体を壊さない（空表示 or ガイド表示）。
 */

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
import { listRecentCareerEvents } from '@/lib/careerEvents/read';
import { toEventTimelineItems, type EventTimelineItem } from '@/lib/careerEvents/timeline';

const TIMELINE_LIMIT = 20;

export default function CareerEventTimelineSection() {
  const userId = useCurrentUserId();
  // 取得結果は userId タグ付きで保持し、別ユーザーの残像を描画しない。
  // setState は async callback 内のみ（effect 本体で同期 setState しない）。
  const [state, setState] = useState<{ userId: string; items: EventTimelineItem[] } | null>(null);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    void listRecentCareerEvents(userId, TIMELINE_LIMIT).then((rows) => {
      if (alive) setState({ userId, items: toEventTimelineItems(rows) });
    });
    return () => {
      alive = false;
    };
  }, [userId]);

  // guest（未ログイン）: 履歴は member 限定である旨のガイド。
  if (!userId) {
    return (
      <Section>
        <Card variant="soft" padding="md">
          <p className="text-sm text-gray-600 leading-relaxed">
            ログインすると、ES・面接・相談などの利用履歴がここに記録され、いつでも振り返れます。
          </p>
        </Card>
      </Section>
    );
  }

  // member ローディング中（初回取得前 or 別ユーザー分の残像）は描画しない（ちらつき防止）。
  const ready = state !== null && state.userId === userId;
  if (!ready) return null;
  const items = state.items;

  // member だが履歴 0 件（error 時も read helper が [] を返すためここに合流）。
  if (items.length === 0) {
    return (
      <Section>
        <Card variant="soft" padding="md">
          <p className="text-sm text-gray-600">
            まだ利用履歴がありません。各機能を使うと、ここに記録されていきます。
          </p>
        </Card>
      </Section>
    );
  }

  return (
    <Section>
      <Card variant="default" padding="none">
        <ul className="divide-y divide-slate-100">
          {items.map((it) => (
            <li key={it.id} className="px-4 py-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                  {it.featureLabel}
                </span>
                <span className="text-sm font-medium text-gray-800">{it.eventTypeLabel}</span>
                {it.scoreBand && (
                  <span className="shrink-0 text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                    {it.scoreBand}
                  </span>
                )}
                {it.occurredAtLabel && (
                  <span className="ml-auto shrink-0 text-xs text-gray-400">
                    {it.occurredAtLabel}
                  </span>
                )}
              </div>
              {(it.industry || it.jobType || it.selectionPhase || it.metaChips.length > 0) && (
                <div className="mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-gray-500">
                  {it.industry && <span>業界: {it.industry}</span>}
                  {it.jobType && <span>職種: {it.jobType}</span>}
                  {it.selectionPhase && <span>選考: {it.selectionPhase}</span>}
                  {it.metaChips.map((c) => (
                    <span key={c.key}>
                      {c.label}: {c.value}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </Section>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-sm font-semibold text-brand-600">最近の利用履歴</h2>
        <span className="text-xs text-gray-400">本人のみ表示</span>
      </div>
      {children}
    </section>
  );
}
