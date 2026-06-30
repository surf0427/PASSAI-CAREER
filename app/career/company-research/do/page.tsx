'use client';

// PASSAI 就活版 — 企業研究 入力・編集・AI添削 兼用ページ（単一）
//
// 1 ページで「新規作成 / 既存ログの編集 / 再添削」をすべて担う。
//   - 新規: /career/company-research/do（?id なし）→ 空状態から開始。
//   - 編集/再添削: /career/company-research/do?id=<logId> → 既存ログを読み込み編集状態に。
//
// 入力フロー:
//   1. 企業名・志望度・業界などの基本情報
//   2. 手入力メモ / テキスト貼り付け / PDF・画像アップロード
//   3. アップロードファイルのテキスト抽出（MVP: text のみ自動。PDF/画像は手動書き写し）
//   4. 抽出テキストを確認欄へまとめ、ユーザーが確認・修正（verifiedResearchText）
//   5. 確認済みテキストを対象に AI添削（アップロードファイルそのものは添削対象にしない）
//   6. 原文・ファイルメタ・抽出テキスト・確認済みテキスト・添削結果を保存（新規 or 既存更新）
//
// DB / 課金 / usage には接続しない（localStorage canonical。Supabase は best-effort mirror）。

import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { Input } from '@/components/ui/Input';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { loadActivityData } from '@/app/career/activity/activityStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import { loadMatchingLogs } from '@/app/career/matching/matchingStorage';
import { loadCareerValues } from '@/app/career/values/careerValuesStorage';
import {
  appendCompanyResearchLog,
  updateCompanyResearchLog,
  loadCompanyResearchLog,
} from '../companyResearchStorage';
import {
  ACCEPTED_FILE_ACCEPT,
  MAX_FILE_SIZE,
  MAX_FILES,
  isAcceptedFile,
  createPendingFile,
  extractTextFromFile,
  applyExtraction,
} from '../extraction';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import { upsertCareerCompanyResearchLogsToSupabase } from '@/lib/supabase/careerCompanyResearch';
import type { BasicInfo } from '@/types/basicInfo';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import {
  CAREER_COMPANY_INTEREST_LABELS,
  type CareerCompanyInterestLevel,
  type CareerCompanyResearchFile,
  type CareerCompanyResearchInput,
  type CareerCompanyResearchReview,
  type CareerCompanyResearchFitAnalysis,
  type CareerCompanyResearchLog,
  type CareerCompanyResearchRevision,
} from '@/types/careerCompanyResearch';

// マウント前 false / マウント後 true（hub と同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ccr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

const INTEREST_OPTIONS: CareerCompanyInterestLevel[] = ['high', 'mid', 'low', 'watch'];

type ReviewResult = {
  review: CareerCompanyResearchReview;
  fitAnalysis: CareerCompanyResearchFitAnalysis;
  interviewContextSummary: string;
};

// 手入力メモ + 貼り付け + 各ファイル抽出テキストを 1 本にまとめる。
function combineSources(
  manualMemo: string,
  pastedText: string,
  files: CareerCompanyResearchFile[],
): string {
  const parts: string[] = [];
  if (manualMemo.trim()) parts.push(manualMemo.trim());
  if (pastedText.trim()) parts.push(pastedText.trim());
  files.forEach((f) => {
    if (f.extractedText.trim()) parts.push(`【${f.fileName}】\n${f.extractedText.trim()}`);
  });
  return parts.join('\n\n');
}

// ファイル群の抽出テキストだけを連結（input.extractedText = OCR/抽出の生テキスト）。
function combineFileExtracts(files: CareerCompanyResearchFile[]): string {
  return files
    .filter((f) => f.extractedText.trim())
    .map((f) => `【${f.fileName}】\n${f.extractedText.trim()}`)
    .join('\n\n');
}

function CompanyResearchDoInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editingId = searchParams.get('id');
  const userId = useCurrentUserId();

  // 基本情報・素材入力。
  const [companyName, setCompanyName] = useState('');
  const [industry, setIndustry] = useState('');
  const [interestLevel, setInterestLevel] = useState<CareerCompanyInterestLevel | null>(null);
  const [manualMemo, setManualMemo] = useState('');
  const [pastedText, setPastedText] = useState('');
  const [sources, setSources] = useState('');
  const [files, setFiles] = useState<CareerCompanyResearchFile[]>([]);
  const [verifiedResearchText, setVerifiedResearchText] = useState('');

  // いずれかのファイルが抽出中なら true（pending から派生）。
  const extracting = files.some((f) => f.extractionStatus === 'pending');

  // 添削結果（保存前の画面 state）。verifiedResearchText 編集で stale 化したら破棄する。
  const [result, setResult] = useState<ReviewResult | null>(null);

  // 既存ログ（編集対象）。新規は null。
  const [editingLog, setEditingLog] = useState<CareerCompanyResearchLog | null>(null);
  const loadedRef = useRef(false);

  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // 既存ログの読み込み（?id あり・1 回だけ）。新規ログ作成では何もしない。
  // localStorage からの 1 回限りの restore のため effect 内 setState が必要。
  // 同パターンの app/self-pr / app/admission-matching に倣い、本 block 限定で
  // react-hooks/set-state-in-effect を disable する（loadedRef で多重実行を防ぐ）。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isMounted || loadedRef.current) return;
    loadedRef.current = true;
    if (!editingId) return;
    const log = loadCompanyResearchLog(editingId);
    if (!log) return;
    setEditingLog(log);
    setCompanyName(log.input.companyName || log.companyName);
    setIndustry(log.input.industry || log.industry);
    setInterestLevel(log.input.interestLevel ?? log.interestLevel);
    setManualMemo(log.input.manualMemo);
    setPastedText(log.input.pastedText);
    setSources(log.input.sources);
    setFiles(log.input.uploadedFiles);
    setVerifiedResearchText(log.input.verifiedResearchText);
  }, [isMounted, editingId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 横断コンテキスト（添削・すり合わせの材料）。
  const basicInfo = useMemo<BasicInfo | null>(
    () => (isMounted ? loadBasicInfo() : null),
    [isMounted],
  );
  const activity = useMemo<CareerActivity | null>(
    () => (isMounted ? loadActivityData() : null),
    [isMounted],
  );
  const values = useMemo<CareerValues | null>(
    () => (isMounted ? loadCareerValues() : null),
    [isMounted],
  );
  const selfAnalysis = useMemo<CareerSelfAnalysisResult | null>(() => {
    if (!isMounted) return null;
    const logs = loadSelfAnalysisLogs();
    return logs.length > 0 ? logs[0].result : null;
  }, [isMounted]);
  const matching = useMemo<CareerMatchEngineResult | null>(() => {
    if (!isMounted) return null;
    const logs = loadMatchingLogs();
    return logs.length > 0 ? logs[0].result : null;
  }, [isMounted]);

  const canReview = companyName.trim() !== '' && verifiedResearchText.trim() !== '';
  const canSave = !!result && canReview;

  // verifiedResearchText を編集したら、既存の添削結果は対象とずれるので破棄する。
  function changeVerifiedText(next: string) {
    setVerifiedResearchText(next);
    if (result) setResult(null);
  }

  // ファイル追加。まず pending で一覧に出し（「抽出中」表示）、各ファイルを並行抽出して
  // 完了したものから state を更新する。抽出は API（PDF 埋め込み / Claude OCR）or ローカル（TXT）。
  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    setFileNote(null);
    const incoming = Array.from(fileList);
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of incoming) {
      if (!isAcceptedFile(f)) {
        rejected.push(`${f.name}（非対応の形式）`);
        continue;
      }
      if (f.size > MAX_FILE_SIZE) {
        rejected.push(`${f.name}（サイズ超過）`);
        continue;
      }
      accepted.push(f);
    }
    if (files.length + accepted.length > MAX_FILES) {
      setError(`ファイルは合計 ${MAX_FILES} 件までです。`);
      if (rejected.length > 0) setFileNote(`追加できなかったファイル: ${rejected.join('、')}`);
      return;
    }
    if (rejected.length > 0) setFileNote(`追加できなかったファイル: ${rejected.join('、')}`);
    if (accepted.length === 0) return;

    const uploadedAt = new Date().toISOString();
    const pendings = accepted.map((f) => ({ file: f, meta: createPendingFile(f, uploadedAt) }));
    setFiles((prev) => [...prev, ...pendings.map((p) => p.meta)]);

    await Promise.all(
      pendings.map(async ({ file, meta }) => {
        const extracted = await extractTextFromFile(file);
        setFiles((prev) =>
          prev.map((f) => (f.id === meta.id ? applyExtraction(f, extracted) : f)),
        );
      }),
    );
  }

  function updateFileText(id: string, text: string) {
    setFiles((prev) =>
      prev.map((f) =>
        f.id === id
          ? {
              ...f,
              extractedText: text,
              extractionStatus: text.trim() ? 'success' : 'manual_required',
              // 手動で直したら自動抽出エラー表示は消す。
              extractionError: undefined,
            }
          : f,
      ),
    );
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  // 手入力 + 貼り付け + 抽出テキストを確認欄へまとめる。
  function consolidateToVerified() {
    const combined = combineSources(manualMemo, pastedText, files);
    changeVerifiedText(combined);
  }

  async function handleReview() {
    if (!canReview || reviewing) return;
    setReviewing(true);
    setError(null);
    try {
      const res = await fetch('/api/career/company-research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: companyName.trim(),
          industry: industry.trim(),
          interestLevel,
          verifiedResearchText: verifiedResearchText.trim(),
          sources: sources.trim(),
          profile: basicInfo,
          activity,
          values,
          selfAnalysis,
          matching,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? '企業研究の添削に失敗しました。');
      }
      const data = (await res.json()) as ReviewResult;
      setResult({
        review: data.review,
        fitAnalysis: data.fitAnalysis,
        interviewContextSummary: data.interviewContextSummary,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '企業研究の添削に失敗しました。');
    } finally {
      setReviewing(false);
    }
  }

  function handleSave() {
    if (!result || !canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const input: CareerCompanyResearchInput = {
        companyName: companyName.trim(),
        industry: industry.trim(),
        interestLevel,
        manualMemo: manualMemo.trim(),
        pastedText: pastedText.trim(),
        uploadedFiles: files,
        extractedText: combineFileExtracts(files),
        verifiedResearchText: verifiedResearchText.trim(),
        sources: sources.trim(),
      };
      const revision: CareerCompanyResearchRevision = {
        revisionId: newId(),
        verifiedResearchText: input.verifiedResearchText,
        review: result.review,
        fitAnalysis: result.fitAnalysis,
        interviewContextSummary: result.interviewContextSummary,
        createdAt: now,
      };

      let saved: CareerCompanyResearchLog;
      if (editingLog) {
        // 既存ログを更新。添削履歴に新リビジョンを先頭追加（学習ループの記録）。
        saved = {
          ...editingLog,
          companyName: input.companyName,
          industry: input.industry,
          interestLevel,
          input,
          review: result.review,
          fitAnalysis: result.fitAnalysis,
          interviewContextSummary: result.interviewContextSummary,
          revisionHistory: [revision, ...editingLog.revisionHistory],
          updatedAt: now,
        };
        updateCompanyResearchLog(saved.id, saved);
      } else {
        saved = {
          id: newId(),
          createdAt: now,
          updatedAt: now,
          companyName: input.companyName,
          industry: input.industry,
          interestLevel,
          input,
          review: result.review,
          fitAnalysis: result.fitAnalysis,
          interviewContextSummary: result.interviewContextSummary,
          revisionHistory: [revision],
        };
        appendCompanyResearchLog(saved);
      }

      // Supabase durable mirror（best-effort / member のみ）。
      if (userId) void upsertCareerCompanyResearchLogsToSupabase(userId, [saved]);

      router.push(`/career/company-research/view?id=${encodeURIComponent(saved.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存に失敗しました。');
      setSaving(false);
    }
  }

  // busy: 入力欄を止める状態（添削中・保存中）。抽出中は入力欄を止めず、
  // 抽出結果に依存するボタン（まとめる / AI添削）だけ extracting で別途ガードする。
  const busy = reviewing || saving;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title={editingLog ? '企業研究を修正して再添削' : '企業研究を添削する'}
        description="自分で調べた内容を入力してください。AIが家庭教師として添削します（企業情報は代わりに生成しません）。"
      />

      {editingLog && (
        <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
          <p className="text-sm text-slate-700">
            <strong>{editingLog.companyName}</strong> の企業研究を編集中です。再添削して保存すると、添削履歴に新しい版が追加されます。
          </p>
        </Card>
      )}

      {/* STEP 1: 企業の基本情報 */}
      <StepCard step={1} title="企業の基本情報">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-2">
              企業名 <span className="text-red-500">*</span>
            </label>
            <Input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="例: 〇〇株式会社"
              disabled={busy}
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-2">業界（任意）</label>
            <Input
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="例: IT・Web、メーカー、商社 など"
              disabled={busy}
            />
          </div>
        </div>
        <label className="block text-sm font-bold text-slate-800 mb-2">志望度（任意）</label>
        <div className="flex flex-wrap gap-2">
          <InterestButton
            label="指定なし"
            active={interestLevel === null}
            onClick={() => setInterestLevel(null)}
            disabled={busy}
          />
          {INTEREST_OPTIONS.map((level) => (
            <InterestButton
              key={level}
              label={CAREER_COMPANY_INTEREST_LABELS[level]}
              active={interestLevel === level}
              onClick={() => setInterestLevel(level)}
              disabled={busy}
            />
          ))}
        </div>
      </StepCard>

      {/* STEP 2: 素材入力（手入力 / 貼り付け / アップロード） */}
      <StepCard step={2} title="企業研究の素材を入れる">
        <p className="text-xs text-slate-500 leading-relaxed mb-4">
          手入力・テキスト貼り付け・PDF/画像アップロードのどれでも構いません。書ける範囲で入力してください。
        </p>

        <label className="block text-sm font-bold text-slate-800 mb-2">手入力メモ（任意）</label>
        <Textarea
          value={manualMemo}
          onChange={(e) => setManualMemo(e.target.value)}
          placeholder="自分の言葉で調べた内容（事業・強み・競合・求める人物像・自分との接点など）"
          rows={5}
          disabled={busy}
          className="mb-4"
        />

        <label className="block text-sm font-bold text-slate-800 mb-2">
          テキスト貼り付け（任意）
        </label>
        <Textarea
          value={pastedText}
          onChange={(e) => setPastedText(e.target.value)}
          placeholder="採用ページ・説明会資料などからコピーしたテキストを貼り付け"
          rows={4}
          disabled={busy}
          className="mb-4"
        />

        {/* ファイルアップロード */}
        <label className="block text-sm font-bold text-slate-800 mb-2">
          PDF / 画像 / スクショ（任意）
        </label>
        <input
          type="file"
          accept={ACCEPTED_FILE_ACCEPT}
          multiple
          disabled={busy}
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = ''; // 同じファイルを再選択できるようにリセット
          }}
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-sm file:font-bold file:text-white hover:file:bg-blue-700 disabled:opacity-50"
        />
        <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
          対応形式: PDF / PNG / JPG / JPEG / WEBP / TXT（合計{MAX_FILES}件・1件{Math.round(MAX_FILE_SIZE / 1024 / 1024)}MBまで）。
          PDFは埋め込みテキストを抽出し、画像・スクショ・画像PDFはAIが文字を読み取ります。
          読み取り結果は必ず確認・修正してください（誤りが残る場合があります）。
          ファイル本体は保存されず、抽出テキストとファイル名などのメタ情報のみ保存します。
        </p>
        {extracting && <p className="mt-2 text-xs text-slate-500">テキストを抽出中…（資料によっては数十秒かかります）</p>}
        {fileNote && <p className="mt-2 text-xs text-amber-700 leading-relaxed">{fileNote}</p>}

        {files.length > 0 && (
          <div className="mt-4 flex flex-col gap-3">
            {files.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                disabled={busy}
                onChangeText={(text) => updateFileText(f.id, text)}
                onRemove={() => removeFile(f.id)}
              />
            ))}
          </div>
        )}

        <div className="mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={consolidateToVerified}
            disabled={busy || extracting}
          >
            ↓ 素材を下の確認欄にまとめる
          </Button>
        </div>
      </StepCard>

      {/* STEP 3: 確認・修正（添削対象） */}
      <StepCard step={3} title="内容を確認・修正する（添削対象）">
        <p className="text-xs text-slate-500 leading-relaxed mb-3">
          ここに入れたテキストだけがAI添削の対象になります。アップロードや貼り付けの内容に誤りがないか、自分の言葉で確認・修正してください。
        </p>
        <Textarea
          value={verifiedResearchText}
          onChange={(e) => changeVerifiedText(e.target.value)}
          placeholder="ここに、確認済みの企業研究テキストをまとめます（上の「まとめる」ボタンで素材を流し込めます）"
          rows={10}
          disabled={busy}
        />
        <div className="mt-4">
          <label className="block text-sm font-bold text-slate-800 mb-2">
            参考にした情報源（任意）
          </label>
          <Textarea
            value={sources}
            onChange={(e) => setSources(e.target.value)}
            placeholder="公式サイト・採用ページ・説明会・OB訪問・IR資料 など"
            rows={2}
            disabled={busy}
          />
        </div>
      </StepCard>

      {error && (
        <p className="mb-4 text-sm text-red-600 leading-relaxed" role="alert">
          {error}
        </p>
      )}
      {!canReview && (
        <p className="mb-4 text-xs text-amber-700 leading-relaxed">
          企業名と、確認欄のテキストを入力するとAI添削できます。
        </p>
      )}

      {/* STEP 4: AI添削 */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <Button
          variant="primary"
          size="md"
          onClick={handleReview}
          disabled={!canReview || busy || extracting}
          className="w-full sm:w-auto"
        >
          {reviewing ? '添削中…' : result ? 'もう一度AI添削する' : 'AIに添削してもらう →'}
        </Button>
        <Link
          href="/career/company-research"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← 企業研究トップに戻る
        </Link>
      </div>

      {/* 添削プレビュー + 保存 */}
      {result && (
        <>
          <ReviewPreview result={result} />
          <Card variant="soft" padding="md" className="mb-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-900">この内容で保存</p>
                <p className="text-xs text-slate-500 leading-relaxed">
                  研究メモ原文・抽出テキスト・確認済みテキスト・添削結果をまとめて保存します。
                  {editingLog ? '既存ログを更新し、添削履歴に追加します。' : ''}
                </p>
              </div>
              <Button
                variant="primary"
                size="md"
                onClick={handleSave}
                disabled={!canSave || saving}
                className="shrink-0"
              >
                {saving ? '保存中…' : editingLog ? '更新して保存' : '保存する'}
              </Button>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

// ── 小コンポーネント ──────────────────────────────────────────────

function StepCard({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
          {step}
        </span>
        <p className="text-sm font-bold text-slate-900">{title}</p>
      </div>
      {children}
    </Card>
  );
}

const STATUS_LABEL: Record<CareerCompanyResearchFile['extractionStatus'], string> = {
  pending: '抽出中…',
  success: '抽出完了',
  failed: '抽出失敗',
  manual_required: '手動入力が必要',
};

const STATUS_STYLE: Record<CareerCompanyResearchFile['extractionStatus'], string> = {
  pending: 'bg-slate-100 text-slate-600',
  success: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-rose-100 text-rose-700',
  manual_required: 'bg-amber-100 text-amber-700',
};

function FileRow({
  file,
  disabled,
  onChangeText,
  onRemove,
}: {
  file: CareerCompanyResearchFile;
  disabled?: boolean;
  onChangeText: (text: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-xl ring-1 ring-slate-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 truncate">{file.fileName}</p>
          <p className="text-[11px] text-slate-400">
            {(file.fileSize / 1024).toFixed(0)} KB
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[file.extractionStatus]}`}
          >
            {STATUS_LABEL[file.extractionStatus]}
          </span>
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled || file.extractionStatus === 'pending'}
            className="text-xs text-slate-400 hover:text-rose-600 disabled:opacity-50"
          >
            削除
          </button>
        </div>
      </div>
      {file.extractionError && (
        <p className="mb-2 text-[11px] text-amber-700 leading-relaxed">{file.extractionError}</p>
      )}
      <Textarea
        value={file.extractedText}
        onChange={(e) => onChangeText(e.target.value)}
        placeholder={
          file.extractionStatus === 'pending'
            ? '抽出中…'
            : 'このファイルの内容（自動抽出できない・誤りがある場合は、見ながら書き写してください）'
        }
        rows={3}
        disabled={disabled || file.extractionStatus === 'pending'}
      />
    </div>
  );
}

