'use client';

// PASSAI 就活版 — プレゼン対策AI result 画面。
// careerPresentationResults（localStorage）から一覧＋選択中の詳細レポートを表示し、
// 発表後の質疑応答（Q&A）をターン制で練習できる。Q&A 結果は同じ result に追記保存する。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { buildPresentationContextPayload } from '../contextSource';
import {
  loadPresentationResults,
  updatePresentationResult,
} from '../presentationStorage';
import {
  getPresentationModeConfig,
  getScenarioConfig,
  getFormatLabel,
  getSelectionTypeLabel,
  evalFocusLabels,
} from '../presentationModes';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
import { upsertCareerPresentationResultsToSupabase } from '@/lib/supabase/careerPresentation';
import type {
  CareerPresentationResult,
  CareerPresentationRank,
  CareerPresentationQaTurn,
} from '@/types/careerPresentation';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

const RANK_COLOR: Record<CareerPresentationRank, string> = {
  S: 'bg-blue-600 text-white',
  A: 'bg-emerald-600 text-white',
  B: 'bg-amber-500 text-white',
  C: 'bg-orange-500 text-white',
  D: 'bg-rose-500 text-white',
};

export default function CareerPresentationResultPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // Supabase mirror 用。useCallback の deps を変えないよう ref で最新 userId を参照する。
  const userId = useCurrentUserId();
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  const results = useMemo<CareerPresentationResult[] | null>(
    () => (isMounted ? loadPresentationResults() : null),
    [isMounted],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo<CareerPresentationResult | null>(() => {
    if (!results || results.length === 0) return null;
    return results.find((r) => r.id === selectedId) ?? results[0];
  }, [results, selectedId]);

  // ── Q&A 練習 ───────────────────────────────────────────────
  const [qaTurns, setQaTurns] = useState<CareerPresentationQaTurn[]>([]);
  const [qaActiveId, setQaActiveId] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [qaPhase, setQaPhase] = useState<'idle' | 'loading' | 'answering' | 'done'>('idle');
  const [qaError, setQaError] = useState<string | null>(null);

  // 選択中 result の保存済み Q&A を表示用に使う（練習開始前）。
  const displayedTurns =
    qaActiveId === selected?.id ? qaTurns : selected?.qa ?? [];

  const persistQa = useCallback(
    (turns: CareerPresentationQaTurn[]) => {
      if (!selected) return;
      // localStorage に追記保存（画面表示はライブの qaTurns が担うため再読込はしない）。
      const updated = { ...selected, qa: turns };
      updatePresentationResult(updated);
      // Supabase durable mirror（best-effort / member のみ）。
      if (userIdRef.current)
        void upsertCareerPresentationResultsToSupabase(userIdRef.current, [updated]);
    },
    [selected],
  );

  const callQa = useCallback(
    async (turns: CareerPresentationQaTurn[]) => {
      if (!selected) return;
      const ctx = buildPresentationContextPayload();
      const res = await fetch('/api/career/presentation/qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...ctx,
          config: selected.config ?? null,
          theme: selected.theme,
          transcript: selected.transcript,
          turns,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? '質問の生成に失敗しました。');
      }
      return (await res.json()) as {
        reaction?: string;
        question?: string | null;
        done?: boolean;
      };
    },
    [selected],
  );

  const startQa = useCallback(async () => {
    if (!selected) return;
    setQaActiveId(selected.id);
    setQaTurns([]);
    setAnswer('');
    setQaError(null);
    setQaPhase('loading');
    try {
      const data = await callQa([]);
      if (!data?.question) {
        setQaPhase('done');
        return;
      }
      const next: CareerPresentationQaTurn[] = [{ role: 'question', content: data.question }];
      setQaTurns(next);
      persistQa(next);
      setQaPhase('answering');
    } catch (e) {
      setQaError(e instanceof Error ? e.message : '質問の生成に失敗しました。');
      setQaPhase('idle');
    }
  }, [selected, callQa, persistQa]);

  const submitAnswer = useCallback(async () => {
    if (qaPhase !== 'answering') return;
    const text = answer.trim();
    if (!text) return;
    const withAnswer: CareerPresentationQaTurn[] = [...qaTurns, { role: 'answer', content: text }];
    setQaTurns(withAnswer);
    setAnswer('');
    setQaError(null);
    setQaPhase('loading');
    try {
      const data = await callQa(withAnswer);
      if (data?.done || !data?.question) {
        persistQa(withAnswer);
        setQaPhase('done');
        return;
      }
      const next: CareerPresentationQaTurn[] = [
        ...withAnswer,
        { role: 'question', content: data.question },
      ];
      setQaTurns(next);
      persistQa(next);
      setQaPhase('answering');
    } catch (e) {
      setQaError(e instanceof Error ? e.message : '質問の生成に失敗しました。');
      setQaPhase('answering');
    }
  }, [qaPhase, answer, qaTurns, callQa, persistQa]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="プレゼンの結果" description="練習したプレゼンの評価です。" />

      {results === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : results.length === 0 ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            まだプレゼンの結果がありません。プレゼンを実施してください。
          </p>
          <Link
            href="/career/presentation/target"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            プレゼンを始める →
          </Link>
        </Card>
      ) : (
        <>
          <Card variant="soft" padding="md" className="mb-5">
            <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
              練習履歴（{results.length}件）
            </p>
            <ul className="flex flex-col gap-2">
              {results.map((r) => {
                const active = selected?.id === r.id;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors ${
                        active
                          ? 'bg-blue-600 text-white'
                          : 'bg-white ring-1 ring-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className="font-semibold">{formatDate(r.createdAt)}</span>
                      <span className={active ? 'text-blue-100' : 'text-slate-400'}>
                        {' — '}
                        {resultLabel(r)}・
                        {r.result.rank}ランク（{r.result.totalScore}点）
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {selected && (
            <>
              {/* スコア・ランク */}
              <Card variant="soft" padding="md" className="mb-4">
                <div className="flex items-center gap-4">
                  <div
                    className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-2xl font-extrabold ${
                      RANK_COLOR[selected.result.rank]
                    }`}
                  >
                    {selected.result.rank}
                  </div>
                  <div className="min-w-0">
                    <p className="text-3xl font-extrabold text-slate-900">
                      {selected.result.totalScore}
                      <span className="text-sm font-bold text-slate-400"> / 100</span>
                    </p>
                    <p className="text-xs text-slate-500">
                      {resultLabel(selected)}・{formatDate(selected.createdAt)}
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-sm font-semibold text-slate-700">
                  お題: {selected.theme || '—'}
                </p>
                <ConditionRow result={selected} />
              </Card>

              <Section title="総評">
                <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {selected.result.overallComment || '—'}
                </p>
              </Section>

              {/* 評価軸別スコア */}
              <Section title="評価軸別スコア">
                <ul className="flex flex-col gap-3">
                  {selected.result.axes.map((a) => (
                    <li key={a.key}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="font-semibold text-slate-700">{a.label}</span>
                        <span className="text-slate-500">{a.score}</span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className="h-full bg-blue-600"
                          style={{ width: `${Math.max(0, Math.min(100, a.score))}%` }}
                        />
                      </div>
                      {a.comment && (
                        <p className="mt-1 text-xs text-slate-500 leading-relaxed">{a.comment}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>

              <ListSection title="良かった点" items={selected.result.goodPoints} />
              <ListSection title="改善点" items={selected.result.improvements} />
              <ListSection title="優先的に直すべきポイント" items={selected.result.priorityImprovements} />

              {/* 観点別フィードバック（任意・ある場合のみ） */}
              <TextSection title="構成へのフィードバック" text={selected.result.structureFeedback} />
              <TextSection title="説得力へのフィードバック" text={selected.result.persuasionFeedback} />
              <TextSection
                title="話し方・伝え方へのフィードバック"
                text={selected.result.deliveryFeedback}
              />

              <ListSection title="次回の練習ポイント" items={selected.result.nextPractice} />
              <ListSection title="改善版の構成例" items={selected.result.improvedStructure} />
              <ListSection title="想定される追加質問・深掘り質問" items={selected.result.expectedQuestions} />
              <ListSection
                title="面接官に突っ込まれそうな点"
                items={selected.result.interviewerConcerns}
              />

              <Section title="選考通過可能性">
                <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {selected.result.passLikelihood || '—'}
                </p>
              </Section>

              <Section title="志望業界・職種・就活軸との相性">
                <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {selected.result.companyFit || '—'}
                </p>
              </Section>

              {/* 発表後 Q&A 練習 */}
              <Section title="発表後の質疑応答（Q&A）練習">
                {displayedTurns.length > 0 && (
                  <ul className="flex flex-col gap-2 mb-4">
                    {displayedTurns.map((t, i) => (
                      <li key={i} className="text-sm leading-relaxed">
                        <span
                          className={
                            t.role === 'question'
                              ? 'font-bold text-slate-900'
                              : 'font-bold text-blue-700'
                          }
                        >
                          {t.role === 'question' ? '面接官: ' : 'あなた: '}
                        </span>
                        <span className="text-slate-700 whitespace-pre-wrap">{t.content}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {qaError && (
                  <p className="mb-3 text-sm text-red-600 leading-relaxed" role="alert">
                    {qaError}
                  </p>
                )}

                {qaActiveId === selected.id && qaPhase === 'answering' && (
                  <div>
                    <Textarea
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      placeholder="質問への回答を入力してください。"
                      rows={4}
                    />
                    <div className="mt-3">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={submitAnswer}
                        disabled={!answer.trim()}
                      >
                        回答する →
                      </Button>
                    </div>
                  </div>
                )}

                {qaActiveId === selected.id && qaPhase === 'loading' && (
                  <p className="text-sm text-slate-500">面接官が考えています…</p>
                )}

                {qaActiveId === selected.id && qaPhase === 'done' && (
                  <p className="text-sm font-semibold text-emerald-700">
                    質疑応答の練習が終了しました。お疲れさまでした。
                  </p>
                )}

                {(qaActiveId !== selected.id || qaPhase === 'idle') && (
                  <Button variant="outline" size="sm" onClick={startQa}>
                    {displayedTurns.length > 0
                      ? '質疑応答をやり直す'
                      : '発表後の質疑応答を始める'}
                  </Button>
                )}
              </Section>

              <Section title="発表の文字起こし">
                <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {selected.transcript || '—'}
                </p>
              </Section>
            </>
          )}
        </>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/presentation/setup"
          className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors"
        >
          もう一度プレゼンする →
        </Link>
        <Link
          href="/career/presentation"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← プレゼントップに戻る
        </Link>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP');
}

// 想定シーンのラベル。新履歴は config.scenario から、旧履歴は presentationType から解決する。
function resultLabel(r: CareerPresentationResult): string {
  if (r.config?.scenario) return getScenarioConfig(r.config.scenario).label;
  return getPresentationModeConfig(r.presentationType).label;
}

function formatSeconds(sec: number): string {
  if (!sec || sec <= 0) return '指定なし';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}分${s}秒` : `${m}分`;
}

// お題以外の発表条件（想定シーン・企業/業界/職種・発表時間・観点）を1行にまとめて表示。
function ConditionRow({ result }: { result: CareerPresentationResult }) {
  const cfg = result.config;
  const parts: string[] = [];
  parts.push(`想定シーン: ${resultLabel(result)}`);
  if (cfg?.companyName) parts.push(`企業: ${cfg.companyName}`);
  if (cfg?.industry) parts.push(`業界: ${cfg.industry}`);
  if (cfg?.jobType) parts.push(`職種: ${cfg.jobType}`);
  const sel = getSelectionTypeLabel(cfg?.selectionType);
  if (sel) parts.push(`選考種別: ${sel}`);
  const fmt = getFormatLabel(cfg?.format);
  if (fmt) parts.push(`形式: ${fmt}`);
  parts.push(
    `発表時間: ${formatSeconds(result.timeLimitSec)}${
      result.durationSec > 0 ? `（実測 ${formatSeconds(result.durationSec)}）` : ''
    }`,
  );
  const focus = evalFocusLabels(cfg?.evaluationFocus);
  if (focus.length > 0) parts.push(`評価観点: ${focus.join('・')}`);

  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
      {parts.map((p, i) => (
        <span key={i} className="text-[11px] text-slate-400">
          {p}
        </span>
      ))}
    </div>
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

// 任意テキストのフィードバック。値が無ければ何も描画しない（旧履歴互換）。
function TextSection({ title, text }: { title: string; text?: string }) {
  if (!text || !text.trim()) return null;
  return (
    <Section title={title}>
      <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{text}</p>
    </Section>
  );
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  return (
    <Section title={title}>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">—</p>
      ) : (
        <ul className="list-disc pl-5 space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="text-sm text-slate-700 leading-relaxed">
              {item}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
