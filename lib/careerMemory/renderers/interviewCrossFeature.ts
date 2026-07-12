// PASSAI CAREER — interview_practice 用の機能横断（cross-feature）context renderer（P15-B）。
//
// 背景（P15-B）:
//   面接評価の「他 PASSAI 機能データ（自己分析 / ES / マッチング / 相談AI / 企業研究）」の render は
//   これまで app/api/career/interview/interviewPrompt.ts 内に builder-local 関数として手組みされていた。
//   P15-B で Context Orchestrator を単一の注入口へ整流するため、その render を **byte-identical のまま**
//   canonical renderer として本モジュールへ移設し、orchestrator（purpose=interview_practice）から呼ぶ。
//
// 厳守:
//   - pure function / deterministic / environment 非依存 / external API 非依存 / storage 非依存。
//   - missing input で throw しない（null/undefined 安全）。
//   - 既存 interviewPrompt.ts の出力 byte を **1 byte も**変えない
//     （見出し・順序・空行・omission・cap・PII policy すべて維持）。
//     → 常設 byte parity harness: scripts/career-interview-orchestrator-parity-qa.ts。
//
// Interview 固有 contract（Presentation とは別実装で維持する理由）:
//   - renderSelfAnalysis は「今後伸ばすべき点（developmentPoints）」を含む（presentation は含まない）。
//   - renderEs は full CareerEsResult を **cap なし**で 4 field render（presentation は cap 済み strict summary）。
//   - renderMatching は「今後の伸ばしどころ（developmentAreas, max4）」を含む（presentation は含まない）。
//   → 出力 contract が異なるため presentation の canonical renderer へは寄せない（P15-B スコープ厳守）。
//   企業研究ブロックは既に canonical 化済みの formatInterviewCompanyResearchForPrompt を再利用する。

import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import {
  type InterviewCompanyResearchContext,
  formatInterviewCompanyResearchForPrompt,
} from '@/lib/careerCompanyResearch/context';

// 直近の自己分析結果を可読テキストに整形（interviewPrompt.ts renderSelfAnalysis と byte 一致）。
export function renderSelfAnalysis(result: CareerSelfAnalysisResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  // v2 フィールドは旧ログで undefined になり得るため、空・非配列は無視して防御する。
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  const pushList = (label: string, values: string[] | undefined) => {
    if (values && values.length > 0) lines.push(`- ${label}: ${values.join('、')}`);
  };
  push('全体所感', result.summary);
  push('キャリアの方向性', result.careerDirection);
  pushList('強み', result.strengths);
  pushList('弱み', result.weaknesses);
  pushList('今後伸ばすべき点', result.developmentPoints);
  pushList('ガクチカ候補', result.gakuchikaIdeas);
  pushList('自己PR候補', result.selfPrIdeas);
  return lines.join('\n');
}

// 直近の ES 結果を可読テキストに整形（interviewPrompt.ts renderEs と byte 一致）。
export function renderEs(result: CareerEsResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  const push = (label: string, value: string) => {
    if (value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  push('キャッチコピー', result.headline);
  push('ガクチカ', result.gakuchika);
  push('自己PR', result.selfPr);
  push('志望動機', result.motivation);
  return lines.join('\n');
}

// 就活マッチング結果を可読テキストに整形（interviewPrompt.ts renderMatching と byte 一致）。
export function renderMatching(result: CareerMatchEngineResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  const pushList = (label: string, values: string[] | undefined, max: number) => {
    if (values && values.length > 0) {
      lines.push(`- ${label}: ${values.slice(0, max).join('、')}`);
    }
  };
  push('適性タイプ', result.careerType);
  pushList('相性の良い業界', result.recommendedIndustries, 5);
  pushList('相性の良い職種', result.recommendedJobs, 5);
  pushList('今後の伸ばしどころ', result.developmentAreas, 4);
  return lines.join('\n');
}

// 相談AIでの最近の気づきを可読テキストに整形（interviewPrompt.ts renderConsultationInsights と byte 一致）。
export function renderConsultationInsights(insights: string[] | null | undefined): string {
  if (!insights || insights.length === 0) return '';
  return insights
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .slice(0, 5)
    .map((s) => `- ${s}`)
    .join('\n');
}

// interview_practice の cross-feature snapshot（orchestrator が受け取る型安全な入力）。
//   presentation と異なり useCareerContext gate は無い（データがあれば常に render）。
export type InterviewCrossFeatureInput = {
  selfAnalysis?: CareerSelfAnalysisResult | null;
  es?: CareerEsResult | null;
  matching?: CareerMatchEngineResult | null;
  consultationInsights?: string[] | null;
  companyResearch?: InterviewCompanyResearchContext | null;
};

// 面接評価の機能横断 context block を決定的に組み立てる（旧 buildInterviewBaseSystem の
//   横断ブロック部分を byte-identical に再現）。base career system prompt・target block・
//   面接の狙い/深掘り観点は含まない（builder 側で base とこの block の前後に結合する）。
export function buildInterviewCrossFeatureContext(input: InterviewCrossFeatureInput): string {
  const selfAnalysisBlock = renderSelfAnalysis(input.selfAnalysis);
  const esBlock = renderEs(input.es);
  const matchingBlock = renderMatching(input.matching);
  const consultationBlock = renderConsultationInsights(input.consultationInsights);
  // 企業研究ログが選択されているときのみブロックを出す（未選択なら空文字）。
  const companyResearchBlock = formatInterviewCompanyResearchForPrompt(input.companyResearch);

  return [
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    esBlock ? `# 直近の ES ドラフト\n${esBlock}` : '',
    matchingBlock ? `# 就活マッチング結果（参考・断定しない）\n${matchingBlock}` : '',
    consultationBlock ? `# 相談AIでの最近の気づき（参考程度）\n${consultationBlock}` : '',
    companyResearchBlock,
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}
