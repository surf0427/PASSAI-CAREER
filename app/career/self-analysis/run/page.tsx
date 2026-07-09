'use client';

// PASSAI 就活版 — 自己分析AI 実行画面（会話型 深掘り壁打ち / Phase 1）
//
// 入力: careerBasicFormData（基本情報）/ careerActivityData（活動整理）/ careerValues（就活軸）。
// 流れ:
//   intro    … 入力データを確認し「深掘りを始める」or「すぐに分析を生成」を選ぶ。
//   chatting … /api/career/self-analysis/question で 1問ずつ深掘り（回答に応じて次の質問）。
//   done     … 上限到達 or ユーザーが切り上げ。
//   生成     … /api/career/self-analysis に conversation を渡して v2 結果を生成 → ログ保存 → 結果へ。
// 会話は本画面の state で保持する（resume は Phase 2）。DB / 課金 / usage 非接続（localStorage のみ）。

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import {
  loadActivityData,
  hasAnyActivity,
} from '@/app/career/activity/activityStorage';
import {
  loadCareerValues,
  isCareerValuesEmpty,
} from '@/app/career/values/careerValuesStorage';
import { appendSelfAnalysisLog, loadSelfAnalysisLogs } from '../selfAnalysisStorage';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import { upsertCareerSelfAnalysisResultsToSupabase } from '@/lib/supabase/careerSelfAnalysis';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import { buildSelfAnalysisPastSummaries } from '@/lib/careerSelfAnalysis/pastLogSummary';
import type { BasicInfo } from '@/types/basicInfo';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type {
  CareerSelfAnalysisResult,
  CareerSelfAnalysisTurn,
} from '@/types/careerSelfAnalysis';

