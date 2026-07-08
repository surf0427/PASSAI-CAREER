// PASSAI CAREER 活動整理（18 セクション）を prompt 向けに圧縮整形する（P2-A で導入）。
//
// 背景: 活動整理は 18 セクション × 複数カード × 長文 field を無圧縮で dump しやすく、
//   ES / interview / presentation / self-analysis / matching / consultation / company-research
//   の入力トークン肥大・timeout 要因になっていた（全て buildCareerSystemPrompt→renderActivity 経由）。
//
// 設計（出力互換を最優先）:
//   - 入力は既に string[] に正規化済みの CareerActivityContext（1 カード = 1 行）。
//     本 formatter は「AI へ渡す文字列」だけを圧縮する。localStorage / Supabase / 型は不変。
//   - **上限に収まるデータでは現行 renderActivity と完全に同一出力**（section 順・ラベル・
//     "■/  - " 形式・空セクション除去・未入力 fallback を厳密に踏襲）。
//     → 既存の大多数ユーザーでは AI 挙動・prompt cache に影響しない。
//   - 上限を超える power user / 長文貼り付けのみ、field 文字数・カード件数・セクション数・
//     全体文字数で圧縮し、省略は件数を明示する（AI が「これで全部」と誤読しないように）。
//   - AI 再要約はしない（本文代筆・drift 防止。決定論的な trim のみ）。

import type { CareerActivityContext } from '@/lib/careerAi/types';
import { truncateText } from './text';

// 上限（現行データ量と prompt 量から設定）。majority（各セクション ≤3 カード・
// 各 field ≤160 字・非空セクション ≤12・全体 ≤3500 字）は現行と同一出力になる。
export const CAREER_ACTIVITY_LIMITS = {
  maxSections: 12,
  maxCardsPerSection: 3,
  maxFieldChars: 160,
  maxTotalChars: 3500,
} as const;

export type CareerActivityFormatLimits = typeof CAREER_ACTIVITY_LIMITS;

// 未入力時の fallback（現行 renderActivity と同一文字列）。
const EMPTY_FALLBACK = '- （活動・経験は未入力）';

// section 定義。順序・ラベルは現行 renderActivity と厳密一致させる（出力互換のため）。
const SECTION_DEFS: ReadonlyArray<readonly [label: string, key: keyof CareerActivityContext]> = [
  ['MBTI・性格', 'personality'],
  ['学業・学生時代の活動', 'academics'],
  ['学生時代に力を入れたこと（ガクチカ）', 'focusedActivities'],
  ['アルバイト', 'partTimeJobs'],
  ['インターン', 'internships'],
  ['サークル・部活動', 'clubActivities'],
  ['プロジェクト経験', 'projects'],
  ['リーダー経験', 'leadership'],
  ['ボランティア・社会活動', 'volunteer'],
  ['海外経験', 'overseas'],
  ['資格', 'certifications'],
  ['ITスキル', 'itSkills'],
  ['語学', 'languages'],
  ['趣味・特技', 'hobbies'],
  ['表彰・実績', 'awards'],
  ['SNS・情報発信', 'snsActivities'],
  ['ポートフォリオ・制作物', 'portfolios'],
  ['人生経験', 'lifeExperiences'],
  ['その他', 'others'],
];

// 1 カード行（"label: v / label: v ..."）内の各 field を上限で切る。
// ' / ' 区切りは context.ts の joinFields と対称のため、上限内なら split→truncate→join は可逆
//（＝現行と同一文字列）。上限を超える field だけが末尾省略される。
function truncateCardLine(line: string, maxFieldChars: number): string {
  return line
    .split(' / ')
    .map((field) => truncateText(field, maxFieldChars))
    .join(' / ');
}

/**
 * CareerActivityContext を system prompt 用の可読テキストへ圧縮整形する。
 * 上限内なら現行 renderActivity と同一出力。超過分のみ決定論的に圧縮する。
 */
export function formatCareerActivityForPrompt(
  activity: CareerActivityContext,
  limits: CareerActivityFormatLimits = CAREER_ACTIVITY_LIMITS,
): string {
  const nonEmpty = SECTION_DEFS
    .map(([label, key]) => [label, activity[key]] as const)
    .filter(([, lines]) => Array.isArray(lines) && lines.length > 0);

  if (nonEmpty.length === 0) return EMPTY_FALLBACK;

  const blocks: string[] = [];
  let omittedSections = 0;

  for (let i = 0; i < nonEmpty.length; i++) {
    if (blocks.length >= limits.maxSections) {
      omittedSections = nonEmpty.length - i;
      break;
    }
    const [label, lines] = nonEmpty[i];
    const shown = lines.slice(0, limits.maxCardsPerSection);
    const renderedLines = shown.map((l) => `  - ${truncateCardLine(l, limits.maxFieldChars)}`);
    if (lines.length > shown.length) {
      renderedLines.push(`  - （ほか ${lines.length - shown.length} 件省略）`);
    }
    blocks.push(`■ ${label}\n${renderedLines.join('\n')}`);
  }

  let out = blocks.join('\n');
  if (omittedSections > 0) {
    out += `\n■ （ほか ${omittedSections} セクション省略）`;
  }

  // 最終安全網: 上記の構造的上限をすり抜けても全体文字数を必ず bound する（超過分のみ）。
  if (out.length > limits.maxTotalChars) {
    out = out.slice(0, limits.maxTotalChars).trimEnd() + '\n…（活動情報が長いため一部省略）';
  }
  return out;
}
