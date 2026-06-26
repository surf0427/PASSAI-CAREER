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
import { loadEsLogs, updateEsLog } from '../esStorage';
import type { CareerEsLog, CareerEsResult } from '@/types/careerEs';

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
  const logs = useMemo<CareerEsLog[] | null>(
    () => (isMounted ? loadEsLogs() : null),
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
                {(selected.companyName || selected.question || selected.charLimit) && (
                  <div className="grid grid-cols-1 gap-1.5 pt-2 border-t border-slate-200">
                    {selected.companyName && (
                      <MetaRow label="企業名" value={selected.companyName} />
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
                <TextSection
                  title="回答"
                  body={selected.result.answer}
                  copyKey={`${selected.id}-answer`}
                  copiedKey={copiedKey}
                  onCopy={handleCopy}
                />
              ) : (
                <SevenFieldResult
                  result={selected.result}
                  logId={selected.id}
                  copiedKey={copiedKey}
                  onCopy={handleCopy}
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

// 一覧での 1 行ラベル。企業名 → 設問（先頭） → キャッチコピー の優先で短く表示する。
function logLabel(log: CareerEsLog): string {
  if (log.companyName) return log.companyName;
  const q = log.question ?? '';
  if (q) return q.length > 24 ? `${q.slice(0, 24)}…` : q;
  return log.result.headline ?? '';
}

// 設問モードでない従来ログの 7 フィールド表示。answer が無いログはこれで描画する。
function SevenFieldResult({
  result,
  logId,
  copiedKey,
  onCopy,
}: {
  result: CareerEsResult;
  logId: string;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
}) {
  return (
    <>
      <TextSection title="キャッチコピー" body={result.headline} copyKey={`${logId}-headline`} copiedKey={copiedKey} onCopy={onCopy} />
      <TextSection title="ガクチカ" body={result.gakuchika} copyKey={`${logId}-gakuchika`} copiedKey={copiedKey} onCopy={onCopy} />
      <TextSection title="自己PR" body={result.selfPr} copyKey={`${logId}-selfPr`} copiedKey={copiedKey} onCopy={onCopy} />
      <TextSection title="志望動機" body={result.motivation} copyKey={`${logId}-motivation`} copiedKey={copiedKey} onCopy={onCopy} />
      <ListSection title="企業へのアピールポイント" items={result.appealPoints} />
      <ListSection title="面接で深掘りされそうな点" items={result.interviewQuestions} />
      <ListSection title="改善点" items={result.improvements} />
    </>
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
