'use client';

// PASSAI 就活版 — GD マルチ テーマ設定ステップ（両 create ページ共用）。
//
// 部屋作成ウィザードの step2。**マルチGD（公開GD部屋 / 合言葉ルーム）は
// 作成者が自分でお題を書く方式に一本化**している（AIお題生成は使わない）。
//   - ここで入力した内容が room の canonical theme。作成 API へそのまま渡る。
//   - タイトル・説明が空だと確定できない（＝待機部屋・GD開始へ進めない条件）。
//   - 「このテーマに決定」で確定 → 親へ GdTheme を渡す（onThemeChange(theme)）。
//   - 下書きを編集し直すと未確定に戻る（onThemeChange(null)）。
//
// ※ AIにテーマを作ってもらう機能はソロGD専用（/career/gd/setup → POST /api/career/gd/theme）。
//    この共用コンポーネントからは AI 生成 API を一切呼ばない（online / friend の導線を外す）。
// ※ 制限時間・人数は step1（部屋設定）で管理済みのため、ここでは重複入力させない。

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { GdTheme } from '@/types/careerGd';
import {
  parseRoomThemeInput,
  GD_DEFAULT_FORMAT,
  GD_THEME_TITLE_MAX,
  GD_THEME_DESCRIPTION_MAX,
} from '@/lib/careerGd/roomThemeInput';

type Accent = 'blue' | 'teal';

const ACCENTS: Record<Accent, { text: string; focus: string }> = {
  blue: { text: 'text-blue-700', focus: 'focus:ring-blue-400' },
  teal: { text: 'text-teal-700', focus: 'focus:ring-teal-400' },
};

export function ThemeSetupStep({
  accent = 'blue',
  onThemeChange,
}: {
  accent?: Accent;
  onThemeChange: (theme: GdTheme | null) => void;
}) {
  const c = ACCENTS[accent];

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [constraintsText, setConstraintsText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 下書きを編集したら未確定へ戻す。
  const markDirty = useCallback(() => {
    setConfirmed(false);
    onThemeChange(null);
  }, [onThemeChange]);

  const canConfirm = title.trim().length > 0 && description.trim().length > 0;

  const confirm = useCallback(() => {
    const parsed = parseRoomThemeInput({
      title,
      description,
      format: GD_DEFAULT_FORMAT,
      constraints: constraintsText.split('\n'),
    });
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(null);
    setConfirmed(true);
    onThemeChange(parsed.theme);
  }, [title, description, constraintsText, onThemeChange]);

  const inputCls = `w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-800 ring-1 ring-slate-200 focus:outline-none focus:ring-2 ${c.focus}`;

  return (
    <div data-testid="gd-theme-setup" data-theme-mode="manual">
      <div className="rounded-xl ring-1 ring-slate-200 bg-white/70 p-4 mb-4">
        <p className={`text-[11px] font-bold tracking-widest mb-3 ${c.text}`}>GDのお題</p>
        <label className="block text-[11px] text-slate-500 mb-1">お題（タイトル）</label>
        <input
          type="text"
          value={title}
          maxLength={GD_THEME_TITLE_MAX}
          onChange={(e) => { setTitle(e.target.value); markDirty(); }}
          placeholder="例: リモートワークと出社、これからの働き方"
          className={inputCls}
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
          placeholder="例: 〇〇について議論し、チームの結論をまとめてください。"
          className={`resize-none ${inputCls}`}
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
          className={`resize-none ${inputCls}`}
          data-testid="gd-theme-constraints"
        />
      </div>

      {error && (
        <p className="mb-3 text-sm text-rose-600 leading-relaxed" role="alert">
          {error}
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
          {confirmed ? '✓ お題を決定済み（変更する）' : 'このお題に決定'}
        </Button>
        {confirmed && <span className="text-xs font-semibold text-emerald-600">お題が確定しました</span>}
        {!confirmed && !canConfirm && (
          <span className="text-xs text-slate-400">お題と説明を入力してください</span>
        )}
      </div>
    </div>
  );
}
