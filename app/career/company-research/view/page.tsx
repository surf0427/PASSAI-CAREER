'use client';

// PASSAI 就活版 — 企業研究 一覧・詳細表示画面
//
// careerCompanyResearchLogs（localStorage）から保存済み企業研究を読み、一覧（企業名・日時）＋
// 選択中の詳細を表示する。詳細では研究メモ原文・抽出テキスト・確認済みテキスト・AI添削・
// 本人情報とのすり合わせ・面接連携要約・添削履歴を確認でき、「修正して再添削」で do?id= へ戻る。
// ?id=<logId> で詳細を直接開ける（保存直後の遷移先）。DB / 課金 / usage には接続しない。

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  loadCompanyResearchLogs,
  updateCompanyResearchLog,
} from '../companyResearchStorage';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
import { upsertCareerCompanyResearchLogsToSupabase } from '@/lib/supabase/careerCompanyResearch';
import {
  CAREER_COMPANY_INTEREST_LABELS,
  type CareerCompanyResearchLog,
  type CareerCompanyResearchReview,
  type CareerCompanyResearchFile,
} from '@/types/careerCompanyResearch';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function CareerCompanyResearchViewInner() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );
  const searchParams = useSearchParams();
  const queryId = searchParams.get('id');

  // Supabase mirror 用。useCallback の deps を変えないよう ref で最新 userId を参照する
  // （ref の更新は render 中ではなく effect で行う）。
  const userId = useCurrentUserId();
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  const [version, setVersion] = useState(0);
  const logs = useMemo<CareerCompanyResearchLog[] | null>(
    () => (isMounted ? loadCompanyResearchLogs() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isMounted, version],
  );

  // 選択中 ID。クリック未選択時は ?id（保存直後の遷移先）→ 先頭 の優先で表示する。
  // effect で setState せず derive することで react-hooks/set-state-in-effect を回避する。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveId = selectedId ?? queryId;

  const selected = useMemo<CareerCompanyResearchLog | null>(() => {
    if (!logs || logs.length === 0) return null;
    return logs.find((l) => l.id === effectiveId) ?? logs[0];
  }, [logs, effectiveId]);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const handleCopy = useCallback((key: string, text: string) => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(text)
      .then(() => setCopiedKey(key))
      .catch(() => setCopiedKey(null));
  }, []);

  const toggleFavorite = useCallback((log: CareerCompanyResearchLog) => {
    const next = { ...log, favorite: !log.favorite };
    updateCompanyResearchLog(log.id, { favorite: next.favorite });
    setVersion((v) => v + 1);
    if (userIdRef.current) void upsertCareerCompanyResearchLogsToSupabase(userIdRef.current, [next]);
  }, []);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="保存した企業研究"
        description="添削済みの企業研究です。研究メモ原文・AI添削・あなたの情報とのすり合わせ・添削履歴を確認できます。"
      />

      {logs === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : logs.length === 0 ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            まだ企業研究がありません。入力画面から添削を受けてください。
          </p>
          <Link
            href="/career/company-research/do"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            企業研究を添削する →
          </Link>
        </Card>
      ) : (
        <>
          <Card variant="soft" padding="md" className="mb-5">
            <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
              保存済み（{logs.length}件）
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
                      <span className="font-semibold">
                        {log.favorite && <span title="お気に入り">★ </span>}
                        {log.companyName || '（企業名なし）'}
                      </span>
                      <span className={active ? 'text-blue-100' : 'text-slate-400'}>
                        {' '}
                        — {formatDate(log.updatedAt || log.createdAt)}
                        {interestBadge(log) && ` ・${interestBadge(log)}`}
                        {log.revisionHistory.length > 1 && ` ・添削${log.revisionHistory.length}回`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {selected && (
            <CompanyResearchDetail
              log={selected}
              copiedKey={copiedKey}
              onCopy={handleCopy}
              onToggleFavorite={() => toggleFavorite(selected)}
            />
          )}
        </>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/company-research/do"
          className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors"
        >
          別の企業を添削する →
        </Link>
        <Link
          href="/career/company-research"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← 企業研究トップに戻る
        </Link>
      </div>
    </div>
  );
}

// ── 詳細表示 ──────────────────────────────────────────────────────

