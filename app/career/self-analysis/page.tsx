'use client';

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { loadAnalyzeState } from './selfAnalysisStorage';
import { loadSelfPRs } from './selfAnalysisStorage';
import { loadSelfAnalysisLogs } from './selfAnalysisStorage';
import type { AnalyzeStep } from '@/types/analysis';

// マウント前 false / マウント後 true。受験版 app/self-analysis/page.tsx と同形パターン。
// SSR では localStorage を読まず status=null（4 stat を `—`）にし、hydration 後に再 render。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

type Status = {
  resumeStep: AnalyzeStep | null;
  summaryReady: boolean;
  prCount: number;
  selfAnalysisLogCount: number;
};

// 就活版 Phase: AI壁打ち（run/resume）は受験版 API（/api/summarize・/api/analysis/additional）に
// 強く依存し、受験版プロンプト・受験版 usage/課金・DB ログへ書き込むため、本フェーズでは
// API 接続を行わず「準備中」とする（画面コピーを優先）。自己PR（/self-pr）・過去結果
// （/self-analysis/result）もまだ就活版へコピーしていないため準備中。
// → ハブの 4 つのアクションカードと「次におすすめ」CTA はすべて disabled で表示する。
export default function SelfAnalysisEntryPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const status = useMemo<Status | null>(() => {
    if (!isMounted) return null;
    const state = loadAnalyzeState();
    return {
      resumeStep: state?.step ?? null,
      summaryReady: !!state?.summary,
      prCount: loadSelfPRs().length,
      selfAnalysisLogCount: loadSelfAnalysisLogs().length,
    };
  }, [isMounted]);

  const suggestion = useMemo(() => pickSelfAnalysisSuggestion(status), [status]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="自己分析"
        description="今やりたいことを選んでください。"
      />

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
          現在地
        </p>
        <div className="grid grid-cols-2 gap-y-3 gap-x-4">
          <StatusItem label="進捗" value={displayProgress(status)} />
          <StatusItem label="活動まとめ" value={displaySummary(status)} />
          <StatusItem label="自己PR添削" value={displayPrCount(status)} />
          <StatusItem label="結果ログ" value={displayResultLog(status)} />
        </div>
      </Card>

      <SuggestionCard suggestion={suggestion} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <ModeCard
          title="0から自己PRを書く"
          description="活動整理から始めて、本文作成・添削まで進めます。"
          disabled
          badge="準備中"
        />
        <ModeCard
          title="全文を自力で書く"
          description="活動整理を使わずに、自分で自己PR本文を書いて添削します。"
          disabled
          badge="準備中"
        />
        <ModeCard
          title="前回の続きからやる"
          description="過去の自己分析ログを選んで、もう一度深掘り質問から始めます。"
          disabled
          badge="準備中"
        />
        <ModeCard
          title="過去の結果を見る"
          description="活動整理・深掘り・添削結果を確認できます。"
          disabled
          badge="準備中"
        />
      </div>

      <p className="mt-6 text-xs text-slate-500 leading-relaxed">
        自己分析のAI機能は現在準備中です。公開までもう少しお待ちください。
      </p>

      {/* ホームへの戻り導線。受験版は /home だが就活版は /career/home。 */}
      <div className="mt-8">
        <Link
          href="/career/home"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← ホームに戻る
        </Link>
      </div>
    </div>
  );
}

// ── 次におすすめ（受験版踏襲）─────────────────────
// status から「次にやること」を 1 つ選ぶ。null 分岐は first-time 用 fallback も兼ねる。
// 就活版では遷移先（run/self-pr/result）がまだ準備中のため、CTA は disabled で表示する。

type Suggestion =
  | {
      kind: 'start';
      title: string;
      description: string;
      cta: string;
    }
  | {
      kind: 'link';
      title: string;
      description: string;
      href: string;
      cta: string;
    };

const SELF_ANALYSIS_SUGGESTION_START: Suggestion = {
  kind: 'start',
  title: 'まず自己分析を始める',
  description: '活動整理から深掘り・まとめまで、一連の流れで進めます。',
  cta: '自己分析を始める →',
};

