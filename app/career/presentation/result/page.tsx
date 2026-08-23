'use client';

// PASSAI 就活版 — プレゼン対策AI result 画面。
// careerPresentationResults（localStorage）から一覧＋選択中の詳細レポートを表示し、
// 発表後の質疑応答（Q&A）をターン制で練習できる。Q&A 結果は同じ result に追記保存する。
//
// Q&A の終了条件と最終評価:
//   最後の回答を送ると API が done を返す（上限 CAREER_PRESENTATION_QA_MAX_TURNS 到達）。
//   その done を受けて **必ず** mode:'final' で質疑応答全体の最終評価を取りに行き、
//   result.qaReview として localStorage に永続化する（リロード・過去結果からも見える）。

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
  getSelectionTypeLabel,
  evalFocusLabels,
} from '../presentationModes';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
import { upsertCareerPresentationResultsToSupabase } from '@/lib/supabase/careerPresentation';
import type {
  CareerPresentationResult,
  CareerPresentationRank,
  CareerPresentationQaReview,
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
  // finalizing … 全問終了後、最終評価を生成中。final_error … 最終評価だけが失敗（回答履歴は保持）。
  const [qaPhase, setQaPhase] = useState<
    'idle' | 'loading' | 'answering' | 'finalizing' | 'final_error' | 'done'
  >('idle');
  const [qaError, setQaError] = useState<string | null>(null);
  // 質疑応答全体の最終評価（今セッション分）。過去分は selected.qaReview を見る。
  const [qaReview, setQaReview] = useState<CareerPresentationQaReview | null>(null);
  // 最終評価の二重実行ガード（done 受信と再試行ボタンの両方から呼ばれるため）。
  const finalizingRef = useRef(false);
  // 回答送信の二重実行ガード。qaPhase はクロージャに閉じ込められるため、同一 render 中の
  // 連打では state だけでは弾けない（同じ回答が 2 回 turns に積まれるのを防ぐ）。
  const submittingRef = useRef(false);

  // 選択中 result の保存済み Q&A を表示用に使う（練習開始前）。
  const isLiveQa = qaActiveId === selected?.id;
  const displayedTurns = isLiveQa ? qaTurns : selected?.qa ?? [];
  const displayedReview = isLiveQa ? qaReview : selected?.qaReview ?? null;

  const persistQa = useCallback(
    (turns: CareerPresentationQaTurn[], review?: CareerPresentationQaReview | null) => {
      if (!selected) return;
      // localStorage に追記保存（画面表示はライブの qaTurns が担うため再読込はしない）。
      //   ★ review 未指定なら qaReview を **落とす**。selected は初回ロード時の snapshot なので、
      //     「やり直す」で新しい Q&A を始めたときに前回の最終評価が残らないようにする。
      const updated: CareerPresentationResult = { ...selected, qa: turns };
      if (review) updated.qaReview = review;
      else delete updated.qaReview;
      updatePresentationResult(updated);
      // Supabase durable mirror（best-effort / member のみ）。
      if (userIdRef.current)
        void upsertCareerPresentationResultsToSupabase(userIdRef.current, [updated]);
    },
    [selected],
  );

  // 質問生成（既定）と最終評価（mode:'final'）で同じ route / 同じ context payload を使う。
  const callQa = useCallback(
    async (turns: CareerPresentationQaTurn[], mode?: 'final') => {
      if (!selected) return;
      const ctx = buildPresentationContextPayload();
      const res = await fetch('/api/career/presentation/qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...ctx,
          config: selected.config ?? null,
          // 企業公式情報の出し分けに使う（旧ログの自己PR / ガクチカは除外される）。
          presentationType: selected.presentationType,
          theme: selected.theme,
          transcript: selected.transcript,
          turns,
          ...(mode ? { mode } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(
          data?.detail ?? (mode === 'final' ? '評価の生成に失敗しました。' : '質問の生成に失敗しました。'),
        );
      }
      return (await res.json()) as {
        reaction?: string;
        question?: string | null;
        done?: boolean;
        review?: CareerPresentationQaReview;
      };
    },
    [selected],
  );

  /**
   * 質疑応答全体の最終評価を生成して保存する。
   *
   * ★ 引数 turns は **呼び出し側が確定させた配列**（最後のユーザー回答を含む）。
   *   qaTurns state を読まないのは、setQaTurns 直後に呼ばれても最新値が反映されている保証が
   *   ないため（stale state で最後の回答が評価対象から抜ける事故を構造的に防ぐ）。
   * ★ 失敗しても回答履歴（turns）は persist 済みのまま保持し、再試行できる状態にする。
   */
  const runFinalReview = useCallback(
    async (turns: CareerPresentationQaTurn[]) => {
      if (finalizingRef.current) return;
      finalizingRef.current = true;
      setQaError(null);
      setQaPhase('finalizing');
      try {
        const data = await callQa(turns, 'final');
        if (!data?.review) throw new Error('評価の生成に失敗しました。');
        setQaReview(data.review);
        persistQa(turns, data.review);
        setQaPhase('done');
      } catch (e) {
        setQaError(e instanceof Error ? e.message : '評価の生成に失敗しました。');
        setQaPhase('final_error');
      } finally {
        finalizingRef.current = false;
      }
    },
    [callQa, persistQa],
  );

  const startQa = useCallback(async () => {
    if (!selected) return;
    setQaActiveId(selected.id);
    setQaTurns([]);
    setAnswer('');
    setQaError(null);
    // 「やり直す」で前回の最終評価が残らないようにする（persistQa 側でも保存から落とす）。
    setQaReview(null);
    finalizingRef.current = false;
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
    if (qaPhase !== 'answering' || submittingRef.current) return;
    const text = answer.trim();
    if (!text) return;
    submittingRef.current = true;
    const withAnswer: CareerPresentationQaTurn[] = [...qaTurns, { role: 'answer', content: text }];
    setQaTurns(withAnswer);
    setAnswer('');
    setQaError(null);
    setQaPhase('loading');
    try {
      const data = await callQa(withAnswer);
      if (data?.done || !data?.question) {
        // Q&A 終了。まず回答履歴を確定保存し、続けて **最後の回答を含む** withAnswer を
        // 評価対象として最終評価を生成する（ここが無いと「終了しました」で終わってしまう）。
        persistQa(withAnswer);
        await runFinalReview(withAnswer);
        return;
      }
      const next: CareerPresentationQaTurn[] = [
        ...withAnswer,
        {
          role: 'question',
          content: data.question,
          // 直前の回答へのリアクション（API は以前から返していたが捨てられていた）。
          // 空文字は保存しない（旧ログと同じ「リアクション無し」状態に揃える）。
          ...(data.reaction?.trim() ? { reaction: data.reaction.trim() } : {}),
        },
      ];
      setQaTurns(next);
      persistQa(next);
      setQaPhase('answering');
    } catch (e) {
      setQaError(e instanceof Error ? e.message : '質問の生成に失敗しました。');
      setQaPhase('answering');
    } finally {
      submittingRef.current = false;
    }
  }, [qaPhase, answer, qaTurns, callQa, persistQa, runFinalReview]);

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
                        {/* 直前の回答への一言リアクション（面接 / ES 深掘りと同じ扱い）。
                            旧ログには無いので、値があるときだけ質問の上に出す。 */}
                        {t.role === 'question' && t.reaction && (
                          <p className="mb-1 text-xs text-emerald-700">{t.reaction}</p>
                        )}
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

                {isLiveQa && qaPhase === 'answering' && (
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
                        disabled={!answer.trim() || qaPhase !== 'answering'}
                      >
                        回答する →
                      </Button>
                    </div>
                  </div>
                )}

                {isLiveQa && qaPhase === 'loading' && (
                  <p className="text-sm text-slate-500">面接官が考えています…</p>
                )}

                {/* 全問終了 → 質疑応答全体の最終評価を生成中。 */}
                {isLiveQa && qaPhase === 'finalizing' && (
                  <p className="text-sm text-slate-500">
                    質疑応答が終了しました。回答全体を評価しています…
                  </p>
                )}

                {/* 最終評価だけが失敗したケース。回答履歴は保存済みのまま再試行できる。 */}
                {isLiveQa && qaPhase === 'final_error' && (
                  <Button variant="outline" size="sm" onClick={() => void runFinalReview(qaTurns)}>
                    最終評価をもう一度生成する
                  </Button>
                )}

                {isLiveQa && qaPhase === 'done' && (
                  <p className="mb-3 text-sm font-semibold text-emerald-700">
                    質疑応答の練習が終了しました。お疲れさまでした。
                  </p>
                )}

                {/* 質疑応答全体の最終評価（今セッション分 / 過去ログのどちらも同じ描画）。 */}
                {displayedReview && <QaReviewView review={displayedReview} />}

                {(!isLiveQa || qaPhase === 'idle') && (
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

// 履歴 1 件のラベル。presentationType は新旧すべての履歴が必ず持つため、これだけで解決できる
// （旧「想定シーン」由来のラベルは廃止した）。
function resultLabel(r: CareerPresentationResult): string {
  return getPresentationModeConfig(r.presentationType).label;
}

function formatSeconds(sec: number): string {
  if (!sec || sec <= 0) return '指定なし';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}分${s}秒` : `${m}分`;
}

// お題以外の発表条件（企業/業界/職種・選考種別・発表時間・観点）を1行にまとめて表示。
function ConditionRow({ result }: { result: CareerPresentationResult }) {
  const cfg = result.config;
  const parts: string[] = [];
  if (cfg?.companyName) parts.push(`企業: ${cfg.companyName}`);
  if (cfg?.industry) parts.push(`業界: ${cfg.industry}`);
  if (cfg?.jobType) parts.push(`職種: ${cfg.jobType}`);
  const sel = getSelectionTypeLabel(cfg?.selectionType);
  if (sel) parts.push(`選考種別: ${sel}`);
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

// 質疑応答全体の最終評価。本編レポートと同じ「スコア＋軸バー＋箇条書き」の見せ方に揃える
// （Q&A 用に軽量な 4 軸版。本編評価の表示は一切変えない）。
function QaReviewView({ review }: { review: CareerPresentationQaReview }) {
  return (
    <div className="mt-1 rounded-xl bg-white ring-1 ring-slate-200 p-4">
      <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
        質疑応答の最終評価
      </p>

      <div className="flex items-center gap-4">
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-xl font-extrabold ${
            RANK_COLOR[review.rank]
          }`}
        >
          {review.rank}
        </div>
        <p className="text-2xl font-extrabold text-slate-900">
          {review.totalScore}
          <span className="text-xs font-bold text-slate-400"> / 100</span>
        </p>
      </div>

      {review.overallComment && (
        <p className="mt-3 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
          {review.overallComment}
        </p>
      )}

      {review.axes.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {review.axes.map((a) => (
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
      )}

      <QaReviewList title="良かった点" items={review.goodPoints} />
      <QaReviewList title="改善すべき点" items={review.improvements} />
      <QaReviewList title="次回に向けたアドバイス" items={review.nextPractice} />
    </div>
  );
}

// 最終評価内の箇条書き。空なら描画しない（欠損に耐える）。
function QaReviewList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4">
      <p className="text-xs font-bold text-slate-800 mb-1">{title}</p>
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
