'use client';

// PASSAI 就活版 — 自己分析AI「過去の結果を更新する」画面
//
// 流れ:
//   select  … 保存済みの自己分析（lineage ごとに最新版）を一覧し、更新対象を選ぶ。
//   compose … 選んだ結果を確認し、「追加したいこと・修正したいこと」を入力する。
//   生成    … /api/career/self-analysis に revisionOf（既存結果 + 備考 + 版番号）を渡し、
//             既存結果をベースに更新版を生成 → **新しい revision として追記保存** → 結果画面へ。
//
// ★ 既存ログは書き換えない。過去 revision はそのまま残る（履歴は結果画面で辿れる）。
// ★ 追記なので createdAt が最新になり、Data Spine / downstream から見た
//   「現在有効な自己分析」は自動的に更新版になる。
// ★ member（ログイン済み）は run 画面と同じ耐障害 job 経路、anonymous は同期経路。

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { loadActivityData, hasAnyActivity } from '@/app/career/activity/activityStorage';
import { loadCareerValues } from '@/app/career/values/careerValuesStorage';
import { loadSelfAnalysisLogs } from '../selfAnalysisStorage';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
import { buildSelfAnalysisPastSummaries } from '@/lib/careerSelfAnalysis/pastLogSummary';
import {
  latestSelfAnalysisRevision,
  parseSelfAnalysisLogId,
} from '@/lib/careerSelfAnalysis/revisionLineage';
import { buildSelfAnalysisEntries, entrySummaryLabel } from '../logEntries';
import { saveCompletedSelfAnalysis } from '../finalizeSummary';
import { useSelfAnalysisGeneration } from '../useSelfAnalysisGeneration';
import {
  clearUpdateDraft,
  readUpdateDraft,
  writeUpdateDraft,
} from './updateDraftStore';
import { genStatusCopy } from '@/lib/careerSelfAnalysis/clientJob/statusCopy';
import type { BasicInfo } from '@/types/basicInfo';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type {
  CareerSelfAnalysisLog,
  CareerSelfAnalysisResult,
} from '@/types/careerSelfAnalysis';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

// 生成は重い（サーバ 60s）ため run 画面と同じ 70s。
const GENERATE_TIMEOUT_MS = 70_000;
// 備考の上限。プロンプト肥大と本文貼り付けを防ぐ。
const NOTE_MAX_LENGTH = 1000;
// pending slot / draft slot を run 画面と分けるための接尾辞（client-local。server へは送らない）。
const PENDING_SCOPE = '#update';

function statusFallback(status: number, fallback: string): string {
  if (status === 429) return 'ただいま混み合っています。少し時間を置いてお試しください。';
  if (status === 503 || status === 504) {
    return 'AIの応答に時間がかかっています。少し時間を置いてもう一度お試しください。';
  }
  return fallback;
}

// run 画面と同じ contract の POST（network reject と API エラーを日本語へ寄せる）。
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

