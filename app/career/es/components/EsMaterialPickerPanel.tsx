'use client';

// PASSAI 就活版 — ES「深掘りしながら書く」材料選択パネル（draft エディタ内・深掘りの前段）。
//
// 役割: 今回の ES 設問に使えそうな「既存の Career Data」を探し、ユーザーが複数選択する。
//   - 候補の列挙は client の純関数（lib/careerEs/materialCandidates.ts）が決定論で行う。
//   - 関連度の順位付けだけを /api/career/es/materials（AI）に任せる。
//   - FULL / PARTIAL / NONE の判定は決定論関数（deriveEsMaterialCoverage）。AI には決めさせない。
//   - **最終的にどれを使うかを決めるのはユーザー**（AI のおすすめは初期チェックとバッジで示すだけ）。
//   - 関連情報が無い（none）ときは候補リストを表示せず、そのまま 1 から深掘りへ進む。
// AI は本文を書かない。ここでは材料の候補提示のみ。

import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { resolveEsAxisCoverage, type EsQuestionType } from '@/lib/careerEs/deepDivePrompt';
import {
  deriveEsMaterialCoverage,
  filterRelevantMaterials,
  toSelectedMaterial,
  type EsMaterialCandidate,
  type EsMaterialSelection,
} from '@/lib/careerEs/materialCandidates';
import type { CareerEsDraftMaterials, CareerEsMaterialCoverage } from '@/types/careerEs';

type Props = {
  question: string;
  questionType: EsQuestionType;
  // client が localStorage canonical から決定論で作った候補（prefilter 済み）。
  candidates: EsMaterialCandidate[];
  // 選択完了（none で通過した場合も呼ぶ）。親が draft へ保存し、深掘りフェーズへ進む。
  onDecided: (materials: CareerEsDraftMaterials) => void;
};

// おすすめとして初期チェックする関連度・件数（強制はしない。ユーザーが外せる）。
const AUTO_CHECK_RELEVANCE = 70;
const AUTO_CHECK_MAX = 3;

function relevanceLabel(relevance: number): string {
  return relevance >= 80 ? '関連度: 高' : '関連度: 中';
}

