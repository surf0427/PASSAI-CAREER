// PASSAI CAREER — es_generation 用の機能横断（cross-feature）context renderer（P15-C）。
//
// 背景（P15-C）:
//   ES 生成の「他 PASSAI 機能データ（自己分析）」の render は、これまで app/api/career/es/route.ts 内に
//   route-local 関数として手組みされていた。P15-C で Context Orchestrator を単一の注入口へ整流するため、
//   その render を **byte-identical のまま** canonical renderer として本モジュールへ移設し、
//   orchestrator（purpose=es_generation）から呼ぶ。
//
// スコープ（P15-C 厳守）:
//   - ES 生成で route-local に手組みされている cross-feature memory renderer は自己分析のみ。
//     企業研究は既に canonical 化済みの formatCompanyResearchContextForPrompt を route が使うため対象外
//     （企業研究ブロックは ES 生成固有の指示 wrapper を伴い route-local のまま＝位置・contract 不変）。
//   - es_review は別 route（静的 SYSTEM_PROMPT）で本層を通らないため一切非関与。
//
// 厳守:
//   - pure function / deterministic / environment 非依存 / external API 非依存 / storage 非依存。
//   - missing input で throw しない（null/undefined 安全）。
//   - 既存 es/route.ts の renderSelfAnalysis 出力 byte を **1 byte も**変えない
//     （見出し・順序・cap・omission すべて維持）。ES 固有 field（強みキーワード / 価値観キーワード /
//     ESで使える切り口）を含む点で presentation / interview の自己分析 renderer とは別 contract。
//     → 常設 byte parity harness: scripts/career-es-orchestrator-parity-qa.ts。

import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';

// 直近の自己分析結果を system prompt 用の可読テキストに整形（es/route.ts renderSelfAnalysis と byte 一致）。
//   未提供（自己分析未実行）なら空文字を返し、prompt 側で section を出さない。
export function renderSelfAnalysis(result: CareerSelfAnalysisResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  // v2 フィールドは旧ログで undefined になり得るため、空・非文字列は無視して防御する。
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  const pushList = (label: string, values: string[] | undefined) => {
    if (values && values.length > 0) lines.push(`- ${label}: ${values.join('、')}`);
  };
  push('全体所感', result.summary);
  push('キャリアの方向性', result.careerDirection);
  pushList('強み', result.strengths);
  pushList('強みキーワード', result.strengthKeywords);
  pushList('価値観キーワード', result.valueKeywords);
  pushList('弱み', result.weaknesses);
  pushList('ガクチカ候補', result.gakuchikaIdeas);
  pushList('自己PR候補', result.selfPrIdeas);
  pushList('ESで使える切り口', result.esAngles);
  return lines.length > 0 ? lines.join('\n') : '';
}

// es_generation の cross-feature snapshot（orchestrator が受け取る型安全な入力）。
//   ES 生成の route-local cross-feature memory は自己分析のみ（企業研究は route 側の canonical 経路）。
export type EsGenerationCrossFeatureInput = {
  selfAnalysis?: CareerSelfAnalysisResult | null;
};

// ES 生成の機能横断 context block を決定的に組み立てる（旧 route の自己分析ブロックを byte-identical に再現）。
//   base career system prompt・企業ブロック・設問・出力形式は含まない（route が base とこの block の
//   前後に結合する。挿入位置は researchBlock と questionBlock の間で不変）。
export function buildEsGenerationCrossFeatureContext(input: EsGenerationCrossFeatureInput): string {
  const selfAnalysisBlock = renderSelfAnalysis(input.selfAnalysis);
  return [selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '']
    .filter((s) => s !== '')
    .join('\n\n');
}
