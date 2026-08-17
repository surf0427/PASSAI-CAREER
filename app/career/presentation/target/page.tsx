'use client';

// PASSAI 就活版 — お題プレゼン「選考文脈（受験先・シーン）」入力画面（setup の前段）。
//
// 目的: AIお題生成の前に「どの企業・業界・職種・選考シーン向けに練習するか」を決める。
//       文脈を先に入れることで、一般的すぎないお題を作りやすくする（面接の /target と同思想）。
//       企業名・業界を目立たせるが、いずれも任意。企業未定でも「指定せずに練習」で進める。
//
// 保存は localStorage の下書きキー（careerPresentationTargetDraft）に置き、setup が読む。
// DB / Supabase / 課金・ログインには一切接続しない。

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import {
  loadPresentationTargetDraft,
  savePresentationTargetDraft,
  clearPresentationTargetDraft,
} from '../presentationStorage';
import { normalizePresentationTarget } from '../presentationModes';
import { CompanyPicker } from '@/components/career/CompanyPicker';
import { loadCompanyApplicationDefaults } from '@/app/career/company/applicationStorage';
import {
  CAREER_PRESENTATION_SELECTION_TYPES,
  CAREER_PRESENTATION_DIFFICULTIES,
} from '../presentationModes';
import type { CareerPresentationSelectionType } from '@/types/careerPresentation';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerPresentationTargetPage() {
  const router = useRouter();
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const draft = useMemo(() => (isMounted ? loadPresentationTargetDraft() : null), [isMounted]);

  const [companyName, setCompanyName] = useState('');
  // Company Data Spine の canonical key（R6）。未紐付け（undefined）が正常。
  const [companyId, setCompanyId] = useState<string | undefined>(undefined);
  const [industry, setIndustry] = useState('');
  const [jobType, setJobType] = useState('');
  const [selectionType, setSelectionType] = useState<CareerPresentationSelectionType | null>(null);
  const [difficulty, setDifficulty] = useState<'easy' | 'standard' | 'hard'>('standard');
  const [focusPoint, setFocusPoint] = useState('');

  // 下書きの初期反映は 1 度だけ（マウント時）。
  const [hydrated, setHydrated] = useState(false);
  if (isMounted && !hydrated) {
    if (draft) {
      setCompanyName(draft.companyName ?? '');
      // 旧 target には companyId が無い（欠損が正常）。
      setCompanyId(draft.companyId);
      setIndustry(draft.industry ?? '');
      setJobType(draft.jobType ?? '');
      setSelectionType(draft.selectionType ?? null);
      setDifficulty(draft.difficulty ?? 'standard');
      setFocusPoint(draft.focusPoint ?? '');
    }
    setHydrated(true);
  }

  // 意味のある文脈が1つでもあれば次へ進める（企業名だけ・業界だけでもOK）。
  const canProceed =
    companyName.trim() !== '' ||
    industry.trim() !== '' ||
    jobType.trim() !== '' ||
    selectionType !== null ||
    focusPoint.trim() !== '';

  /**
   * 企業選択（Company Identity / R6）+ 応募文脈の初期値供給（Application Context / R6）。
   * ★ 既に入力済みの項目は上書きしない（空欄のときだけ初期値を入れる）。
   */
  function handleCompanyChange(next: { companyId?: string; companyName: string }) {
    setCompanyId(next.companyId);
    setCompanyName(next.companyName);
    if (!next.companyId) return;
    const defaults = loadCompanyApplicationDefaults(next.companyId);
    if (defaults.jobType && jobType.trim() === '') setJobType(defaults.jobType);
    if (defaults.selectionType && selectionType === null) setSelectionType(defaults.selectionType);
  }

  function handleNext() {
    const target = normalizePresentationTarget({
      companyName,
      // companyName が空なら normalize 側が companyId を落とす（乖離を作らない）。
      companyId,
      industry,
      jobType,
      selectionType: selectionType ?? undefined,
      difficulty,
      focusPoint,
    });
    // 文脈が空なら null。ボタンは disabled だが念のため弾く。
    if (!target) return;
    savePresentationTargetDraft(target);
    router.push('/career/presentation/setup');
  }

  // 企業・文脈を指定せずに練習する（従来どおりの汎用お題）。下書きを消して setup へ。
  function handleSkip() {
    clearPresentationTargetDraft();
    router.push('/career/presentation/setup');
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="どの選考向けに練習しますか？"
        description="企業名・業界・職種・選考種別を入れておくと、その選考で出されそうなお題をAIが作りやすくなります。企業名だけ・業界だけでも始められます。"
      />

      {/* 企業名・業界（目立たせる） */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
          受ける企業・業界（おすすめ）
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* 登録済み企業の選択 or 従来どおりの直接入力（free-text fallback は常に残す）。 */}
          <CompanyPicker
            value={{ companyId, companyName }}
            onChange={handleCompanyChange}
            placeholder="例: 株式会社〇〇"
          />
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-2">業界</label>
            <Input
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="例: 人材・IT、メーカー など"
            />
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500 leading-relaxed">
          この選考を受ける想定で、AIがお題を作ります。企業の事業内容・制度・課題をAIが勝手に断定することはありません。
        </p>
      </Card>

      {/* 職種・選考種別など */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">職種・選考種別</p>

        <label className="block text-sm font-bold text-slate-800 mb-2">職種（任意）</label>
        <Input
          value={jobType}
          onChange={(e) => setJobType(e.target.value)}
          placeholder="例: 総合職、営業、企画、マーケ、エンジニア、コンサル など"
          className="mb-4"
        />

        <label className="block text-sm font-bold text-slate-800 mb-2">選考種別（任意）</label>
        <div className="flex flex-wrap gap-2 mb-4">
          {CAREER_PRESENTATION_SELECTION_TYPES.map((o) => (
            <Pill
              key={o.value}
              label={o.label}
              active={selectionType === o.value}
              // 任意入力のため、選択中のものをもう一度押すと未選択に戻せる。
              onClick={() => setSelectionType((prev) => (prev === o.value ? null : o.value))}
            />
          ))}
        </div>

        <label className="block text-sm font-bold text-slate-800 mb-2">AIお題の難易度</label>
        <div className="flex flex-wrap gap-2">
          {CAREER_PRESENTATION_DIFFICULTIES.map((d) => (
            <Pill
              key={d.key}
              label={d.label}
              active={difficulty === d.key}
              onClick={() => setDifficulty(d.key)}
            />
          ))}
        </div>
      </Card>

      {/* 練習したいこと */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">メモ（任意）</p>
        <label className="block text-sm font-bold text-slate-800 mb-2">特に練習したいこと</label>
        <Textarea
          value={focusPoint}
          onChange={(e) => setFocusPoint(e.target.value)}
          placeholder="例: 結論ファーストで話す練習、ケース課題の構成、企業課題の提案 など"
          rows={2}
        />
      </Card>

      <div className="flex flex-col sm:flex-row gap-3">
        <Button
          variant="primary"
          size="md"
          onClick={handleNext}
          disabled={!canProceed}
          className="w-full sm:w-auto"
        >
          次へ：お題を作る・入力する →
        </Button>
        <button
          type="button"
          onClick={handleSkip}
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          企業を指定せずに練習する
        </button>
      </div>

      <div className="mt-6">
        <Link
          href="/career/presentation"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
        >
          ← プレゼントップに戻る
        </Link>
      </div>
    </div>
  );
}

function Pill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-4 py-2 text-sm font-semibold ring-1 transition-colors ${
        active
          ? 'bg-blue-600 text-white ring-blue-600'
          : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );
}
