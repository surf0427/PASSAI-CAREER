// PASSAI CAREER — consultation 用の機能横断（cross-feature）context renderer（P15-D）。
//
// 背景（P15-D）:
//   相談AI（司令塔）の「Personal Memory / Source Data 由来の横断ブロック（自己分析 / ES / 面接 /
//   プレゼン / 企業研究 / GD / GDルーム / マッチング）」の組み立ては、これまで
//   app/api/career/consultation/route.ts の POST 内に手組みされていた。P15-D で Context Orchestrator を
//   単一の注入口へ整流するため、その組み立てを **byte-identical のまま** canonical renderer として
//   本モジュールへ移設し、orchestrator（purpose=consultation）から呼ぶ。
//
// ★ Event Signal 境界（絶対厳守 / P15-D）:
//   本モジュールは **Career Event Signal に一切関与しない**。Event Signal の reader / guard / renderer /
//   pilot flag / block 挿入は route 側に現行位置のまま残す。本ファイルは Event Signal 関連 module を
//   一切 import しない（isolation QA が静的に検証する）。ここで扱うのは Personal Memory / Source Data 由来の
//   横断情報のみ。
//
// 厳守:
//   - pure function / deterministic / environment 非依存 / external API 非依存 / storage 非依存 /
//     Event Signal 非依存 / feature flag 非依存。
//   - missing input で throw しない（null/undefined / 空配列安全）。
//   - 既存 route の各ブロック出力 byte を **1 byte も**変えない（見出し・順序・cap・omission・
//     latest 選択規則すべて維持）。Consultation 固有 contract（自己分析の向いている業界/企業選びの条件、
//     面接の deepDiveTopics/nextActions 等）を維持し presentation/interview/es の renderer へは寄せない。
//     → 常設 byte parity harness: scripts/career-consultation-orchestrator-parity-qa.ts。
//   - 履歴フォーマッタ（format*HistoryForPrompt）・GD/マッチングフォーマッタ・企業研究 canonical formatter は
//     既存の canonical 実装を再利用する（重複実装を作らない）。

import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerInterviewFinalResult } from '@/types/careerInterview';
import type { CareerPresentationFinalResult } from '@/types/careerPresentation';
import type { CompanyResearchSnapshot } from '@/types/careerCompanyResearch';
import { formatCompanyResearchContextForPrompt } from '@/lib/careerCompanyResearch/context';
import {
  formatGdConsultationForPrompt,
  formatGdRoomSignalsForConsultation,
  type GdConsultationSnapshot,
  type GdRoomSignalSnapshot,
} from '@/lib/careerGd/context';
import {
  formatMatchingConsultationForPrompt,
  type MatchingConsultationSnapshot,
} from '@/lib/careerMatching/consultationContext';
import {
  formatSelfAnalysisHistoryForPrompt,
  formatEsHistoryForPrompt,
  formatInterviewHistoryForPrompt,
  formatPresentationHistoryForPrompt,
  type SelfAnalysisHistorySnapshot,
  type EsHistorySnapshot,
  type InterviewHistorySnapshot,
  type PresentationHistorySnapshot,
} from '@/lib/careerConsultation/historySnapshots';
import { str } from '@/lib/careerMemory/summaryUtils';

// 直近の自己分析を可読テキストに整形（route renderSelfAnalysis と byte 一致）。
function renderSelfAnalysis(r: CareerSelfAnalysisResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.summary)) lines.push(`- 全体所感: ${str(r.summary)}`);
  // v2 構造化フィールド（旧ログには無いので ?. で防御）。司令塔が方向性・企業選びを踏まえられるよう軽く反映。
  if (str(r.careerDirection)) lines.push(`- キャリアの方向性: ${str(r.careerDirection)}`);
  if (r.strengths?.length) lines.push(`- 強み: ${r.strengths.join('、')}`);
  if (r.weaknesses?.length) lines.push(`- 弱み: ${r.weaknesses.join('、')}`);
  if (r.recommendedIndustries?.length) lines.push(`- 向いている業界: ${r.recommendedIndustries.join('、')}`);
  if (r.companySelectionCriteria?.length) lines.push(`- 企業選びの条件: ${r.companySelectionCriteria.join('、')}`);
  if (r.gakuchikaIdeas?.length) lines.push(`- ガクチカ候補: ${r.gakuchikaIdeas.join('、')}`);
  return lines.join('\n');
}