export function EsMaterialPickerPanel({ question, questionType, candidates, onDecided }: Props) {
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selections, setSelections] = useState<EsMaterialSelection[]>([]);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);

  // 候補が 1 件も無い（Career Data 未入力）なら AI を呼ばずに「関連なし」。
  const hasCandidates = candidates.length > 0;

  const coverage: CareerEsMaterialCoverage = useMemo(
    () => (searched ? deriveEsMaterialCoverage(candidates, selections, questionType) : 'none'),
    [searched, candidates, selections, questionType],
  );

  // 関連ありと判定された候補（relevance 降順）。
  const relevant = useMemo(
    () => (searched ? filterRelevantMaterials(candidates, selections) : []),
    [searched, candidates, selections],
  );
  const relevanceById = useMemo(
    () => new Map(selections.map((s) => [s.id, s])),
    [selections],
  );

  const checked = useMemo(
    () => relevant.filter((c) => checkedIds.includes(c.id)),
    [relevant, checkedIds],
  );

  // 選択中の材料で埋まらない観点（＝これから深掘りで聞かれること）。
  const missingAxisLabels = useMemo(
    () =>
      resolveEsAxisCoverage(
        questionType,
        checked.flatMap((c) => c.factKinds),
      ).missing.map((a) => a.label),
    [questionType, checked],
  );

  function toggle(id: string) {
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function search() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/career/es/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          questionType,
          // AI へ渡すのは id と 1 行ラベルだけ（活動整理の全文は送らない）。
          candidates: candidates.map((c) => ({ id: c.id, label: c.label })),
        }),
      });
      const data = (await res.json()) as { selections?: EsMaterialSelection[]; detail?: string };
      if (!res.ok) throw new Error(data.detail ?? '関連する情報の検索に失敗しました。');
      const next = Array.isArray(data.selections) ? data.selections : [];
      setSelections(next);
      // おすすめを初期チェック（強制ではなく、外せる初期値）。
      setCheckedIds(
        next
          .filter((s) => s.relevance >= AUTO_CHECK_RELEVANCE)
          .slice(0, AUTO_CHECK_MAX)
          .map((s) => s.id),
      );
      setSearched(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '関連する情報の検索に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  // 選択を確定して深掘りへ（選択 0 件でも進める＝1 から深掘り）。
  function decide(selectedCandidates: EsMaterialCandidate[], resolved: CareerEsMaterialCoverage) {
    onDecided({
      decided: true,
      coverage: resolved,
      selected: selectedCandidates.map(toSelectedMaterial),
    });
  }

  // ── 関連情報なし（候補ゼロ or coverage=none）: リストを出さず 1 から深掘りへ ──
  if (!hasCandidates || (searched && coverage === 'none')) {
    return (
      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">今回の材料</p>
        <p className="text-sm text-slate-700 leading-relaxed mb-1">
          このテーマについては、まだ使える情報がありません。
        </p>
        <p className="text-xs text-slate-500 leading-relaxed mb-4">
          AIと一緒に、1から整理していきましょう。質問に答えるだけで材料が集まります。
        </p>
        <Button variant="primary" size="md" onClick={() => decide([], 'none')}>
          深掘りを始める →
        </Button>
      </Card>
    );
  }

  // ── 検索前 ──────────────────────────────────────────────────────
  if (!searched) {
    return (
      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">今回の材料を選ぶ</p>
        <p className="text-sm text-slate-700 leading-relaxed mb-1">
          この設問に使えそうな情報が、これまでの入力の中にあるか探します。
        </p>
        <p className="text-xs text-slate-500 leading-relaxed mb-4">
          活動整理・就活軸・過去の自己分析から候補を探します。見つかった中から今回使いたいものを選ぶと、
          AIはすでに分かっていることを聞き返さず、足りない部分だけを質問します。
        </p>
        {error && (
          <p className="mb-3 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" size="md" onClick={search} disabled={loading}>
            {loading ? '探しています…' : 'この設問に使えそうな情報を探す →'}
          </Button>
          <Button variant="secondary" size="md" onClick={() => decide([], 'none')} disabled={loading}>
            使わずに1から深掘りする
          </Button>
        </div>
      </Card>
    );
  }

  // ── 候補あり（full / partial）────────────────────────────────────
  return (
    <Card variant="soft" padding="md" className="mb-4">
      <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">今回の材料を選ぶ</p>
      <p className="text-sm font-bold text-slate-900 leading-relaxed mb-1">
        この設問に使えそうな情報が見つかりました
      </p>
      <p className="text-xs text-slate-500 leading-relaxed mb-4">
        今回のESで使いたいものを選んでください（複数選択できます）。選んだ内容はAIがすでに知っている前提になり、
        同じことを聞き返しません。
      </p>

      <ul className="flex flex-col gap-2 mb-4">
        {relevant.map((candidate) => {
          const selection = relevanceById.get(candidate.id);
          const isChecked = checkedIds.includes(candidate.id);
          return (
            <li key={candidate.id}>
              <label
                className={`flex gap-3 rounded-xl bg-white px-3.5 py-3 cursor-pointer transition-colors ring-1 ${
                  isChecked ? 'ring-blue-400 bg-blue-50/40' : 'ring-slate-200 hover:bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggle(candidate.id)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-800 leading-snug break-words">
                    {candidate.label}
                  </span>
                  {selection?.reason && (
                    <span className="mt-0.5 block text-xs text-slate-500 leading-relaxed break-words">
                      {selection.reason}
                    </span>
                  )}
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[11px] text-slate-400">{candidate.category}</span>
                    {selection && (
                      <span className="text-[11px] text-blue-600">{relevanceLabel(selection.relevance)}</span>
                    )}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {/* 選択内容から決まる「これから聞かれること」。partial のときに特に効く。 */}
      {missingAxisLabels.length > 0 && (
        <div className="mb-4 rounded-xl bg-white ring-1 ring-slate-200 px-3.5 py-3">
          <p className="text-[11px] font-bold text-slate-500 tracking-widest mb-1.5">
            このあと深掘りする内容（不足している観点）
          </p>
          <ul className="list-disc pl-4 space-y-1">
            {missingAxisLabels.map((label) => (
              <li key={label} className="text-xs text-slate-600 leading-relaxed">
                {label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="mb-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <Button variant="primary" size="md" onClick={() => decide(checked, coverage)}>
          {checked.length > 0 ? `${checked.length}件を使って深掘りへ →` : '選ばずに深掘りへ →'}
        </Button>
        <Button variant="secondary" size="md" onClick={() => decide([], coverage)}>
          別の経験について話す
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">
        「別の経験について話す」を選ぶと、候補を使わずに1から深掘りします。
      </p>
    </Card>
  );
}
