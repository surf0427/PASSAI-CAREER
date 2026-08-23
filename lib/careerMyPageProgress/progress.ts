// PASSAI CAREER — マイページ進度の **唯一の集計実装**（純関数）。
//
//   CareerSourceBundle（Layer 1 Source。server reader / 端末 canonical のどちらでも同じ型）
//        ↓ buildCareerMyPageProgress
//   CareerMyPageProgress（グラフに要る最小の数値だけ）
//
// server 経路（Supabase mirror）と端末 canonical 経路で **同じ関数**を使うのが要点。
// 経路ごとに数え方が違うと「マイページの回数」が端末で変わるため、判定はここ 1 箇所に閉じる。
//
// 厳守:
//   - AI を呼ばない / スコアを再計算しない / 仮のスコアを作らない。
//   - 欠損・不正値は **0 点として扱わず、グラフ対象から外す**（0 点は「悪い評価」を意味してしまう）。
//   - 本文・transcript・AI 全文を出力へ入れない。
//   - I/O・env・Date.now 非依存（同じ入力 → 同じ出力）。

import type { CareerSourceBundle } from '@/lib/careerSourceData/types';
import type { CareerSelfAnalysisLog, CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsLog } from '@/types/careerEs';
import type { CareerInterviewResult } from '@/types/careerInterview';
import type { CareerPresentationResult } from '@/types/careerPresentation';
import {
  EMPTY_CAREER_GROWTH_SERIES,
  type CareerGrowthPoint,
  type CareerGrowthSeries,
  type CareerMyPageProgress,
  type CareerSelfAnalysisProgress,
  type CareerSelfUnderstandingDimension,
} from './types';

// ── 自己分析レーダーの軸定義 ────────────────────────────────────────
//
// ★ 軸を新しく発明していない。CareerSelfAnalysisResult に **実在する出力 field** と 1:1 で対応させ、
//   1 軸 = 1 field に固定する（複数 field を混ぜると件数の意味が軸ごとに変わるため）。
//   自己分析には数値評価が無いので、値は「その領域を何件言語化できているか」の件数である。
export const CAREER_SELF_UNDERSTANDING_AXES: readonly {
  key: keyof CareerSelfAnalysisResult & string;
  label: string;
}[] = [
  { key: 'strengths', label: '強み' },
  { key: 'weaknesses', label: '伸びしろ' },
  { key: 'gakuchikaIdeas', label: 'ガクチカ候補' },
  { key: 'selfPrIdeas', label: '自己PR候補' },
  { key: 'valueKeywords', label: '価値観' },
  { key: 'esAngles', label: 'ES切り口' },
];

// ── 防御的な値の読み取り ────────────────────────────────────────────

/** 既存仕様の 0〜100 スコアだけを受け入れる。NaN / 範囲外 / 非数値は null（＝スコア無し）。 */
function validScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  // 表示・差分計算を安定させるため小数第 1 位で丸める（既存スコアは整数運用だが legacy 行に備える）。
  return Math.round(value * 10) / 10;
}

/** ISO 文字列として解釈できる時刻だけを受け入れる。壊れた日時は時系列に載せない。 */
function validTime(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    seen.add(trimmed);
  }
  return [...seen];
}

/**
 * 同一 id の重複行を 1 件に潰す（再保存・mirror 二重書き・legacy 重複への耐性）。
 * 衝突時は createdAt が新しい方を採用し、同時刻なら先に見えた方を維持する（順序非依存で決定的）。
 */
function dedupeById<T extends { id?: unknown; createdAt?: unknown }>(items: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    if (id === '') continue; // id 無し = 突き合わせ不能な壊れた行。数えない。
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, item);
      continue;
    }
    const prevTime = validTime(prev.createdAt) ?? -Infinity;
    const nextTime = validTime(item.createdAt) ?? -Infinity;
    if (nextTime > prevTime) byId.set(id, item);
  }
  return [...byId.values()];
}

// ── 折れ線 series の組み立て ────────────────────────────────────────

type ScoredEntry = { id: string; score: number; time: number; completedAt: string };

/**
 * 「完成した結果」だけを時系列に並べて series 化する。
 *
 * @param items      dedupe 済みの機能別レコード
 * @param scoreOf    そのレコードの確定スコア（未確定なら null を返すこと）
 * @param completedAtOf 結果確定時刻（各機能の実データモデルに合わせて呼び出し側が選ぶ）
 */
