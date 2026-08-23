'use client';

// PASSAI 就活版 — 就活相談AI（司令塔）チャット画面。
//
// UI は ChatGPT 型の 2 ペイン構成（左 Sidebar = 相談履歴 / 右 Main = 会話 + composer）。
// 会話状態は localStorage（careerConsultationLogs）で保持し、生成はステートレス API
// （/api/career/consultation）に委ねる。DB / 課金 / usage 非接続。
// ★ 本ファイルの変更は presentation layer に限る。AI prompt / Data Spine / Company grounding /
//   Event Signal の呼び出し順序（loader → fetch → recordCareerEvent）は不変。

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { LinkButton } from '@/components/ui/LinkButton';
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
import { CONSULTATION_STARTER_QUERY } from '@/lib/careerConsultation/starterSuggestions';
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
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
import {
  upsertCareerConsultationThreadsToSupabase,
  deleteCareerConsultationThreadFromSupabase,
} from '@/lib/supabase/careerConsultation';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import { loadCareerEventSignalSummary } from '@/lib/careerMemory/loadEventSignals';
import {
  isConsultationEventSignalPilotEnabled,
  shouldLoadConsultationEventSignals,
} from '@/lib/careerMemory/eventSignalPilotGuard';
import type {
  CareerConsultationThread,
  CareerConsultationMessage,
  CareerConsultationRecommendedAction,
} from '@/types/careerConsultation';
import { withSourceSyncHeader } from '@/app/career/sourceSyncClient';
import { BASE_CONTEXT_SYNC_KINDS } from '@/lib/careerSourceSync/kinds';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

