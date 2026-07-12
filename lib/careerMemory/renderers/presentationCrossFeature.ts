// PASSAI CAREER — presentation_feedback 用の機能横断（cross-feature）context renderer（P15-A）。
//
// 背景（P15-A）:
//   プレゼン評価の「他 PASSAI 機能データ（自己分析 / ES / 面接 / マッチング / 相談AI）」の render は
//   これまで app/api/career/presentation/presentationPrompt.ts 内に route-local 関数として手組みされていた。
//   P15-A で Context Orchestrator を単一の注入口へ整流するため、その render を **byte-identical のまま**
//   canonical renderer として本モジュールへ移設し、orchestrator（purpose=presentation_feedback）から呼ぶ。
//
// 厳守:
//   - pure function / deterministic / environment 非依存 / external API 非依存 / storage 非依存。
//   - missing input で throw しない（null/undefined 安全）。
//   - 既存 presentationPrompt.ts の出力 byte を **1 byte も**変えない
//     （見出し・順序・空行・omission・truncate・PII policy すべて維持）。
//     → 常設 byte parity harness: scripts/career-presentation-orchestrator-parity-qa.ts。
//   - presentation 専用。他 route（interview / consultation / matching / company-research）の
//     同名 renderer は contract（cap / 順序 / missing 時挙動）が異なるため統合しない（P15-A スコープ外）。
//
// ES の render のみ既存の presentation-local 実装（lib/careerMemory/presentationEs）を再利用する
//   （P7-F で canonical 化済み。cap 300 / 4 field / gate は本モジュール外で不変）。

import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerInterviewFinalResult } from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import {
  renderPresentationEsSummary,
  type PresentationEsSummary,
} from '@/lib/careerMemory/presentationEs';

// 直近の自己分析結果 → prompt block（presentationPrompt.ts renderSelfAnalysis と byte 一致）。
export function renderSelfAnalysis(result: CareerSelfAnalysisResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
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
  pushList('ガクチカ候補', result.gakuchikaIdeas);
  pushList('自己PR候補', result.selfPrIdeas);
  return lines.join('\n');
}

// 直近のAI面接フィードバック → prompt block（presentationPrompt.ts renderInterview と byte 一致）。
export function renderInterview(result: CareerInterviewFinalResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  if (result.overallComment?.trim()) lines.push(`- 面接の総評: ${result.overallComment.trim()}`);
  if (result.strengths?.length) lines.push(`- 面接での良かった点: ${result.strengths.join('、')}`);
  if (result.improvements?.length) lines.push(`- 面接での改善点: ${result.improvements.join('、')}`);
  return lines.join('\n');
}

// 就活マッチング結果 → prompt block（presentationPrompt.ts renderMatching と byte 一致）。
export function renderMatching(result: CareerMatchEngineResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  if (result.careerType?.trim()) lines.push(`- 適性タイプ: ${result.careerType.trim()}`);
  if (result.recommendedIndustries?.length)
    lines.push(`- 相性の良い業界: ${result.recommendedIndustries.slice(0, 5).join('、')}`);
  if (result.recommendedJobs?.length)
    lines.push(`- 相性の良い職種: ${result.recommendedJobs.slice(0, 5).join('、')}`);
  return lines.join('\n');
}

// 相談AIでの最近の気づき → prompt block（presentationPrompt.ts renderConsultationInsights と byte 一致）。
export function renderConsultationInsights(insights: string[] | null | undefined): string {
  if (!insights || insights.length === 0) return '';
  return insights
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .slice(0, 5)
    .map((s) => `- ${s}`)
    .join('\n');
}

// presentation_feedback の cross-feature snapshot（orchestrator が受け取る型安全な入力）。
//   - useCareerContext gate（config.useCareerContext === true）は呼び出し側で確定した値を渡す。
//   - 各 field は presentation の request context selector が用意した cap 済み summary / 結果。
export type PresentationCrossFeatureInput = {
  useCareerContext: boolean;
  selfAnalysis?: CareerSelfAnalysisResult | null;
  // P7-F: presentation-local strict summary（cap 済み）。full CareerEsResult でも防御的に再 cap される。
  es?: PresentationEsSummary | null;
  interview?: CareerInterviewFinalResult | null;
  matching?: CareerMatchEngineResult | null;
  consultationInsights?: string[] | null;
};

// プレゼン評価の機能横断 context block を決定的に組み立てる（旧 buildPresentationBaseSystem の
//   useCtx 分岐 + refGuard + 見出し付き block を byte-identical に再現）。
//   base career system prompt は含まない（orchestrator が base と別 field で返す）。
export function buildPresentationCrossFeatureContext(input: PresentationCrossFeatureInput): string {
  // 他PASSAI機能データは useCareerContext が true のときだけ「参考程度」に注入する。
  // 既定（false）は注入しない。主役は常に target 文脈・お題・発表内容。
  const useCtx = input.useCareerContext === true;
  const selfAnalysisBlock = useCtx ? renderSelfAnalysis(input.selfAnalysis) : '';
  // P7-F: gate（useCtx）は不変。ON のときだけ summary を render（値は snapshot 時点で cap 済み）。
  const esBlock = useCtx ? renderPresentationEsSummary(input.es) : '';
  const interviewBlock = useCtx ? renderInterview(input.interview) : '';
  const matchingBlock = useCtx ? renderMatching(input.matching) : '';
  const consultationBlock = useCtx ? renderConsultationInsights(input.consultationInsights) : '';

  // 参考データを注入する場合の注意書き（お題への回答度を優先し、発表に無い情報で加減点しない）。
  const refGuard =
    useCtx && (selfAnalysisBlock || esBlock || interviewBlock || matchingBlock || consultationBlock)
      ? [
          '# 参考情報の扱い（重要）',
          '以下の登録済み情報は補助的な参考に留める。発表対象は「お題への回答（発表内容）」であり、登録情報そのものを発表対象として扱わない。',
          '登録情報との整合性より「お題への回答度」を優先し、発表内容に出ていない情報をもとに過度な加点・減点をしない。',
        ].join('\n')
      : '';

  return [
    refGuard,
    selfAnalysisBlock ? `# 参考: 直近の自己分析結果（発表の主役ではない）\n${selfAnalysisBlock}` : '',
    esBlock ? `# 参考: 直近の ES ドラフト（発表の主役ではない）\n${esBlock}` : '',
    interviewBlock ? `# 参考: 直近のAI面接フィードバック\n${interviewBlock}` : '',
    matchingBlock ? `# 参考: 就活マッチング結果（断定しない）\n${matchingBlock}` : '',
    consultationBlock ? `# 参考: 相談AIでの最近の気づき\n${consultationBlock}` : '',
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}