function buildSeries<T extends { id?: unknown }>(
  items: readonly T[],
  scoreOf: (item: T) => number | null,
  completedAtOf: (item: T) => string,
): CareerGrowthSeries {
  const scored: ScoredEntry[] = [];
  for (const item of items) {
    const id = typeof item.id === 'string' ? item.id : '';
    if (id === '') continue;
    const score = scoreOf(item);
    if (score === null) continue; // 未完了 / 中断 / legacy / score NULL は履歴に載せない。
    const completedAt = completedAtOf(item);
    const time = validTime(completedAt);
    if (time === null) continue; // 時刻不明は時系列に置けない。
    scored.push({ id, score, time, completedAt });
  }

  // 時系列昇順。同時刻は id で決定的に並べる（表示が実行ごとに揺れないようにする）。
  scored.sort((a, b) => (a.time !== b.time ? a.time - b.time : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const history: CareerGrowthPoint[] = scored.map((entry, index) => ({
    id: entry.id,
    attempt: index + 1,
    score: entry.score,
    completedAt: entry.completedAt,
  }));

  const latestScore = history.length > 0 ? history[history.length - 1].score : null;
  const delta =
    history.length >= 2
      ? Math.round((history[history.length - 1].score - history[history.length - 2].score) * 10) / 10
      : null;

  return { history, latestScore, delta, totalCount: items.length };
}

// ── 自己分析（レーダー） ────────────────────────────────────────────

function dimensionsOf(log: CareerSelfAnalysisLog): CareerSelfUnderstandingDimension[] {
  const result = (log.result ?? {}) as Partial<CareerSelfAnalysisResult>;
  return CAREER_SELF_UNDERSTANDING_AXES.map((axis) => ({
    key: axis.key,
    label: axis.label,
    count: nonEmptyStrings((result as Record<string, unknown>)[axis.key]).length,
  }));
}

function buildSelfAnalysis(logs: readonly CareerSelfAnalysisLog[]): CareerSelfAnalysisProgress {
  let best: { log: CareerSelfAnalysisLog; time: number; dimensions: CareerSelfUnderstandingDimension[] } | null =
    null;

  for (const log of logs) {
    const time = validTime(log.createdAt);
    if (time === null) continue;
    const dimensions = dimensionsOf(log);
    // 全軸 0 件 = 中身の無い行（生成失敗・legacy・空 result）。レーダーの対象にしない。
    if (dimensions.every((d) => d.count === 0)) continue;
    if (
      !best ||
      time > best.time ||
      // 同時刻は id で決定的に選ぶ（最新判定が実行ごとに揺れないようにする）。
      (time === best.time && log.id > best.log.id)
    ) {
      best = { log, time, dimensions };
    }
  }

  if (!best) return { latest: null };
  return {
    latest: {
      id: best.log.id,
      createdAt: best.log.createdAt,
      dimensions: best.dimensions,
    },
  };
}

// ── entry point ─────────────────────────────────────────────────────

/**
 * Layer 1 Source bundle → マイページ進度。
 *
 * 各機能の「1 回」の定義（既存の保存構造から判定したもの）:
 *   - 自己分析: careerSelfAnalysisLogs / career_self_analysis_results の 1 ログ。
 *       壁打ち中の会話は保存されず、**完了時に 1 件だけ**追記されるため 1 ログ = 1 回。
 *   - ES:      careerEsLogs / career_es_logs の 1 ログ（= ES 1 版）。作成中は careerEsDrafts
 *       という別ストアにあり、ここには入らないため未完成 draft は数に混ざらない。
 *   - 面接:    careerInterviewResults / career_interview_results の 1 件。
 *       進行中セッションは career_interview_sessions 側にあり、結果 table には
 *       **面接終了時の最終評価しか書かれない**（＝質問単位の点は存在しない）。
 *   - プレゼン: careerPresentationResults / career_presentation_results の 1 件。
 *       Q&A の評価（qaReview）は別物なので成長グラフには使わない（本編 totalScore のみ）。
 *
 * 時刻は各機能とも「結果 row の createdAt」を使う。面接・プレゼン・自己分析の結果 row は
 * 確定時にしか作られないため createdAt = 結果確定時刻。ES も添削確定と同じ版 row に載る。
 * 専用の completed_at 列はどの table にも存在しない。
 */
export function buildCareerMyPageProgress(bundle: CareerSourceBundle): CareerMyPageProgress {
  const selfAnalysisLogs = dedupeById<CareerSelfAnalysisLog>(bundle.selfAnalysisLogs ?? []);
  const esLogs = dedupeById<CareerEsLog>(bundle.esLogs ?? []);
  const interviewResults = dedupeById<CareerInterviewResult>(bundle.interviewResults ?? []);
  const presentationResults = dedupeById<CareerPresentationResult>(bundle.presentationResults ?? []);

  const es = buildSeries<CareerEsLog>(
    esLogs,
    // 完成判定: ユーザー自身が本文を書き、AI 添削が確定した版だけ（生成のみの旧ログは対象外）。
    (log) => validScore(log.review?.overallScore),
    (log) => log.createdAt,
  );

  const interview = buildSeries<CareerInterviewResult>(
    interviewResults,
    // 完成判定: 面接終了時に server が rubric から算出した総合スコア（旧ログには欠損）。
    (item) => validScore(item.result?.overallScore),
    (item) => item.createdAt,
  );

  const presentation = buildSeries<CareerPresentationResult>(
    presentationResults,
    // 完成判定: 発表本編の最終評価の総合スコア（Q&A の qaReview は別評価なので使わない）。
    (item) => validScore(item.result?.totalScore),
    (item) => item.createdAt,
  );

  return {
    activity: {
      selfAnalysisCount: selfAnalysisLogs.length,
      esCount: esLogs.length,
      interviewCount: interviewResults.length,
      presentationCount: presentationResults.length,
    },
    selfAnalysis: buildSelfAnalysis(selfAnalysisLogs),
    es,
    interview,
    presentation,
  };
}

/** 表示するものが 1 つも無いか（server 結果が空のとき端末 canonical へ倒す判定に使う）。 */
export function isCareerMyPageProgressEmpty(progress: CareerMyPageProgress): boolean {
  const { activity } = progress;
  return (
    activity.selfAnalysisCount === 0 &&
    activity.esCount === 0 &&
    activity.interviewCount === 0 &&
    activity.presentationCount === 0
  );
}

export { EMPTY_CAREER_GROWTH_SERIES };
