'use client';

// PASSAI 就活版 — GD マルチ テーマ設定ステップ（修正1・両 create ページ共用）。
//
// 部屋作成ウィザードの step2。ユーザーは 2 方式でテーマを用意できる:
//   ① 自分でテーマを作る（手動入力）
//   ② AIにテーマを作ってもらう（業界/職種/難易度/種別を指定 → 生成 → 編集 → 確定）
//
// いずれも編集可能な下書き（draft）に集約し、「このテーマに決定」で確定する。
//   - 確定すると親へ GdTheme を渡す（onThemeChange(theme)）。
//   - 下書きを編集し直すと未確定に戻る（onThemeChange(null)）＝AI 生成物もそのまま確定させない。
//   - タイトル・説明が空だと確定できない（＝待機部屋・GD開始へ進めない条件）。
//   - AI 生成失敗はフロー全体を止めず、再試行 or 手動入力へ切り替えられる。
//
// 制限時間・形式・人数は step1（部屋設定）で管理済みのため、ここでは重複入力させない。

import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { GdFormat, GdTheme } from '@/types/careerGd';
import {
  parseRoomThemeInput,
  GD_THEME_TITLE_MAX,
  GD_THEME_DESCRIPTION_MAX,
} from '@/lib/careerGd/roomThemeInput';

type Accent = 'blue' | 'teal';

const ACCENTS: Record<Accent, { label: string; ringActive: string; chipActive: string; text: string }> = {
  blue: {
    label: 'text-blue-700',
    ringActive: 'ring-blue-500 bg-blue-50',
    chipActive: 'ring-blue-500 bg-blue-50 text-blue-700',
    text: 'text-blue-700',
  },
  teal: {
    label: 'text-teal-700',
    ringActive: 'ring-teal-500 bg-teal-50',
    chipActive: 'ring-teal-500 bg-teal-50 text-teal-700',
    text: 'text-teal-700',
  },
};

const DIFFICULTIES = [
  { key: 'やさしめ', label: 'やさしめ' },
  { key: 'ふつう', label: 'ふつう' },
  { key: '難しめ', label: '難しめ' },
];

type Mode = 'manual' | 'ai';