// 直近の ES を可読テキストに整形（route renderEs と byte 一致）。
function renderEs(r: CareerEsResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.headline)) lines.push(`- キャッチコピー: ${str(r.headline)}`);
  if (str(r.gakuchika)) lines.push(`- ガクチカ: ${str(r.gakuchika)}`);
  if (str(r.selfPr)) lines.push(`- 自己PR: ${str(r.selfPr)}`);
  if (str(r.motivation)) lines.push(`- 志望動機: ${str(r.motivation)}`);
  return lines.join('\n');
}

// 直近の面接結果を可読テキストに整形（route renderInterview と byte 一致）。
function renderInterview(r: CareerInterviewFinalResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.overallComment)) lines.push(`- 総合評価: ${str(r.overallComment)}`);
  if (r.strengths?.length) lines.push(`- 良かった点: ${r.strengths.join('、')}`);
  if (r.improvements?.length) lines.push(`- 改善点: ${r.improvements.join('、')}`);
  if (r.deepDiveTopics?.length)
    lines.push(`- さらに深掘りされそうな論点: ${r.deepDiveTopics.join('、')}`);
  if (r.nextActions?.length)
    lines.push(`- 次にやるべきこと: ${r.nextActions.join('、')}`);
  if (str(r.companyFit)) lines.push(`- 想定企業との相性: ${str(r.companyFit)}`);
  return lines.join('\n');
}

// 直近のプレゼン練習結果を可読テキストに整形（route renderPresentation と byte 一致）。
function renderPresentation(r: CareerPresentationFinalResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (typeof r.totalScore === 'number' && r.rank) {
    lines.push(`- 総合: ${r.totalScore}点（${r.rank}ランク）`);
  }
  if (str(r.overallComment)) lines.push(`- 総評: ${str(r.overallComment)}`);
  if (r.goodPoints?.length) lines.push(`- 良かった点: ${r.goodPoints.join('、')}`);
  if (r.improvements?.length) lines.push(`- 改善点: ${r.improvements.join('、')}`);
  if (r.priorityImprovements?.length)
    lines.push(`- 優先改善: ${r.priorityImprovements.join('、')}`);
  if (r.nextPractice?.length) lines.push(`- 次の練習: ${r.nextPractice.join('、')}`);
  if (r.expectedQuestions?.length)
    lines.push(`- 想定質問: ${r.expectedQuestions.join('、')}`);
  if (str(r.passLikelihood)) lines.push(`- 選考通過可能性: ${str(r.passLikelihood)}`);
  if (str(r.companyFit)) lines.push(`- 企業/職種との相性: ${str(r.companyFit)}`);
  return lines.join('\n');
}

// 保存済み企業研究（複数）を相談AI用の指示ブロックに整形（route renderCompanyResearch と byte 一致）。
function renderCompanyResearch(snapshots: CompanyResearchSnapshot[]): string {
  const formatted = formatCompanyResearchContextForPrompt(snapshots);
  if (!formatted) return '';
  return [
    '# 保存済みの企業研究（ユーザー本人が作成・確認したもの）',
    formatted,
    '',
    '企業について聞かれたら（例:「この企業どう思う？」「A社とB社どっちが合う？」「志望動機どう作る？」',
    '「企業研究で足りないところある？」）、この保存済み企業研究を根拠に答えてください。',
    '- 「保存済みの企業研究を見る限り」「あなたのメモでは」「PASSAI上に保存されている情報では」という文体にする。',
    '- 保存されていない企業情報を断定せず、AIが勝手に最新の企業情報を生成しない。',
    '- 根拠なく「この会社は合う/合わない」と断定しない。不足情報・自己分析/活動整理/就活軸とのギャップ・',
    '  ES/面接で使える観点を示し、「断定はできませんが追加確認すべき点は」と公式情報・説明会資料での確認を促す。',
  ].join('\n');
}

// consultation の Personal Memory 由来 cross-feature snapshot（orchestrator が受け取る型安全な入力）。
//   ★ Event Signal / feature flag / raw career events は含めない（Event Signal は route 側で独立処理）。
//   各フィールドは route が body から正規化した typed 値（latest 単件 + history 配列 + 各スナップショット群）。
export type ConsultationCrossFeatureInput = {
  // 旧クライアント互換（最新1件）。
  selfAnalysis?: CareerSelfAnalysisResult | null;
  es?: CareerEsResult | null;
  interviewResult?: CareerInterviewFinalResult | null;
  presentationResult?: CareerPresentationFinalResult | null;
  // 新クライアント（最新3件までの推移スナップショット・正規化済み）。
  selfAnalysisHistory: SelfAnalysisHistorySnapshot[];
  esHistory: EsHistorySnapshot[];
  interviewHistory: InterviewHistorySnapshot[];
  presentationHistory: PresentationHistorySnapshot[];
  // 正規化済みスナップショット群。
  companyResearch: CompanyResearchSnapshot[];
  gd: GdConsultationSnapshot[];
  gdRoom: GdRoomSignalSnapshot[];
  matching: MatchingConsultationSnapshot[];
};