const SELF_ANALYSIS_SUGGESTION_PR: Suggestion = {
  kind: 'link',
  title: '自己PRを書いてみる',
  description: '自己分析の結果をもとに、自己PR本文を作って添削できます。',
  href: '/self-pr',
  cta: '自己PRに進む →',
};

const SELF_ANALYSIS_SUGGESTION_RESULT: Suggestion = {
  kind: 'link',
  title: '過去の結果を見直す',
  description: 'まとめログと自己PR履歴をまとめて確認できます。',
  href: '/self-analysis/result',
  cta: '結果を見る →',
};

function pickSelfAnalysisSuggestion(status: Status | null): Suggestion {
  if (status === null) return SELF_ANALYSIS_SUGGESTION_START;
  if (status.prCount > 0) return SELF_ANALYSIS_SUGGESTION_RESULT;
  if (status.summaryReady || status.selfAnalysisLogCount > 0) {
    return SELF_ANALYSIS_SUGGESTION_PR;
  }
  return SELF_ANALYSIS_SUGGESTION_START;
}

function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  return (
    <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
      <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">
        次におすすめ
      </p>
      <p className="text-sm font-bold text-slate-800 mb-1">{suggestion.title}</p>
      <p className="text-xs text-slate-500 leading-relaxed mb-3">
        {suggestion.description}
      </p>
      {/* 遷移先（AI壁打ち / 自己PR / 結果）はまだ準備中のため disabled で表示する。 */}
      <Button
        variant="primary"
        size="md"
        disabled
        className="w-full sm:w-auto"
      >
        {suggestion.cta}
      </Button>
    </Card>
  );
}

const EM_DASH = '—';

function displayProgress(status: Status | null): string {
  if (!status || status.resumeStep === null) return EM_DASH;
  switch (status.resumeStep) {
    case 'confirm':
      return '活動確認';
    case 'answering':
      return '深掘り中';
    case 'summary':
      return 'まとめ済';
  }
}

function displaySummary(status: Status | null): string {
  if (!status) return EM_DASH;
  return status.summaryReady ? 'あり' : EM_DASH;
}

function displayPrCount(status: Status | null): string {
  if (!status || status.prCount === 0) return EM_DASH;
  return `${status.prCount}件`;
}

function displayResultLog(status: Status | null): string {
  if (!status || status.selfAnalysisLogCount === 0) return EM_DASH;
  return `${status.selfAnalysisLogCount}件`;
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-slate-500 mb-0.5">{label}</p>
      <p className="text-sm font-semibold truncate text-slate-800">{value}</p>
    </div>
  );
}

const CARD_BASE =
  'block w-full text-left rounded-2xl bg-white ring-1 ring-slate-200 shadow-card transition-all p-4 sm:p-5 min-h-[120px]';
const CARD_ACTIVE = 'hover:shadow-md active:bg-slate-50';
const CARD_DISABLED = 'opacity-60 pointer-events-none';

type ModeCardProps = {
  title: string;
  description: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  badge?: string;
};

// 「使えない」より「まだ今ではない」空気感を出すため、disabled でも
// ring/shadow/レイアウトは維持し、テキスト彩度だけ下げる（受験版と同じ思想）。
function ModeCard({ title, description, href, onClick, disabled, badge }: ModeCardProps) {
  const titleClass = `text-sm sm:text-base font-bold mb-1.5 leading-snug ${
    disabled ? 'text-slate-400' : 'text-slate-900'
  }`;
  const descClass = `text-xs leading-relaxed ${
    disabled ? 'text-slate-400' : 'text-slate-500'
  }`;

  const inner = (
    <>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <h2 className={titleClass}>{title}</h2>
        {badge && (
          <span className="shrink-0 text-[10px] font-bold tracking-wider text-slate-400 border border-slate-200 rounded-full px-2 py-0.5">
            {badge}
          </span>
        )}
      </div>
      <p className={descClass}>{description}</p>
    </>
  );

  if (disabled) {
    return (
      <div aria-disabled="true" className={`${CARD_BASE} ${CARD_DISABLED}`}>
        {inner}
      </div>
    );
  }

  if (href) {
    return (
      <Link href={href} className={`${CARD_BASE} ${CARD_ACTIVE}`}>
        {inner}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={`${CARD_BASE} ${CARD_ACTIVE}`}>
      {inner}
    </button>
  );
}
