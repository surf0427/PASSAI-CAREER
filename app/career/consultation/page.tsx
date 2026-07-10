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
import { loadGdResults } from '@/app/career/gd/gdStorage';
import { loadGdRoomLogs } from '@/app/career/gd/gdRoomLogStorage';
import { loadMatchingLogs } from '@/app/career/matching/matchingStorage';
import { hasAnyActivity } from '@/app/career/activity/activityStorage';
import {
  buildConsultationStarters,
  CONSULTATION_STARTER_QUERY,
  type ConsultationDataFlags,
} from '@/lib/careerConsultation/starterSuggestions';
// P4-C: 横断 context 組み立ては lib/careerMemory/selector.ts へ抽出（出力 request body は byte 不変）。
import { buildConsultationRequestContext } from '@/lib/careerMemory/selector';
// buildLatestGdRoomSignals は下部の hasGdRoomSignals（UI注記）でも使うため引き続き import する。
import { buildLatestGdRoomSignals } from '@/lib/careerGd/context';
import {
  loadConsultationThreads,
  saveConsultationThreads,
  createThread,
  appendMessageToThread,
  deleteThread,
} from './consultationStorage';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import {
  upsertCareerConsultationThreadsToSupabase,
  deleteCareerConsultationThreadFromSupabase,
} from '@/lib/supabase/careerConsultation';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import type {
  CareerConsultationThread,
  CareerConsultationMessage,
  CareerConsultationRecommendedAction,
} from '@/types/careerConsultation';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

// localStorage から、各機能データの有無フラグを算出する（初回相談テーマの出し分け用）。
// 追加 API・DB には触れず、既存 load 関数の結果の有無だけを見る（トークンにも影響しない）。
function computeConsultationDataFlags(): ConsultationDataFlags {
  const profile = loadBasicInfo();
  const values = loadCareerValues();
  const hasValues =
    !!values &&
    Object.values(values.selections ?? {}).some((arr) => Array.isArray(arr) && arr.length > 0);
  return {
    hasProfile: !!profile && (profile.name ?? '').trim() !== '',
    hasActivity: hasAnyActivity(loadActivityData()),
    hasValues,
    hasSelfAnalysis: loadSelfAnalysisLogs().length > 0,
    hasMatching: loadMatchingLogs().length > 0,
    hasEs: loadEsLogs().length > 0,
    hasInterview: loadInterviewResults().length > 0,
    hasGd: loadGdResults().length > 0,
    hasPresentation: loadPresentationResults().length > 0,
    hasCompanyResearch: loadCompanyResearchLogs().length > 0,
  };
}

// 相談AIに渡す横断コンテキストを localStorage から組み立てる。
// P4-C: load* はここ（page）に残し、組み立ては純関数 selector へ委譲する（request body は byte 不変）。
// gdResultId があれば、そのGD結果を優先して会話文脈に載せる。
function buildConsultationContext(gdResultId?: string | null) {
  return buildConsultationRequestContext({
    profile: loadBasicInfo(),
    activity: loadActivityData(),
    values: loadCareerValues(),
    selfAnalysisLogs: loadSelfAnalysisLogs(),
    esLogs: loadEsLogs(),
    interviewResults: loadInterviewResults(),
    presentationResults: loadPresentationResults(),
    companyResearchLogs: loadCompanyResearchLogs(),
    gdResults: loadGdResults(),
    gdRoomLogs: loadGdRoomLogs(),
    matchingLogs: loadMatchingLogs(),
    gdResultId,
  });
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
  // 入力欄。ホームからの深リンク（?starter=priority|axis|matching）があれば初期値にプリフィル。
  // 初期化時に 1 回だけ解決するので、既存チャットや以降の入力を邪魔しない。
  const [input, setInput] = useState<string>(
    () => CONSULTATION_STARTER_QUERY[searchParams.get('starter') ?? ''] ?? '',
  );
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

  // STEP-CONSULT-05: 入力済みデータに応じた初回相談テーマ（fallback つき）。
  const starters = useMemo<string[]>(
    () => (isMounted ? buildConsultationStarters(computeConsultationDataFlags()) : []),
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
        // Event Log（本文なし・fire-and-forget / member のみ）。相談本文・回答本文は渡さない。
        // clientEventId = 直前に append した assistant message の安定 id（localStorage / Supabase
        // mirror と共通・イベント記録用の新規 UUID は発行しない）。retry / 再レンダー / 二重実行で
        // 同一応答なら同じ id → (user_id, client_event_id) unique index が二重 INSERT を冪等吸収する。
        // 別の相談応答は別 message id なので衝突しない。取得不能時のみ null（従来どおり非冪等）。
        const assistantMessageId = t?.messages[t.messages.length - 1]?.id ?? null;
        void recordCareerEvent(userId, {
          feature: 'consultation',
          eventType: 'consultation_asked',
          completionStatus: 'completed',
          clientEventId: assistantMessageId,
        });
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
    // localStorage（canonical）から消したスレッドを durable mirror からも削除して整合を保つ。
    // best-effort・never throw。未ログイン / env 未設定なら no-op。
    if (userId) void deleteCareerConsultationThreadFromSupabase(userId, id);
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
            <p className="text-sm font-bold text-slate-800 mb-1">今の状況から相談できます</p>
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
              入力済みの自己分析・ES・面接・GD・マッチングなどをもとに、相談テーマを出しています。
              データがまだ少ない場合は、就活準備の優先順位から整理できます。
            </p>
            <div className="flex flex-wrap gap-2">
              {starters.map((s) => (
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
      {/* STEP-CONSULT-07: 現在地サマリ（あるときだけ）を回答本文の上に独立表示。旧履歴には無いので非表示。 */}
      {r?.currentStatusSummary && (
        <div className="mb-3 rounded-xl bg-blue-50/70 ring-1 ring-blue-100 px-3 py-2.5">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-1">現在地サマリ</p>
          <p className="text-sm text-slate-700 leading-relaxed">{r.currentStatusSummary}</p>
        </div>
      )}
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