export function ThemeSetupStep({
  format,
  participantCount,
  timeLimitSec,
  accent = 'blue',
  onThemeChange,
}: {
  format: GdFormat;
  participantCount: number;
  timeLimitSec: number;
  accent?: Accent;
  onThemeChange: (theme: GdTheme | null) => void;
}) {
  const c = ACCENTS[accent];
  const [mode, setMode] = useState<Mode>('manual');

  // 確定対象の下書き（手動・AI 共通）。
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [constraintsText, setConstraintsText] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  // AI 生成の入力。
  const [industry, setIndustry] = useState('');
  const [jobType, setJobType] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [themeType, setThemeType] = useState('');
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // 下書きを編集したら未確定へ戻す（AI 生成物もそのまま確定させない）。
  const markDirty = useCallback(() => {
    setConfirmed(false);
    onThemeChange(null);
  }, [onThemeChange]);

  const canConfirm = title.trim().length > 0 && description.trim().length > 0;

  const applyDraft = useCallback((next: { title: string; description: string; constraints: string[] }) => {
    setTitle(next.title);
    setDescription(next.description);
    setConstraintsText(next.constraints.join('\n'));
    setConfirmed(false);
    onThemeChange(null);
  }, [onThemeChange]);

  const confirm = useCallback(() => {
    const parsed = parseRoomThemeInput({
      title,
      description,
      format,
      constraints: constraintsText.split('\n'),
    });
    if (!parsed.ok) {
      setAiError(parsed.reason);
      return;
    }
    setAiError(null);
    setConfirmed(true);
    onThemeChange(parsed.theme);
  }, [title, description, format, constraintsText, onThemeChange]);

  const generate = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    setAiError(null);
    try {
      const res = await fetch('/api/career/gd/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          participantCount,
          timeLimitSec,
          industry: industry.trim() || undefined,
          jobType: jobType.trim() || undefined,
          difficulty: difficulty || undefined,
          themeType: themeType.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { theme?: GdTheme; error?: string; detail?: string }
        | null;
      if (!res.ok || !data?.theme?.title) {
        throw new Error(data?.detail ?? 'テーマの生成に失敗しました。もう一度お試しください。');
      }
      applyDraft({
        title: data.theme.title,
        description: data.theme.description,
        constraints: Array.isArray(data.theme.constraints) ? data.theme.constraints : [],
      });
    } catch (e) {
      setAiError(
        e instanceof Error
          ? e.message
          : 'テーマの生成に失敗しました。再試行するか、手動で入力してください。',
      );
    } finally {
      setGenerating(false);
    }
  }, [generating, format, participantCount, timeLimitSec, industry, jobType, difficulty, themeType, applyDraft]);

  const hasDraft = useMemo(() => title.trim() || description.trim(), [title, description]);

  return (
    <div data-testid="gd-theme-setup">
      {/* 方式の 2 択 */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <ModeButton
          active={mode === 'manual'}
          accent={c}
          emoji="✍️"
          title="自分でテーマを作る"
          description="GDテーマを直接入力します"
          onClick={() => setMode('manual')}
        />
        <ModeButton
          active={mode === 'ai'}
          accent={c}
          emoji="🤖"
          title="AIにテーマを作ってもらう"
          description="条件を選んでAIが生成します"
          onClick={() => setMode('ai')}
        />
      </div>

      {/* AI 生成の条件入力（AI モードのみ） */}
      {mode === 'ai' && (
        <div className="rounded-xl ring-1 ring-slate-200 bg-white/70 p-4 mb-5">
          <p className={`text-[11px] font-bold tracking-widest mb-3 ${c.text}`}>AI生成の条件（任意）</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="業界" value={industry} onChange={setIndustry} placeholder="例: IT・メーカー・金融" />
            <Field label="職種" value={jobType} onChange={setJobType} placeholder="例: 営業・エンジニア・企画" />
            <Field label="テーマの種類" value={themeType} onChange={setThemeType} placeholder="例: 時事・ビジネス課題・価値観" />
            <div>
              <p className="text-[11px] text-slate-500 mb-1">難易度</p>
              <div className="grid grid-cols-3 gap-2">
                {DIFFICULTIES.map((d) => (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => setDifficulty(difficulty === d.key ? '' : d.key)}
                    className={`rounded-lg ring-1 py-2 text-xs font-semibold transition-colors ${
                      difficulty === d.key ? `${c.chipActive}` : 'ring-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-4">
            <Button
              variant="primary"
              size="md"
              onClick={generate}
              disabled={generating}
              className="w-full sm:w-auto"
            >
              {generating ? 'AIがテーマを作成中…' : hasDraft ? 'AIで再生成する' : 'AIでテーマを生成'}
            </Button>
            <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
              生成された内容は下の欄で自由に編集してから決定できます。
            </p>
          </div>
        </div>
      )}

      {/* 下書き（手動・AI 共通の編集フォーム） */}
      <div className="rounded-xl ring-1 ring-slate-200 bg-white/70 p-4 mb-4">
        <p className={`text-[11px] font-bold tracking-widest mb-3 ${c.text}`}>
          {mode === 'ai' ? '生成されたテーマ（編集できます）' : 'GDテーマ'}
        </p>
        <label className="block text-[11px] text-slate-500 mb-1">テーマ（タイトル）</label>
        <input
          type="text"
          value={title}
          maxLength={GD_THEME_TITLE_MAX}
          onChange={(e) => { setTitle(e.target.value); markDirty(); }}
          placeholder="例: リモートワークと出社、これからの働き方"
          className="w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-800 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
          data-testid="gd-theme-title"
        />
        <label className="block text-[11px] text-slate-500 mt-3 mb-1">
          議論内容・説明（参加者に表示されます）
        </label>
        <textarea
          value={description}
          rows={3}
          maxLength={GD_THEME_DESCRIPTION_MAX}
          onChange={(e) => { setDescription(e.target.value); markDirty(); }}
          placeholder="何について議論し、何を結論づけるかを2〜3文で書いてください。"
          className="w-full resize-none rounded-lg bg-white px-3 py-2 text-sm text-slate-800 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
          data-testid="gd-theme-description"
        />
        <label className="block text-[11px] text-slate-500 mt-3 mb-1">
          前提条件・与件（任意・1行に1つ）
        </label>
        <textarea
          value={constraintsText}
          rows={3}
          onChange={(e) => { setConstraintsText(e.target.value); markDirty(); }}
          placeholder={'例:\n主要顧客は20〜40代の会社員\n価格の大幅値下げは不可'}
          className="w-full resize-none rounded-lg bg-white px-3 py-2 text-sm text-slate-800 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
          data-testid="gd-theme-constraints"
        />
      </div>

      {aiError && (
        <p className="mb-3 text-sm text-rose-600 leading-relaxed" role="alert">
          {aiError}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button
          variant={confirmed ? 'outline' : 'primary'}
          size="md"
          onClick={confirm}
          disabled={!canConfirm}
          data-testid="gd-theme-confirm"
        >
          {confirmed ? '✓ テーマを決定済み（変更する）' : 'このテーマに決定'}
        </Button>
        {confirmed && <span className="text-xs font-semibold text-emerald-600">テーマが確定しました</span>}
        {!confirmed && !canConfirm && (
          <span className="text-xs text-slate-400">テーマと説明を入力してください</span>
        )}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  accent,
  emoji,
  title,
  description,
  onClick,
}: {
  active: boolean;
  accent: (typeof ACCENTS)[Accent];
  emoji: string;
  title: string;
  description: string;
  onClick: () => void;
}) {
  const base = 'w-full text-left rounded-xl ring-1 p-4 transition-colors';
  const cls = active ? `${base} ${accent.ringActive}` : `${base} ring-slate-200 bg-white hover:bg-slate-50`;
  return (
    <button type="button" onClick={onClick} className={cls}>
      <p className="text-sm font-bold text-slate-900 mb-1">
        <span aria-hidden className="mr-1">{emoji}</span>
        {title}
      </p>
      <p className="text-xs text-slate-500 leading-relaxed">{description}</p>
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <p className="text-[11px] text-slate-500 mb-1">{label}</p>
      <input
        type="text"
        value={value}
        maxLength={60}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-800 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
      />
    </div>
  );
}
