'use client';

// Application Context の編集カード（企業詳細ページ内）。Phase A / R6。
//
// ★ ここで編集するのは「その企業をどう受けるか」だけ（職種 / 選考種別 / 選考段階 /
//   選考年度 / 志望度）。企業の事実（Official）でも本人が得た企業情報（Private Evidence）でもない。
// ★ 明示保存のみ。各機能のフォームから自動で書き戻さない
//   （「今回だけ別職種で練習する」を壊さないため）。

import { useMemo, useState, useSyncExternalStore } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  loadCompanyApplication,
  saveCompanyApplication,
} from '../applicationStorage';
import { mirrorCompanyApplication } from '@/lib/supabase/careerCompanyApplication';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
import { CAREER_COMPANY_INTEREST_LABELS } from '@/types/careerCompanyResearch';
import type { CareerCompanyApplicationDefaults } from '@/types/careerCompanyApplication';
import type { CareerCompanyInterestLevel } from '@/types/careerCompanyResearch';
import type {
  CareerInterviewPhase,
  CareerInterviewSelectionType,
} from '@/types/careerInterview';

const INTEREST_OPTIONS: Array<{ value: CareerCompanyInterestLevel | null; label: string }> = [
  { value: null, label: '指定なし' },
  { value: 'high', label: CAREER_COMPANY_INTEREST_LABELS.high },
  { value: 'mid', label: CAREER_COMPANY_INTEREST_LABELS.mid },
  { value: 'low', label: CAREER_COMPANY_INTEREST_LABELS.low },
  { value: 'watch', label: CAREER_COMPANY_INTEREST_LABELS.watch },
];

const SELECTION_TYPE_OPTIONS: Array<{
  value: CareerInterviewSelectionType | null;
  label: string;
}> = [
  { value: null, label: '指定なし' },
  { value: 'main', label: '本選考' },
  { value: 'internship', label: 'インターン' },
];

// マウント前 false / マウント後 true（他ページと同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

const PHASE_OPTIONS: Array<{ value: CareerInterviewPhase | null; label: string }> = [
  { value: null, label: '指定なし' },
  { value: 'first', label: '一次面接' },
  { value: 'second', label: '二次面接' },
  { value: 'final', label: '最終面接' },
  { value: 'internship', label: 'インターン面接' },
  { value: 'casual', label: 'カジュアル面談' },
];

export function CompanyApplicationCard({ companyId }: { companyId: string }) {
  const userId = useCurrentUserId();
  const [interestLevel, setInterestLevel] = useState<CareerCompanyInterestLevel | null>(null);
  const [jobType, setJobType] = useState('');
  const [selectionType, setSelectionType] = useState<CareerInterviewSelectionType | null>(null);
  const [selectionPhase, setSelectionPhase] = useState<CareerInterviewPhase | null>(null);
  const [selectionYear, setSelectionYear] = useState('');
  const [saved, setSaved] = useState(false);

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );
  const stored = useMemo(
    () => (isMounted ? loadCompanyApplication(companyId) : null),
    [isMounted, companyId],
  );

  // 保存済みの応募文脈をフォーム初期値へ 1 度だけ反映する
  // （他 target 画面と同じ render-phase hydration パターン）。
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  if (isMounted && hydratedFor !== companyId) {
    if (stored) {
      setInterestLevel(stored.interestLevel ?? null);
      setJobType(stored.jobType ?? '');
      setSelectionType(stored.selectionType ?? null);
      setSelectionPhase(stored.selectionPhase ?? null);
      setSelectionYear(stored.selectionYear ?? '');
    }
    setHydratedFor(companyId);
  }

  function handleSave() {
    const patch: CareerCompanyApplicationDefaults = {
      jobType: jobType.trim(),
      selectionYear: selectionYear.trim(),
    };
    if (interestLevel) patch.interestLevel = interestLevel;
    if (selectionType) patch.selectionType = selectionType;
    if (selectionPhase) patch.selectionPhase = selectionPhase;
    saveCompanyApplication(companyId, patch);

    const next = loadCompanyApplication(companyId);
    // durable mirror は best-effort（member のみ・失敗しても UI は成功扱い）。
    if (next) void mirrorCompanyApplication(userId, next);

    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }

  return (
    <Card variant="soft" padding="md" className="mb-5">
      <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">応募の状況</p>
      <p className="text-xs text-slate-500 leading-relaxed mb-4">
        ここに入れておくと、ES・面接練習・プレゼン対策を始めるときの初期値として使われます
        （各機能でその場で変更できます）。
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-bold text-slate-800 mb-2">応募職種（任意）</label>
          <Input
            value={jobType}
            onChange={(e) => setJobType(e.target.value)}
            placeholder="例: 総合職、エンジニア など"
          />
        </div>
        <div>
          <label className="block text-sm font-bold text-slate-800 mb-2">選考年度（任意）</label>
          <Input
            value={selectionYear}
            onChange={(e) => setSelectionYear(e.target.value)}
            placeholder="例: 2027"
          />
        </div>
      </div>

      <PillGroup
        label="志望度（任意）"
        options={INTEREST_OPTIONS}
        value={interestLevel}
        onChange={setInterestLevel}
      />
      <PillGroup
        label="選考種別（任意）"
        options={SELECTION_TYPE_OPTIONS}
        value={selectionType}
        onChange={setSelectionType}
      />
      <PillGroup
        label="選考段階（任意）"
        options={PHASE_OPTIONS}
        value={selectionPhase}
        onChange={setSelectionPhase}
      />

      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" size="sm" onClick={handleSave}>
          保存する
        </Button>
        {saved && <span className="text-xs font-semibold text-emerald-600">保存しました</span>}
      </div>
    </Card>
  );
}

function PillGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T | null; label: string }>;
  value: T | null;
  onChange: (next: T | null) => void;
}) {
  return (
    <div className="mb-4">
      <label className="block text-sm font-bold text-slate-800 mb-2">{label}</label>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={value === o.value}
            className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 transition-colors ${
              value === o.value
                ? 'bg-blue-600 text-white ring-blue-600'
                : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
