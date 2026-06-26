// PASSAI 就活版 — measured readiness のアンチコラプション層（ACL）。
//
// 役割: 既存 PASSAI CAREER のデータ形状（活動整理・ES・面接・自己分析・SPI・プレゼン 等）を
// 読み取り、スコアリングエンジンが食べる readiness シグナル（ScoreSignal[]）へ変換する。
// 「外部データの形状依存」をこの 1 ファイルに閉じ込めることで、storage の形が変わっても
// 影響範囲をここだけに留める（route / engine は無改修で済む）。
//
// 設計原則:
//   - measured-first: 実測できるものは AI 推測より優先する（mergeReadinessSignals が担保）。
//   - 欠損は 0 点ではなく present:false（confidence / missingKeys に反映される）。
//   - 純粋関数（同じ入力 → 同じ出力）。AI / route / DB 非依存。
//
// 注記（MVP の現状）: ES・面接・自己理解の readiness は、現状 AI が質的データから推定する
// （measured には含めない）= 前バージョンと同一の振る舞い。input では es/interview/selfAnalysis
// を受け取れる形にしてあり、将来これらを presence ベースの measured に切り替える際は本ファイル
// のみを変更すればよい（route は無改修）。

import type { CareerProfileInput, CareerActivityInput } from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerInterviewFinalResult } from '@/types/careerInterview';
import type { ScoreSignal } from './types';

// measured readiness の入力（既存データの集約。全フィールド任意・部分データでも落ちない）。
export type MeasuredReadinessInput = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  selfAnalysis?: CareerSelfAnalysisResult | null;
  es?: CareerEsResult | null;
  interview?: CareerInterviewFinalResult | null;
  // 未実装機能のプレースホルダ。将来データ源が出来たら measured 化する（現状は欠損扱い）。
  spi?: unknown | null;
  presentation?: unknown | null;
};

// 出力シグナルは共通の ScoreSignal を再利用する（型の重複を増やさない）。
export type MeasuredReadinessSignal = ScoreSignal;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 活動整理の「内容のあるエピソード」数を決定的に数える。
function countExperiences(activity: CareerActivityInput | null | undefined): number {
  if (!activity) return 0;
  const groups = [
    activity.internships,
    activity.partTimeJobs,
    activity.club,
    activity.projects,
    activity.leadership,
    activity.volunteer,
  ];
  let count = 0;
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    for (const e of g) {
      if (!e || typeof e !== 'object') continue;
      const rec = e as Record<string, unknown>;
      if (text(rec.quantitativeResult) || text(rec.ingenuity) || text(rec.role)) count++;
    }
  }
  return count;
}

// 既存 PASSAI CAREER データ → measured readiness signals。
// 実測できるもののみ present:true。データ源が無いもの（SPI/プレゼン）は present:false で返す。
export function buildMeasuredReadiness(input: MeasuredReadinessInput): MeasuredReadinessSignal[] {
  const { activity } = input;
  const signals: MeasuredReadinessSignal[] = [];

  // ガクチカ・実績: 活動整理のエピソード数から決定的に算出。
  const expCount = countExperiences(activity);
  if (expCount > 0) {
    signals.push({
      key: 'readiness:gakuchika',
      value: Math.min(100, 45 + expCount * 12),
      present: true,
      source: 'measured',
      rationale: `活動整理に内容のあるエピソードが ${expCount} 件`,
    });
  }

  // 語学・英語: 語学エントリ or 英語系資格の有無。
  const hasLanguages = Array.isArray(activity?.languages) && activity!.languages!.length > 0;
  const certs = Array.isArray(activity?.certifications) ? activity!.certifications! : [];
  const hasEnglishCert = certs.some((c) => {
    const name = c && typeof c === 'object' ? text((c as Record<string, unknown>).name) : '';
    return /TOEIC|英語|英検|TOEFL|IELTS/i.test(name);
  });
  if (hasLanguages || hasEnglishCert) {
    signals.push({
      key: 'readiness:english',
      value: 60,
      present: true,
      source: 'measured',
      rationale: '語学・英語系の登録あり（レベルは要確認）',
    });
  }

  // 資格・スキル: 資格 or IT スキルの有無。
  const hasCerts = certs.length > 0;
  const hasItSkills = Array.isArray(activity?.itSkills) && activity!.itSkills!.length > 0;
  if (hasCerts || hasItSkills) {
    signals.push({
      key: 'readiness:certifications',
      value: 60,
      present: true,
      source: 'measured',
      rationale: '資格・スキルの登録あり',
    });
  }

  // SPI・プレゼンは就活版 MVP ではデータ源が無い → 欠損（present:false）。
  signals.push({
    key: 'readiness:spi',
    value: 0,
    present: false,
    source: 'absent',
    rationale: 'SPI・適性検査のデータが未取得',
  });
  signals.push({
    key: 'readiness:presentation',
    value: 0,
    present: false,
    source: 'absent',
    rationale: 'プレゼンのデータが未取得',
  });

  return signals;
}

// measured-first マージ: measured を優先し、AI の readiness は measured に無いキーだけ採用する。
// （AI 推測で measured を上書きしない。）
export function mergeReadinessSignals(
  measured: MeasuredReadinessSignal[],
  aiSignals: ScoreSignal[],
): ScoreSignal[] {
  const byKey = new Map<string, ScoreSignal>();
  for (const s of measured) byKey.set(s.key, s);
  for (const s of aiSignals) {
    if (s.key.startsWith('readiness:') && !byKey.has(s.key)) byKey.set(s.key, s);
  }
  return Array.from(byKey.values());
}
