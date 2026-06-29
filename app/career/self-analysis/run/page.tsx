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
import { appendSelfAnalysisLog } from '../selfAnalysisStorage';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import { upsertCareerSelfAnalysisResultsToSupabase } from '@/lib/supabase/careerSelfAnalysis';
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
  function payload() {
    return { profile: basicInfo, activity, values };
  }

  // 深掘り開始（1問目を取得）。成功するまで画面は intro のまま。
  async function startDeepDive() {
    if (!canRun || busy) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/career/self-analysis/question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload(), turns: [] }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? '深掘りの開始に失敗しました。');
      }
      const data = (await res.json()) as { question?: string | null };
      if (!data.question) throw new Error('質問の生成に失敗しました。');
      setTurns([{ role: 'question', content: data.question }]);
      setReaction('');
      setPhase('chatting');
    } catch (e) {
      setError(e instanceof Error ? e.message : '深掘りの開始に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  // 回答を送って次の質問（or 終了）を取得。
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
      const res = await fetch('/api/career/self-analysis/question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload(), turns: turnsBefore, answer: trimmed }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? '次の質問の生成に失敗しました。');
      }
      const data = (await res.json()) as {
        done?: boolean;
        reaction?: string;
        question?: string | null;
      };

      if (data.done || !data.question) {
        setTurns(withAnswer);
        setReaction(data.reaction ?? '');
        setAnswer('');
        setPhase('done');
        return;
      }

      setTurns([...withAnswer, { role: 'question', content: data.question }]);
      setReaction(data.reaction ?? '');
      setAnswer('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '次の質問の生成に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  // 自己分析結果を生成する（会話があれば conversation として渡す）。
  async function generate() {
    if (!canRun || busy) return;
    setError(null);
    setGenerating(true);
    try {
      const res = await fetch('/api/career/self-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload(), conversation: turns }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? '自己分析の生成に失敗しました。');
      }
      const data = (await res.json()) as { result: CareerSelfAnalysisResult };
      const log = {
        id: newId(),
        createdAt: new Date().toISOString(),
        userInput: '',
        result: data.result,
      };
      appendSelfAnalysisLog(log);
      // Supabase durable mirror（best-effort / member のみ）。
      if (userId) void upsertCareerSelfAnalysisResultsToSupabase(userId, [log]);
      router.push('/career/self-analysis/result');
    } catch (e) {
      setError(e instanceof Error ? e.message : '自己分析の生成に失敗しました。');
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

      {/* intro: 開始方法の選択 */}
      {phase === 'intro' && (
        <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
          <p className="text-sm font-bold text-slate-800 mb-1">深掘りしながら分析する（おすすめ）</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">
            AIが {MAX_TURNS} 問程度の質問を1つずつ出します。あなたの回答に合わせて深掘りし、
            行動の理由・成果・価値観・向いている環境までを引き出してから分析を作ります。
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