// 相談AIの Personal Memory 由来 cross-feature block を決定的に組み立てる（旧 route の
//   history-vs-latest 分岐 + 見出し + 各ブロックを byte-identical に再現）。
//   base career system prompt・司令塔 persona・Event Signal block・出力形式は含まない
//   （route/builder が base とこの block の前後に、Event Signal を現行位置で結合する）。
// 各 block の算出（build と presence 判定の **単一実装**。ここを分けると dedupe が prompt と乖離する）。
function computeConsultationBlocks(input: ConsultationCrossFeatureInput): {
  selfAnalysisBlock: string;
  esBlock: string;
  interviewBlock: string;
  presentationBlock: string;
  companyResearchBlock: string;
  gdBlock: string;
  gdRoomBlock: string;
  matchingBlock: string;
} {
  // history があれば推移ブロック（見出し込み）、無ければ旧「最新1件」ブロック（見出しを付ける）。
  const withHeader = (header: string, body: string) => (body ? `${header}\n${body}` : '');
  return {
    selfAnalysisBlock: input.selfAnalysisHistory.length
      ? formatSelfAnalysisHistoryForPrompt(input.selfAnalysisHistory)
      : withHeader('# 直近の自己分析結果', renderSelfAnalysis(input.selfAnalysis)),
    esBlock: input.esHistory.length
      ? formatEsHistoryForPrompt(input.esHistory)
      : withHeader('# 直近の ES ドラフト', renderEs(input.es)),
    interviewBlock: input.interviewHistory.length
      ? formatInterviewHistoryForPrompt(input.interviewHistory)
      : withHeader('# 直近の面接練習の結果', renderInterview(input.interviewResult)),
    presentationBlock: input.presentationHistory.length
      ? formatPresentationHistoryForPrompt(input.presentationHistory)
      : withHeader('# 直近のプレゼン練習の結果', renderPresentation(input.presentationResult)),
    companyResearchBlock: renderCompanyResearch(input.companyResearch),
    gdBlock: formatGdConsultationForPrompt(input.gd),
    gdRoomBlock: formatGdRoomSignalsForConsultation(input.gdRoom),
    matchingBlock: formatMatchingConsultationForPrompt(input.matching),
  };
}

export function buildConsultationCrossFeatureContext(input: ConsultationCrossFeatureInput): string {
  const b = computeConsultationBlocks(input);
  return [
    b.selfAnalysisBlock,
    b.esBlock,
    b.interviewBlock,
    b.presentationBlock,
    b.companyResearchBlock,
    b.gdBlock,
    b.gdRoomBlock,
    b.matchingBlock,
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}

/**
 * Personal Memory dedupe 用の bridge presence（純関数）。
 *
 * ★ 判定は「body に field があるか」ではなく **「その block を実際に描画するか」**
 *   （＝上の build と同一実装の出力が空でないか）。bridge wins / memory fills gaps。
 *
 * - base          : 常に true。base system prompt（buildCareerSystemPrompt）が
 *                   profile / activity / values を必ず描画するため、Memory の base は常に重複する。
 * - self_analysis : 自己分析 block（推移 or 最新1件）を描画するとき true。
 * - es            : ES block を描画するとき true。
 * - interview     : 面接 block を描画するとき true。
 *
 * 戻り値は `BridgeContextPresence`（lib/careerMemory/personalMemoryDedupe）へ構造的に代入できる。
 * ★ 型 import はしない（renderer から persistence 系への依存を増やさないための既存方針）。
 */
export function consultationBridgePresence(input: ConsultationCrossFeatureInput): {
  base: true;
  self_analysis: boolean;
  es: boolean;
  interview: boolean;
} {
  const b = computeConsultationBlocks(input);
  return {
    base: true,
    self_analysis: b.selfAnalysisBlock !== '',
    es: b.esBlock !== '',
    interview: b.interviewBlock !== '',
  };
}
