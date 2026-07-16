'use client';

// PASSAI 就活版 — ES エディタ／詳細（[id]）
//
// 1 版 = 1 ログ。設問（上）＋整理メモ（左・深掘りモードのみ）＋本文入力（中央）を表示し、
// ユーザーが自分で本文を書く。AIは本文を書かない。「AI添削」で採点・指摘を受け、結果は
// 版に保存する（③結果を見る／版比較のため永続化）。「改善する」で同グループの次版を作る。
//
// 対応する仕様:
//   ① 深掘りしながら書く Step3/Step4（メモ参照 + 本文 + 添削）
//   ② 自力で書く Step2/Step3（本文 + 添削）
//   ③ 添削結果を見る Step2（本文・点数・良かった点・改善点・不足要素・採用担当視点）
//   ④ 改善する Step2/Step3（前版本文を初期表示・前回添削を左に・再添削で新版）
// DB / 課金 / usage には接続しない（localStorage のみ。Supabase mirror は best-effort）。

import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import {
  appendEsLog,
  createEsWorkspaceLog,
  loadEsGroupVersions,
  loadEsLogById,
  latestEsVersion,
  updateEsLog,
} from '../esStorage';
import { EsReviewPanel } from '../components/EsReviewPanel';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import { upsertCareerEsLogsToSupabase } from '@/lib/supabase/careerEs';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import type { CareerEsLog, CareerEsReview } from '@/types/careerEs';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function selectionTypeLabel(type: CareerEsLog['selectionType']): string {
  if (type === 'main') return '本選考';
  if (type === 'internship') return 'インターン応募';
  return '';
}

