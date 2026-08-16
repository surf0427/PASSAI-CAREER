'use client';

// PASSAI 就活版 — 自己分析AI 結果画面（閲覧専用）
//
// careerSelfAnalysisLogs（localStorage）から 1 つの自己分析ログの
// **canonical/current result（= その系列の最新結果）だけ** を表示する。
// DB / 課金 / usage には接続しない。
//
// 表示対象の選び方:
//   ?log=<rootId> … 一覧（/career/self-analysis/logs）から選ばれた自己分析ログ。
//   パラメータ無し … 最新の自己分析ログ（生成・更新直後の遷移先がここ）。
//
// ★ ユーザーに revision（版1 / 版2 …）は見せない。更新した結果は最新結果に
//   置き換わって見える。内部の revision lineage は監査 / rollback 用にそのまま残る
//   （lib/careerSelfAnalysis/revisionLineage.ts。ここでは読み取りのみ）。
// ★ read-only。ここでは保存・再生成・削除は行わない。
//   更新は「過去の結果を更新する」（/career/self-analysis/update）が担う。

import { Suspense, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadSelfAnalysisLogs } from '../selfAnalysisStorage';
import {
  buildSelfAnalysisEntries,
  findSelfAnalysisEntry,
  type SelfAnalysisEntry,
} from '../logEntries';

// マウント前 false / マウント後 true（hub と同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function CareerSelfAnalysisResultInner() {
  const searchParams = useSearchParams();
  const queryRootId = searchParams.get('log');

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // null = hydration 前 / 未読込。読み込み後は自己分析ログ一覧（先頭が最新）。
  const entries = useMemo<SelfAnalysisEntry[] | null>(
    () => (isMounted ? buildSelfAnalysisEntries(loadSelfAnalysisLogs()) : null),
    [isMounted],
  );

  // 指定ログ → 見つからなければ最新ログ（古いリンク / 直接アクセスでも落ちない）。
  const entry = entries
    ? findSelfAnalysisEntry(entries, queryRootId) ?? entries[0] ?? null
    : null;
  const selected = entry?.current ?? null;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="自己分析の結果"
        description="これまでに作成した自己分析を確認します。"
      />

      {entries === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : !selected || !entry ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            まだ自己分析の結果がありません。実行画面から生成してください。
          </p>
          <Link
            href="/career/self-analysis/run"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            自己分析を実行する →
          </Link>
        </Card>
      ) : (
        <>
          {/* 作成日時と、更新している場合はその最終更新日時。版番号は出さない。 */}
          <p className="text-xs text-slate-400 mb-4">
            作成日時: {formatDate(entry.createdAt)}
            {entry.updatedAt && `　/　最終更新: ${formatDate(entry.updatedAt)}`}
          </p>

          {/* 更新時にユーザーが入力した「追加したいこと・修正したいこと」。
              現在の結果がどう作られたかの理解に有用なので残す。 */}
          {str(selected.userInput) && (
            <Section title="このとき追加・修正を指示した内容">
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                {str(selected.userInput)}
              </p>
            </Section>
          )}

          <Section title="全体所感">
            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
              {selected.result.summary || '—'}
            </p>
          </Section>

          {/* v2 構造化フィールド。旧ログには無いので、内容があるときだけ表示する（未定義でも落ちない）。 */}
          {str(selected.result.careerDirection) && (
            <Section title="キャリアの方向性">
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                {str(selected.result.careerDirection)}
              </p>
            </Section>
          )}
          <MaybeListSection title="向いている業界" items={selected.result.recommendedIndustries} />
          <MaybeListSection title="向いている職種" items={selected.result.recommendedJobs} />
          <MaybeListSection title="向いている環境" items={selected.result.suitableEnvironment} />
          <MaybeListSection title="価値観キーワード" items={selected.result.valueKeywords} />
          <MaybeListSection title="強みキーワード" items={selected.result.strengthKeywords} />
          <MaybeListSection title="企業選びの条件" items={selected.result.companySelectionCriteria} />

          <ListSection title="強み" items={selected.result.strengths} />
          <ListSection title="弱み・伸びしろ" items={selected.result.weaknesses} />
          <ListSection title="ガクチカ候補" items={selected.result.gakuchikaIdeas} />
          <ListSection title="自己PR候補" items={selected.result.selfPrIdeas} />
          <ListSection title="ESで使える経験の切り口" items={selected.result.esAngles} />
          <ListSection title="面接で深掘りされそうな点" items={selected.result.interviewQuestions} />
          <ListSection title="次にやるべきこと" items={selected.result.nextActions} />
        </>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/self-analysis/run"
          className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors"
        >
          新しく自己分析する →
        </Link>
        {selected && (
          <Link
            href="/career/self-analysis/update"
            className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-blue-600 border border-blue-200 hover:bg-blue-50 rounded-lg px-4 py-2 transition-colors"
          >
            過去の結果を更新する →
          </Link>
        )}
        {/* 複数の自己分析ログがあるときだけ、一覧へ戻る導線を出す。 */}
        {entries !== null && entries.length > 1 && (
          <Link
            href="/career/self-analysis/logs"
            className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
          >
            ← 過去の自己分析一覧
          </Link>
        )}
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

// useSearchParams を使うため Suspense 境界で包む（career の既存 view 画面と同形）。
export default function CareerSelfAnalysisResultPage() {
  return (
    <Suspense fallback={null}>
      <CareerSelfAnalysisResultInner />
    </Suspense>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP');
}

// 旧ログ（v2 フィールド未保存）でも落ちないよう、文字列・配列を安全に丸める。
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function arr(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card variant="soft" padding="md" className="mb-4">
      <h2 className="text-sm font-bold text-slate-900 mb-2">{title}</h2>
      {children}
    </Card>
  );
}

// 既存の常時表示セクション（強み・弱み等）。items が未定義の旧ログでも空表示で落ちない。
function ListSection({ title, items }: { title: string; items?: string[] }) {
  const list = arr(items);
  return (
    <Section title={title}>
      {list.length === 0 ? (
        <p className="text-sm text-slate-400">—</p>
      ) : (
        <ul className="list-disc pl-5 space-y-1.5">
          {list.map((item, i) => (
            <li key={i} className="text-sm text-slate-700 leading-relaxed">
              {item}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// v2 フィールド用。内容があるときだけセクションを表示（旧ログでは何も出さない）。
function MaybeListSection({ title, items }: { title: string; items?: string[] }) {
  if (arr(items).length === 0) return null;
  return <ListSection title={title} items={items} />;
}
