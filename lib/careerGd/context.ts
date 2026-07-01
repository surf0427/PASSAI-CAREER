// PASSAI 就活版 — GD 結果を他機能（careerMatching / 相談AI / 面接 / ES / 自己分析）へ
// 渡すための共通整形ヘルパー（純粋関数）。
//
// 役割: GD 完了結果（CareerGdResult）から、他機能が参照しやすい軽量スナップショットと、
//       プロンプトへ注入しやすいテキストを作る。
//   - DOM / localStorage / Supabase には触れない純粋関数のみ（client / server 双方から使う）。
//   - 実際の localStorage 読み出しは呼び出し側が `loadGdResults()`（app/career/gd/gdStorage）で行い、
//     その結果を本モジュールに渡す（既存 careerCompanyResearch/context.ts と同じ分離方針）。
//
// 使用例（他機能側 / client）:
//   import { loadGdResults } from '@/app/career/gd/gdStorage';
//   import { buildGdMatchingSnapshot, formatGdMatchingForPrompt } from '@/lib/careerGd/context';
//   const snap = buildGdMatchingSnapshot(loadGdResults()[0]);          // 最新のGD結果
//   const block = formatGdMatchingForPrompt(snap);                     // プロンプトに差し込む

import {
  GD_BEHAVIOR_TRAIT_LABELS,
  GD_GRADE_LABELS,
} from '@/app/career/gd/gdRoles';
import type {
  CareerGdResult,
  GdBehaviorTrait,
  GdCompanyGrade,
} from '@/types/careerGd';

// 他機能へ渡す最小スナップショット（matchingHints を中心に、参照元も辿れる形）。
export type GdMatchingSnapshot = {
  resultId: string;
  createdAt: string;
  themeTitle: string;
  companyGrade: GdCompanyGrade;
  behaviorTraits: GdBehaviorTrait[];
  strengthKeywords: string[];
  suggestedEnvironments: string[];
  summary: string;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// GD 結果 1 件 → matching 連携スナップショット。null / 欠損に耐える。
export function buildGdMatchingSnapshot(
  result: CareerGdResult | null | undefined,
): GdMatchingSnapshot | null {
  if (!result || typeof result !== 'object' || typeof result.id !== 'string') return null;
  const mh = result.matchingHints;
  return {
    resultId: result.id,
    createdAt: str(result.createdAt),
    themeTitle: str(result.theme?.title),
    companyGrade: mh?.companyGrade ?? result.selfCompanyGrade ?? 'B',
    behaviorTraits: Array.isArray(mh?.behaviorTraits) ? mh.behaviorTraits : [],
    strengthKeywords: Array.isArray(mh?.strengthKeywords) ? mh.strengthKeywords : [],
    suggestedEnvironments: Array.isArray(mh?.suggestedEnvironments)
      ? mh.suggestedEnvironments
      : [],
    summary: str(mh?.summary),
  };
}

// 複数の GD 結果 → 最新 1 件のスナップショット（最新更新順を想定して先頭を採用）。
export function buildLatestGdMatchingSnapshot(
  results: CareerGdResult[] | null | undefined,
): GdMatchingSnapshot | null {
  if (!results || results.length === 0) return null;
  return buildGdMatchingSnapshot(results[0]);
}

// 行動特性キー配列 → 日本語ラベル配列。
export function gdBehaviorTraitLabels(traits: GdBehaviorTrait[]): string[] {
  return traits.map((t) => GD_BEHAVIOR_TRAIT_LABELS[t]).filter(Boolean);
}

// スナップショット → プロンプト用テキストブロック。空なら空文字。
// careerMatching / 相談AI / 面接 などの system/user プロンプトに差し込む用途。
export function formatGdMatchingForPrompt(
  snapshot: GdMatchingSnapshot | null | undefined,
): string {
  if (!snapshot) return '';
  const lines: string[] = ['【GD（グループディスカッション）で見えた特性（本人の練習結果より）】'];
  if (snapshot.themeTitle) lines.push(`直近のテーマ: ${snapshot.themeTitle}`);
  lines.push(
    `企業選考目線の評価: ${snapshot.companyGrade}（${GD_GRADE_LABELS[snapshot.companyGrade]}）`,
  );
  const traitLabels = gdBehaviorTraitLabels(snapshot.behaviorTraits);
  if (traitLabels.length > 0) lines.push(`行動特性: ${traitLabels.join('、')}`);
  if (snapshot.strengthKeywords.length > 0) {
    lines.push(`GDで顕在化した強み: ${snapshot.strengthKeywords.join('、')}`);
  }
  if (snapshot.suggestedEnvironments.length > 0) {
    lines.push(`向いてそうな環境・役割: ${snapshot.suggestedEnvironments.join('、')}`);
  }
  if (snapshot.summary) lines.push(`要約: ${snapshot.summary}`);
  lines.push(
    '',
    '注意: これは1回の練習結果であり、断定材料にはしない。他データと合わせて参考程度に扱う。',
  );
  return lines.join('\n');
}
