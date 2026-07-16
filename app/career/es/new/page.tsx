'use client';

// PASSAI 就活版 — ES作成 Step1（設問メタ入力 + 下書き再開）
//
// ① 深掘りしながら書く（?mode=deep）/ ② 自力で書く（?mode=write）共通の入口。
// 設問・文字数・企業名・業界・職種を入力し、作成中ドラフト（careerEsDrafts）を作って
// エディタ /career/es/draft/[draftId] へ遷移する。正式ログ（careerEsLogs）はまだ作らない。
//   - 同モードの未完成ドラフトがあれば「続きから再開」を上部に表示する（勝手に上書きしない）。
// AI は本文を書かない。DB / 課金 / usage には接続しない（localStorage のみ）。

import { Suspense, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { Input } from '@/components/ui/Input';
import { loadEsDrafts, saveEsDraft } from '../esDraftStorage';
import { newEsId } from '../esStorage';
import { classifyEsQuestionType } from '@/lib/careerEs/deepDivePrompt';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import {
  ES_DRAFT_SCHEMA_VERSION,
  type CareerEsDraft,
  type CareerEsSelectionType,
} from '@/types/careerEs';

type EsMode = 'deep' | 'write';

function parseMode(value: string | null): EsMode {
  return value === 'deep' ? 'deep' : 'write';
}

const MODE_META: Record<EsMode, { badge: string; hint: string }> = {
  deep: {
    badge: '① 深掘りしながら書く',
    hint: 'この後、AIが設問に合わせて質問します。答えて経験を整理してから、要約メモを見つつ自分で本文を書きます。',
  },
  write: {
    badge: '② 自力で書く',
    hint: 'この後、設問だけを見ながら最初から最後まで自力で本文を書きます。',
  },
};

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function CareerEsNewInner() {
  const router = useRouter();
  const userId = useCurrentUserId();
  const searchParams = useSearchParams();
  const mode = useMemo<EsMode>(() => parseMode(searchParams.get('mode')), [searchParams]);
  const meta = MODE_META[mode];

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // 同モードの未完成ドラフト（続きから再開の候補）。owner 単位・更新日時降順。
  const resumable = useMemo<CareerEsDraft[]>(
    () => (isMounted ? loadEsDrafts(userId).filter((d) => d.mode === mode) : []),
    [isMounted, userId, mode],
  );

  const [question, setQuestion] = useState('');
  const [charLimitInput, setCharLimitInput] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [industry, setIndustry] = useState('');
  const [jobType, setJobType] = useState('');
  const [selectionType, setSelectionType] = useState<CareerEsSelectionType | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canStart = question.trim().length > 0 && !submitting;

  function handleStart() {
    if (!canStart) return;
    setSubmitting(true);
    const parsedLimit = Number.parseInt(charLimitInput, 10);
    const charLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;
    const now = new Date().toISOString();
    const id = newEsId();

    const draft: CareerEsDraft = {
      id,
      schemaVersion: ES_DRAFT_SCHEMA_VERSION,
      ownerId: userId ?? null,
      mode,
      createdAt: now,
      updatedAt: now,
      question: question.trim(),
      questionType: classifyEsQuestionType(question.trim()),
    };
    if (charLimit) draft.charLimit = charLimit;
    if (companyName.trim()) draft.companyName = companyName.trim();
    if (industry.trim()) draft.industry = industry.trim();
    if (jobType.trim()) draft.jobType = jobType.trim();
    if (selectionType) draft.selectionType = selectionType;
    saveEsDraft(draft);

    // Event Log（本文なし・fire-and-forget / member のみ）。設問本文は渡さない。
    void recordCareerEvent(userId, {
      feature: 'es',
      eventType: 'feature_started',
      completionStatus: 'in_progress',
      clientEventId: draft.id,
      industry: industry.trim() || null,
      jobType: jobType.trim() || null,
      metadata: { mode, ...(selectionType ? { selectionType } : {}) },
    });

    router.push(`/career/es/draft/${encodeURIComponent(draft.id)}`);
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="ESを書く準備" description={meta.hint} />

      {/* 続きから再開（同モードの未完成ドラフト） */}
      {resumable.length > 0 && (
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">続きから再開</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-3">
            前回の続きから再開できます。下の入力から新しく始めることもできます。
          </p>
          <ul className="flex flex-col gap-2">
            {resumable.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/career/es/draft/${encodeURIComponent(d.id)}`}
                  className="block rounded-xl bg-white ring-1 ring-slate-200 px-3.5 py-2.5 hover:bg-slate-50 transition-colors"
                >
                  <p className="text-sm font-semibold text-slate-800 leading-snug break-words">
                    {d.question?.trim() || '（設問未設定）'}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {resumeStatusLabel(d)} ・ 最終更新 {formatDate(d.updatedAt)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card variant="soft" padding="md" className="mb-5">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
          {resumable.length > 0 ? `新しく始める（${meta.badge}）` : meta.badge}
        </p>

        <label className="block text-sm font-bold text-slate-800 mb-2">
          ES設問 <span className="text-rose-500">*</span>
        </label>
        <p className="text-xs text-slate-500 leading-relaxed mb-2">
          企業のESで実際に聞かれている質問文を入力します（例:「学生時代に最も力を入れたことを教えてください」）。
        </p>
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="例: 学生時代に最も力を入れたことを教えてください。"
          rows={3}
          disabled={submitting}
          className="mb-4"
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="文字数（任意）">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={charLimitInput}
              onChange={(e) => setCharLimitInput(e.target.value)}
              placeholder="例: 400"
              disabled={submitting}
            />
          </Field>
          <Field label="企業名（任意）">
            <Input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="例: 〇〇株式会社"
              disabled={submitting}
            />
          </Field>
          <Field label="志望業界（任意）">
            <Input
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="例: IT・Web、メーカー、商社 など"
              disabled={submitting}
            />
          </Field>
          <Field label="志望職種（任意）">
            <Input
              value={jobType}
              onChange={(e) => setJobType(e.target.value)}
              placeholder="例: 営業、エンジニア、企画 など"
              disabled={submitting}
            />
          </Field>
        </div>

        <label className="block text-sm font-bold text-slate-800 mt-4 mb-2">選考種別（任意）</label>
        <div className="flex flex-wrap gap-2">
          <SelectionTypeButton label="指定なし" active={selectionType === null} onClick={() => setSelectionType(null)} disabled={submitting} />
          <SelectionTypeButton label="本選考" active={selectionType === 'main'} onClick={() => setSelectionType('main')} disabled={submitting} />
          <SelectionTypeButton label="インターン応募" active={selectionType === 'internship'} onClick={() => setSelectionType('internship')} disabled={submitting} />
        </div>
      </Card>

      <div className="flex flex-col sm:flex-row gap-3">
        <Button variant="primary" size="md" onClick={handleStart} disabled={!canStart} className="w-full sm:w-auto">
          {submitting ? '準備中…' : mode === 'deep' ? '深掘りを始める →' : '本文を書き始める →'}
        </Button>
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

// 下書きの進捗ラベル（再開カード用）。
function resumeStatusLabel(d: CareerEsDraft): string {
  if (d.mode === 'deep' && !d.organized) {
    const answered = (d.deepTurns ?? []).filter((t) => t.role === 'answer').length;
    return answered > 0 ? `深掘り中（${answered}問回答済み）` : '深掘り開始前';
  }
  if (d.body && d.body.trim()) return '本文執筆中';
  return d.mode === 'deep' ? '整理済み・本文未着手' : '本文未着手';
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-bold text-slate-800 mb-2">{label}</label>
      {children}
    </div>
  );
}

function SelectionTypeButton({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
        active ? 'bg-blue-600 text-white' : 'bg-white ring-1 ring-slate-300 text-slate-600 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );
}

export default function CareerEsNewPage() {
  return (
    <Suspense fallback={null}>
      <CareerEsNewInner />
    </Suspense>
  );
}
