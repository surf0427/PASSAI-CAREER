'use client';

// PASSAI 就活版 — 面接AI「受験先・選考の想定」入力画面（面接タイプ選択の前段）。
//
// 目的: 面接の種類を選ぶ前に「どの企業・どの選考を受けるか」を入力させ、面接AIが
//       志望動機・企業理解・職種理解・選考フェーズに合わせた深掘り／フィードバックを
//       出せるようにする。企業名のみ必須、他は任意（精度を上げたい人向け）。
//
// 保存は localStorage の下書きキー（careerInterviewTargetDraft）に置き、setup 画面が読む。
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
  loadInterviewTargetDraft,
  saveInterviewTargetDraft,
  clearInterviewTargetDraft,
} from '../interviewStorage';
import { normalizeInterviewTarget } from '../interviewModes';
import { CompanyPicker } from '@/components/career/CompanyPicker';
import { loadCompanyApplicationDefaults } from '@/app/career/company/applicationStorage';
import type {
  CareerInterviewSelectionType,
  CareerInterviewPhase,
} from '@/types/careerInterview';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

// 選考種別の選択肢（null = 指定なし）。
const SELECTION_OPTIONS: Array<{
  value: CareerInterviewSelectionType | null;
  label: string;
}> = [
  { value: null, label: '指定なし' },
  { value: 'main', label: '本選考' },
  { value: 'internship', label: 'インターン' },
];

// 選考フェーズの選択肢（null = 指定なし）。
const PHASE_OPTIONS: Array<{
  value: CareerInterviewPhase | null;
  label: string;
}> = [
  { value: null, label: '指定なし' },
  { value: 'first', label: '一次面接' },
  { value: 'second', label: '二次面接' },
  { value: 'final', label: '最終面接' },
  { value: 'internship', label: 'インターン面接' },
  { value: 'casual', label: 'カジュアル面談' },
];

