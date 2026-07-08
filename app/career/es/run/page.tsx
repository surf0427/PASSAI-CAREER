'use client';

// PASSAI 就活版 — ES作成 実行画面（最小版）
//
// 入力: careerBasicFormData / careerActivityData / careerSelfAnalysisLogs（最新1件）を
//       localStorage から読む。
// 実行: /api/career/es を呼び、結果を careerEsLogs に保存して結果画面へ遷移する。
// DB / 課金 / usage には接続しない（localStorage のみ）。

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { Input } from '@/components/ui/Input';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import {
  loadActivityData,
  hasAnyActivity,
} from '@/app/career/activity/activityStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import {
  loadCareerValues,
  isCareerValuesEmpty,
} from '@/app/career/values/careerValuesStorage';
import { appendEsLog } from '../esStorage';
import { loadCompanyResearchLogs } from '@/app/career/company-research/companyResearchStorage';
import {
  buildCompanyResearchSnapshot,
  SINGLE_VERIFIED_PREVIEW,
} from '@/lib/careerCompanyResearch/context';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import { upsertCareerEsLogsToSupabase } from '@/lib/supabase/careerEs';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import type { BasicInfo } from '@/types/basicInfo';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult, CareerEsSelectionType } from '@/types/careerEs';
import type { CareerCompanyResearchLog } from '@/types/careerCompanyResearch';
import { CAREER_COMPANY_INTEREST_LABELS } from '@/types/careerCompanyResearch';

// マウント前 false / マウント後 true（hub と同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

