'use client';

// PASSAI 就活版 — ES「深掘りしながら書く」Q&Aパネル（draft エディタ内で使用）
//
// 設問に対する深掘り質問を1問ずつ提示し、本人が回答する。上限に達したら回答を
// 材料メモに整理（/api/career/es/organize）する。
//   - 進捗（turns）は onTurns で親（draft ストア）へ即時保存 → 途中離脱・リロードで再開できる。
//   - 整理完了時は onOrganized(turns, memo) で親へ通知（本文執筆フェーズへ）。
// AI は本文を書かない。材料整理のみ。

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { esTurnCapForContext, type EsQuestionType, type EsTurn } from '@/lib/careerEs/deepDivePrompt';
// Data Spine: 選択材料と併用する背景 context を届ける（server が別ブロックとして扱う）。
import { esFallbackBridge } from '../reviewContextSource';

type Props = {
  question: string;
  questionType: EsQuestionType;
  initialTurns: EsTurn[];
  // Q&A 進捗が変わるたびに呼ぶ（親が draft へ autosave）。
  onTurns: (turns: EsTurn[]) => void;
  // 整理完了（または「メモなしで本文へ」）時に呼ぶ。organized へ遷移させる。
  onOrganized: (turns: EsTurn[], memo: string[]) => void;
  // 材料選択フェーズで選ばれた既存 Career Data から作った既知事実（V1・任意）。
  //   - 未指定 / 空なら従来どおり「1 から深掘り」（プロンプトも上限も現行と同じ）。
  //   - 指定時は AI が同じ事実を聞き返さず、不足観点だけを質問する。
  knownFacts?: string[];
  // まだ埋まっていない観点の key（ES_AXIS_DEFS の key。任意）。
  missingAxes?: string[];
  // 提出先の企業（draft 由来・任意）。企業依存設問（志望動機 / 企業研究）でのみ
  //   server が Company Data Spine を背景に載せる。旧 draft では欠損が正常。
  //   ★ companyId は権威ではなく解決 hint（server が canonical company を決める）。
  companyName?: string;
  companyId?: string;
};