export default function CareerInterviewTargetPage() {
  const router = useRouter();
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // 既存下書きを初期値に反映（再編集・戻る導線で入力が消えないように）。
  const draft = useMemo(() => (isMounted ? loadInterviewTargetDraft() : null), [isMounted]);

  const [companyName, setCompanyName] = useState('');
  // Company Data Spine の canonical key（R5）。未紐付け（undefined）が正常。
  const [companyId, setCompanyId] = useState<string | undefined>(undefined);
  const [industry, setIndustry] = useState('');
  const [jobType, setJobType] = useState('');
  const [selectionType, setSelectionType] =
    useState<CareerInterviewSelectionType | null>(null);
  const [interviewPhase, setInterviewPhase] =
    useState<CareerInterviewPhase | null>(null);
  const [companyMemo, setCompanyMemo] = useState('');
  const [focusPoint, setFocusPoint] = useState('');
  // 下書きの初期反映は 1 度だけ（マウント時）。
  const [hydrated, setHydrated] = useState(false);
  if (isMounted && !hydrated) {
    if (draft) {
      setCompanyName(draft.companyName);
      // 旧 target には companyId が無い（欠損が正常）。
      setCompanyId(draft.companyId);
      setIndustry(draft.industry ?? '');
      setJobType(draft.jobType ?? '');
      setSelectionType(draft.selectionType ?? null);
      setInterviewPhase(draft.interviewPhase ?? null);
      setCompanyMemo(draft.companyMemo ?? '');
      setFocusPoint(draft.focusPoint ?? '');
    }
    setHydrated(true);
  }

  const canProceed = companyName.trim() !== '';

  /**
   * 企業選択（Company Identity）+ 応募文脈の初期値供給（Application Context / R6）。
   *
   * ★ 既に入力済みの項目は **上書きしない**（「今回だけ別職種で練習する」を壊さない）。
   *   空欄のときだけ Application Context の値を初期値として入れる。
   */
  function handleCompanyChange(next: { companyId?: string; companyName: string }) {
    setCompanyId(next.companyId);
    setCompanyName(next.companyName);
    if (!next.companyId) return;
    const defaults = loadCompanyApplicationDefaults(next.companyId);
    if (defaults.jobType && jobType.trim() === '') setJobType(defaults.jobType);
    if (defaults.selectionType && selectionType === null) setSelectionType(defaults.selectionType);
    if (defaults.selectionPhase && interviewPhase === null) {
      setInterviewPhase(defaults.selectionPhase);
    }
  }

  function handleNext() {
    const target = normalizeInterviewTarget({
      companyName,
      // companyName が空なら normalize が null を返すため、
      // 「companyId があるのに companyName 空」は保存され得ない（R5 不変条件）。
      companyId,
      industry,
      jobType,
      selectionType: selectionType ?? undefined,
      interviewPhase: interviewPhase ?? undefined,
      companyMemo,
      focusPoint,
    });
    // companyName が空なら normalize は null。ボタンは disabled だが念のため弾く。
    if (!target) return;
    saveInterviewTargetDraft(target);
    router.push('/career/interview/setup');
  }

  // 企業を特定せずに練習する（従来どおりの面接）。下書きを消して setup へ。
  function handleSkip() {
    clearInterviewTargetDraft();
    router.push('/career/interview/setup');
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="どこの選考を受けますか？"
        description="受ける企業・選考に合わせて、面接官AIの質問と深掘りを最適化します。企業名だけでも始められます。"
      />

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        {/* 登録済み企業の選択 or 従来どおりの直接入力（free-text fallback は常に残す）。 */}
        <CompanyPicker
          value={{ companyId, companyName }}
          onChange={handleCompanyChange}
          required
          placeholder="例: 株式会社〇〇"
          hint="この企業を受ける想定で、志望動機・企業理解・職種理解の深掘りを増やします（AIが企業情報を断定することはありません）。"
        />
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-1">
          より精度を上げたい人向け（任意）
        </p>
        <p className="text-xs text-slate-500 leading-relaxed mb-4">
          入力した分だけ、面接AIが選考に合わせて質問を調整します。空欄でも問題ありません。
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-2">
              業界（任意）
            </label>
            <Input
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="例: 人材・IT、メーカー など"
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-2">
              職種（任意）
            </label>
            <Input
              value={jobType}
              onChange={(e) => setJobType(e.target.value)}
              placeholder="例: 総合職、エンジニア など"
            />
          </div>
        </div>

        <label className="block text-sm font-bold text-slate-800 mb-2">
          選考種別（任意）
        </label>
        <div className="flex flex-wrap gap-2 mb-4">
          {SELECTION_OPTIONS.map((o) => (
            <Pill
              key={o.label}
              label={o.label}
              active={selectionType === o.value}
              onClick={() => setSelectionType(o.value)}
            />
          ))}
        </div>

        <label className="block text-sm font-bold text-slate-800 mb-2">
          選考フェーズ（任意）
        </label>
        <div className="flex flex-wrap gap-2 mb-4">
          {PHASE_OPTIONS.map((o) => (
            <Pill
              key={o.label}
              label={o.label}
              active={interviewPhase === o.value}
              onClick={() => setInterviewPhase(o.value)}
            />
          ))}
        </div>

        <label className="block text-sm font-bold text-slate-800 mb-2">
          企業について分かっていること・メモ（任意）
        </label>
        <Textarea
          value={companyMemo}
          onChange={(e) => setCompanyMemo(e.target.value)}
          placeholder="例: 事業内容、求める人物像、志望理由の軸など（あなたが調べた範囲でOK）"
          rows={3}
          className="mb-4"
        />

        <label className="block text-sm font-bold text-slate-800 mb-2">
          特に対策したいこと（任意）
        </label>
        <Textarea
          value={focusPoint}
          onChange={(e) => setFocusPoint(e.target.value)}
          placeholder="例: 志望動機を深掘りされると弱い、逆質問の練習をしたい など"
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
          次へ：面接タイプを選ぶ →
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
          href="/career/interview"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
        >
          ← 面接トップに戻る
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
