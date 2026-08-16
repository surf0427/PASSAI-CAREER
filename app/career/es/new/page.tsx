'use client';

// PASSAI 就活版 — ES作成 Step1（設問メタ入力 + 下書き再開）
//
// ① 深掘りしながら書く（?mode=deep）/ ② 自力で書く（?mode=write）共通の入口。
// 設問・文字数・企業名・業界・職種・選考種別を入力し、作成中ドラフト（careerEsDrafts）を作って
// エディタ /career/es/draft/[draftId] へ遷移する。正式ログ（careerEsLogs）はまだ作らない。
//   - 同モードの未完成ドラフトがあれば「続きから再開」を上部に表示する（勝手に上書きしない）。
//   - 6 項目はすべて**新規作成時のみ**必須（validateEsSettings）。最終 AI 添削の
//     コンテキストとして使うため、ここで欠落させない。旧 draft / 旧ログの欠損は許容する。
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
import {
  ES_SELECTION_TYPE_OPTIONS,
  validateEsSettings,
  type EsSettingsFieldKey,
} from '@/lib/careerEs/esSettings';
import { CompanyPicker } from '@/components/career/CompanyPicker';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
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
  // Company Data Spine の canonical key（Phase A / R4）。登録済み企業を選んだときだけ入る。
  //   - 必須ではない（未登録・free-text 入力のままでも ES は作成できる）。
  //   - ★ 必須判定は従来どおり companyName のみ（validateEsSettings は companyId を見ない）。
  //     したがって「companyName 空 + companyId あり」で validation を突破する経路は存在しない。
  const [companyId, setCompanyId] = useState<string | undefined>(undefined);
  const [industry, setIndustry] = useState('');
  const [jobType, setJobType] = useState('');
  // 選考種別は初期値を持たない（ユーザーが 2 種類のどちらかを明示的に選ぶ）。
  const [selectionType, setSelectionType] = useState<CareerEsSelectionType | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 一度「開始」を押したか。押すまではエラーを出さず、押した後は入力に追従して消える。
  const [attempted, setAttempted] = useState(false);

  // 必須チェックは required 属性任せにせず、開始処理側で確定させる。
  // 6 項目すべてが揃わない限り draft を作らない（＝最終添削のコンテキストを欠落させない）。
  const validation = useMemo(
    () =>
      validateEsSettings({ question, charLimitInput, companyName, industry, jobType, selectionType }),
    [question, charLimitInput, companyName, industry, jobType, selectionType],
  );
  const errors: Partial<Record<EsSettingsFieldKey, string>> = attempted ? validation.errors : {};

  function handleStart() {
    if (submitting) return;
    if (!validation.ok || !validation.normalized) {
      setAttempted(true);
      return;
    }
    setSubmitting(true);
    const settings = validation.normalized;
    const now = new Date().toISOString();
    const id = newEsId();
    // Company Identity（R4）: 登録済み企業を選んだときだけ付く **追加情報**。
    // companyName は settings 側で非空が保証済みなので、ID と表示名が乖離しない。
    const linkedCompanyId = companyId?.trim();

    // 6 項目はすべて確定値（optional 型のままだが新規作成では必ず埋まる）。
    const draft: CareerEsDraft = {
      id,
      schemaVersion: ES_DRAFT_SCHEMA_VERSION,
      ownerId: userId ?? null,
      mode,
      createdAt: now,
      updatedAt: now,
      question: settings.question,
      questionType: classifyEsQuestionType(settings.question),
      charLimit: settings.charLimit,
      companyName: settings.companyName,
      // 未紐付けなら field ごと作らない（旧 draft と同じ形を保つ）。
      ...(linkedCompanyId ? { companyId: linkedCompanyId } : {}),
      industry: settings.industry,
      jobType: settings.jobType,
      selectionType: settings.selectionType,
    };
    saveEsDraft(draft);

    // Event Log（本文なし・fire-and-forget / member のみ）。設問本文は渡さない。
    void recordCareerEvent(userId, {
      feature: 'es',
      eventType: 'feature_started',
      completionStatus: 'in_progress',
      clientEventId: draft.id,
      industry: settings.industry,
      jobType: settings.jobType,
      metadata: { mode, selectionType: settings.selectionType },
    });

    router.push(`/career/es/draft/${encodeURIComponent(draft.id)}`);
  }

  // 未入力のまま開始したときに、原因をまとめて 1 行で示す（alert は出さない）。
  const errorCount = Object.keys(errors).length;

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
          className={errors.question ? '' : 'mb-4'}
        />
        {errors.question && <FieldError message={errors.question} />}

        <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4${errors.question ? ' mt-4' : ''}`}>
          <Field label="文字数" error={errors.charLimit}>
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
          {/* 企業名: 登録済み企業の選択 or 従来どおりの直接入力（free-text fallback は常に残る）。
              CompanyPicker が Field と同じラベル体裁（太字 + 必須の * ）を描くため、
              ここでは Field で包まず、エラーだけ既存の FieldError で揃える。 */}
          <div>
            <CompanyPicker
              value={{ companyId, companyName }}
              onChange={(next) => {
                // 登録済み企業を選ぶと companyId と companyName が必ず同時に入る。
                // free-text を編集すると CompanyPicker 側が companyId を外す（乖離を作らない）。
                setCompanyId(next.companyId);
                setCompanyName(next.companyName);
              }}
              label="企業名"
              required
              disabled={submitting}
              placeholder="例: 〇〇株式会社"
            />
            {errors.companyName && <FieldError message={errors.companyName} />}
          </div>
          <Field label="志望業界" error={errors.industry}>
            <Input
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="例: IT・Web、メーカー、商社 など"
              disabled={submitting}
            />
          </Field>
          <Field label="志望職種" error={errors.jobType}>
            <Input
              value={jobType}
              onChange={(e) => setJobType(e.target.value)}
              placeholder="例: 営業、エンジニア、企画 など"
              disabled={submitting}
            />
          </Field>
        </div>

        <label className="block text-sm font-bold text-slate-800 mt-4 mb-2">
          選考種別 <span className="text-rose-500">*</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {ES_SELECTION_TYPE_OPTIONS.map((option) => (
            <SelectionTypeButton
              key={option.value}
              label={option.label}
              active={selectionType === option.value}
              onClick={() => setSelectionType(option.value)}
              disabled={submitting}
            />
          ))}
        </div>
        {errors.selectionType && <FieldError message={errors.selectionType} />}
      </Card>

      {errorCount > 0 && (
        <p className="mb-4 text-sm text-red-600" role="alert">
          未入力の項目が {errorCount} 件あります。すべて入力するとES作成を始められます。
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <Button variant="primary" size="md" onClick={handleStart} disabled={submitting} className="w-full sm:w-auto">
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
    if (answered > 0) return `深掘り中（${answered}問回答済み）`;
    // materials 未決定 & 深掘り未着手 = 材料選択フェーズから再開する（旧 draft は深掘りから）。
    if (!d.materials?.decided) return '材料選択から';
    const used = d.materials.selected.length;
    return used > 0 ? `深掘り開始前（材料${used}件を選択済み）` : '深掘り開始前';
  }
  if (d.body && d.body.trim()) return '本文執筆中';
  return d.mode === 'deep' ? '整理済み・本文未着手' : '本文未着手';
}

// 必須フィールド（ラベルに * を付ける。設問欄の既存表記と同じデザイン規約）。
function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-bold text-slate-800 mb-2">
        {label} <span className="text-rose-500">*</span>
      </label>
      {children}
      {error && <FieldError message={error} />}
    </div>
  );
}

// フィールド直下のエラー表示（alert は使わず、原因の項目だけを指す）。
function FieldError({ message }: { message: string }) {
  return (
    <p className="mt-1.5 text-xs text-rose-600" role="alert">
      {message}
    </p>
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
