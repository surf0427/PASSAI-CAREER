'use client';

// PASSAI 就活版 — ES 作成中ドラフト エディタ（/career/es/draft/[draftId]）
//
// 未完成の作成状態（深掘りQ&A・整理メモ・執筆中本文）を careerEsDrafts に autosave し、
// 途中離脱・リロードから再開できるようにする。正式ログ（careerEsLogs）へは書かない。
//   - deep: 深掘りQ&A（EsDeepDivePanel）→ 整理メモ → 本文執筆
//   - write: 本文執筆のみ
//   - 「AI添削する」= 保存を確定 = 添削成功時に careerEsLog(v1) を作成し、draft を削除して [id] へ。
//     添削失敗時は log を作らず draft を残す（進捗は失われない）。
// AI は本文を書かない。DB / 課金 / usage には接続しない（localStorage / Supabase mirror は best-effort）。

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { loadEsDraft, saveEsDraft, deleteEsDraft } from '../../esDraftStorage';
import { appendEsLog, createEsWorkspaceLog, loadEsLogById } from '../../esStorage';
import { EsDeepDivePanel } from '../../components/EsDeepDivePanel';
import { classifyEsQuestionType, type EsTurn } from '@/lib/careerEs/deepDivePrompt';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import { upsertCareerEsLogsToSupabase } from '@/lib/supabase/careerEs';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import type { CareerEsDraft, CareerEsLog, CareerEsReview } from '@/types/careerEs';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function selectionTypeLabel(type: CareerEsDraft['selectionType']): string {
  if (type === 'main') return '本選考';
  if (type === 'internship') return 'インターン応募';
  return '';
}

