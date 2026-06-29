'use client';

// PASSAI 就活版 — ES作成 結果画面（最小版）
//
// careerEsLogs（localStorage）から結果を読み、一覧（日時）＋選択中の詳細を表示する。
// 既定では最新（先頭）を選択。DB / 課金 / usage には接続しない。

import {
  useMemo,
  useState,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { loadEsLogs, updateEsLog, appendEsLog } from '../esStorage';
import type {
  CareerEsLog,
  CareerEsResult,
  CareerEsReview,
} from '@/types/careerEs';

// SSR / 旧 runtime fallback 付き UUID（run 画面と同方針）。
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ces-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// AI添削の画面 state（添削結果自体は careerEsLogs には保存しない）。
//   - 1 つの添削対象（設問モードの answer / 7 フィールドの各項目）ごとに 1 件持つ。
//     親では Record<reviewKey, ReviewState> で保持し、項目間で結果が混ざらないようにする。
//   - saving / saved / saveError は「改善版を保存」（rewriteExample → 新規ログ）の状態。
//   - data が差し替わる（再添削）たびに saved/saving はリセットする。
type ReviewState = {
  data: CareerEsReview | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  saved: boolean;
  saveError: string | null;
};

// 添削 1 件分の依頼内容（保存時の question/charLimit/companyName 等の引き継ぎにも使う）。
type ReviewRequest = {
  answer: string;
  question?: string;
  companyName?: string;
  charLimit?: number;
  selectionType?: CareerEsLog['selectionType'];
  industry?: string;
  jobType?: string;
};

// マウント前 false / マウント後 true（hub と同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerEsResultPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // localStorage 書き込み（お気に入り / 提出済みトグル）後に再読込するためのバージョン。
  const [version, setVersion] = useState(0);

  // null = hydration 前 / 未読込。読み込み後は配列（最新が先頭）。
  // version は localStorage 書き込み後に再読込を強制するための意図的な依存
  // （loadEsLogs は外部可変ストアを読むため eslint は不要依存と誤検知する）。
  const logs = useMemo<CareerEsLog[] | null>(
    () => (isMounted ? loadEsLogs() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isMounted, version],
  );

  // 選択中の ID。未選択（null）なら最新（先頭）を表示する。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo<CareerEsLog | null>(() => {
    if (!logs || logs.length === 0) return null;
    return logs.find((l) => l.id === selectedId) ?? logs[0];
  }, [logs, selectedId]);

  // コピー成功表示用（直近にコピーした論理ブロックのキー）。
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = useCallback((key: string, text: string) => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(text)
      .then(() => setCopiedKey(key))
      .catch(() => setCopiedKey(null));
  }, []);

  const toggleFavorite = useCallback((log: CareerEsLog) => {
    updateEsLog(log.id, { favorite: !log.favorite });
    setVersion((v) => v + 1);
  }, []);

  const toggleSubmitted = useCallback((log: CareerEsLog) => {
    updateEsLog(log.id, { submitted: !log.submitted });
    setVersion((v) => v + 1);
  }, []);

  // AI添削。添削対象（設問モードの answer / 7 フィールドの各項目）ごとに 1 件保持する。
  // ページ遷移なし・添削結果自体は保存なし（画面 state のみ）。
  const [reviews, setReviews] = useState<Record<string, ReviewState>>({});
  // 直近に「改善版を保存」で作成したログ ID（成功表示を保存先ログに紐づける）。
  const [lastSavedId, setLastSavedId] = useState<string | null>(null);

  // 指定キーの添削を実行する。既存 /api/career/es-review を再利用（新 API なし）。
  const runReview = useCallback(async (key: string, request: ReviewRequest) => {
    const answer = request.answer.trim();
    if (!answer) return;
    setReviews((prev) => ({
      ...prev,
      [key]: { data: null, loading: true, error: null, saving: false, saved: false, saveError: null },
    }));
    try {
      const res = await fetch('/api/career/es-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer,
          question: request.question,
          companyName: request.companyName,
          charLimit: request.charLimit,
          selectionType: request.selectionType,
          industry: request.industry,
          jobType: request.jobType,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? 'ESの添削に失敗しました。');
      }
      const data = (await res.json()) as { review: CareerEsReview };
      setReviews((prev) => ({
        ...prev,
        [key]: { data: data.review, loading: false, error: null, saving: false, saved: false, saveError: null },
      }));
    } catch (e) {
      setReviews((prev) => ({
        ...prev,
        [key]: {
          data: null,
          loading: false,
          error: e instanceof Error ? e.message : 'ESの添削に失敗しました。',
          saving: false,
          saved: false,
          saveError: null,
        },
      }));
    }
  }, []);

  // 添削結果の rewriteExample を「改善版ES」として新規ログ保存する（設問モードと同形）。
  // request は添削時の依頼内容で、question/charLimit/companyName を新ログへ引き継ぐ。
  // 連打防止: saving 中・保存済みは早期 return。ページ遷移はしない。
  const handleSaveRewrite = useCallback(
    (key: string, sourceLog: CareerEsLog, data: CareerEsReview, request: ReviewRequest) => {
      const rewrite = data.rewriteExample?.trim();
      if (!rewrite) return;

      let blocked = false;
      setReviews((prev) => {
        const cur = prev[key];
        if (!cur || cur.data !== data || cur.saving || cur.saved) {
          blocked = true;
          return prev;
        }
        return { ...prev, [key]: { ...cur, saving: true, saveError: null } };
      });
      if (blocked) return;

      const question = request.question;
      const charLimit = request.charLimit;
      const companyName = request.companyName;
      const selectionType = request.selectionType;
      const industry = request.industry;
      const jobType = request.jobType;

      const result: CareerEsResult = {
        answer: rewrite,
        question,
        charLimit,
        companyName,
        ...(selectionType ? { selectionType } : {}),
        ...(industry ? { industry } : {}),
        ...(jobType ? { jobType } : {}),
        // 7 フィールドは空（設問モードログと同形）。
        headline: '',
        gakuchika: '',
        selfPr: '',
        motivation: '',
        appealPoints: [],
        interviewQuestions: [],
        improvements: [],
      };

      const newLog: CareerEsLog = {
        id: newId(),
        createdAt: new Date().toISOString(),
        userInput: '',
        result,
        sourceLogId: sourceLog.id,
        sourceType: 'review_rewrite',
        ...(companyName ? { companyName } : {}),
        ...(question ? { question } : {}),
        ...(charLimit ? { charLimit } : {}),
        ...(selectionType ? { selectionType } : {}),
        ...(industry ? { industry } : {}),
        ...(jobType ? { jobType } : {}),
      };

      try {
        appendEsLog(newLog);
        setSelectedId(newLog.id); // 保存したログを自動選択
        setLastSavedId(newLog.id); // 保存成功表示を保存先ログに紐づける
        setVersion((v) => v + 1); // 一覧（先頭）へ即時反映
        setReviews((prev) =>
          prev[key] ? { ...prev, [key]: { ...prev[key], saving: false, saved: true, saveError: null } } : prev,
        );
      } catch (e) {
        setReviews((prev) =>
          prev[key]
            ? {
                ...prev,
                [key]: {
                  ...prev[key],
                  saving: false,
                  saved: false,
                  saveError: e instanceof Error ? e.message : '保存に失敗しました。',
                },
              }
            : prev,
        );
      }
    },
    [],
  );

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="ESの結果" description="生成済みのESドラフトです。" />

      {logs === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : logs.length === 0 ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            まだESの結果がありません。実行画面から生成してください。
          </p>
          <Link
            href="/career/es/run"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            ESを作成する →
          </Link>
        </Card>
      ) : (
        <>
          {/* 生成済み一覧（日時）。クリックで詳細を切替。 */}
          <Card variant="soft" padding="md" className="mb-5">
            <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
              生成済み（{logs.length}件）
            </p>
            <ul className="flex flex-col gap-2">
              {logs.map((log) => {
                const active = selected?.id === log.id;
                return (
                  <li key={log.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(log.id)}
                      className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors ${
                        active
                          ? 'bg-blue-600 text-white'
                          : 'bg-white ring-1 ring-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className="font-semibold">{formatDate(log.createdAt)}</span>
                      {logLabel(log) && (
                        <span className={active ? 'text-blue-100' : 'text-slate-400'}>
                          {' '}
                          — {logLabel(log)}
                        </span>
                      )}
                      {(log.favorite || log.submitted) && (
                        <span className="ml-1">
                          {log.favorite && <span title="お気に入り">★</span>}
                          {log.submitted && (
                            <span className={active ? 'text-blue-100' : 'text-emerald-600'}>
                              {' '}
                              提出済み
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {selected && (
            <>
              {/* 改善版の保存成功表示（保存先ログを選択中のときだけ出す）。 */}
              {selected.id === lastSavedId && (
                <Card variant="soft" padding="md" className="mb-4">
                  <p className="text-sm font-semibold text-emerald-700">
                    改善版を保存しました
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    AI添削の完成例を新しいESとして履歴に追加しました。
                  </p>
                </Card>
              )}

              {/* メタ情報 + 管理トグル（企業名 / 設問 / 文字数 / お気に入り / 提出済み）。 */}
              <Card variant="soft" padding="md" className="mb-4">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <p className="text-xs text-slate-400">
                    生成日時: {formatDate(selected.createdAt)}
                  </p>
                  <div className="flex gap-2">
                    <ToggleButton
                      active={!!selected.favorite}
                      activeLabel="★ お気に入り"
                      inactiveLabel="☆ お気に入り"
                      onClick={() => toggleFavorite(selected)}
                    />
                    <ToggleButton
                      active={!!selected.submitted}
                      activeLabel="提出済み ✓"
                      inactiveLabel="提出済みにする"
                      onClick={() => toggleSubmitted(selected)}
                    />
                  </div>
                </div>
                {(selected.companyName ||
                  selected.question ||
                  selected.charLimit ||
                  selected.selectionType ||
                  selected.industry ||
                  selected.jobType) && (
                  <div className="grid grid-cols-1 gap-1.5 pt-2 border-t border-slate-200">
                    {selected.selectionType && (
                      <MetaRow
                        label="選考種別"
                        value={selectionTypeLabel(selected.selectionType)}
                      />
                    )}
                    {selected.companyName && (
                      <MetaRow label="企業名" value={selected.companyName} />
                    )}
                    {selected.industry && (
                      <MetaRow label="志望業界" value={selected.industry} />
                    )}
                    {selected.jobType && (
                      <MetaRow label="志望職種" value={selected.jobType} />
                    )}
                    {selected.question && (
                      <MetaRow label="設問" value={selected.question} />
                    )}
                    {selected.charLimit && (
                      <MetaRow label="指定文字数" value={`${selected.charLimit} 字`} />
                    )}
                  </div>
                )}
              </Card>

              {/* 設問モード（answer あり）は回答を優先表示。それ以外は従来の 7 フィールド。 */}
              {selected.result.answer ? (
                (() => {
                  const reviewKey = `${selected.id}:answer`;
                  const request: ReviewRequest = {
                    answer: selected.result.answer,
                    question: selected.result.question ?? selected.question,
                    companyName: selected.result.companyName ?? selected.companyName,
                    charLimit: selected.result.charLimit ?? selected.charLimit,
                    selectionType: selected.result.selectionType ?? selected.selectionType,
                    industry: selected.result.industry ?? selected.industry,
                    jobType: selected.result.jobType ?? selected.jobType,
                  };
                  return (
                    <>
                      <TextSection
                        title="回答"
                        body={selected.result.answer}
                        copyKey={`${selected.id}-answer`}
                        copiedKey={copiedKey}
                        onCopy={handleCopy}
                      />
                      <ReviewBlock
                        review={reviews[reviewKey]}
                        onRun={() => runReview(reviewKey, request)}
                        onSave={(data) => handleSaveRewrite(reviewKey, selected, data, request)}
                      />
                    </>
                  );
                })()
              ) : (
                <SevenFieldResult
                  log={selected}
                  copiedKey={copiedKey}
                  onCopy={handleCopy}
                  reviews={reviews}
                  onRun={runReview}
                  onSave={handleSaveRewrite}
                />
              )}
            </>
          )}
        </>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/es/run"
          className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors"
        >
          もう一度作成する →
        </Link>
        <Link
          href="/career/es"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← ESトップに戻る
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

// 選考種別の表示ラベル。未知の値（将来の追加・壊れたログ）は素通しせず空表示にしない。
function selectionTypeLabel(type: CareerEsLog['selectionType']): string {
  if (type === 'main') return '本選考';
  if (type === 'internship') return 'インターン応募';
  return '';
}

// 一覧での 1 行ラベル。選考種別を頭に付け、企業名 → 設問（先頭） → キャッチコピー の優先で短く表示する。
function logLabel(log: CareerEsLog): string {
  const prefix = log.selectionType ? `[${selectionTypeLabel(log.selectionType)}] ` : '';
  if (log.companyName) return `${prefix}${log.companyName}`;
  const q = log.question ?? '';
  if (q) return `${prefix}${q.length > 24 ? `${q.slice(0, 24)}…` : q}`;
  return `${prefix}${log.result.headline ?? ''}`.trim();
}

// 7 フィールドのうち AI添削の対象にする独立 ES 項目。各項目を「1 つの ES」として扱う。
// question は添削/保存時に自動付与する設問文。キャッチコピー・配列項目は対象外。
const REVIEWABLE_SECTIONS: Array<{
  field: 'gakuchika' | 'selfPr' | 'motivation';
  title: string;
  question: string;
}> = [
  { field: 'gakuchika', title: 'ガクチカ', question: '学生時代に力を入れたことを書いてください' },
  { field: 'selfPr', title: '自己PR', question: '自己PRを書いてください' },
  { field: 'motivation', title: '志望動機', question: '志望動機を書いてください' },
];

// 設問モードでない従来ログの 7 フィールド表示。answer が無いログはこれで描画する。
// 自己PR / ガクチカ / 志望動機は各カード直下に AI添削（項目ごと state）を表示する。
function SevenFieldResult({
  log,
  copiedKey,
  onCopy,
  reviews,
  onRun,
  onSave,
}: {
  log: CareerEsLog;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
  reviews: Record<string, ReviewState>;
  onRun: (key: string, request: ReviewRequest) => void;
  onSave: (key: string, sourceLog: CareerEsLog, data: CareerEsReview, request: ReviewRequest) => void;
}) {
  const { result } = log;
  const companyName = result.companyName ?? log.companyName;
  const selectionType = result.selectionType ?? log.selectionType;
  const industry = result.industry ?? log.industry;
  const jobType = result.jobType ?? log.jobType;

  return (
    <>
      <TextSection title="キャッチコピー" body={result.headline} copyKey={`${log.id}-headline`} copiedKey={copiedKey} onCopy={onCopy} />

      {REVIEWABLE_SECTIONS.map(({ field, title, question }) => {
        const body = result[field];
        const reviewKey = `${log.id}:${field}`;
        // 各項目を独立した ES として添削する。文字数指定は無し（未指定）。
        const request: ReviewRequest = {
          answer: body,
          question,
          companyName,
          selectionType,
          industry,
          jobType,
        };
        return (
          <div key={field}>
            <TextSection
              title={title}
              body={body}
              copyKey={`${log.id}-${field}`}
              copiedKey={copiedKey}
              onCopy={onCopy}
            />
            {/* 本文があるときだけ、そのカードの直下にだけ添削を表示する（他項目に波及しない）。 */}
            {body && (
              <ReviewBlock
                review={reviews[reviewKey]}
                onRun={() => onRun(reviewKey, request)}
                onSave={(data) => onSave(reviewKey, log, data, request)}
              />
            )}
          </div>
        );
      })}

      <ListSection title="企業へのアピールポイント" items={result.appealPoints} />
      <ListSection title="面接で深掘りされそうな点" items={result.interviewQuestions} />
      <ListSection title="改善点" items={result.improvements} />
    </>
  );
}

// AI添削の実行ボタン + 結果パネル + 改善版保存ボタンをまとめた再利用ブロック。
// 設問モード（answer）と 7 フィールド各項目の両方から同じ形で使う。
function ReviewBlock({
  review,
  onRun,
  onSave,
}: {
  review: ReviewState | undefined;
  onRun: () => void;
  onSave: (data: CareerEsReview) => void;
}) {
  return (
    <>
      {/* AI添削（その場で結果表示・ページ遷移なし・添削結果は保存なし）。 */}
      <Card variant="soft" padding="md" className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-900">AI添削</p>
            <p className="text-xs text-slate-500 leading-relaxed">
              6軸でスコアリングし、改善後の完成例まで提示します。
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={onRun}
            disabled={!!review?.loading}
            className="shrink-0"
          >
            {review?.loading ? '添削中…' : 'AI添削する'}
          </Button>
        </div>
        {review?.error && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {review.error}
          </p>
        )}
      </Card>

      {review?.data && (
        <>
          <ReviewPanel review={review.data} />

          {/* 改善版（rewriteExample）を新規ESログとして保存する。 */}
          {review.data.rewriteExample && (
            <Card variant="soft" padding="md" className="mb-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900">改善版を保存</p>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    完成例を新しいESとして履歴に追加します。
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => onSave(review.data!)}
                  disabled={review.saving || review.saved}
                  className="shrink-0"
                >
                  {review.saved ? '保存済み' : review.saving ? '保存中…' : '改善版を保存'}
                </Button>
              </div>
              {review.saveError && (
                <p className="mt-3 text-sm text-red-600" role="alert">
                  {review.saveError}
                </p>
              )}
            </Card>
          )}
        </>
      )}
    </>
  );
}

// ── AI添削パネル ──────────────────────────────────────────────────
// 表示順: 総合スコア / ランク / 総評 → 6軸スコア → 良い点 → 改善点 → 優先改善 → 完成例。

const RANK_STYLE: Record<CareerEsReview['rank'], string> = {
  S: 'bg-amber-100 text-amber-800 ring-amber-300',
  A: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  B: 'bg-blue-100 text-blue-800 ring-blue-300',
  C: 'bg-slate-100 text-slate-700 ring-slate-300',
  D: 'bg-rose-100 text-rose-800 ring-rose-300',
};

const BREAKDOWN_LABELS: Array<[keyof CareerEsReview['breakdown'], string]> = [
  ['logic', '論理性'],
  ['specificity', '具体性'],
  ['originality', 'オリジナリティ'],
  ['readability', '読みやすさ'],
  ['persuasion', '説得力'],
  ['companyFit', '企業適合性'],
];

function ReviewPanel({ review }: { review: CareerEsReview }) {
  return (
    <div className="mb-4">
      {/* 総合スコア / ランク / 総評 */}
      <Card variant="soft" padding="md" className="mb-4">
        <div className="flex items-center gap-4 mb-3">
          <div>
            <p className="text-[11px] text-slate-500 mb-0.5">総合スコア</p>
            <p className="text-3xl font-bold text-slate-900 leading-none">
              {review.overallScore}
              <span className="text-base text-slate-400"> / 100</span>
            </p>
          </div>
          <span
            className={`inline-flex h-12 w-12 items-center justify-center rounded-full text-xl font-bold ring-2 ${RANK_STYLE[review.rank]}`}
            title="ランク"
          >
            {review.rank}
          </span>
        </div>
        {review.overallComment ? (
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
            {review.overallComment}
          </p>
        ) : (
          <p className="text-sm text-slate-400">—</p>
        )}
      </Card>

      {/* 6軸スコア */}
      <Section title="6軸スコア">
        <div className="flex flex-col gap-2.5">
          {BREAKDOWN_LABELS.map(([key, label]) => (
            <ScoreBar key={key} label={label} score={review.breakdown[key]} />
          ))}
        </div>
      </Section>

      <ReviewListSection title="良い点" items={review.strengths} />
      <ReviewListSection title="改善点" items={review.improvements} ordered />
      <ReviewListSection title="優先改善" items={review.priorityActions} ordered />

      {/* 改善後の完成例 */}
      <Section title="改善後の完成例">
        {review.rewriteExample ? (
          <>
            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
              {review.rewriteExample}
            </p>
            <p className="mt-2 text-[11px] text-slate-400">
              {review.rewriteExample.length} 字
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-400">—</p>
        )}
      </Section>
    </div>
  );
}

function ScoreBar({ label, score }: { label: string; score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-slate-600">{label}</span>
        <span className="text-xs font-semibold text-slate-800">{score}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden">
        <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ReviewListSection({
  title,
  items,
  ordered = false,
}: {
  title: string;
  items: string[];
  ordered?: boolean;
}) {
  return (
    <Section title={title}>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">—</p>
      ) : ordered ? (
        <ol className="list-decimal pl-5 space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="text-sm text-slate-700 leading-relaxed">
              {item}
            </li>
          ))}
        </ol>
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

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="shrink-0 text-slate-400">{label}</span>
      <span className="text-slate-700 whitespace-pre-wrap break-words">{value}</span>
    </div>
  );
}

function ToggleButton({
  active,
  activeLabel,
  inactiveLabel,
  onClick,
}: {
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
        active
          ? 'bg-blue-600 text-white'
          : 'bg-white ring-1 ring-slate-300 text-slate-600 hover:bg-slate-50'
      }`}
    >
      {active ? activeLabel : inactiveLabel}
    </button>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card variant="soft" padding="md" className="mb-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

function TextSection({
  title,
  body,
  copyKey,
  copiedKey,
  onCopy,
}: {
  title: string;
  body: string;
  copyKey?: string;
  copiedKey?: string | null;
  onCopy?: (key: string, text: string) => void;
}) {
  const canCopy = !!body && !!copyKey && !!onCopy;
  return (
    <Section
      title={title}
      action={
        canCopy ? (
          <button
            type="button"
            onClick={() => onCopy!(copyKey!, body)}
            className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold bg-white ring-1 ring-slate-300 text-slate-600 hover:bg-slate-50 transition-colors"
          >
            {copiedKey === copyKey ? 'コピーしました' : 'コピー'}
          </button>
        ) : undefined
      }
    >
      {body ? (
        <>
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{body}</p>
          <p className="mt-2 text-[11px] text-slate-400">{body.length} 字</p>
        </>
      ) : (
        <p className="text-sm text-slate-400">—</p>
      )}
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