// SSR / 旧 runtime fallback 付き UUID（lib/tutorChatStorage.ts と同方針）。
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ces-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export default function CareerEsRunPage() {
  const router = useRouter();
  const userId = useCurrentUserId();
  const [userInput, setUserInput] = useState('');
  // 設問モード用の入力。すべて任意。設問が空なら従来の「おまかせ生成」になる。
  const [question, setQuestion] = useState('');
  const [charLimitInput, setCharLimitInput] = useState('');
  const [companyName, setCompanyName] = useState('');
  // 応募メタ（このES1本に限った文脈）。すべて任意。
  const [selectionType, setSelectionType] = useState<CareerEsSelectionType | null>(null);
  const [industry, setIndustry] = useState('');
  const [jobType, setJobType] = useState('');
  // 任意: 参照する企業研究ログ（ユーザー本人が確認した企業研究）。null = 使わない。
  const [researchLogId, setResearchLogId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // localStorage は client でのみ読む（hydration 後に useMemo を再評価）。
  const basicInfo = useMemo<BasicInfo | null>(
    () => (isMounted ? loadBasicInfo() : null),
    [isMounted],
  );
  const activity = useMemo<CareerActivity | null>(
    () => (isMounted ? loadActivityData() : null),
    [isMounted],
  );
  // 就活軸（/career/values）。ES に価値観・志望軸を反映させるため AI へ渡す。
  const values = useMemo<CareerValues | null>(
    () => (isMounted ? loadCareerValues() : null),
    [isMounted],
  );
  // 自己分析は最新1件を使う（appendSelfAnalysisLog が先頭に積む）。
  const selfAnalysis = useMemo<CareerSelfAnalysisResult | null>(() => {
    if (!isMounted) return null;
    const logs = loadSelfAnalysisLogs();
    return logs.length > 0 ? logs[0].result : null;
  }, [isMounted]);
  // 保存済み企業研究ログ（最新更新順）。選択でこの企業向けに ES を寄せる。
  const researchLogs = useMemo<CareerCompanyResearchLog[]>(() => {
    if (!isMounted) return [];
    return [...loadCompanyResearchLogs()].sort((a, b) =>
      (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''),
    );
  }, [isMounted]);
  const selectedResearchLog = useMemo<CareerCompanyResearchLog | null>(
    () => researchLogs.find((l) => l.id === researchLogId) ?? null,
    [researchLogs, researchLogId],
  );

  // 企業研究ログを選ぶと、その企業に ES を寄せる（企業名・業界を引き継ぐ）。
  function pickResearchLog(log: CareerCompanyResearchLog | null) {
    setResearchLogId(log?.id ?? null);
    if (log) {
      if (log.companyName) setCompanyName(log.companyName);
      if (log.industry) setIndustry(log.industry);
    }
  }

  const profileReady = !!basicInfo;
  const activityReady = hasAnyActivity(activity);
  // 1 つでも選択 / 備考があれば「入力あり」とみなす簡易判定（自己分析画面と同方針）。
  const valuesReady = !!values && !isCareerValuesEmpty(values);
  const selfAnalysisReady = !!selfAnalysis;
  const canRun = profileReady || activityReady;

  async function handleRun() {
    if (!canRun || loading) return;
    setLoading(true);
    setError(null);

    // 設問モードの入力を正規化する。空なら従来のおまかせ生成にフォールバック。
    const trimmedQuestion = question.trim();
    const trimmedCompany = companyName.trim();
    const trimmedIndustry = industry.trim();
    const trimmedJobType = jobType.trim();
    const parsedLimit = Number.parseInt(charLimitInput, 10);
    const charLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;

    // 企業研究ログを選んでいれば、軽量スナップショットを根拠として渡す（1 件・抜粋）。
    const researchSnapshot = selectedResearchLog
      ? buildCompanyResearchSnapshot(selectedResearchLog, {
          verifiedTextMaxChars: SINGLE_VERIFIED_PREVIEW,
        })
      : null;

    try {
      const res = await fetch('/api/career/es', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: basicInfo,
          activity,
          values,
          selfAnalysis,
          userInput,
          // 任意フィールド。未入力なら送らない（API 側は欠損を許容する）。
          question: trimmedQuestion || undefined,
          charLimit,
          companyName: trimmedCompany || undefined,
          selectionType: selectionType ?? undefined,
          industry: trimmedIndustry || undefined,
          jobType: trimmedJobType || undefined,
          companyResearchContext: researchSnapshot ?? undefined,
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? 'ESの生成に失敗しました。');
      }

      const data = (await res.json()) as { result: CareerEsResult };
      const log = {
        id: newId(),
        createdAt: new Date().toISOString(),
        userInput: userInput.trim(),
        result: data.result,
        // 企業別 ES 管理の土台。入力があった分だけ保存する（既存ログ形状は不変）。
        ...(trimmedCompany ? { companyName: trimmedCompany } : {}),
        ...(trimmedQuestion ? { question: trimmedQuestion } : {}),
        ...(charLimit ? { charLimit } : {}),
        ...(selectionType ? { selectionType } : {}),
        ...(trimmedIndustry ? { industry: trimmedIndustry } : {}),
        ...(trimmedJobType ? { jobType: trimmedJobType } : {}),
        // 参照した企業研究ログ（traceability・添削での再利用）。
        ...(researchSnapshot
          ? {
              companyResearchLogId: researchSnapshot.logId,
              companyResearchSnapshot: researchSnapshot,
            }
          : {}),
      };
      appendEsLog(log);
      // Supabase durable mirror（best-effort / member のみ）。
      if (userId) void upsertCareerEsLogsToSupabase(userId, [log]);
      // Event Log（本文なし・fire-and-forget / member のみ）。設問本文・生成本文は渡さない。
      void recordCareerEvent(userId, {
        feature: 'es',
        eventType: 'ai_generated',
        completionStatus: 'completed',
        clientEventId: log.id,
        industry: trimmedIndustry || null,
        jobType: trimmedJobType || null,
        metadata: { ...(selectionType ? { selectionType } : {}) },
      });

      router.push('/career/es/result');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ESの生成に失敗しました。');
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="ESを作成"
        description="登録済みの情報をもとに、ESのドラフトを生成します。"
      />

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">入力データ</p>
        <div className="grid grid-cols-2 gap-y-3 gap-x-4">
          <ReadyItem label="基本情報" ready={profileReady} href="/career/profile" />
          <ReadyItem label="活動整理" ready={activityReady} href="/career/activity" />
          <ReadyItem label="就活軸" ready={valuesReady} href="/career/values" />
          <ReadyItem label="自己分析" ready={selfAnalysisReady} href="/career/self-analysis" />
        </div>
        {!canRun && (
          <p className="mt-4 text-xs text-amber-700 leading-relaxed">
            基本情報または活動整理のいずれかを入力すると実行できます。
          </p>
        )}
        {canRun && !selfAnalysisReady && (
          <p className="mt-4 text-xs text-slate-500 leading-relaxed">
            自己分析の結果があると、より精度の高いESを生成できます（任意）。
          </p>
        )}
      </Card>

      {researchLogs.length > 0 && (
        <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">
            企業研究ログを使う（任意）
          </p>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">
            あなたが保存した企業研究を選ぶと、その企業に合わせて志望動機などを下書きします（AIが企業情報を作るのではなく、あなたの研究を根拠にします）。
          </p>
          <div className="flex flex-col gap-2">
            <ResearchOption
              label="企業研究なしで進める"
              sub="登録済みの基本情報・活動・自己分析だけで作成します。"
              active={researchLogId === null}
              onClick={() => setResearchLogId(null)}
              disabled={loading}
            />
            {researchLogs.map((log) => (
              <ResearchOption
                key={log.id}
                label={log.companyName || '（企業名なし）'}
                sub={researchSummary(log)}
                active={researchLogId === log.id}
                onClick={() => pickResearchLog(log)}
                disabled={loading}
              />
            ))}
          </div>
        </Card>
      )}

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
          企業・選考に合わせて作る（任意）
        </p>
        <p className="text-xs text-slate-500 leading-relaxed mb-4">
          ES設問を入力すると、その設問への回答を生成します。空のままだと、ガクチカ・自己PR・志望動機などを一括で下書きします。選考種別・業界・職種・企業名を指定すると、その応募先に合わせた表現に調整します。
        </p>

        <label className="block text-sm font-bold text-slate-800 mb-2">
          選考種別（任意）
        </label>
        <div className="flex flex-wrap gap-2 mb-4">
          <SelectionTypeButton
            label="指定なし"
            active={selectionType === null}
            onClick={() => setSelectionType(null)}
            disabled={loading}
          />
          <SelectionTypeButton
            label="本選考"
            active={selectionType === 'main'}
            onClick={() => setSelectionType('main')}
            disabled={loading}
          />
          <SelectionTypeButton
            label="インターン応募"
            active={selectionType === 'internship'}
            onClick={() => setSelectionType('internship')}
            disabled={loading}
          />
        </div>
        <p className="text-xs text-slate-500 leading-relaxed mb-4">
          {selectionType === 'main'
            ? '本選考：入社後の貢献・志望度・企業適合性を重視して生成します。'
            : selectionType === 'internship'
              ? 'インターン：参加目的・学習意欲・業務理解を重視して生成します。'
              : '指定なし：本選考にもインターンにも使える中立的な表現で生成します。'}
        </p>

        <label className="block text-sm font-bold text-slate-800 mb-2">
          ES設問（任意）
        </label>
        <p className="text-xs text-slate-500 leading-relaxed mb-2">
          企業のESで実際に聞かれている質問文を入力する欄です（例:「当社を志望する理由を教えてください」）。
          空欄のままでも、ガクチカ・自己PR・志望動機などの下書きをまとめて生成できます。
        </p>
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="例: 学生時代に最も力を入れたことを教えてください。"
          rows={3}
          disabled={loading}
          className="mb-4"
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-2">
              文字数（任意）
            </label>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={charLimitInput}
              onChange={(e) => setCharLimitInput(e.target.value)}
              placeholder="例: 400"
              disabled={loading}
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-2">
              企業名（任意）
            </label>
            <Input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="例: 〇〇株式会社"
              disabled={loading}
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-2">
              志望業界（任意）
            </label>
            <Input
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="例: IT・Web、メーカー、商社 など"
              disabled={loading}
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-2">
              志望職種（任意）
            </label>
            <Input
              value={jobType}
              onChange={(e) => setJobType(e.target.value)}
              placeholder="例: 営業、エンジニア、企画 など"
              disabled={loading}
            />
          </div>
        </div>
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <label className="block text-sm font-bold text-slate-800 mb-2">
          補足・志望企業メモ（任意）
        </label>
        <Textarea
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          placeholder="例: 〇〇業界の総合職を志望。リーダー経験を軸にアピールしたい。"
          rows={4}
          disabled={loading}
        />
      </Card>

      {error && (
        <p className="mb-4 text-sm text-red-600 leading-relaxed" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <Button
          variant="primary"
          size="md"
          onClick={handleRun}
          disabled={!canRun || loading}
          className="w-full sm:w-auto"
        >
          {loading ? '生成中…' : 'ESを生成する →'}
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
        active
          ? 'bg-blue-600 text-white'
          : 'bg-white ring-1 ring-slate-300 text-slate-600 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );
}

// 企業研究ログの 1 行サマリ（志望度・更新日・理解度スコア・メモ抜粋）。
function researchSummary(log: CareerCompanyResearchLog): string {
  const parts: string[] = [];
  if (log.interestLevel) parts.push(CAREER_COMPANY_INTEREST_LABELS[log.interestLevel]);
  const d = new Date(log.updatedAt || log.createdAt);
  if (!Number.isNaN(d.getTime())) parts.push(`更新 ${d.toLocaleDateString('ja-JP')}`);
  if (log.review?.overallScore) parts.push(`理解度${log.review.overallScore}点`);
  const head = parts.join('・');
  const memo = (log.input?.verifiedResearchText || log.input?.manualMemo || '').trim();
  const memoPreview = memo ? `｜${memo.slice(0, 40)}${memo.length > 40 ? '…' : ''}` : '';
  return `${head}${memoPreview}`;
}

function ResearchOption({
  label,
  sub,
  active,
  onClick,
  disabled,
}: {
  label: string;
  sub?: string;
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
      className={`w-full text-left rounded-xl px-3 py-2.5 ring-1 transition-colors disabled:opacity-50 ${
        active ? 'bg-blue-50 ring-blue-400' : 'bg-white ring-slate-200 hover:bg-slate-50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
            active ? 'border-blue-600' : 'border-slate-300'
          }`}
        >
          {active && <span className="h-2 w-2 rounded-full bg-blue-600" />}
        </span>
        <span className="text-sm font-semibold text-slate-800 truncate">{label}</span>
      </div>
      {sub && <p className="mt-1 pl-6 text-xs text-slate-500 leading-relaxed">{sub}</p>}
    </button>
  );
}

function ReadyItem({ label, ready, href }: { label: string; ready: boolean; href: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-slate-500 mb-0.5">{label}</p>
      {ready ? (
        <p className="text-sm font-semibold text-emerald-700">入力あり</p>
      ) : (
        <Link href={href} className="text-sm font-semibold text-blue-600 hover:underline">
          未入力（入力する →）
        </Link>
      )}
    </div>
  );
}
