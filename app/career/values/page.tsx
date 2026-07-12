'use client';

// 就活軸整理（/career/values）
//
// チェック項目（8 カテゴリ）+ カテゴリ別備考 + 総合備考で、就活で重視/回避する条件や
// 志向を整理する。canonical は localStorage（careerValuesStorage）。ログイン済み
// （member）ユーザーは Supabase career_values へ best-effort で durable 同期する。
//
// hydration 方針は他の career ページ（home 等）と同形:
//   - SSR / 初回 client render は mount フラグ false で null を返す。
//   - mount 後に localStorage を useMemo で読み出し、初期値として内側フォームに渡す
//     （effect 内の同期 setState を避け、react-hooks/set-state-in-effect を満たす）。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { PageHeader } from '@/components/ui/PageHeader';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import {
  CAREER_VALUES_CATEGORIES,
  type CareerValuesCategory,
} from './careerValuesCategories';
import { loadCareerValues, saveCareerValues } from './careerValuesStorage';
import {
  loadCareerValuesFromSupabase,
  saveCareerValuesToSupabase,
} from '@/lib/supabase/careerValues';
import { shadowWriteBaseMemory } from '@/app/career/personalMemoryShadowWrite';
import type {
  CareerValues,
  CareerValuesCategoryKey,
} from '@/types/careerValues';
import { emptyCareerValues } from '@/types/careerValues';

// SSR-stable mount flag（home/page.tsx と同形）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerValuesPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // mount 後にだけ localStorage を読む（SSR では実行しない）。
  const initial = useMemo<CareerValues | null>(
    () => (isMounted ? loadCareerValues() : null),
    [isMounted],
  );

  if (!isMounted) return null;

  // key で「LS あり / なし」を分け、ストアの初期値が確定したフォームを 1 度だけマウントする。
  return (
    <ValuesForm
      key={initial ? 'stored' : 'empty'}
      initial={initial}
    />
  );
}

// ── フォーム本体 ──────────────────────────────────────────────────

type SaveStatus = 'idle' | 'saved';