// ルート layout の fixed ヘッダー（h-14 = 56px）を差し引いた作業領域の高さ。
// ページ全体は伸ばさず、この枠の中で conversation だけを scroll させる（二重 scroll を作らない）。
const WORKSPACE_HEIGHT = 'h-[calc(100dvh-3.5rem)]';

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
  // Mobile 用 drawer（Desktop では常時表示のため未使用）。
  const [isSidebarOpen, setSidebarOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

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
  const messageCount = messages.length;

  // 会話が伸びたら最下部へ（チャットとして自然な挙動。scroll は main 内のみ）。
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageCount, loading, currentThreadId]);

  // composer の高さを内容に追従させる（1 行 → 最大 ~8 行）。
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 176)}px`;
  }, [input]);

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
    // L2 Event Signal（member のみ・完全に supplemental）。認証 session 由来の userId のみ使用し、
    // guest では reader を呼ばない。取得失敗 / 0件 / timeout（soft 1000ms）は undefined で、その場合は
    // Signal なしで従来どおり相談を続行する（相談本体・thread 保存・event 記録を一切止めない）。
    // 現在処理中の consultation_asked は AI 応答成功後に記録されるため、この request には含まれない。
    // P10-F: Operational Guard（Deployment guard・fail-closed）。無効なら loader を呼ばず reader 0 回・
    // 1000ms 待ちなし・body へ eventSignals を付与しない（従来 request body と完全一致）。
    const eventSignals = shouldLoadConsultationEventSignals(userId, isConsultationEventSignalPilotEnabled())
      ? await loadCareerEventSignalSummary({ userId, now: Date.now() })
      : undefined;
    try {
      const res = await fetch('/api/career/consultation', {
        method: 'POST',
        // D-R2/D-S4: base context を server Source から出してよいかの claim（revision token のみ）。
        //   生データは送らない。未送信・不一致なら server は bridge へ倒れる（安全側）。
        headers: withSourceSyncHeader(
          { 'Content-Type': 'application/json' },
          BASE_CONTEXT_SYNC_KINDS,
        ),
        body: JSON.stringify({
          message: trimmed,
          history,
          ...ctx,
          ...(eventSignals ? { eventSignals } : {}),
        }),
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
    setSidebarOpen(false);
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

  const handleSelectThread = useCallback((id: string) => {
    setCurrentThreadId(id);
    setError(null);
    setSidebarOpen(false);
  }, []);

  // Enter で送信 / Shift+Enter で改行。日本語 IME の確定 Enter は isComposing で除外する。
  // 画面が狭い端末（ソフトキーボード）では Enter を改行のまま残す。
  function handleComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches) return;
    e.preventDefault();
    void send(input);
  }

  if (!isMounted) return null;

  const sidebar = (
    <ConsultationSidebar
      threads={threads}
      currentThreadId={currentThreadId}
      onNewThread={handleNewThread}
      onSelectThread={handleSelectThread}
      onDeleteThread={handleDeleteThread}
    />
  );

  return (
    <div className={`flex ${WORKSPACE_HEIGHT} w-full overflow-hidden bg-white`}>
      {/* Desktop: 固定幅サイドバー */}
      <aside className="hidden md:flex md:w-[272px] lg:w-[288px] shrink-0 flex-col border-r border-slate-200 bg-slate-50">
        {sidebar}
      </aside>

      {/* Mobile: drawer。fixed ヘッダー（h-14）の下から始める——inset-0 だと
          drawer 上端の「＋ 新しい相談」がヘッダー（z-50）の裏に隠れる。 */}
      {isSidebarOpen && (
        <div className="fixed inset-x-0 bottom-0 top-14 z-40 md:hidden">
          <button
            type="button"
            aria-label="相談履歴を閉じる"
            onClick={() => setSidebarOpen(false)}
            className="absolute inset-0 bg-slate-900/40"
          />
          <aside className="absolute inset-y-0 left-0 flex w-[82vw] max-w-[300px] flex-col border-r border-slate-200 bg-slate-50 shadow-xl">
            {sidebar}
          </aside>
        </div>
      )}

      {/* Main: conversation + composer */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="相談履歴を開く"
            className="md:hidden shrink-0 rounded-lg border border-gray-200 p-2 text-slate-600 hover:bg-gray-50"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3 5.5h14M3 10h14M3 14.5h14" />
            </svg>
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-base sm:text-lg font-bold text-slate-900">就活相談AI</h1>
            <p className="hidden sm:block truncate text-xs text-slate-500">
              就活全体の司令塔として、今やるべきことを一緒に整理します。
            </p>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
            {hasGdRoomSignals && (
              <p className="mb-4 text-[11px] text-slate-400">
                ※ 直近のGD（グループディスカッション）結果も参考にしています。
              </p>
            )}
            {messages.length === 0 ? (
              <div className="py-10 text-center">
                <p className="text-base font-bold text-slate-800">今の状況から相談を始めましょう</p>
                <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-slate-500">
                  入力済みの自己分析・ES・面接・GD・マッチングの内容を踏まえて回答します。
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {messages.map((m) => (
                  <Bubble key={m.id} message={m} onPickFollowUp={setInput} />
                ))}
              </div>
            )}
            {loading && (
              <div className="mt-6">
                <p className="mb-1.5 text-[11px] font-bold tracking-widest text-blue-700">AI</p>
                <p className="text-sm text-slate-500">司令塔が考えています…</p>
              </div>
            )}
            {error && (
              <p className="mt-6 text-sm leading-relaxed text-red-600" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-slate-200 bg-white">
          <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6 sm:py-4">
            <div className="flex items-end gap-2 rounded-2xl border border-gray-300 bg-white px-3 py-2 shadow-sm transition focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-100">
              <textarea
                ref={composerRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder="就活について相談したいことを書いてください。"
                rows={1}
                disabled={loading}
                className="max-h-44 flex-1 resize-none bg-transparent py-1.5 text-sm text-gray-900 placeholder:text-gray-400 outline-none disabled:cursor-not-allowed disabled:text-gray-500"
              />
              <button
                type="button"
                onClick={() => send(input)}
                disabled={loading || !input.trim()}
                aria-label="相談する"
                className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-600 text-white transition-colors hover:bg-brand-700 disabled:opacity-40 disabled:pointer-events-none"
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 16V4M10 4l-5 5M10 4l5 5" />
                </svg>
              </button>
            </div>
            <p className="mt-2 hidden text-[11px] text-slate-400 md:block">
              Enter で送信 / Shift + Enter で改行
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

// 左サイドバー本体（Desktop の固定ペインと Mobile drawer で共有する）。
function ConsultationSidebar({
  threads,
  currentThreadId,
  onNewThread,
  onSelectThread,
  onDeleteThread,
}: {
  threads: CareerConsultationThread[];
  currentThreadId: string | null;
  onNewThread: () => void;
  onSelectThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pt-4">
        <button
          type="button"
          onClick={onNewThread}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-700"
        >
          ＋ 新しい相談
        </button>
      </div>

      <p className="shrink-0 px-4 pt-5 pb-2 text-[11px] font-bold tracking-widest text-slate-500">
        相談履歴
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {threads.length === 0 ? (
          <p className="px-1 py-2 text-xs text-slate-400">まだ相談履歴がありません。</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {threads.map((t) => {
              const active = t.id === currentThreadId;
              return (
                <li key={t.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onSelectThread(t.id)}
                    aria-current={active ? 'true' : undefined}
                    className={`min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      active
                        ? 'bg-white font-semibold text-slate-900 ring-1 ring-slate-200'
                        : 'text-slate-600 hover:bg-white/70'
                    }`}
                  >
                    {t.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteThread(t.id)}
                    className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-slate-400 opacity-0 transition-opacity hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
                    aria-label="この相談を削除"
                  >
                    削除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-200 px-3 py-3">
        <Link
          href="/career/home"
          className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-slate-500 transition-colors hover:bg-white hover:text-slate-800"
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
      <div className="flex flex-col items-end">
        <p className="mb-1.5 pr-1 text-[11px] font-bold tracking-widest text-slate-400">あなた</p>
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-blue-600 px-4 py-3 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }

  const r = message.result;
  return (
    <div className="flex flex-col items-start">
      <p className="mb-1.5 pl-1 text-[11px] font-bold tracking-widest text-blue-700">AI</p>
      <div className="w-full rounded-2xl bg-white px-4 py-3 ring-1 ring-slate-200">
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