function CompanyResearchDetail({
  log,
  copiedKey,
  onCopy,
  onToggleFavorite,
}: {
  log: CareerCompanyResearchLog;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
  onToggleFavorite: () => void;
}) {
  const { review, fitAnalysis, input } = log;
  const hasFitText =
    fitAnalysis.selfAnalysisFit ||
    fitAnalysis.valuesFit ||
    fitAnalysis.activityFit ||
    fitAnalysis.matchingFit ||
    fitAnalysis.gaps.length > 0 ||
    fitAnalysis.strengthsToUse.length > 0;

  return (
    <>
      {/* メタ + お気に入りトグル + 修正して再添削 */}
      <Card variant="soft" padding="md" className="mb-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900 truncate">{log.companyName}</h2>
            <p className="text-xs text-slate-400">
              {[log.industry, interestBadge(log)].filter(Boolean).join(' ・ ')}
              {log.industry || interestBadge(log) ? ' ・ ' : ''}
              更新 {formatDate(log.updatedAt || log.createdAt)}
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleFavorite}
            className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
              log.favorite
                ? 'bg-blue-600 text-white'
                : 'bg-white ring-1 ring-slate-300 text-slate-600 hover:bg-slate-50'
            }`}
          >
            {log.favorite ? '★ お気に入り' : '☆ お気に入り'}
          </button>
        </div>
        <Link
          href={`/career/company-research/do?id=${encodeURIComponent(log.id)}`}
          className="inline-flex w-full sm:w-auto items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 transition-colors"
        >
          修正して再添削する →
        </Link>
      </Card>

      {/* AI添削: 総合スコア / ランク / 総評 */}
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
      <Section title="理解度スコア（6軸）">
        <div className="flex flex-col gap-2.5">
          {BREAKDOWN_LABELS.map(([key, label]) => (
            <ScoreBar key={key} label={label} score={review.breakdown[key]} />
          ))}
        </div>
      </Section>

      <ListSection title="良い点" items={review.goodPoints} />
      <ListSection title="不足している情報" items={review.missingInfo} />
      <ListSection title="思い込み・根拠不足の指摘" items={review.weakAssumptions} />
      <ListSection title="次に調べるべきこと" items={review.nextResearchActions} ordered />

      {/* ユーザー情報とのすり合わせ */}
      <Section title="あなたの情報とのすり合わせ">
        {hasFitText ? (
          <>
            <FitText label="自己分析との整合" text={fitAnalysis.selfAnalysisFit} />
            <FitText label="就活軸との整合" text={fitAnalysis.valuesFit} />
            <FitText label="活動・経験との整合" text={fitAnalysis.activityFit} />
            <FitText label="企業マッチングとの整合" text={fitAnalysis.matchingFit} />
            <FitGroup label="ギャップ・確認すべき点" items={fitAnalysis.gaps} tone="warning" />
            <FitGroup label="この企業で活かせる強み" items={fitAnalysis.strengthsToUse} tone="positive" />
          </>
        ) : (
          <p className="text-sm text-slate-400">
            すり合わせに使える本人情報が不足しています。基本情報・活動整理・自己分析・就活軸を入力すると精度が上がります。
          </p>
        )}
      </Section>

      {/* 面接連携要約 */}
      <Section
        title="面接練習へ渡せる要約"
        action={
          log.interviewContextSummary ? (
            <CopyButton
              copied={copiedKey === `${log.id}-interview`}
              onClick={() => onCopy(`${log.id}-interview`, log.interviewContextSummary)}
            />
          ) : undefined
        }
      >
        {log.interviewContextSummary ? (
          <>
            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
              {log.interviewContextSummary}
            </p>
            <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
              この企業の面接練習をするときに、文脈として面接官AIに渡せる要約です。
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-400">—</p>
        )}
      </Section>

      {/* 確認済みテキスト（添削対象になった本文） */}
      <Section
        title="添削対象のテキスト（確認済み）"
        action={
          input.verifiedResearchText ? (
            <CopyButton
              copied={copiedKey === `${log.id}-verified`}
              onClick={() => onCopy(`${log.id}-verified`, input.verifiedResearchText)}
            />
          ) : undefined
        }
      >
        {input.verifiedResearchText ? (
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
            {input.verifiedResearchText}
          </p>
        ) : (
          <p className="text-sm text-slate-400">—</p>
        )}
      </Section>

      {/* 研究メモ原文（手入力・貼り付け） */}
      {(input.manualMemo || input.pastedText || input.sources) && (
        <Section title="あなたの研究メモ（原文）">
          {input.manualMemo && <RawBlock label="手入力メモ" text={input.manualMemo} />}
          {input.pastedText && <RawBlock label="貼り付けテキスト" text={input.pastedText} />}
          {input.sources && <RawBlock label="参考にした情報源" text={input.sources} />}
        </Section>
      )}

      {/* アップロードファイルと抽出テキスト */}
      {input.uploadedFiles.length > 0 && (
        <Section title={`アップロード資料（${input.uploadedFiles.length}件）`}>
          <div className="flex flex-col gap-3">
            {input.uploadedFiles.map((f) => (
              <UploadedFileView key={f.id} file={f} />
            ))}
          </div>
        </Section>
      )}

      {/* 添削履歴 */}
      {log.revisionHistory.length > 1 && (
        <Section title={`添削履歴（${log.revisionHistory.length}回）`}>
          <ul className="flex flex-col gap-2">
            {log.revisionHistory.map((rev, i) => (
              <li
                key={rev.revisionId || i}
                className="flex items-center justify-between gap-3 rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2"
              >
                <span className="text-sm text-slate-700">
                  {i === 0 ? '最新' : `第${log.revisionHistory.length - i}版`} ・{' '}
                  {formatDate(rev.createdAt)}
                </span>
                <span className="text-sm font-bold text-slate-800">
                  {rev.review.overallScore}点（{rev.review.rank}）
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
            「修正して再添削する」で内容を直すたびに、新しい版が履歴に追加されます。
          </p>
        </Section>
      )}
    </>
  );
}

// ── 表示ヘルパー ──────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP');
}

function interestBadge(log: CareerCompanyResearchLog): string {
  return log.interestLevel ? CAREER_COMPANY_INTEREST_LABELS[log.interestLevel] : '';
}

const RANK_STYLE: Record<CareerCompanyResearchReview['rank'], string> = {
  S: 'bg-amber-100 text-amber-800 ring-amber-300',
  A: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  B: 'bg-blue-100 text-blue-800 ring-blue-300',
  C: 'bg-slate-100 text-slate-700 ring-slate-300',
  D: 'bg-rose-100 text-rose-800 ring-rose-300',
};

const BREAKDOWN_LABELS: Array<[keyof CareerCompanyResearchReview['breakdown'], string]> = [
  ['companyUnderstanding', '企業理解度'],
  ['industryUnderstanding', '業界理解度'],
  ['competitorUnderstanding', '競合理解度'],
  ['evidenceQuality', '根拠の質'],
  ['depthOfThought', '考察の深さ'],
  ['motivationConnection', '志望理由への接続度'],
];

const FILE_STATUS_LABEL: Record<CareerCompanyResearchFile['extractionStatus'], string> = {
  pending: '抽出中',
  success: '抽出完了',
  failed: '抽出失敗',
  manual_required: '手動入力',
};

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

function FitText({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="mb-3 last:mb-0">
      <p className="text-[11px] font-semibold text-slate-500 mb-1">{label}</p>
      <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{text}</p>
    </div>
  );
}

function FitGroup({
  label,
  items,
  tone,
}: {
  label: string;
  items: string[];
  tone: 'positive' | 'warning';
}) {
  if (items.length === 0) return null;
  const dot = tone === 'positive' ? 'text-emerald-500' : 'text-amber-500';
  return (
    <div className="mb-3 last:mb-0">
      <p className="text-[11px] font-semibold text-slate-500 mb-1.5">{label}</p>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 text-sm text-slate-700 leading-relaxed">
            <span className={`shrink-0 ${dot}`}>●</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RawBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="text-[11px] font-semibold text-slate-500 mb-1">{label}</p>
      <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{text}</p>
    </div>
  );
}

function UploadedFileView({ file }: { file: CareerCompanyResearchFile }) {
  return (
    <div className="rounded-xl ring-1 ring-slate-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <p className="text-sm font-semibold text-slate-800 truncate">{file.fileName}</p>
        <span className="shrink-0 text-[11px] text-slate-400">
          {FILE_STATUS_LABEL[file.extractionStatus]}
        </span>
      </div>
      {file.extractedText ? (
        <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
          {file.extractedText}
        </p>
      ) : (
        <p className="text-sm text-slate-400">（抽出テキストなし）</p>
      )}
    </div>
  );
}

function CopyButton({ copied, onClick }: { copied: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold bg-white ring-1 ring-slate-300 text-slate-600 hover:bg-slate-50 transition-colors"
    >
      {copied ? 'コピーしました' : 'コピー'}
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

function ListSection({
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

export default function CareerCompanyResearchViewPage() {
  return (
    <Suspense fallback={null}>
      <CareerCompanyResearchViewInner />
    </Suspense>
  );
}
