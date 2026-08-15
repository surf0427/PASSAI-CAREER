'use client';

// PASSAI 就活版 — 自己分析AI 結果画面（閲覧専用）
//
// careerSelfAnalysisLogs（localStorage）から結果を読み、選択された 1 件を表示する。
// 既定は最新（＝更新した場合は最新 revision）。DB / 課金 / usage には接続しない。
//
// ★ read-only。ここでは保存・再生成・削除は行わない。
//   更新は「過去の結果を更新する」（/career/self-analysis/update）が担う。
// ★ 更新は既存ログの上書きではなく revision の追記なので、過去の版もこの画面から辿れる。

import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadSelfAnalysisLogs } from '../selfAnalysisStorage';
import {
  collapseSelfAnalysisRevisions,
  parseSelfAnalysisLogId,
  selectSelfAnalysisLineage,
} from '@/lib/careerSelfAnalysis/revisionLineage';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

// マウント前 false / マウント後 true（hub と同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerSelfAnalysisResultPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // null = hydration 前 / 未読込。読み込み後は配列（先頭が最新）。
  const logs = useMemo<CareerSelfAnalysisLog[] | null>(
    () => (isMounted ? loadSelfAnalysisLogs() : null),
    [isMounted],
  );

  // 一覧は lineage 単位（更新した分は最新版 1 件にまとまる）。
  const entries = useMemo(
    () => (logs ? collapseSelfAnalysisRevisions(logs) : []),
    [logs],
  );

  // 選択状態。null は「一覧の先頭（＝最新）」を意味する。
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);

  const activeRootId =
    selectedRootId ?? (entries.length > 0 ? parseSelfAnalysisLogId(entries[0].id).rootId : null);

  // 選択 lineage の全 revision（新しい版が先頭）。履歴の追跡に使う。
  const lineage = useMemo(
    () => (logs && activeRootId ? selectSelfAnalysisLineage(logs, activeRootId) : []),
    [logs, activeRootId],
  );

  const selected =
    lineage.find((log) => log.id === selectedLogId) ?? lineage[0] ?? null;

  function selectEntry(log: CareerSelfAnalysisLog) {
    setSelectedRootId(parseSelfAnalysisLogId(log.id).rootId);
    setSelectedLogId(log.id);
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="自己分析の結果"
        description="これまでに作成した自己分析を確認します。"
      />

      {logs === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : !selected ? (
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
          {/* 自己分析ログ一覧 → 選択。1 件のときは選ぶ余地がないので出さない。 */}
          {entries.length > 1 && (
            <Card variant="soft" padding="md" className="mb-4">
              <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
                自己分析ログ（{entries.length}件）
              </p>
              <ul className="space-y-2">
                {entries.map((log) => {
                  const { rootId, revision } = parseSelfAnalysisLogId(log.id);
                  const active = rootId === activeRootId;
                  return (
                    <li key={log.id}>
                      <button
                        type="button"
                        onClick={() => selectEntry(log)}
                        aria-current={active ? 'true' : undefined}
                        className={`block w-full text-left rounded-xl border px-3 py-2 transition-colors ${
                          active
                            ? 'border-blue-600 bg-blue-50/60'
                            : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <span className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-semibold text-slate-700">
                            {formatDate(log.createdAt)}
                          </span>
                          {revision > 1 && <RevisionBadge revision={revision} />}
                        </span>
                        <span className="block text-xs text-slate-500 truncate">
                          {str(log.result?.summary) || '（要約なし）'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {/* 更新履歴（同じ自己分析の版）。更新したことがある lineage でだけ出す。 */}
          {lineage.length > 1 && (
            <Card variant="soft" padding="md" className="mb-4">
              <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">
                更新履歴
              </p>
              <p className="text-xs text-slate-500 leading-relaxed mb-3">
                更新しても過去の版は残ります。版を選ぶと当時の内容を確認できます。
              </p>
              <div className="flex flex-wrap gap-2">
                {lineage.map((log) => {
                  const { revision } = parseSelfAnalysisLogId(log.id);
                  const active = log.id === selected.id;
                  return (
                    <button
                      key={log.id}
                      type="button"
                      onClick={() => setSelectedLogId(log.id)}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                        active
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      版{revision}
                      {revision === parseSelfAnalysisLogId(lineage[0].id).revision
                        ? '（最新）'
                        : ''}
                    </button>
                  );
                })}
              </div>
            </Card>
          )}

          <p className="text-xs text-slate-400 mb-4">
            生成日時: {formatDate(selected.createdAt)}
            {(() => {
              const { revision } = parseSelfAnalysisLogId(selected.id);
              return revision > 1 ? `（版${revision}）` : '';
            })()}
          </p>

          {/* 更新時にユーザーが入力した「追加したいこと・修正したいこと」。 */}
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

function RevisionBadge({ revision }: { revision: number }) {
  return (
    <span className="shrink-0 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-bold tracking-wider text-blue-700">
      版{revision}
    </span>
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
