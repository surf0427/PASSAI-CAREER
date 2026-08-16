'use client';

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadSelfAnalysisLogs } from './selfAnalysisStorage';
import { buildSelfAnalysisEntries } from './logEntries';

// マウント前 false / マウント後 true。受験版 app/self-analysis/page.tsx と同形パターン。
// SSR では localStorage を読まず status=null（stat を `—`）にし、hydration 後に再 render。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

type Status = {
  /** 保存済みの自己分析ログ数。更新（revision）は件数に数えない。 */
  analysisCount: number;
  /** 最新ログの current result の生成・更新日時（ISO）。 */
  latestAt: string | null;
};

// 就活版 自己分析ハブ。ユーザーがここで選ぶのは 3 つだけ:
//   ① 新しく自己分析する（新規フロー = /run）
//   ② 過去の結果を見る（閲覧専用 = /result）
//   ③ 過去の結果を更新する（既存結果に追記して再生成 = /update）
// ★「前回の続きからやる」は使わない。③ は途中保存の resume ではなく
//   「完了済みの結果に情報を足して版を上げる」機能であり、誤解を避けるため名称を分けている。
// ★「0から自己PRを書く」「全文を自力で書く」は就活版に対応する route / API / DB が存在せず
//   （受験版 app/self-pr/* 専用の導線）、ここでは常時 disabled の飾りだったため入口ごと削除した。
//   受験版の機能自体には手を触れていない。
export default function SelfAnalysisEntryPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const status = useMemo<Status | null>(() => {
    if (!isMounted) return null;
    // entries は「ユーザーから見える自己分析ログ」単位（更新分は 1 件にまとまる）。
    const entries = buildSelfAnalysisEntries(loadSelfAnalysisLogs());
    return {
      analysisCount: entries.length,
      // 先頭 = 最新ログ。その current result の日時（更新していれば更新日時）。
      latestAt: entries[0]?.current.createdAt ?? null,
    };
  }, [isMounted]);

  const hasLogs = !!status && status.analysisCount > 0;

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
          <StatusItem label="保存済みの自己分析" value={displayCount(status)} />
          <StatusItem label="最終更新" value={displayLatestAt(status)} />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:gap-4">
        <ModeCard
          title="新しく自己分析する"
          description="活動整理から始めて、あなたの経験を深掘りします。"
          href="/career/self-analysis/run"
          primary
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <ModeCard
            title="過去の結果を見る"
            description="これまでに作成した自己分析を一覧から選んで確認します。"
            href="/career/self-analysis/logs"
            disabled={status !== null && !hasLogs}
            badge={status !== null && !hasLogs ? 'まだありません' : undefined}
          />
          <ModeCard
            title="過去の結果を更新する"
            description="以前の自己分析に情報を追加して、内容をアップデートします。"
            href="/career/self-analysis/update"
            disabled={status !== null && !hasLogs}
            badge={status !== null && !hasLogs ? 'まだありません' : undefined}
          />
        </div>
      </div>

      <p className="mt-6 text-xs text-slate-500 leading-relaxed">
        自己分析は1回で完成させるものではありません。新しく自己分析を行うか、過去の結果に情報を足して
        更新することで、別の観点から活動・価値観を深掘りし、ES・面接・企業選びに使える自己理解を
        育てていきます。更新した場合、その自己分析の結果は最新の内容に置き換わります。
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

const EM_DASH = '—';

// 数えるのは自己分析ログの件数のみ。更新（revision）は件数に含めない。
function displayCount(status: Status | null): string {
  if (!status || status.analysisCount === 0) return EM_DASH;
  return `${status.analysisCount}件`;
}

function displayLatestAt(status: Status | null): string {
  if (!status || !status.latestAt) return EM_DASH;
  const d = new Date(status.latestAt);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  return d.toLocaleDateString('ja-JP');
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
const CARD_PRIMARY = 'ring-2 ring-blue-600 hover:shadow-md active:bg-blue-50/40';
const CARD_DISABLED = 'opacity-60 pointer-events-none';

type ModeCardProps = {
  title: string;
  description: string;
  href?: string;
  disabled?: boolean;
  badge?: string;
  /** primary 導線（新しく自己分析する）だけ枠線を強調する。 */
  primary?: boolean;
};

// 「使えない」より「まだ今ではない」空気感を出すため、disabled でも
// ring/shadow/レイアウトは維持し、テキスト彩度だけ下げる（受験版と同じ思想）。
function ModeCard({ title, description, href, disabled, badge, primary }: ModeCardProps) {
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

  if (disabled || !href) {
    return (
      <div aria-disabled="true" className={`${CARD_BASE} ${CARD_DISABLED}`}>
        {inner}
      </div>
    );
  }

  return (
    <Link href={href} className={`${CARD_BASE} ${primary ? CARD_PRIMARY : CARD_ACTIVE}`}>
      {inner}
    </Link>
  );
}
