/**
 * Safe renderer — safe artifact → user-facing / AI-safe な語彙化文（P14-B / P14-A §Safe renderer）。
 *
 * production UI / AI へは接続しない。pure function として、将来 consumer が使う「安全な言語化」の
 * 契約だけを固定する。
 *
 * 原則:
 *   - valid のみ一般傾向文を出す。suppressed / zero は数値を出さず neutral 文言。missing(null) は render しない。
 *   - 生の numerator / denominator / exact prevalence を文へ出さない（多い/やや多い等の粗い語彙）。
 *   - 非因果・非評価 disclaimer を **必ず**付ける。
 *   - 禁止表現（遅れ・不足・能力・合否・属性適性・比較）を生成しない。
 */

import {
  AGGREGATE_DISCLAIMER,
  INSUFFICIENT_DATA_MESSAGE,
  PROHIBITED_RENDER_PHRASES,
} from './policy';
import { artifactHasPublicNumbers } from './artifact';
import type {
  AiSafeAggregateContext,
  SafeAggregateArtifact,
  SafeRenderedAggregate,
  ValidAggregateArtifact,
} from '@/types/careerAggregate';

// feature → 固定日本語ラベル（timeline / event signal renderer と同じ語彙）。
const FEATURE_LABELS: Record<string, string> = {
  matching: 'マッチング',
  consultation: '相談AI',
  interview: '面接練習',
  es: 'ES作成',
  presentation: 'プレゼン練習',
  company_research: '企業研究',
  self_analysis: '自己分析',
  gd: 'グループディスカッション',
  profile: '基本情報',
  activity: '活動整理',
  values: '就活軸',
};

function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? '一部の準備';
}

// prevalence → 粗い頻度語彙（exact 値・順位を出さない）。
function prevalenceWording(prevalence: number): string {
  if (prevalence >= 0.5) return '比較的多い';
  if (prevalence >= 0.2) return '一定数いる';
  return '一部にみられる';
}

/** defensive: 出力文に禁止表現が含まれないことを保証（含まれれば neutral へ倒す）。 */
function isCleanWording(text: string): boolean {
  return !PROHIBITED_RENDER_PHRASES.some((bad) => text.includes(bad));
}

function neutral(kind: SafeAggregateArtifact['kind']): SafeRenderedAggregate {
  return { text: INSUFFICIENT_DATA_MESSAGE, disclaimer: AGGREGATE_DISCLAIMER, kind };
}

/**
 * safe artifact を user-facing の一般傾向文へ変換する（pure）。
 *   - null / undefined（missing）→ null（render しない・negative evidence にしない）
 *   - suppressed / zero → neutral 文言（数値なし）
 *   - valid → 一般傾向文 + disclaimer
 */
export function renderSafeAggregate(
  artifact: SafeAggregateArtifact | null | undefined,
): SafeRenderedAggregate | null {
  if (!artifact || typeof artifact !== 'object') return null; // missing → 何も出さない
  if (!artifactHasPublicNumbers(artifact)) return neutral(artifact.kind);

  const valid = artifact as ValidAggregateArtifact;
  const label = featureLabel(valid.feature);
  const wording = prevalenceWording(valid.prevalence);
  const text = `この時期には、${label}に取り組む利用者が${wording}傾向があります。`;

  // 防御的: 万一禁止表現が混じったら neutral へ。
  if (!isCleanWording(text)) return neutral('valid');

  return { text, disclaimer: AGGREGATE_DISCLAIMER, kind: 'valid' };
}

/**
 * AI へ渡してよい最小 context を作る（今回 AI へは接続しない）。
 *   valid かつ十分な cohort（valid=denominator>=threshold）でのみ生成。それ以外は null。
 */
export function buildAiSafeAggregateContext(
  artifact: SafeAggregateArtifact | null | undefined,
): AiSafeAggregateContext | null {
  if (!artifact || !artifactHasPublicNumbers(artifact)) return null;
  const valid = artifact as ValidAggregateArtifact;
  const label = featureLabel(valid.feature);
  const cohortDescription =
    valid.cohortType === 'all' ? '就活生全体' : `卒年 ${valid.cohortValue} の就活生`;
  return {
    metricDescription: `${label}に取り組む利用者の割合（一般的傾向）`,
    cohortDescription,
    coarseTimeWindow: valid.timeBucket,
    sufficientCohort: true,
    sampleSizeBucket: valid.sampleSizeBucket,
    nonCausalDisclaimer: '利用傾向であり、行動と選考結果の因果を示すものではありません。',
    nonEvaluativeDisclaimer: '個人の能力・準備度・適性・合否の評価には使用できません。',
    calculationVersion: valid.calculationVersion,
  };
}