export default function CareerSelfAnalysisUpdatePage() {
  const router = useRouter();
  const userId = useCurrentUserId();
  // null = ユーザー未操作（生成中 draft があればそれを既定値に使う）。
  const [selectedIdInput, setSelectedId] = useState<string | null>(null);
  const [noteInput, setNote] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const logs = useMemo<CareerSelfAnalysisLog[] | null>(
    () => (isMounted ? loadSelfAnalysisLogs() : null),
    [isMounted],
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
  const pastSummaries = useMemo(
    () => (isMounted ? buildSelfAnalysisPastSummaries(loadSelfAnalysisLogs()) : []),
    [isMounted],
  );

  // 更新対象は「自己分析ログ」単位。更新すると常にその current result（最新版）を土台にする
  // （古い版を分岐させない＝履歴が枝分かれしない）。
  const entries = useMemo(() => buildSelfAnalysisEntries(logs), [logs]);

  // member のみ draft を持つ（anonymous は同期経路で resume が無いため不要）。
  const draftScope = userId ? `${userId}${PENDING_SCOPE}` : '';

  // 生成中にリロード / 再訪しても「どの自己分析を・どんな備考で更新中か」を復元する。
  // これが無いと、resume した job の finalize が更新対象を見失い新規保存になってしまう。
  // ★ effect で setState せず「未操作なら draft を既定値にする」派生値として扱う。
  const draft = useMemo(
    () => (isMounted && draftScope ? readUpdateDraft(draftScope) : null),
    [isMounted, draftScope],
  );
  const draftEntryId = useMemo(() => {
    if (!draft) return null;
    return entries.find((entry) => entry.rootId === draft.rootId)?.current.id ?? null;
  }, [entries, draft]);

  const selectedId = selectedIdInput ?? draftEntryId;
  const note = noteInput ?? draft?.note ?? '';

  // 以降の処理（revisionOf / 保存 / prompt）は従来どおり「更新の土台になるログ」を扱う。
  const selected = useMemo(
    () => entries.find((entry) => entry.current.id === selectedId)?.current ?? null,
    [entries, selectedId],
  );

  // 生成される版番号（現在の最大 revision + 1、最低 2）。
  const nextRevision = useMemo(() => {
    if (!selected || !logs) return 2;
    const rootId = parseSelfAnalysisLogId(selected.id).rootId;
    return Math.max(2, latestSelfAnalysisRevision(logs, rootId) + 1);
  }, [selected, logs]);

  const trimmedNote = note.trim();
  const canRun = !!basicInfo || hasAnyActivity(activity);

  // API へ渡す更新指定（既存結果の全文 + 版番号 + 備考）。
  function revisionOf() {
    if (!selected) return null;
    return {
      rootId: parseSelfAnalysisLogId(selected.id).rootId,
      revision: nextRevision,
      baseCreatedAt: selected.createdAt,
      base: selected.result,
      note: trimmedNote,
    };
  }

  // 保存時の lineage 指定（revision 番号は保存直前に再採番される）。
  // 画面の選択が最優先。resume 直後などで選択が未復元でも draft から復元できるようにする。
  function revisionTarget() {
    if (selected) {
      return { rootId: parseSelfAnalysisLogId(selected.id).rootId, note: trimmedNote };
    }
    const draft = draftScope ? readUpdateDraft(draftScope) : null;
    return draft ? { rootId: draft.rootId, note: draft.note } : null;
  }

  const gen = useSelfAnalysisGeneration({
    userId,
    getRequestBody: () => {
      const rev = revisionOf();
      if (!canRun || !rev) return null;
      return {
        profile: basicInfo,
        activity,
        values,
        userInput: '',
        conversation: [],
        pastSummaries,
        revisionOf: rev,
      };
    },
    getTurnCount: () => 0,
    getRevisionTarget: () => revisionTarget(),
    // 更新フロー専用の pending slot。run 画面の controller が更新 job を resume して
    // 「新規保存」してしまうことを防ぐ（server へは送らない client-local な scope 名）。
    pendingScope: '#update',
  });
  const memberGenBusy =
    !!userId &&
    (gen.view.state === 'submitting' ||
      gen.view.state === 'running' ||
      gen.view.state === 'reconnecting');
  const busy = generating || memberGenBusy;

  // 生成完了で draft を破棄（best-effort。残っても次回の下書きになるだけで害はない）。
  useEffect(() => {
    if (draftScope && gen.view.state === 'completed') clearUpdateDraft(draftScope);
  }, [draftScope, gen.view.state]);

  function generate() {
    if (!selected || !canRun || busy) return;
    setError(null);
    if (userId) {
      // resume 時に更新対象を見失わないよう、submit 前に draft を確定させる。
      writeUpdateDraft(draftScope, parseSelfAnalysisLogId(selected.id).rootId, trimmedNote);
      gen.start();
      return;
    }
    void legacyGenerate();
  }

  // anonymous 向け同期経路。保存は共有 finalize（saveCompletedSelfAnalysis）へ集約。
  async function legacyGenerate() {
    const rev = revisionOf();
    const target = revisionTarget();
    if (!rev || !target) return;
    setGenerating(true);
    try {
      const data = await postJson(
        '/api/career/self-analysis',
        {
          profile: basicInfo,
          activity,
          values,
          pastSummaries,
          conversation: [],
          revisionOf: rev,
        },
        GENERATE_TIMEOUT_MS,
        '分析の更新に失敗しました。入力内容は保持されています。もう一度お試しください。',
      );
      const result = data.result as CareerSelfAnalysisResult | undefined;
      if (!result) throw new Error('分析の更新に失敗しました。もう一度お試しください。');
      const saved = saveCompletedSelfAnalysis({
        result,
        userId,
        turnCount: 0,
        revision: target,
      });
      if (!saved) throw new Error('分析の保存に失敗しました。もう一度お試しください。');
      router.push('/career/self-analysis/result');
    } catch (e) {
      setError(e instanceof Error ? e.message : '分析の更新に失敗しました。もう一度お試しください。');
      setGenerating(false);
    }
    // 成功時は遷移するため setGenerating(false) は不要（失敗時のみ上で解除）。
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="自己分析を更新する"
        description="以前の自己分析に情報を追加して、内容をアップデートします。"
      />

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-xs text-slate-600 leading-relaxed">
          選んだ自己分析を土台に、追加・修正したい内容を反映して結果を更新します。
          ゼロから作り直すのではなく、既存の結論を引き継いで更新します。
          更新すると、その自己分析の結果は最新の内容に置き換わります（新しい自己分析は増えません）。
        </p>
      </Card>

      {logs === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : entries.length === 0 ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            更新できる自己分析がまだありません。まずは新しく自己分析を作成してください。
          </p>
          <Link
            href="/career/self-analysis/run"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            新しく自己分析する →
          </Link>
        </Card>
      ) : (
        <>
          {/* ① 自己分析ログ一覧 → 更新対象を選ぶ */}
          <Card variant="soft" padding="md" className="mb-5">
            <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
              更新する自己分析を選ぶ
            </p>
            <ul className="space-y-2">
              {entries.map((entry) => {
                const active = entry.current.id === selectedId;
                return (
                  <li key={entry.rootId}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(entry.current.id)}
                      disabled={busy}
                      aria-pressed={active}
                      className={`block w-full text-left rounded-xl border px-3 py-2 transition-colors disabled:opacity-60 ${
                        active
                          ? 'border-blue-600 bg-blue-50/60'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <span className="block text-xs font-semibold text-slate-700 mb-0.5">
                        作成日時: {formatDate(entry.createdAt)}
                        {entry.updatedAt && `　/　最終更新: ${formatDate(entry.updatedAt)}`}
                      </span>
                      <span className="block text-xs text-slate-500 line-clamp-2">
                        {entrySummaryLabel(entry)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {/* ② 選択した結果を確認 */}
          {selected && (
            <Card variant="soft" padding="md" className="mb-5">
              <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
                更新のベースになる内容
              </p>
              <BaseField label="全体所感" value={str(selected.result.summary)} />
              <BaseField
                label="キャリアの方向性"
                value={str(selected.result.careerDirection)}
              />
              <BaseList label="強み" items={selected.result.strengths} />
              <BaseList label="弱み・伸びしろ" items={selected.result.weaknesses} />
              <BaseList label="次にやるべきこと" items={selected.result.nextActions} />
              <Link
                href="/career/self-analysis/result"
                className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
              >
                全文を確認する →
              </Link>
            </Card>
          )}

          {/* ③ 備考の入力 → ④ AI再生成 */}
          {selected && (
            <Card variant="soft" padding="md" className="mb-5">
              <label
                htmlFor="self-analysis-update-note"
                className="block text-sm font-bold text-slate-800 mb-1"
              >
                追加したいこと・修正したいこと
              </label>
              <p className="text-xs text-slate-500 leading-relaxed mb-3">
                その後にやった活動、考えが変わった点、直してほしい記述などを書いてください。
                ここに書いた内容を反映して、上の結果を更新します。
              </p>
              <Textarea
                id="self-analysis-update-note"
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX_LENGTH))}
                placeholder="例）長期インターンを始めたので、その経験を反映してほしい。志望業界はメーカーより IT に寄ってきた。"
                rows={5}
                disabled={busy}
              />
              <p className="mt-1 text-right text-[11px] text-slate-400">
                {trimmedNote.length} / {NOTE_MAX_LENGTH}
              </p>

              {!canRun && (
                <p className="mt-3 text-xs text-amber-700 leading-relaxed">
                  基本情報または活動整理のいずれかを入力すると更新できます。
                </p>
              )}
              {error && (
                <p className="mt-3 text-sm text-red-600 leading-relaxed" role="alert">
                  {error}
                </p>
              )}

              <div className="mt-4">
                <Button
                  variant="primary"
                  size="md"
                  onClick={generate}
                  disabled={!canRun || busy || trimmedNote === ''}
                  className="w-full sm:w-auto"
                >
                  {busy ? '更新中…' : '更新する →'}
                </Button>
              </div>
            </Card>
          )}

          {/* member 生成の進行・復旧（202→poll→復元）。実際に確認できる状態のみ表示。 */}
          {userId && gen.view.state !== 'idle' && gen.view.state !== 'completed' && (
            <Card variant="soft" padding="md" className="mb-5">
              <p className="text-sm font-bold text-slate-800 mb-1">{genStatusCopy(gen.view).title}</p>
              <p className="text-xs text-slate-500 leading-relaxed mb-3">
                {genStatusCopy(gen.view).detail}
              </p>
              {(gen.view.canRetry || gen.view.canRecheck) && (
                <div className="flex flex-col sm:flex-row gap-3">
                  {gen.view.canRetry && (
                    <Button variant="primary" size="md" onClick={gen.retry} className="w-full sm:w-auto">
                      もう一度試す
                    </Button>
                  )}
                  {gen.view.canRecheck && (
                    <Button variant="outline" size="md" onClick={gen.recheck} className="w-full sm:w-auto">
                      処理状況を再確認
                    </Button>
                  )}
                </div>
              )}
            </Card>
          )}
        </>
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function BaseField({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="mb-3">
      <p className="text-[11px] text-slate-500 mb-0.5">{label}</p>
      <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{value}</p>
    </div>
  );
}

function BaseList({ label, items }: { label: string; items?: string[] }) {
  const list = Array.isArray(items)
    ? items.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : [];
  if (list.length === 0) return null;
  return (
    <div className="mb-3">
      <p className="text-[11px] text-slate-500 mb-0.5">{label}</p>
      <ul className="list-disc pl-5 space-y-1">
        {list.map((item, i) => (
          <li key={i} className="text-sm text-slate-700 leading-relaxed">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