function ValuesForm({ initial }: { initial: CareerValues | null }) {
  const currentUserId = useCurrentUserId();

  // 初期値は lazy initializer で確定（effect 内の同期 setState を避ける）。
  const [values, setValues] = useState<CareerValues>(
    () => initial ?? emptyCareerValues(),
  );
  const [status, setStatus] = useState<SaveStatus>('idle');

  // ユーザーが編集したら true。Supabase からの遅延 down-sync で上書きしないためのガード。
  const dirtyRef = useRef(false);
  const localWasEmpty = initial === null;

  // localStorage が空 + ログイン済みなら、Supabase の durable mirror から 1 回だけ復元する
  // （別端末で保存した内容の取り込み）。ユーザーが既に編集していれば適用しない。
  // setValues は async コールバック内のため effect 同期 setState には当たらない。
  useEffect(() => {
    if (!currentUserId || !localWasEmpty) return;
    let cancelled = false;
    (async () => {
      const result = await loadCareerValuesFromSupabase(currentUserId);
      if (cancelled || dirtyRef.current) return;
      if (result.kind === 'ok') {
        setValues(result.values);
        // 取り込んだ内容を localStorage にも反映して以降は LS canonical に揃える。
        saveCareerValues(result.values);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUserId, localWasEmpty]);

  const toggleOption = useCallback(
    (key: CareerValuesCategoryKey, option: string) => {
      dirtyRef.current = true;
      setStatus('idle');
      setValues((prev) => {
        const current = prev.selections[key];
        const next = current.includes(option)
          ? current.filter((o) => o !== option)
          : [...current, option];
        return { ...prev, selections: { ...prev.selections, [key]: next } };
      });
    },
    [],
  );

  const setNote = useCallback((key: CareerValuesCategoryKey, note: string) => {
    dirtyRef.current = true;
    setStatus('idle');
    setValues((prev) => ({ ...prev, notes: { ...prev.notes, [key]: note } }));
  }, []);

  const setOverallNote = useCallback((note: string) => {
    dirtyRef.current = true;
    setStatus('idle');
    setValues((prev) => ({ ...prev, overallNote: note }));
  }, []);

  const handleSave = useCallback(() => {
    // updatedAt を LS / Supabase で共有する。
    const toSave: CareerValues = {
      ...values,
      updatedAt: new Date().toISOString(),
    };
    // localStorage（canonical）。これが成功すれば「保存できた」とみなす。
    const saved = saveCareerValues(toSave);
    setValues(saved);
    setStatus('saved');
    dirtyRef.current = false;

    // Supabase durable mirror（best-effort / member のみ）。失敗しても保存成功表示は維持する。
    if (currentUserId) {
      void saveCareerValuesToSupabase(currentUserId, saved);
      // P16-D: Personal Memory base shadow write（flag OFF 既定＝no-op / best-effort / prompt 非利用）。
      void shadowWriteBaseMemory();
    }
  }, [values, currentUserId]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 pb-28">
      <Link
        href="/career/home"
        className="inline-block mb-4 text-sm text-gray-500 hover:text-gray-800 transition-colors"
      >
        ← キャリアホームに戻る
      </Link>

      <PageHeader
        title="就活軸整理"
        description="就活で重視したい条件・避けたい条件・興味のある業界や職種・働き方・社風などを整理します。当てはまる項目にチェックを入れ、補足は備考欄に自由に書いてください。未入力の項目があっても保存できます。"
      />

      <div className="space-y-5">
        {CAREER_VALUES_CATEGORIES.map((category) => (
          <CategoryCard
            key={category.key}
            category={category}
            selected={values.selections[category.key]}
            note={values.notes[category.key]}
            onToggle={toggleOption}
            onNoteChange={setNote}
          />
        ))}

        {/* 総合備考 */}
        <Card variant="soft" padding="md">
          <h2 className="text-base font-bold text-gray-800 mb-1">総合備考</h2>
          <p className="text-sm text-gray-500 mb-3 leading-relaxed">
            チェック項目では拾いきれない例外やニュアンス（例：「年収は重視するが激務すぎる外資コンサルは避けたい」「全国転勤は避けたいが海外勤務ならOK」など）を自由に書いてください。
          </p>
          <Textarea
            value={values.overallNote}
            onChange={(e) => setOverallNote(e.target.value)}
            rows={5}
            placeholder="全体を通して伝えておきたいことを自由に記入してください。"
          />
        </Card>
      </div>

      {/* 保存バー（下部固定） */}
      <div className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white/95 backdrop-blur px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
          <div className="text-sm min-h-[1.25rem]" aria-live="polite">
            {status === 'saved' && (
              <span className="text-green-700">保存しました。</span>
            )}
          </div>
          <Button variant="primary" size="md" onClick={handleSave}>
            保存する
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── カテゴリカード ────────────────────────────────────────────────

function CategoryCard({
  category,
  selected,
  note,
  onToggle,
  onNoteChange,
}: {
  category: CareerValuesCategory;
  selected: string[];
  note: string;
  onToggle: (key: CareerValuesCategoryKey, option: string) => void;
  onNoteChange: (key: CareerValuesCategoryKey, note: string) => void;
}) {
  return (
    <Card variant="default" padding="md">
      <div className="mb-3">
        <h2 className="text-base font-bold text-gray-800">{category.title}</h2>
        <p className="text-sm text-gray-500 leading-relaxed">
          {category.description}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {category.options.map((option) => (
          <CheckChip
            key={option}
            label={option}
            checked={selected.includes(option)}
            onChange={() => onToggle(category.key, option)}
          />
        ))}
      </div>

      <div className="mt-4">
        <label className="block text-xs font-medium text-gray-500 mb-1.5">
          備考（このカテゴリについての補足）
        </label>
        <Textarea
          value={note}
          onChange={(e) => onNoteChange(category.key, e.target.value)}
          rows={2}
          placeholder="例：このカテゴリで特に重視する点や例外があれば記入してください。"
        />
      </div>
    </Card>
  );
}

// ── チェックチップ ────────────────────────────────────────────────
// チェックボックスを「押せるタグ」風に見せる。項目数が多いので折り返し表示にする。
function CheckChip({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm cursor-pointer select-none transition-colors ${
        checked
          ? 'border-blue-500 bg-blue-50 text-blue-700'
          : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 accent-blue-600"
      />
      {label}
    </label>
  );
}