function InterestButton({
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

const RANK_STYLE: Record<CareerCompanyResearchReview['rank'], string> = {
  S: 'bg-amber-100 text-amber-800 ring-amber-300',
  A: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  B: 'bg-blue-100 text-blue-800 ring-blue-300',
  C: 'bg-slate-100 text-slate-700 ring-slate-300',
  D: 'bg-rose-100 text-rose-800 ring-rose-300',
};

// 添削プレビュー（保存前の確認用・最小表示）。詳細表示は view 側に揃える。
function ReviewPreview({ result }: { result: ReviewResult }) {
  const { review } = result;
  return (
    <Card variant="soft" padding="md" className="mb-4">
      <div className="flex items-center gap-4 mb-3">
        <div>
          <p className="text-[11px] text-slate-500 mb-0.5">総合スコア</p>
          <p className="text-3xl font-bold text-slate-900 leading-none">
            {review.overallScore}
            <span className="text-base text-slate-400"> / 100</span>
          </p>
        </div>
        <span
          className={`inline-flex h-12 w-12 items-center justify-center rounded-full text-xl font-bold ring-2 ${RANK_STYLE[review.rank]}`}
          title="ランク"
        >
          {review.rank}
        </span>
      </div>
      {review.overallComment && (
        <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap mb-3">
          {review.overallComment}
        </p>
      )}
      {review.missingInfo.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-slate-500 mb-1">不足している情報</p>
          <ul className="list-disc pl-5 space-y-1">
            {review.missingInfo.slice(0, 3).map((item, i) => (
              <li key={i} className="text-sm text-slate-700 leading-relaxed">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-[11px] text-slate-400">
        保存すると、すり合わせ・面接連携要約を含む全文を一覧画面で確認できます。
      </p>
    </Card>
  );
}

export default function CareerCompanyResearchDoPage() {
  return (
    <Suspense fallback={null}>
      <CompanyResearchDoInner />
    </Suspense>
  );
}