export default function CareerEsDraftEditorPage() {
  const router = useRouter();
  const userId = useCurrentUserId();
  const params = useParams<{ draftId: string }>();
  const draftId = typeof params.draftId === 'string' ? params.draftId : '';

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // マウント後に owner 単位で draft をロードする。編集は edited を優先する
  //（essay-practice の postApi ?? mounted パターン。useEffect 内 setState を避ける）。
  const mounted = useMemo<CareerEsDraft | null | undefined>(
    () => (isMounted ? loadEsDraft(draftId, userId) ?? null : undefined),
    [isMounted, draftId, userId],
  );
  const [edited, setEdited] = useState<CareerEsDraft | null>(null);
  const draft = edited ?? mounted ?? null;

  // body autosave 用の debounce タイマ（ref はイベント内でのみ read/write する）。
  const bodyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // draft に patch を当てて即時保存する（構造変更: Q&A・整理・設定）。
  const applyDraft = useCallback(
    (patch: Partial<CareerEsDraft>) => {
      if (!draft) return;
      const next: CareerEsDraft = { ...draft, ...patch, updatedAt: new Date().toISOString() };
      setEdited(next);
      saveEsDraft(next);
    },
    [draft],
  );

  // 本文入力: UI は即時反映、保存は軽く debounce する。
  const onBodyChange = useCallback(
    (value: string) => {
      if (!draft) return;
      const next: CareerEsDraft = { ...draft, body: value, updatedAt: new Date().toISOString() };
      setEdited(next);
      if (bodyTimer.current) clearTimeout(bodyTimer.current);
      bodyTimer.current = setTimeout(() => saveEsDraft(next), 700);
    },
    [draft],
  );

  const flushBody = useCallback(() => {
    if (bodyTimer.current) {
      clearTimeout(bodyTimer.current);
      bodyTimer.current = null;
    }
    if (draft) saveEsDraft(draft);
  }, [draft]);

  // 深掘りQ&A: 進捗 autosave / 整理完了。
  const handleDeepTurns = useCallback((turns: EsTurn[]) => applyDraft({ deepTurns: turns }), [applyDraft]);
  const handleOrganized = useCallback(
    (turns: EsTurn[], memo: string[]) => applyDraft({ deepTurns: turns, memo, organized: true }),
    [applyDraft],
  );

  // 破棄: draft を削除して ES トップへ（明示破棄のみ削除）。
  const handleDiscard = useCallback(() => {
    if (!draft) return;
    deleteEsDraft(draft.id, userId);
    router.push('/career/es');
  }, [draft, userId, router]);

  // 保存を確定（AI添削）: 添削成功時に careerEsLog(v1) を作成し、draft を削除して [id] へ。
  const handlePromoteAndReview = useCallback(async () => {
    if (!draft || reviewLoading) return;
    flushBody();
    const answer = (draft.body ?? '').trim();
    if (!answer) {
      setReviewError('添削する本文を入力してください。');
      return;
    }
    setReviewLoading(true);
    setReviewError(null);
    try {
      const res = await fetch('/api/career/es-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer,
          question: draft.question,
          companyName: draft.companyName,
          charLimit: draft.charLimit,
          selectionType: draft.selectionType,
          industry: draft.industry,
          jobType: draft.jobType,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? 'ESの添削に失敗しました。');
      }
      const { review } = (await res.json()) as { review: CareerEsReview };

      // 添削成功 → ここで初めて正式ログ化する（保存確定）。
      const hasDeep = (draft.deepTurns && draft.deepTurns.length > 0) || (draft.memo && draft.memo.length > 0);
      const log: CareerEsLog = {
        ...createEsWorkspaceLog({
          mode: draft.mode,
          question: draft.question,
          charLimit: draft.charLimit,
          companyName: draft.companyName,
          industry: draft.industry,
          jobType: draft.jobType,
          selectionType: draft.selectionType ?? null,
          body: draft.body ?? '',
          deepDive: hasDeep ? { turns: draft.deepTurns ?? [], memo: draft.memo } : undefined,
        }),
        review,
      };
      appendEsLog(log);
      // 正式ログが実際に永続化できたことを確認してから draft を削除する。
      // localStorage quota 超過時、safeSetStorage は例外を投げず黙って失敗するため、
      // 確認せず draft を消すと本文が失われる（正式ログも draft も残らない）。
      if (!loadEsLogById(log.id)) {
        throw new Error(
          '保存容量が不足しているため、ESを保存できませんでした。不要なデータを削除して、もう一度お試しください。',
        );
      }
      if (userId) void upsertCareerEsLogsToSupabase(userId, [log]);
      void recordCareerEvent(userId, {
        feature: 'es',
        eventType: 'ai_generated',
        completionStatus: 'completed',
        clientEventId: `${log.id}:review:v1`,
        industry: draft.industry ?? null,
        jobType: draft.jobType ?? null,
        metadata: { mode: draft.mode, kind: 'review' },
      });
      // 正式ログの保存を確認できたときだけ draft を削除する。
      deleteEsDraft(draft.id, userId);
      router.push(`/career/es/${encodeURIComponent(log.id)}`);
    } catch (e) {
      // 添削失敗: log は作らず draft を残す（進捗は失われない）。
      setReviewError(e instanceof Error ? e.message : 'ESの添削に失敗しました。');
      setReviewLoading(false);
    }
  }, [draft, reviewLoading, flushBody, userId, router]);

  if (draft === undefined) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      </div>
    );
  }

  if (draft === null) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            この下書きは見つかりませんでした（削除済み、または別のアカウントの下書きです）。
          </p>
          <Link
            href="/career/es"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            ← ESトップに戻る
          </Link>
        </Card>
      </div>
    );
  }

  const isDeep = draft.mode === 'deep';
  const deepPending = isDeep && !draft.organized;
  const questionType = classifyEsQuestionType(draft.question);
  const body = draft.body ?? '';
  const overLimit = !!draft.charLimit && body.length > draft.charLimit;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title={isDeep ? '深掘りしながら書く' : '自力で書く'}
        description="下書きは自動保存されます。AIは本文を書きません。あなたが本文を書き、AIは添削します。"
      />

      {/* 設問・メタ（上部） */}
      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-1.5">ES設問</p>
        <p className="text-sm font-bold text-slate-900 leading-relaxed whitespace-pre-wrap">
          {draft.question?.trim() || '（設問未設定）'}
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          {draft.companyName && <span>企業: {draft.companyName}</span>}
          {draft.industry && <span>業界: {draft.industry}</span>}
          {draft.jobType && <span>職種: {draft.jobType}</span>}
          {draft.selectionType && <span>{selectionTypeLabel(draft.selectionType)}</span>}
          {draft.charLimit && <span>指定 {draft.charLimit} 字</span>}
          <span className="text-amber-600">下書き（未保存のトレーニング）</span>
        </div>
      </Card>

      {deepPending ? (
        <EsDeepDivePanel
          question={draft.question}
          questionType={questionType}
          initialTurns={draft.deepTurns ?? []}
          onTurns={handleDeepTurns}
          onOrganized={handleOrganized}
        />
      ) : (
        <div
          className={
            isDeep ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4' : ''
          }
        >
          {/* 左: 整理メモ（深掘りモードのみ） */}
          {isDeep && (
            <div className="order-2 lg:order-1">
              <Card variant="soft" padding="md">
                <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">整理メモ（AIの深掘りから）</p>
                {draft.memo && draft.memo.length > 0 ? (
                  <ul className="list-disc pl-4 space-y-1.5">
                    {draft.memo.map((m, i) => (
                      <li key={i} className="text-sm text-slate-700 leading-relaxed">{m}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-400">整理メモはありません。</p>
                )}
              </Card>
            </div>
          )}

          {/* 中央: 本文入力 */}
          <div className={isDeep ? 'order-1 lg:order-2' : ''}>
            <Card variant="soft" padding="md" className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-bold text-slate-800">ES本文（自分で書く）</label>
                <span className={`text-[11px] ${overLimit ? 'text-rose-600 font-semibold' : 'text-slate-400'}`}>
                  {body.length}
                  {draft.charLimit ? ` / ${draft.charLimit}` : ''} 字
                </span>
              </div>
              <Textarea
                value={body}
                onChange={(e) => onBodyChange(e.target.value)}
                onBlur={flushBody}
                placeholder="設問への回答を、あなた自身の言葉で書いてください。"
                rows={12}
                disabled={reviewLoading}
              />
              {reviewError && (
                <p className="mt-3 text-sm text-red-600" role="alert">{reviewError}</p>
              )}
              <div className="mt-4 flex flex-wrap gap-3">
                <Button
                  variant="primary"
                  size="md"
                  onClick={handlePromoteAndReview}
                  disabled={reviewLoading || !body.trim()}
                >
                  {reviewLoading ? 'AI添削中…' : 'AI添削する（保存して結果へ）'}
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-slate-400">
                AI添削するとこの下書きが正式なESとして保存され、履歴に残ります。
              </p>
            </Card>
          </div>
        </div>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/es"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← 中断する（下書きは保存されます）
        </Link>
        <button
          type="button"
          onClick={handleDiscard}
          disabled={reviewLoading}
          className="inline-flex items-center justify-center gap-1 text-sm text-rose-600 hover:text-rose-700 border border-rose-200 hover:border-rose-300 rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
        >
          この下書きを破棄する
        </button>
      </div>
    </div>
  );
}