// 進捗表示用の上限（サーバ側 CAREER_SELF_ANALYSIS_MAX_TURNS と一致させる）。
const MAX_TURNS = 6;

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `csa-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// クライアント側のタイムアウト（サーバ無応答でも操作不能にならないよう上限を設ける）。
// 質問生成は軽い（サーバ AI timeout 30s）ため 35s。結果生成は重い（サーバ 60s）ため 70s。
const QUESTION_TIMEOUT_MS = 35_000;
const GENERATE_TIMEOUT_MS = 70_000;

// HTTP status → ユーザー向けフォールバック文言。detail が無い場合に使う。
function statusFallback(status: number, fallback: string): string {
  if (status === 429) return 'ただいま混み合っています。少し時間を置いてお試しください。';
  if (status === 503 || status === 504) {
    return 'AIの応答に時間がかかっています。少し時間を置いてもう一度お試しください。';
  }
  return fallback;
}

// タイムアウト付き POST。fetch 自体の reject（モバイルSafari の "Load failed" 等）と
// API エラー（!res.ok）を区別し、常に自然な日本語メッセージに変換して throw する。
// 成功時は JSON をそのまま返す。呼び出し側は throw された Error.message をそのまま表示できる。
async function postJson(
  url: string,
  body: unknown,
  timeoutMs: number,
  fallbackMessage: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    // ネットワーク reject（"Load failed" / "Failed to fetch"）or クライアント timeout（abort）。
    const aborted = !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
    throw new Error(
      aborted
        ? '時間内に応答がありませんでした。電波の良い場所で、もう一度お試しください。'
        : '通信に失敗しました。電波の良い場所で、少し時間を置いてもう一度お試しください。',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail ?? statusFallback(res.status, fallbackMessage));
  }

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data) throw new Error(fallbackMessage);
  return data;
}

// 画面の論理状態（busy は loading フラグで別管理する）。
type Phase = 'intro' | 'chatting' | 'done';

function countAnswers(turns: CareerSelfAnalysisTurn[]): number {
  return turns.filter((t) => t.role === 'answer').length;
}

function currentQuestion(turns: CareerSelfAnalysisTurn[]): string | null {
  const last = turns[turns.length - 1];
  return last && last.role === 'question' ? last.content : null;
}

export default function CareerSelfAnalysisRunPage() {
  const router = useRouter();
  const userId = useCurrentUserId();
  const [phase, setPhase] = useState<Phase>('intro');
  const [turns, setTurns] = useState<CareerSelfAnalysisTurn[]>([]);
  const [answer, setAnswer] = useState('');
  const [reaction, setReaction] = useState('');
  // AI 呼び出し中フラグ（質問生成・最終生成で共有）。
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const basicInfo = useMemo<BasicInfo | null>(
    () => (isMounted ? loadBasicInfo() : null),
    [isMounted],
  );
  const activity = useMemo<CareerActivity | null>(
    () => (isMounted ? loadActivityData() : null),
    [isMounted],
  );
  const values = useMemo<CareerValues | null>(
    () => (isMounted ? loadCareerValues() : null),
    [isMounted],
  );

  // 過去の自己分析ログの軽量サマリ（最新→過去・最大3件）。今回のログ生成前に読むので過去分のみ。
  // 深掘り質問・結果生成へ渡し「繰り返し回避」と「次テーマ選定」「初回/2回目以降の出し分け」に使う。
  const pastSummaries = useMemo(
    () => (isMounted ? buildSelfAnalysisPastSummaries(loadSelfAnalysisLogs()) : []),
    [isMounted],
  );
  const isRepeatRun = pastSummaries.length > 0;

  const profileReady = !!basicInfo;
  const activityReady = hasAnyActivity(activity);
  const valuesReady = !!values && !isCareerValuesEmpty(values);
  const canRun = profileReady || activityReady;

  const question = currentQuestion(turns);
  const answered = countAnswers(turns);
  const progressPct = Math.min(100, Math.round((answered / MAX_TURNS) * 100));
  const questionNumber = Math.min(answered + 1, MAX_TURNS);
  const busy = loading || generating;

  // 入力データを body に積む（最新の localStorage を反映）。
  // pastSummaries は過去ログの軽量サマリ（全文は渡さない）。
  function payload() {
    return { profile: basicInfo, activity, values, pastSummaries };
  }

  // 深掘り開始（1問目を取得）。成功するまで画面は intro のまま。
  async function startDeepDive() {
    if (!canRun || busy) return;
    setError(null);
    setLoading(true);
    try {
      const data = await postJson(
        '/api/career/self-analysis/question',
        { ...payload(), turns: [] },
        QUESTION_TIMEOUT_MS,
        '深掘りの開始に失敗しました。もう一度お試しください。',
      );
      const question = typeof data.question === 'string' ? data.question : '';
      if (!question) throw new Error('質問の生成に失敗しました。もう一度お試しください。');
      setTurns([{ role: 'question', content: question }]);
      setReaction('');
      setPhase('chatting');
    } catch (e) {
      setError(e instanceof Error ? e.message : '深掘りの開始に失敗しました。もう一度お試しください。');
    } finally {
      setLoading(false);
    }
  }

  // 回答を送って次の質問（or 終了）を取得。
  // 失敗時は回答文・turns を保持し、同じ回答でそのまま再試行 or「ここまでで生成」に進めるようにする。
  async function submitAnswer() {
    if (phase !== 'chatting' || busy) return;
    const trimmed = answer.trim();
    if (!trimmed) return;
    setError(null);
    setLoading(true);

    const turnsBefore = turns;
    const withAnswer: CareerSelfAnalysisTurn[] = [
      ...turnsBefore,
      { role: 'answer', content: trimmed },
    ];

    try {
      const data = await postJson(
        '/api/career/self-analysis/question',
        { ...payload(), turns: turnsBefore, answer: trimmed },
        QUESTION_TIMEOUT_MS,
        '次の質問の生成に失敗しました。もう一度お試しください。',
      );

      const done = data.done === true;
      const nextQuestion = typeof data.question === 'string' ? data.question : '';
      const reactionText = typeof data.reaction === 'string' ? data.reaction : '';

      if (done || !nextQuestion) {
        setTurns(withAnswer);
        setReaction(reactionText);
        setAnswer('');
        setPhase('done');
        return;
      }

      setTurns([...withAnswer, { role: 'question', content: nextQuestion }]);
      setReaction(reactionText);
      setAnswer('');
    } catch (e) {
      // answer/turns は保持したまま（再試行 or 途中生成できるように）。
      setError(e instanceof Error ? e.message : '次の質問の生成に失敗しました。もう一度お試しください。');
    } finally {
      setLoading(false);
    }
  }

  // 自己分析結果を生成する（会話があれば conversation として渡す）。
  // 質問生成が失敗していても、既存 turns があれば本関数で結果生成に進める。
  async function generate() {
    if (!canRun || busy) return;
    setError(null);
    setGenerating(true);
    try {
      const data = await postJson(
        '/api/career/self-analysis',
        { ...payload(), conversation: turns },
        GENERATE_TIMEOUT_MS,
        '分析の生成に失敗しました。入力内容は保持されています。もう一度お試しください。',
      );
      const result = data.result as CareerSelfAnalysisResult | undefined;
      if (!result) throw new Error('分析の生成に失敗しました。もう一度お試しください。');
      const log = {
        id: newId(),
        createdAt: new Date().toISOString(),
        userInput: '',
        result,
      };
      appendSelfAnalysisLog(log);
      // Supabase durable mirror（best-effort / member のみ）。
      if (userId) {
        void upsertCareerSelfAnalysisResultsToSupabase(userId, [log]);
        // Event Log（本文なし・fire-and-forget / member のみ）。自己分析本文・AI出力本文・
        // 強み弱み本文・深掘り質問/回答本文・userInput は渡さない。深掘り回数のみ turnCount で記録。
        // event_type は ai_generated（AI生成物である点で ES と同方針）。
        void recordCareerEvent(userId, {
          feature: 'self_analysis',
          eventType: 'ai_generated',
          completionStatus: 'completed',
          clientEventId: log.id,
          metadata: { turnCount: countAnswers(turns) },
        });
      }
      router.push('/career/self-analysis/result');
    } catch (e) {
      setError(e instanceof Error ? e.message : '分析の生成に失敗しました。もう一度お試しください。');
      setGenerating(false);
    }
    // 成功時は遷移するため setGenerating(false) は不要（失敗時のみ上で解除）。
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="自己分析AI"
        description="AIと対話しながら経験を深掘りし、就活で使える自己分析を作成します。"
      />

      {/* 入力データ */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">入力データ</p>
        <div className="grid grid-cols-2 gap-y-3 gap-x-4">
          <ReadyItem label="基本情報" ready={profileReady} href="/career/profile" />
          <ReadyItem label="活動整理" ready={activityReady} href="/career/activity" />
          <ReadyItem label="就活軸" ready={valuesReady} href="/career/values" />
        </div>
        {!canRun && (
          <p className="mt-4 text-xs text-amber-700 leading-relaxed">
            基本情報または活動整理のいずれかを入力すると実行できます。
          </p>
        )}
      </Card>

      {/* 複数回利用の前提を伝える案内（初回 / 2回目以降で文言を出し分け）。 */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">
          自己分析の進め方
        </p>
        {isRepeatRun ? (
          <p className="text-xs text-slate-600 leading-relaxed">
            自己分析は1回で完成させるものではありません。今回は前回までに扱えていない活動・価値観を中心に、
            別の観点から深掘りします。回数を重ねるほど、強み・向いている環境・志望軸がより具体的になり、
            ES・面接・企業選びに使える自己理解に育っていきます。
          </p>
        ) : (
          <p className="text-xs text-slate-600 leading-relaxed">
            今回は活動・価値観を幅広く確認し、全体像（仮説）を作ります。1回で掘り切る必要はありません。
            活動整理・就活軸整理をもとに、自己分析を複数回行うことで、強み・向いている環境・志望軸が
            少しずつ具体化され、ES・面接・企業選びに使える自己理解に育っていきます。
          </p>
        )}
      </Card>

      {/* intro: 開始方法の選択 */}
      {phase === 'intro' && (
        <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
          <p className="text-sm font-bold text-slate-800 mb-1">深掘りしながら分析する（おすすめ）</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">
            AIが {MAX_TURNS} 問程度の質問を1つずつ出します。1つの活動に偏らず、複数の活動・価値観・就活軸を
            幅広く横断しながら、行動の理由・成果・向いている環境までを引き出して分析を作ります。
          </p>
          {error && (
            <p className="mb-3 text-sm text-red-600 leading-relaxed" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-col sm:flex-row gap-3">
            <Button
              variant="primary"
              size="md"
              onClick={startDeepDive}
              disabled={!canRun || busy}
              className="w-full sm:w-auto"
            >
              {loading ? '準備中…' : '深掘りを始める →'}
            </Button>
            <Button
              variant="outline"
              size="md"
              onClick={generate}
              disabled={!canRun || busy}
              className="w-full sm:w-auto"
            >
              {generating ? '生成中…' : '対話せずにすぐ生成する'}
            </Button>
          </div>
        </Card>
      )}

      {/* chatting: 進行バー + 質問 + 回答 */}
      {phase === 'chatting' && (
        <>
          <div className="mb-5">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
              <span>質問 {questionNumber} / {MAX_TURNS}</span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full bg-blue-600 transition-all" style={{ width: `${progressPct}%` }} />
            </div>
          </div>

          {reaction && (
            <p className="mb-3 text-xs text-slate-500 italic">AI: {reaction}</p>
          )}

          {question && (
            <Card variant="soft" padding="md" className="mb-5">
              <p className="text-base font-bold text-slate-900 leading-relaxed whitespace-pre-wrap">
                {question}
              </p>
            </Card>
          )}

          <Card variant="soft" padding="md" className="mb-5">
            <label className="block text-sm font-bold text-slate-800 mb-2">あなたの回答</label>
            <Textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="思い出せる範囲で、具体的に書いてください。"
              rows={5}
              disabled={busy}
            />
            {error && (
              <p className="mt-3 text-sm text-red-600 leading-relaxed" role="alert">
                {error}
              </p>
            )}
            <div className="mt-4 flex flex-col sm:flex-row gap-3">
              <Button
                variant="primary"
                size="md"
                onClick={submitAnswer}
                disabled={busy || !answer.trim()}
                className="w-full sm:w-auto"
              >
                {loading ? 'AIが考えています…' : '回答を送る →'}
              </Button>
              {answered >= 1 && (
                <Button
                  variant="outline"
                  size="md"
                  onClick={generate}
                  disabled={busy}
                  className="w-full sm:w-auto"
                >
                  {generating ? '生成中…' : 'ここまでで分析を生成する'}
                </Button>
              )}
            </div>
          </Card>
        </>
      )}

      {/* done: 深掘り完了 → 生成 */}
      {phase === 'done' && (
        <Card variant="soft" padding="md" className="mb-5">
          {reaction && <p className="mb-3 text-xs text-slate-500 italic">AI: {reaction}</p>}
          <p className="text-sm font-bold text-slate-800 mb-1">深掘りが完了しました</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-3">
            {answered} 件の回答をもとに、就活向けの自己分析を作成します。
          </p>
          {error && (
            <p className="mb-3 text-sm text-red-600 leading-relaxed" role="alert">
              {error}
            </p>
          )}
          <Button
            variant="primary"
            size="md"
            onClick={generate}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {generating ? '分析を作成中…' : '自己分析を生成する →'}
          </Button>
        </Card>
      )}

      <div className="mt-4">
        <Link
          href="/career/self-analysis"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← 自己分析トップに戻る
        </Link>
      </div>
    </div>
  );
}

function ReadyItem({ label, ready, href }: { label: string; ready: boolean; href: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-slate-500 mb-0.5">{label}</p>
      {ready ? (
        <p className="text-sm font-semibold text-emerald-700">入力あり</p>
      ) : (
        <Link href={href} className="text-sm font-semibold text-blue-600 hover:underline">
          未入力（入力する →）
        </Link>
      )}
    </div>
  );
}