export function EsDeepDivePanel({
  question,
  questionType,
  initialTurns,
  onTurns,
  onOrganized,
  knownFacts,
  missingAxes,
  companyName,
  companyId,
}: Props) {
  // 既知の観点の分だけ質問数上限を下げる（server と同じ純関数・同じ入力で一致する）。
  const cap = esTurnCapForContext(questionType, { knownFacts, missingAxes });
  const hasKnownFacts = (knownFacts?.length ?? 0) > 0;

  const [turns, setTurns] = useState<EsTurn[]>(initialTurns);
  const [answer, setAnswer] = useState('');
  const [reaction, setReaction] = useState('');
  const [loading, setLoading] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const started = turns.length > 0;
  const pending =
    turns.length > 0 && turns[turns.length - 1].role === 'question'
      ? turns[turns.length - 1].content
      : null;
  const answered = turns.filter((t) => t.role === 'answer').length;

  // turns を更新しつつ親へ即時 autosave する。
  function commitTurns(next: EsTurn[]) {
    setTurns(next);
    onTurns(next);
  }

  async function fetchSeed() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/career/es/deep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          questionType,
          knownFacts,
          missingAxes,
          companyName: companyName ?? null,
          companyId: companyId ?? null,
          // Data Spine 背景 context 用 bridge（選択材料とは別ブロックとして扱われる）。
          ...esFallbackBridge(),
        }),
      });
      const data = (await res.json()) as { question?: string; detail?: string };
      if (!res.ok || !data.question) throw new Error(data.detail ?? '深掘りの開始に失敗しました。');
      commitTurns([{ role: 'question', content: data.question }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '深掘りの開始に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  async function organize(finalTurns: EsTurn[]) {
    setOrganizing(true);
    setError(null);
    try {
      const res = await fetch('/api/career/es/organize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          turns: finalTurns,
          knownFacts,
          // Data Spine 背景 context 用 bridge（Organize に企業情報は載せない）。
          ...esFallbackBridge(),
        }),
      });
      const data = (await res.json()) as { memo?: string[]; detail?: string };
      if (!res.ok) throw new Error(data.detail ?? '材料整理に失敗しました。');
      onOrganized(finalTurns, Array.isArray(data.memo) ? data.memo : []);
    } catch (e) {
      // 整理に失敗しても Q&A は済んでいる（draft に保存済み）。メモ無しで本文へ進める導線を残す。
      setError(
        (e instanceof Error ? e.message : '材料整理に失敗しました。') +
          '「メモなしで本文に進む」で書き始められます。',
      );
    } finally {
      setOrganizing(false);
    }
  }

  async function submitAnswer() {
    const a = answer.trim();
    if (!pending || !a || loading) return;
    setLoading(true);
    setError(null);
    setReaction('');
    try {
      const res = await fetch('/api/career/es/deep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          questionType,
          turns,
          answer: a,
          knownFacts,
          missingAxes,
          companyName: companyName ?? null,
          companyId: companyId ?? null,
          // Data Spine 背景 context 用 bridge（選択材料とは別ブロックとして扱われる）。
          ...esFallbackBridge(),
        }),
      });
      const data = (await res.json()) as {
        reaction?: string;
        question?: string | null;
        done?: boolean;
        detail?: string;
      };
      if (!res.ok) throw new Error(data.detail ?? '次の質問の生成に失敗しました。');

      const withAnswer: EsTurn[] = [...turns, { role: 'answer', content: a }];
      setAnswer('');
      if (data.done || !data.question) {
        commitTurns(withAnswer);
        await organize(withAnswer);
      } else {
        setReaction(data.reaction ?? '');
        commitTurns([...withAnswer, { role: 'question', content: data.question }]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '次の質問の生成に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  // まだ始めていない: 開始ボタン（AI 呼び出しは明示操作でのみ）。
  if (!started) {
    return (
      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">深掘りしながら書く</p>
        <p className="text-sm text-slate-700 leading-relaxed mb-1">
          この設問に答える材料を、AIとの対話で整理します。
        </p>
        <p className="text-xs text-slate-500 leading-relaxed mb-4">
          {hasKnownFacts
            ? `選んだ材料はAIが把握済みです。同じことは聞かず、足りない部分だけを質問します（${cap}問程度）。整理メモを見ながら本文は自分で書きます。AIは本文を書きません。`
            : `AIが質問します（${cap}問程度）。あなたの回答をもとに整理メモを作り、そのメモを見ながら本文は自分で書きます。AIは本文を書きません。`}
        </p>
        {error && <p className="mb-3 text-sm text-red-600" role="alert">{error}</p>}
        <Button variant="primary" size="md" onClick={fetchSeed} disabled={loading}>
          {loading ? '準備中…' : '深掘りを始める →'}
        </Button>
      </Card>
    );
  }

  return (
    <Card variant="soft" padding="md" className="mb-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest">深掘り Q&amp;A</p>
        <span className="text-[11px] text-slate-400">{answered} / {cap} 問程度</span>
      </div>

      {/* これまでのQ&A（末尾の保留質問は下の入力枠で強調表示するのでここでは省く） */}
      {turns.length > 0 && (
        <div className="mb-4 space-y-3">
          {turns.map((t, i) =>
            t.role === 'question' && i === turns.length - 1 ? null : (
              <div key={i} className={t.role === 'answer' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    t.role === 'answer' ? 'bg-blue-600 text-white' : 'bg-white ring-1 ring-slate-200 text-slate-800'
                  }`}
                >
                  {t.content}
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {organizing ? (
        <p className="text-sm text-slate-500">回答を材料メモに整理しています…</p>
      ) : pending ? (
        <>
          {reaction && <p className="mb-2 text-xs text-emerald-700">{reaction}</p>}
          <div className="rounded-xl bg-blue-50 ring-1 ring-blue-100 px-3.5 py-3 mb-3">
            <p className="text-sm font-semibold text-slate-800 leading-relaxed whitespace-pre-wrap">
              {pending}
            </p>
          </div>
          <Textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="思い出せる具体を、話すように書いてください。"
            rows={4}
            disabled={loading}
          />
          {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}
          <div className="mt-3 flex flex-wrap gap-3">
            <Button variant="primary" size="md" onClick={submitAnswer} disabled={loading || !answer.trim()}>
              {loading ? '送信中…' : '回答する →'}
            </Button>
            {/* 途中で切り上げて整理へ進む（十分材料が集まったと感じたとき）。 */}
            {answered >= 1 && (
              <Button
                variant="secondary"
                size="md"
                onClick={() => organize(pending ? turns.slice(0, -1) : turns)}
                disabled={loading}
              >
                ここまでで整理して本文へ →
              </Button>
            )}
          </div>
        </>
      ) : (
        // pending が無い（organize 失敗などで停止）: メモ無しで本文へ進む導線。
        <>
          {error && <p className="mb-3 text-sm text-red-600" role="alert">{error}</p>}
          <Button variant="secondary" size="md" onClick={() => onOrganized(turns, [])}>
            メモなしで本文に進む →
          </Button>
        </>
      )}
    </Card>
  );
}