export default function CareerEsEditorPage() {
  const router = useRouter();
  const userId = useCurrentUserId();
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // localStorage 書き込み後に再読込するためのバージョンカウンタ。
  const [reloadKey, setReloadKey] = useState(0);

  // reloadKey は localStorage 書き込み後に再読込を強制する意図的な依存
  // （loadEsLogById は外部可変ストアを読むため eslint は不要依存と誤検知する）。
  const log = useMemo<CareerEsLog | null>(
    () => (isMounted ? loadEsLogById(id) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isMounted, id, reloadKey],
  );
  const groupId = log?.groupId ?? log?.id ?? '';
  const versions = useMemo<CareerEsLog[]>(
    () => (isMounted && groupId ? loadEsGroupVersions(groupId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isMounted, groupId, reloadKey],
  );
  // 改善（次版）で開いたとき、参照する前版の添削（spec ④ Step2: 左＝前回添削結果）。
  const sourceReview = useMemo<CareerEsReview | null>(
    () => (log?.sourceLogId ? loadEsLogById(log.sourceLogId)?.review ?? null : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log?.sourceLogId, reloadKey],
  );

  // 本文の編集 state。log 読み込み後に初期化する（未編集なら log.body を表示）。
  const [bodyEdited, setBodyEdited] = useState<string | null>(null);
  const body = bodyEdited ?? log?.body ?? '';

  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // 深掘りモードで作成されたログか（整理メモを左に表示するため）。
  // 深掘りQ&A自体は下書き段階（/career/es/draft/[draftId]）で完結し、正式ログ化時には
  // deepDive（turns / memo）が確定している。[id] は保存済みログの閲覧・添削・改善に専念する。
  const isDeep = log?.mode === 'deep';

  // 本文を保存する（明示保存 / 添削前 / 改善前に呼ぶ）。result.answer も同期する。
  const persistBody = useCallback(
    (next: string) => {
      if (!log) return;
      updateEsLog(log.id, {
        body: next,
        result: { ...log.result, answer: next },
      });
      if (userId) {
        void upsertCareerEsLogsToSupabase(userId, [
          { ...log, body: next, result: { ...log.result, answer: next } },
        ]);
      }
    },
    [log, userId],
  );

  const handleReview = useCallback(async () => {
    if (!log || reviewLoading) return;
    const answer = body.trim();
    if (!answer) {
      setReviewError('添削する本文を入力してください。');
      return;
    }
    persistBody(body);
    setReviewLoading(true);
    setReviewError(null);
    try {
      const res = await fetch('/api/career/es-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer,
          question: log.question,
          companyName: log.companyName,
          charLimit: log.charLimit,
          selectionType: log.selectionType,
          industry: log.industry,
          jobType: log.jobType,
          companyResearchContext: log.companyResearchSnapshot,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? 'ESの添削に失敗しました。');
      }
      const data = (await res.json()) as { review: CareerEsReview };
      updateEsLog(log.id, { review: data.review });
      if (userId) {
        void upsertCareerEsLogsToSupabase(userId, [{ ...log, body, review: data.review }]);
      }
      void recordCareerEvent(userId, {
        feature: 'es',
        eventType: 'ai_generated',
        completionStatus: 'completed',
        clientEventId: `${log.id}:review:v${log.version ?? 1}`,
        industry: log.industry ?? null,
        jobType: log.jobType ?? null,
        metadata: { mode: log.mode ?? 'write', kind: 'review' },
      });
      setReloadKey((v) => v + 1);
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : 'ESの添削に失敗しました。');
    } finally {
      setReviewLoading(false);
    }
  }, [log, body, reviewLoading, persistBody, userId]);

  // 改善する: 現在の本文を引き継いだ次版を作成して、その版のエディタへ遷移する。
  const handleImprove = useCallback(() => {
    if (!log) return;
    persistBody(body);
    const next = createEsWorkspaceLog({
      mode: log.mode ?? 'write',
      question: log.question,
      charLimit: log.charLimit,
      companyName: log.companyName,
      industry: log.industry,
      jobType: log.jobType,
      selectionType: log.selectionType ?? null,
      body,
      groupId,
      version: latestEsVersion(groupId) + 1,
      sourceLogId: log.id,
      // 深掘りの整理メモは版をまたいで参照できるよう引き継ぐ。
      deepDive: log.deepDive,
    });
    appendEsLog(next);
    if (userId) void upsertCareerEsLogsToSupabase(userId, [next]);
    router.push(`/career/es/${encodeURIComponent(next.id)}`);
  }, [log, body, groupId, persistBody, userId, router]);

  if (!isMounted || log === null) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            {isMounted ? 'このESは見つかりませんでした。' : '読み込み中…'}
          </p>
          {isMounted && (
            <Link
              href="/career/es/history"
              className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
            >
              ← ES履歴に戻る
            </Link>
          )}
        </Card>
      </div>
    );
  }

  // 旧生成ログ（body / mode 無し）は編集対象にせず、legacy 表示にする。
  const isLegacy = log.body === undefined && log.mode === undefined;

  const review = log.review ?? null;
  const overLimit = !!log.charLimit && body.length > log.charLimit;
  // 左カラムを出すか（深掘りモード or 改善時の前回添削参照があるとき）。
  const showLeft = isDeep || sourceReview !== null;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title={log.mode === 'deep' ? '深掘りしながら書く' : log.mode === 'write' ? '自力で書く' : 'ESの詳細'}
        description="AIは本文を書きません。あなたが本文を書き、AIは添削と改善支援を行います。"
      />

      {/* 設問・メタ（上部） */}
      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-1.5">ES設問</p>
        <p className="text-sm font-bold text-slate-900 leading-relaxed whitespace-pre-wrap">
          {log.question?.trim() || '（設問未設定）'}
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          {log.companyName && <span>企業: {log.companyName}</span>}
          {log.industry && <span>業界: {log.industry}</span>}
          {log.jobType && <span>職種: {log.jobType}</span>}
          {log.selectionType && <span>{selectionTypeLabel(log.selectionType)}</span>}
          {log.charLimit && <span>指定 {log.charLimit} 字</span>}
          <span>版 v{log.version ?? 1}</span>
        </div>
      </Card>

      {/* 版タイムライン（2版以上あるとき） */}
      {versions.length > 1 && (
        <Card variant="soft" padding="md" className="mb-4">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">バージョン履歴</p>
          <div className="flex flex-wrap items-center gap-2">
            {versions.map((v, i) => {
              const active = v.id === log.id;
              return (
                <span key={v.id} className="flex items-center gap-2">
                  {i > 0 && <span className="text-slate-300">→</span>}
                  <Link
                    href={`/career/es/${encodeURIComponent(v.id)}`}
                    aria-current={active ? 'true' : undefined}
                    className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                      active
                        ? 'bg-blue-600 text-white'
                        : 'bg-white ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    v{v.version ?? 1}
                    <span className={active ? 'text-blue-100' : 'text-slate-400'}>
                      {' '}
                      {typeof v.review?.overallScore === 'number' ? `${v.review.overallScore}点` : '未添削'}
                    </span>
                  </Link>
                </span>
              );
            })}
          </div>
        </Card>
      )}

      {isLegacy ? (
        <LegacyView log={log} />
      ) : (
        <div
          className={
            showLeft
              ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4'
              : ''
          }
        >
          {/* 左: 整理メモ（深掘りモード）／前回添削（改善時の参照） */}
          {showLeft && (
            <div className="order-2 lg:order-1 space-y-4">
              {isDeep && (
                <Card variant="soft" padding="md">
                  <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">整理メモ（AIの深掘りから）</p>
                  {log.deepDive?.memo && log.deepDive.memo.length > 0 ? (
                    <ul className="list-disc pl-4 space-y-1.5">
                      {log.deepDive.memo.map((m, i) => (
                        <li key={i} className="text-sm text-slate-700 leading-relaxed">{m}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-slate-400">整理メモはありません。</p>
                  )}
                </Card>
              )}
              {sourceReview && (
                <Card variant="soft" padding="md">
                  <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">
                    前回の添削（改善の参考）
                  </p>
                  <p className="text-sm text-slate-700 mb-2">
                    前回スコア <span className="font-bold text-slate-900">{sourceReview.overallScore}</span> 点
                    （{sourceReview.rank}）
                  </p>
                  <PrevReviewList title="改善点" items={sourceReview.improvements} />
                  <PrevReviewList title="不足していた要素" items={sourceReview.missingElements} />
                </Card>
              )}
            </div>
          )}

          {/* 中央: 本文入力 */}
          <div className={showLeft ? 'order-1 lg:order-2' : ''}>
            <Card variant="soft" padding="md" className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-bold text-slate-800">ES本文（自分で書く）</label>
                <span className={`text-[11px] ${overLimit ? 'text-rose-600 font-semibold' : 'text-slate-400'}`}>
                  {body.length}
                  {log.charLimit ? ` / ${log.charLimit}` : ''} 字
                </span>
              </div>
              <Textarea
                value={body}
                onChange={(e) => setBodyEdited(e.target.value)}
                onBlur={() => persistBody(body)}
                placeholder="設問への回答を、あなた自身の言葉で書いてください。"
                rows={12}
                disabled={reviewLoading}
              />
              {reviewError && (
                <p className="mt-3 text-sm text-red-600" role="alert">{reviewError}</p>
              )}
              <div className="mt-4 flex flex-wrap gap-3">
                <Button variant="primary" size="md" onClick={handleReview} disabled={reviewLoading || !body.trim()}>
                  {reviewLoading ? 'AI添削中…' : review ? 'もう一度 AI添削する' : 'AI添削する'}
                </Button>
                {review && (
                  <Button variant="secondary" size="md" onClick={handleImprove} disabled={reviewLoading}>
                    改善する（次の版を作る）→
                  </Button>
                )}
              </div>
            </Card>

            {review && <EsReviewPanel review={review} />}
          </div>
        </div>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/es/history"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← ES履歴に戻る
        </Link>
        <Link
          href="/career/es"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ESトップ
        </Link>
      </div>
    </div>
  );
}

// 前回添削の参照用リスト（改善画面の左カラム）。空なら何も出さない。
function PrevReviewList({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-semibold text-slate-600 mb-1">{title}</p>
      <ul className="list-disc pl-4 space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-xs text-slate-600 leading-relaxed">{item}</li>
        ))}
      </ul>
    </div>
  );
}

// 旧生成ログ（AI代筆時代）の read-only 表示。編集はさせず、同設問で自分で書く導線だけ出す。
function LegacyView({ log }: { log: CareerEsLog }) {
  const r = log.result;
  const sections: Array<[string, string]> = [
    ['キャッチコピー', r.headline],
    ['ガクチカ', r.gakuchika],
    ['自己PR', r.selfPr],
    ['志望動機', r.motivation],
    ['回答', r.answer ?? ''],
  ].filter(([, v]) => v && v.trim()) as Array<[string, string]>;

  return (
    <div>
      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-xs text-amber-700 leading-relaxed">
          これは旧バージョンで生成された記録です。閲覧のみできます。同じ設問で、今のトレーニング（自分で書く）を始められます。
        </p>
      </Card>
      {sections.map(([title, value]) => (
        <Card key={title} variant="soft" padding="md" className="mb-4">
          <h2 className="text-sm font-bold text-slate-900 mb-2">{title}</h2>
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{value}</p>
        </Card>
      ))}
      <Link
        href={`/career/es/new?mode=write`}
        className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 transition-colors"
      >
        同じような設問で自分で書く →
      </Link>
    </div>
  );
}
