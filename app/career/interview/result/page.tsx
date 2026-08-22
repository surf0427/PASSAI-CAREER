'use client';

// PASSAI 就活版 — 面接AI result 画面。
// careerInterviewResults（localStorage）から一覧（日時）＋選択中の詳細を表示する。

import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadInterviewResults } from '../interviewStorage';
import {
  getInterviewModeConfig,
  interviewSelectionLabel,
  scoredInterviewCriteria,
  CAREER_INTERVIEW_RUBRIC_CRITERIA,
  CAREER_INTERVIEW_RUBRIC_WEIGHT_LABELS,
} from '../interviewModes';
import type {
  CareerInterviewResult,
  CareerInterviewTargetFeedback,
  CareerInterviewType,
} from '@/types/careerInterview';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerInterviewResultPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const results = useMemo<CareerInterviewResult[] | null>(
    () => (isMounted ? loadInterviewResults() : null),
    [isMounted],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo<CareerInterviewResult | null>(() => {
    if (!results || results.length === 0) return null;
    return results.find((r) => r.id === selectedId) ?? results[0];
  }, [results, selectedId]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="面接の結果" description="練習した面接の評価です。" />

      {results === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : results.length === 0 ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            まだ面接の結果がありません。面接を実施してください。
          </p>
          <Link
            href="/career/interview/target"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            面接を始める →
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
                        {' '}
                        — {getInterviewModeConfig(r.interviewType).label}・
                        {r.mode === 'voice' ? '音声' : 'テキスト'}・
                        {r.turns.filter((t) => t.role === 'answer').length}問回答
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {selected && (
            <>
              <p className="text-xs text-slate-400 mb-4">
                実施日時: {formatDate(selected.createdAt)}
              </p>

              {/* 今回の面接条件。評価はこの条件（企業・業界・職種・選考種別・モード・重点対策）を
                  前提に生成されているため、結果を読むときの文脈として先頭に置く。
                  ★ target を持たない過去ログでも面接モードだけは必ず出す（後方互換）。 */}
              <Card variant="soft" padding="md" className="mb-4">
                <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">
                  今回の面接条件
                </p>
                {selected.target ? (
                  <>
                    <p className="text-sm font-bold text-slate-900 break-words">
                      {selected.target.companyName}
                    </p>
                    {(() => {
                      const meta = [
                        selected.target.industry,
                        selected.target.jobType,
                        interviewSelectionLabel(selected.target.selectionType),
                      ].filter((s) => s);
                      return meta.length > 0 ? (
                        <p className="mt-1 text-xs text-slate-500 leading-relaxed break-words">
                          {meta.join(' / ')}
                        </p>
                      ) : null;
                    })()}
                  </>
                ) : null}
                <p
                  className={`text-xs text-slate-500 leading-relaxed ${
                    selected.target ? 'mt-1' : ''
                  }`}
                >
                  {getInterviewModeConfig(selected.interviewType).label}
                </p>
                {selected.target?.focusPoint && (
                  <p className="mt-1.5 text-xs text-slate-500 leading-relaxed break-words">
                    重点対策: {selected.target.focusPoint}
                  </p>
                )}
              </Card>

              {selected.companyResearchLogId && (
                <Card variant="soft" padding="md" className="mb-4">
                  <div className="flex gap-2 text-xs">
                    <span className="shrink-0 text-slate-400">使用した企業研究</span>
                    <Link
                      href={`/career/company-research/view?id=${encodeURIComponent(selected.companyResearchLogId)}`}
                      className="text-blue-600 hover:underline break-words"
                    >
                      {selected.companyResearchSnapshot?.companyName || '保存済みの企業研究'} を見る →
                    </Link>
                  </div>
                </Card>
              )}

              {/* 数値評価（rubric ベース）。旧ログ（スコア無し）では丸ごと出さない。 */}
              <InterviewScoreCard
                interviewType={selected.interviewType}
                overallScore={selected.result.overallScore}
                criterionScores={selected.result.criterionScores}
              />

              <Section title="総合評価">
                <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {selected.result.overallComment || '—'}
                </p>
              </Section>

              <ListSection title="良かった点・強み" items={selected.result.strengths} />
              <ListSection title="改善点" items={selected.result.improvements} />
              <ListSection title="より良い回答例" items={selected.result.sampleAnswers} />
              <ListSection title="さらに深掘りされそうな論点" items={selected.result.deepDiveTopics} />
              <ListSection title="次にやるべきこと" items={selected.result.nextActions} />

              <Section title="想定企業との相性（志望業界・職種・就活軸）">
                <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {selected.result.companyFit || '—'}
                </p>
              </Section>

              {selected.result.companyResearchFit && (
                <Section title="企業研究との接続評価">
                  <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                    {selected.result.companyResearchFit}
                  </p>
                </Section>
              )}

              {selected.result.targetFeedback && (
                <TargetFeedbackCard
                  feedback={selected.result.targetFeedback}
                  companyName={selected.target?.companyName}
                />
              )}

              <Section title="面接のやり取り">
                <ul className="flex flex-col gap-2">
                  {selected.turns.map((t, i) => (
                    <li key={i} className="text-sm leading-relaxed">
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
              </Section>
            </>
          )}
        </>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/interview/target"
          className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors"
        >
          もう一度面接する →
        </Link>
        <Link
          href="/career/interview"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← 面接トップに戻る
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

// 数値評価カード（総合スコア + 評価軸別スコア）。
//
// 表示規則:
//   - スコアを持たない旧ログでは **カードごと出さない**（0 点表示にしない）。
//   - 表示する観点は、その面接モードで採点対象（weight !== 'none'）のものだけ。
//     モードごとに評価軸が違うこと自体が面接機能の設計なので、
//     対象外の軸を「0 点」や「—」で並べない。
//   - 重視度ラベル（最重視 / 重視 / 通常 / 参考）を添えて、同じ点でもモードによって
//     総合スコアへの効き方が違うことが読み取れるようにする。
function InterviewScoreCard({
  interviewType,
  overallScore,
  criterionScores,
}: {
  interviewType?: CareerInterviewType;
  overallScore?: number;
  criterionScores?: Record<string, number>;
}) {
  const config = getInterviewModeConfig(interviewType);
  const rows = scoredInterviewCriteria(config)
    .map((key) => ({
      key,
      label: CAREER_INTERVIEW_RUBRIC_CRITERIA[key].replace(/（.*$/, ''),
      weightLabel: CAREER_INTERVIEW_RUBRIC_WEIGHT_LABELS[config.rubric[key]],
      score: criterionScores?.[key],
    }))
    .filter((row): row is typeof row & { score: number } => typeof row.score === 'number');

  // 旧ログ（スコア無し）は静かに何も出さない。
  if (typeof overallScore !== 'number' && rows.length === 0) return null;

  return (
    <Card variant="soft" padding="md" className="mb-4">
      {typeof overallScore === 'number' && (
        <div className="mb-3">
          <p className="text-[11px] text-slate-500 mb-0.5">総合スコア</p>
          <p className="text-3xl font-bold text-slate-900 leading-none">
            {overallScore}
            <span className="text-base text-slate-400"> / 100</span>
          </p>
          <p className="mt-1 text-[11px] text-slate-400">
            {config.label}の評価ウェイトで算出しています。
          </p>
        </div>
      )}
      {rows.length > 0 && (
        <>
          <h2 className="text-sm font-bold text-slate-900 mb-2">評価軸</h2>
          <div className="flex flex-col gap-2.5">
            {rows.map((row) => (
              <div key={row.key}>
                <div className="flex items-center justify-between mb-1 gap-2">
                  <span className="text-xs text-slate-600 min-w-0 truncate">
                    {row.label}
                    <span className="ml-1.5 text-[10px] text-slate-400">{row.weightLabel}</span>
                  </span>
                  <span className="text-xs font-semibold text-slate-800 shrink-0">{row.score}</span>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-blue-500"
                    style={{ width: `${Math.max(0, Math.min(100, row.score))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// 受験先・選考の想定に向けた追加フィードバック（target あり結果のみ）。
// 補足カード 1 枚に、存在するフィールドだけを詰めて表示する（画面を重くしない）。
function TargetFeedbackCard({
  feedback,
  companyName,
}: {
  feedback: CareerInterviewTargetFeedback;
  companyName?: string;
}) {
  const comments: Array<[label: string, value?: string]> = [
    ['企業向けの評価', feedback.companyFitComment],
    ['職種向けの評価', feedback.jobFitComment],
    ['選考種別の評価', feedback.selectionTypeComment],
    // 選考フェーズ入力は廃止済み。値を持つ過去ログのためだけに表示を残す（新規面接では常に空）。
    ['選考フェーズ別の評価', feedback.phaseSpecificComment],
  ];
  const lists: Array<[label: string, items?: string[]]> = [
    ['この選考で特に弱い点', feedback.weakPointsForThisTarget],
    ['次に練習すべき想定質問', feedback.nextPracticeQuestions],
    ['逆質問案', feedback.suggestedReverseQuestions],
  ];
  const shownComments = comments.filter(([, v]) => v && v.trim() !== '');
  const shownLists = lists.filter(([, items]) => items && items.length > 0);
  if (shownComments.length === 0 && shownLists.length === 0) return null;

  return (
    <Card variant="soft" padding="md" className="mb-4">
      <h2 className="text-sm font-bold text-slate-900 mb-1">
        この企業・選考に向けた改善ポイント
      </h2>
      {companyName && (
        <p className="text-xs text-slate-400 mb-3 break-words">{companyName} 向け</p>
      )}
      <div className="flex flex-col gap-3">
        {shownComments.map(([label, value]) => (
          <div key={label}>
            <p className="text-xs font-bold text-slate-500 mb-1">{label}</p>
            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
              {value}
            </p>
          </div>
        ))}
        {shownLists.map(([label, items]) => (
          <div key={label}>
            <p className="text-xs font-bold text-slate-500 mb-1">{label}</p>
            <ul className="list-disc pl-5 space-y-1">
              {items!.map((item, i) => (
                <li key={i} className="text-sm text-slate-700 leading-relaxed">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
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
