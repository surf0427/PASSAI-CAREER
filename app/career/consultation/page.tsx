'use client';

// PASSAI 就活版 — 就活相談AI（司令塔）チャット画面。
//
// 受験版 app/tutor の UX（チャット + スレッド履歴 + 相談例 + 次アクション）を踏襲しつつ、
// 会話状態は localStorage（careerConsultationLogs）で保持し、生成はステートレス API
// （/api/career/consultation）に委ねる。DB / 課金 / usage 非接続。

import { Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { LinkButton } from '@/components/ui/LinkButton';
import { Textarea } from '@/components/ui/Textarea';
import {
  actionFeatureHref,
  actionFeatureCta,
} from '@/lib/careerConsultation/actionLinks';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { loadActivityData } from '@/app/career/activity/activityStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import { loadEsLogs } from '@/app/career/es/esStorage';
import { loadInterviewResults } from '@/app/career/interview/interviewStorage';
import { loadPresentationResults } from '@/app/career/presentation/presentationStorage';
import { loadCareerValues } from '@/app/career/values/careerValuesStorage';
import { loadCompanyResearchLogs } from '@/app/career/company-research/companyResearchStorage';
import { buildCompanyResearchContext } from '@/lib/careerCompanyResearch/context';
import { loadGdResults } from '@/app/career/gd/gdStorage';
import { loadGdRoomLogs } from '@/app/career/gd/gdRoomLogStorage';
import { loadMatchingLogs } from '@/app/career/matching/matchingStorage';
import { buildLatestMatchingConsultationSnapshots } from '@/lib/careerMatching/consultationContext';
import {
  buildLatestGdConsultationSnapshots,
  buildGdConsultationSnapshotById,
  buildLatestGdRoomSignals,
} from '@/lib/careerGd/context';
import {
  loadConsultationThreads,
  saveConsultationThreads,
  createThread,
  appendMessageToThread,
  deleteThread,
} from './consultationStorage';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import { upsertCareerConsultationThreadsToSupabase } from '@/lib/supabase/careerConsultation';
import type {
  CareerConsultationThread,
  CareerConsultationMessage,
  CareerConsultationRecommendedAction,
} from '@/types/careerConsultation';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

// よくある相談例（クリックで入力欄へ）。
const SUGGESTED_STARTERS = [
  '就活、何から始めればいいですか？',
  'ガクチカに自信がありません。相談したいです。',
  '自己PRの方向性を一緒に整理してください。',
  'ESの志望動機がうまく書けません。',
  '面接が不安です。何を準備すべきですか？',
  '業界・職種の選び方がわかりません。',
  '就活スケジュールを整理したいです。',
] as const;

// 相談AIに渡す横断コンテキストを localStorage から組み立てる。
// gdResultId があれば、そのGD結果を優先して会話文脈に載せる。
function buildConsultationContext(gdResultId?: string | null) {
  const selfLogs = loadSelfAnalysisLogs();
  const esLogs = loadEsLogs();
  const interviewResults = loadInterviewResults();
  const presentationResults = loadPresentationResults();
  return {
    profile: loadBasicInfo(),
    activity: loadActivityData(),
    values: loadCareerValues(),
    selfAnalysis: selfLogs.length > 0 ? selfLogs[0].result : null,
    es: esLogs.length > 0 ? esLogs[0].result : null,
    interviewResult: interviewResults.length > 0 ? interviewResults[0].result : null,
    presentationResult: presentationResults.length > 0 ? presentationResults[0].result : null,
    // 保存済み企業研究（最新更新順・最大5件の軽量スナップショット）。
    companyResearch: buildCompanyResearchContext(loadCompanyResearchLogs(), { limit: 5 }),
    // GD練習結果。gdResultId があればその1件を優先、無い/見つからない場合は最新2件。
    gd: gdConsultationContext(gdResultId),
    // STEP-GD-17: マルチGD の 6 軸評価を参考シグナルとして追加（最新3件・採点済みのみ）。
    gdRoom: buildLatestGdRoomSignals(loadGdRoomLogs(), 3),
    // STEP-CONSULT-03: 企業マッチング結果（最新2件・軽量スナップショット）。
    // 司令塔が「自己理解 × 企業理解」を横断し、就活軸とのズレを指摘できるようにする。
    matching: buildLatestMatchingConsultationSnapshots(loadMatchingLogs(), 2),
  };
}

// gdResultId 指定時はその GD 結果を優先、無ければ最新2件を返す（純粋な組み立て）。
function gdConsultationContext(gdResultId?: string | null) {
  const results = loadGdResults();
  if (gdResultId) {
    const byId = buildGdConsultationSnapshotById(results, gdResultId);
    if (byId) return [byId];
  }
  return buildLatestGdConsultationSnapshots(results, 2);
}

function CareerConsultationInner() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const userId = useCurrentUserId();
  const searchParams = useSearchParams();
  const gdResultId = searchParams.get('gdResultId');

  // localStorage から lazy 取得（SSR では空）。出力は isMounted で gate する。
  const [threads, setThreads] = useState<CareerConsultationThread[]>(
    () => loadConsultationThreads(),
  );
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(
    () => loadConsultationThreads()[0]?.id ?? null,
  );
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // threads 変更を localStorage へ同期（外部システムへの sync = effect の正当な用途）。
  useEffect(() => {
    saveConsultationThreads(threads);
  }, [threads]);

  const currentThread = useMemo<CareerConsultationThread | null>(
    () => threads.find((t) => t.id === currentThreadId) ?? null,
    [threads, currentThreadId],
  );

  // STEP-GD-17: マルチGD の参考シグナルが手元にあるか（UI の控えめな注記用）。
  const hasGdRoomSignals = useMemo(
    () => (isMounted ? buildLatestGdRoomSignals(loadGdRoomLogs(), 1).length > 0 : false),
    [isMounted],
  );

  const messages = currentThread?.messages ?? [];
  const latestActions = useMemo<CareerConsultationRecommendedAction[]>(() => {
    const msgs = currentThread?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'assistant' && m.result) return m.result.recommendedActions;
    }
    return [];
  }, [currentThread]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setError(null);

    // スレッドが無ければ新規作成。
    let threadId = currentThreadId;
    let working = threads;
    if (!threadId || !working.some((t) => t.id === threadId)) {
      const t = createThread();
      threadId = t.id;
      working = [t, ...working];
      setCurrentThreadId(threadId);
    }

    const thread = working.find((t) => t.id === threadId);
    const history = (thread?.messages ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const afterUser = appendMessageToThread(working, threadId, {
      role: 'user',
      content: trimmed,
    });
    setThreads(afterUser);
    setInput('');
    setLoading(true);
    // Supabase durable mirror（best-effort / member のみ / 送信ごと）。当該スレッドのみ upsert。
    if (userId) {
      const t = afterUser.find((x) => x.id === threadId);
      if (t) void upsertCareerConsultationThreadsToSupabase(userId, [t]);
    }

    const ctx = buildConsultationContext(gdResultId);
    try {
      const res = await fetch('/api/career/consultation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, history, ...ctx }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? '相談の生成に失敗しました。');
      }
      const data = (await res.json()) as {
        result: NonNullable<CareerConsultationMessage['result']>;
      };
      const afterAssistant = appendMessageToThread(afterUser, threadId, {
        role: 'assistant',
        content: data.result.answer,
        result: data.result,
      });
      setThreads(afterAssistant);
      // Supabase durable mirror（受信ごと）。当該スレッドのみ upsert。
      if (userId) {
        const t = afterAssistant.find((x) => x.id === threadId);
        if (t) void upsertCareerConsultationThreadsToSupabase(userId, [t]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '相談の生成に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  function handleNewThread() {
    const t = createThread();
    setThreads((prev) => [t, ...prev]);
    setCurrentThreadId(t.id);
    setError(null);
  }

  function handleDeleteThread(id: string) {
    setThreads((prev) => {
      const next = deleteThread(prev, id);
      if (id === currentThreadId) {
        setCurrentThreadId(next[0]?.id ?? null);
      }
      return next;
    });
  }

  if (!isMounted) return null;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="就活相談AI"
        description="就活全体の司令塔として、今やるべきことを一緒に整理します。"
      />

      {hasGdRoomSignals && (
        <p className="mb-4 text-[11px] text-slate-400">
          ※ 直近のGD（グループディスカッション）結果も参考にしています。
        </p>
      )}

      {/* 履歴一覧 */}
      <Card variant="soft" padding="md" className="mb-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest">相談履歴</p>
          <button
            type="button"
            onClick={handleNewThread}
            className="text-xs font-semibold text-blue-600 hover:underline"
          >
            ＋ 新しい相談
          </button>
        </div>
        {threads.length === 0 ? (
          <p className="text-xs text-slate-400">まだ相談履歴がありません。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {threads.map((t) => {
              const active = t.id === currentThreadId;
              return (
                <li key={t.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCurrentThreadId(t.id)}
                    className={`flex-1 text-left rounded-lg px-3 py-2 text-sm transition-colors truncate ${
                      active
                        ? 'bg-blue-600 text-white'
                        : 'bg-white ring-1 ring-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {t.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteThread(t.id)}
                    className="shrink-0 text-xs text-slate-400 hover:text-red-500"
                    aria-label="この相談を削除"
                  >
                    削除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* チャット */}
      <div className="mb-5 flex flex-col gap-3">
        {messages.length === 0 ? (
          <Card variant="soft" padding="md">
            <p className="text-sm font-bold text-slate-800 mb-3">よくある相談例</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setInput(s)}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </Card>
        ) : (
          messages.map((m) => <Bubble key={m.id} message={m} onPickFollowUp={setInput} />)
        )}
        {loading && (
          <div className="self-start rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-500">
            司令塔が考えています…
          </div>
        )}
      </div>

      {/* 司令塔からの次アクション（最新回答分を上部に集約表示） */}
      {latestActions.length > 0 && (
        <Card variant="soft" padding="md" className="mb-5 ring-1 ring-blue-100 bg-blue-50/40">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">
            司令塔からの次アクション
          </p>
          <ActionList actions={latestActions} />
        </Card>
      )}

      {error && (
        <p className="mb-4 text-sm text-red-600 leading-relaxed" role="alert">
          {error}
        </p>
      )}

      {/* 入力 */}
      <Card variant="soft" padding="md" className="mb-5">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="就活について相談したいことを書いてください。"
          rows={3}
          disabled={loading}
        />
        <div className="mt-3 flex justify-end">
          <Button
            variant="primary"
            size="md"
            onClick={() => send(input)}
            disabled={loading || !input.trim()}
          >
            {loading ? '送信中…' : '相談する →'}
          </Button>
        </div>
      </Card>

      <div className="mt-2">
        <Link
          href="/career/home"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← ホームに戻る
        </Link>
      </div>
    </div>
  );
}

function Bubble({
  message,
  onPickFollowUp,
}: {
  message: CareerConsultationMessage;
  onPickFollowUp: (text: string) => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="self-end max-w-[85%] rounded-2xl bg-blue-600 px-4 py-3 text-sm text-white whitespace-pre-wrap">
        {message.content}
      </div>
    );
  }

  const r = message.result;
  return (
    <div className="self-start w-full max-w-[95%] rounded-2xl bg-white ring-1 ring-slate-200 px-4 py-3">
      <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
        {message.content}
      </p>
      {r && (
        <div className="mt-3 flex flex-col gap-3">
          <MiniList title="ポイント" items={r.keyInsights} />
          {r.recommendedActions.length > 0 && (
            <ActionList title="この相談から進めること" actions={r.recommendedActions} />
          )}
          <MiniList title="教えてほしいこと（不足情報）" items={r.missingInformation} />
          {r.followUpQuestions.length > 0 && (
            <div>
              <p className="text-[11px] font-bold text-slate-500 mb-1.5">深掘りの問い</p>
              <div className="flex flex-wrap gap-2">
                {r.followUpQuestions.map((q, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onPickFollowUp(q)}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 text-left"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MiniList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] font-bold text-slate-500 mb-1">{title}</p>
      <ul className="list-disc pl-5 space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-sm text-slate-700 leading-relaxed">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

// priority の控えめなチップ表示。
const PRIORITY_META: Record<
  NonNullable<Exclude<CareerConsultationRecommendedAction, string>['priority']>,
  { label: string; className: string }
> = {
  high: { label: '優先度 高', className: 'bg-amber-50 text-amber-700 ring-amber-200' },
  medium: { label: '優先度 中', className: 'bg-slate-100 text-slate-600 ring-slate-200' },
  low: { label: '優先度 低', className: 'bg-slate-50 text-slate-500 ring-slate-200' },
};

function PriorityChip({
  priority,
}: {
  priority: NonNullable<Exclude<CareerConsultationRecommendedAction, string>['priority']>;
}) {
  const meta = PRIORITY_META[priority];
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

// 次アクション 1 件の表示。string（旧互換）はテキスト、object は理由・優先度・機能導線を出す。
function ActionItem({ action }: { action: CareerConsultationRecommendedAction }) {
  if (typeof action === 'string') {
    return (
      <li className="ml-5 list-disc text-sm text-slate-700 leading-relaxed">{action}</li>
    );
  }
  const href = actionFeatureHref(action.feature);
  const cta = actionFeatureCta(action.feature);
  return (
    <li className="rounded-lg bg-slate-50 ring-1 ring-slate-100 px-3 py-2.5">
      <div className="flex items-start gap-2">
        {action.priority && <PriorityChip priority={action.priority} />}
        <p className="flex-1 text-sm text-slate-800 leading-relaxed">{action.label}</p>
      </div>
      {action.reason && (
        <p className="mt-1 text-xs text-slate-500 leading-relaxed">{action.reason}</p>
      )}
      {href && (
        <div className="mt-2">
          <LinkButton href={href} variant="secondary" size="sm">
            {cta} →
          </LinkButton>
        </div>
      )}
    </li>
  );
}

// 次アクション一覧。string / object を混在で安全に描画する（後方互換）。
function ActionList({
  title,
  actions,
}: {
  title?: string;
  actions: CareerConsultationRecommendedAction[];
}) {
  if (!actions || actions.length === 0) return null;
  return (
    <div>
      {title && <p className="text-[11px] font-bold text-slate-500 mb-1.5">{title}</p>}
      <ul className="flex flex-col gap-2">
        {actions.map((a, i) => (
          <ActionItem key={i} action={a} />
        ))}
      </ul>
    </div>
  );
}

export default function CareerConsultationPage() {
  return (
    <Suspense fallback={null}>
      <CareerConsultationInner />
    </Suspense>
  );
}
