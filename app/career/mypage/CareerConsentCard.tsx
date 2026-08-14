'use client';

// PASSAI CAREER — 同意取得カード（NEXT-7 / Data Spine consent capture surface）。
//
// ★ 既定では **何も描画しない**。/api/career/consent が `enabled:true` を返したときだけ現れる。
//   gate（運用 flag + 法務承認 + readiness）が閉じている間は API が enabled:false を返すため、
//   本カードは DOM に一切出ない＝現行 UI は 1px も変わらない。
//
// 厳守:
//   - 同意文言をここに hard-code しない。表示するラベルは **範囲名と現在状態のみ**で、
//     法的 notice 本文は legal 承認後に policy manifest / notice 配信経路から供給する。
//   - IP / UA / 端末情報 / 自由記述を送らない（送るのは scope と action のみ）。
//   - 失敗しても他の mypage 表示を壊さない（never-throw / エラー時は非表示）。

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';

type ConsentScopeState = {
  scope: string;
  status: string;
  reconsentRequired?: boolean;
};

type ConsentApiState = {
  enabled: boolean;
  authenticated?: boolean;
  available?: boolean;
  scopes?: string[];
  receipt?: { entries?: ConsentScopeState[] };
};

// 範囲名の表示ラベル（法的文言ではなく、機能範囲の識別ラベル）。
const SCOPE_LABELS: Record<string, string> = {
  internal_aggregated_analytics: 'サービス改善のための統計利用',
  user_facing_aggregated_insight: '他ユーザー向け統計情報への反映',
  ai_context_aggregated_insight: 'AI 回答の参考統計への反映',
  externally_shared_insight: '外部共有される統計への反映',
  company_knowledge_contribution: '企業研究ナレッジへの提供',
};

const STATUS_LABELS: Record<string, string> = {
  never_granted: '未同意',
  active: '同意済み',
  withdrawn: '撤回済み',
  version_outdated: '再同意が必要',
  account_deletion_pending: '削除手続き中',
  account_deleted: '削除済み',
  invalid_ledger: '確認中',
};

export default function CareerConsentCard() {
  const [state, setState] = useState<ConsentApiState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // setState は async callback 内のみ（effect 本体で同期 setState しない）。
  useEffect(() => {
    let alive = true;
    void fetch('/api/career/consent', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (alive && json) setState(json as ConsentApiState);
      })
      .catch(() => {
        /* never-throw: 取得できなければ非表示のまま */
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((v) => v + 1), []);

  const submit = useCallback(
    async (scope: string, action: 'grant' | 'withdraw') => {
      setBusy(scope);
      try {
        // 送るのは scope と action のみ（evidence field は一切送らない）。
        const res = await fetch('/api/career/consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope, action }),
        });
        if (res.ok) reload();
      } catch {
        /* never-throw */
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  // gate が閉じている / 未認証 / repository 未接続 → 何も描画しない（現行 UI 不変）。
  if (!state?.enabled || !state.authenticated || !state.available) return null;
  const scopes = state.scopes ?? [];
  if (scopes.length === 0) return null;

  const byScope = new Map<string, ConsentScopeState>(
    (state.receipt?.entries ?? []).map((e) => [e.scope, e]),
  );

  return (
    <Card className="p-4 sm:p-6">
      <h2 className="text-base sm:text-lg font-bold mb-1">データの利用に関する同意</h2>
      <p className="text-xs sm:text-sm text-gray-600 mb-4">
        通常の機能（自己分析・ES・面接など）は、以下の同意の有無にかかわらずご利用いただけます。
      </p>
      <ul className="space-y-3">
        {scopes.map((scope) => {
          const entry = byScope.get(scope);
          const status = entry?.status ?? 'never_granted';
          const granted = status === 'active';
          return (
            <li key={scope} className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium break-words">{SCOPE_LABELS[scope] ?? scope}</p>
                <p className="text-xs text-gray-500">{STATUS_LABELS[status] ?? status}</p>
              </div>
              <button
                type="button"
                disabled={busy === scope}
                onClick={() => void submit(scope, granted ? 'withdraw' : 'grant')}
                className="shrink-0 rounded-md border px-3 py-1.5 text-xs sm:text-sm disabled:opacity-50"
              >
                {granted ? '同意を撤回する' : '同意する'}
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
