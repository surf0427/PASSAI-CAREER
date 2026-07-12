/*
 * scripts/career-consultation-orchestrator-parity-qa.ts
 *
 * PASSAI CAREER — P15-D: 相談AI（司令塔）prompt の byte parity QA + Event Signal 隔離 QA（dev-only）。
 *
 * 目的（P15-D）:
 *   「相談AIの Personal Memory 由来の機能横断 context を Context Orchestrator 側へ移す」構造変更
 *   （+ route inline assembly の pure builder 抽出）の前後で、完成 system prompt が **UTF-8 byte 列として
 *   同一**であることを、Personal Memory fixture × Event Signal 状態（OFF/ON valid/empty/malformed/rejected）
 *   の組で常設検証する。
 *
 *   legacyBuild（リファクタ前 route の system prompt 組み立てを **逐語複製**した old 参照）と production の
 *   buildConsultationSystemPrompt を比較する。Event Signal block は **本番の resolver**
 *   （resolveConsultationEventSignalsBlock）で state ごとに生成し、legacy/production の双方へ同一文字列で渡す
 *   （＝Event Signal の production code は不変・本 harness も改変しない）。
 *
 * ★ Event Signal 隔離（静的検証も本 harness で実施）:
 *   - orchestrator が Event Signal renderer を import しない。
 *   - consultation canonical renderer が Event Signal 関連 module を import しない。
 *   - consultation prompt builder が Event Signal 関連 module を import しない。
 *   - ConsultationCrossFeatureInput 型に Event Signal を渡す口が無い（型に eventSignal 系フィールド無し）。
 *
 * 厳守: production の純関数を読むだけ。route / AI schema / request・response / model / timeout / DB / Supabase /
 *   env / secret 非接続。外部 AI 非実行・実データ非参照。日時・乱数・不安定 key 順を持ち込まない。
 *
 * 使い方:
 *   npx tsx scripts/career-consultation-orchestrator-parity-qa.ts            # 比較 + golden + 隔離検証
 *   npx tsx scripts/career-consultation-orchestrator-parity-qa.ts --update   # golden 固定
 * 終了コード: 全 fixture EXACT_MATCH + 隔離 OK → 0 / 差分 → 1。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { buildCareerAiContext } from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerInterviewFinalResult } from '@/types/careerInterview';
import type { CareerPresentationFinalResult } from '@/types/careerPresentation';
import type { CompanyResearchSnapshot } from '@/types/careerCompanyResearch';
import {
  formatCompanyResearchContextForPrompt,
  normalizeCompanyResearchSnapshot,
} from '@/lib/careerCompanyResearch/context';
import {
  formatGdConsultationForPrompt,
  formatGdRoomSignalsForConsultation,
  normalizeGdConsultationSnapshot,
  normalizeGdRoomSignal,
} from '@/lib/careerGd/context';
import {
  formatMatchingConsultationForPrompt,
  normalizeMatchingConsultationSnapshot,
} from '@/lib/careerMatching/consultationContext';
import {
  formatSelfAnalysisHistoryForPrompt,
  formatEsHistoryForPrompt,
  formatInterviewHistoryForPrompt,
  formatPresentationHistoryForPrompt,
  normalizeSelfAnalysisHistory,
  normalizeEsHistory,
  normalizeInterviewHistory,
  normalizePresentationHistory,
} from '@/lib/careerConsultation/historySnapshots';
import { str } from '@/lib/careerMemory/summaryUtils';
import { resolveConsultationEventSignalsBlock } from '@/lib/careerMemory/renderEventSignals';
import type { CareerEventSignalSummary } from '@/lib/careerMemory/eventSignals';
import {
  buildConsultationSystemPrompt,
} from '@/app/api/career/consultation/consultationPrompt';
import type { ConsultationCrossFeatureInput } from '@/lib/careerMemory/renderers/consultationCrossFeature';

const cast = <T>(v: unknown): T => v as T;

const GOLDEN_DIR = join(process.cwd(), 'scripts/fixtures/consultation-orchestrator-parity');
const ROOT = process.cwd();
const UPDATE = process.argv.includes('--update') || process.env.UPDATE === '1';

// ══════════════════════════════════════════════════════════════════════════
//  legacyBuild — リファクタ前 route の system prompt 組み立ての逐語複製（old 参照）
//  persona / output / 5 renderers / withHeader / 2 引数 orchestrator をそのまま再現する。
// ══════════════════════════════════════════════════════════════════════════
const LEGACY_FEATURE_KEY = 'career-consultation' as const;

const LEGACY_COMMANDER_PERSONA = [
  'あなたは新卒就活専門のキャリアコーチであり、PASSAI CAREER の「就活全体の司令塔」です。',
  '単なるチャットボットや検索エンジンではありません。学生が今どこにいて、次に何をすべきかを',
  '俯瞰し、本人の就活力そのものを引き上げる伴走者として振る舞います。',
  'PASSAI CAREER には、活動整理・自己分析・就活軸整理・企業マッチング・企業研究・ES・面接・GD・',
  'プレゼンの各機能があり、その結果が下記コンテキストとして渡されます。それらを横断し、',
  '「点」ではなく「線」で就活を捉え、一貫した方針を示してください。',
  '毎回、ユーザーの「現在地」を currentStatusSummary（独立フィールド）に1〜2文で出し、',
  'answer 本文はそれを踏まえた論点整理・ズレ/リスク・次の方向性に充てます（現在地の完全な繰り返しは避ける）。',
  '',
  '【自己理解 × 企業理解 × 選考対策を必ずつなげる】',
  '自己分析・活動整理・就活軸・マッチング・企業研究・ES・面接・GD・プレゼンをバラバラに扱わず、',
  'できる限り次の流れで接続して語ります（該当データがある範囲で）。',
  '- 活動経験 → 強み → ES/面接で語る材料',
  '- 就活軸 → 業界/企業選び → 志望動機',
  '- マッチング結果 → 受ける企業の優先順位 → 企業研究 → ES/面接準備',
  '- ES内容 → 面接での深掘り質問への備え',
  '- GD/プレゼン結果 → 面接で語れる強み・改善点',
  '- 企業研究 → 志望動機 → 逆質問 → 面接対策',
  '',
  '【推移・繰り返しを見る（複数ログがある場合）】',
  '自己分析・ES・面接・プレゼンは「最新1件」ではなく推移（最新→過去）が渡されることがあります。',
  '- 最新結果だけで判断せず、推移メモも踏まえて全体の傾向を見ます。',
  '- 同じ弱点・改善点が複数回繰り返されている場合は、最優先で取り組む課題として扱います。',
  '- 強みが複数ログで一貫している場合は、ES・面接で使える「軸となる強み」として提案します。',
  '- 評価（スコア等）が改善している場合は、次に伸ばすポイントを示します。',
  '- 評価が下がっている場合は、原因を断定せず仮説として整理します。',
  '- ログ間で内容が矛盾している場合（強み・志望業界・志望動機のブレ等）は、責めずに可視化します。',
  '',
  '【就活軸のズレ・矛盾を見抜く（データがある項目のみ・断定しない）】',
  '- 就活軸（values）と志望業界・志望企業・マッチング結果が噛み合っているか。',
  '- 高年収・安定・成長・裁量・勤務地・働き方・社風などの重視条件が互いに衝突していないか。',
  '- 「避けたい条件」と志望先・マッチング上位企業が矛盾していないか。',
  '- 強み・自己分析と志望職種がつながっているか。ES/面接で語る強みが、その企業の業務で再現できる内容か。',
  '- マッチングの相性理由と本人の納得感が一致しているか。企業研究メモと志望動機がつながっているか。',
  'ズレや矛盾に気づいたら、責めず丁寧に「現時点では、ここが噛み合っていないように見えます」と可視化し、',
  'どう整理すれば一貫するかを一緒に考えます（本人が納得して判断できる状態を作る）。',
  '',
  '【脳死回答を避ける — 就活力を上げる壁打ちに徹する】',
  '- 完成回答を一方的に渡して終わりにしません。答えを押し付けず、判断軸と選択肢の比較を示します。',
  '- 「なぜその行動をすべきか」まで説明します。',
  '- ユーザーの入力が浅い・抽象的なときは、無理に完成回答を出さず、深掘り質問（followUpQuestions）に寄せます。',
  '- 一般論で埋めず、本人の実体験・具体的なエピソードの言語化を促します。',
  '',
  '【企業情報・業界情報の安全な扱い】',
  '- 根拠にできるのは、保存済みの企業研究メモ・ユーザー入力・マッチング結果に含まれる範囲だけです。',
  '- 最新の企業情報・採用情報・評判・年収・選考フローなどを勝手に生成・断定しません。',
  '- 「一般に〜と言われます」といった曖昧な断定もしません。個別企業の評価は、本人の就活軸との',
  '  一致/不一致に限定します。根拠が無ければ「企業研究で確認しましょう」と案内します。',
  '- 断定ではなく「あなたの入力情報を見る限り」「保存済みメモ上では」「現時点の材料では」と表現します。',
  '',
  '【行動への接続】',
  '- 必ず「次の具体的な行動」に落とし込み、recommendedActions には少なくとも1つ「今日15分でできる行動」を含めます。',
  '- 行動が PASSAI の機能に対応するなら、その要素に feature キーを付けて機能ページへ導線化します',
  '  （URL は書かず feature キーだけ。許可リストは出力形式の指示に従う）。',
  '',
  '【トーン】',
  '- 就活塾の優秀なメンター。きつすぎないが、ズレははっきり指摘する。友達ノリにはならない。',
  '- 抽象論で逃げず、具体的で行動に移せる。焦らせすぎないが、優先順位は明確に言い切る。',
  '- 次の表現は使わない:「完璧です」「絶対に受かります」「この企業はホワイトです」',
  '  「この業界なら安泰です」「とりあえず頑張りましょう」。また「自己分析を深めましょう」だけで終わらせない。',
  '- 対象は新卒就活のみ。基本方針にある通り、受験系の語彙・文脈は一切持ち込まない。',
].join('\n');

const LEGACY_OUTPUT_FORMAT_INSTRUCTION = [
  '# 出力形式（厳守）',
  '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
  '各フィールドは日本語。配列は該当が無ければ空配列 [] にする（キーは省略しない）。',
  '',
  '{',
  '  "currentStatusSummary": string, // 現在地サマリ（1〜2文・80〜160字）。下記ルールに従う',
  '  "answer": string,              // 回答本文（下記「answer の構成」に従う）',
  '  "keyInsights": string[],       // 持ち帰るべき「気づき」（単なる要約・TODO ではない）',
  '  "recommendedActions": Action[],// 次に取るべき具体的アクション（下記 Action オブジェクトの配列）',
  '  "missingInformation": string[],// 何が無くて何を判断できないかを明示した不足情報',
  '  "followUpQuestions": string[]  // 思考を深める問いかけ（浅い回答を掘り下げる／矛盾を確かめる）',
  '}',
  '',
  '# currentStatusSummary（現在地サマリ）のルール',
  '- 1〜2文・80〜160字程度。「今は〇〇の段階です」のように現在地が一目で分かる文にする。',
  '- 渡されたデータ（自己分析/活動/就活軸/マッチング/ES/面接/GD/プレゼンの有無と推移）から、',
  '  就活のどの段階にいて何が強く何が弱いかを言語化する。',
  '- データが乏しければ「まだ判断材料が少ないため」と明記し、断定しない。企業情報は根拠なく断定しない。',
  '',
  '# answer の構成（この順序に寄せる。目安 500〜800字。一般論で字数を埋めない）',
  '  currentStatusSummary で現在地は別途出すので、answer では現在地サマリを繰り返さない',
  '  （1文目で軽く受けるのは可。完全な重複は避ける）。',
  '1. 論点整理: 相談を就活上の論点に分解する（自己分析の問題か／企業選びの問題か／ES・面接への変換の問題か 等）。',
  '2. ズレ・リスク・伸ばすべき点: values/matching/ES/interview/GD 等から見える点を「現時点では〜に見えます」と断定せず示す。',
  '3. 次にやるべき方向性: 何を優先すべきか、なぜそれが先か。押し付けず判断軸と選択肢を添える。',
  '',
  '# 各フィールドの品質基準',
  '- keyInsights: ユーザーが持ち帰る「気づき」にする。',
  '  良い例:「高年収と働きやすさを両立したいなら、短期と中長期で優先順位を分ける必要があります」',
  '  良い例:「ガクチカの素材はありますが、企業で再現できる強みとしては言語化がまだ弱いです」',
  '  悪い例:「自己分析をしましょう」「面接練習が必要です」（＝ただのTODO・要約は入れない）',
  '- missingInformation: 「何が無いから何を判断できないか」を書く。',
  '  良い例:「志望企業が未入力のため、就活軸との一致度を判断できません」',
  '  悪い例:「情報が足りません」「もっと詳しく教えてください」',
  '- followUpQuestions: 本人の思考を深める問い。',
  '  良い例:「その強みは、志望企業のどの業務で再現できると考えていますか？」',
  '  良い例:「相性が高い企業の中で、逆に不安に感じる条件は何ですか？」',
  '  悪い例:「どんな企業に興味がありますか？」「あなたの強みは何ですか？」',
  '',
  '# recommendedActions（Action）の形式',
  '各要素は次のオブジェクト。3〜5件。最低1件は「今日15分でできる行動」を含める。',
  '{',
  '  "label": string,      // 具体的な行動（必須）。「何を・どの粒度で・何分で」やるかまで書く',
  '  "feature"?: string,   // 対応機能。下の許可リストのキーだけ。無理に付けない（雑談・整理だけなら省略）',
  '  "reason"?: string,    // なぜやるべきか（短く1文・行動理由を明確に）',
  '  "priority"?: string   // "high" | "medium" | "low" のいずれか',
  '}',
  'label の質:「自己分析をする」「企業研究をしましょう」のような粒度の粗い指示は禁止。',
  '  良い例:「気になる企業を3社選び、就活軸に合う点・合わない点を1行ずつ書く」',
  '  良い例:「ガクチカの結論だけを30秒で話せる形に直す」',
  '',
  'feature の許可リスト（この文字列以外は使わない。URL は書かない＝アプリ側で導線を決める）:',
  '  profile（基本情報） / activity（活動整理） / values（就活軸整理） / selfAnalysis（自己分析） /',
  '  matching（企業マッチング） / es（ES作成） / interview（面接練習） / gd（GD練習） /',
  '  presentation（プレゼン対策） / companyResearch（企業研究） / consultation（就活相談） / home（ホーム）',
  '例: {"label":"気になる企業を3社選び、就活軸に合う点・合わない点を1行ずつ書く","feature":"companyResearch","reason":"志望企業と就活軸のズレを確認するため","priority":"high"}',
].join('\n');

function legacyRenderSelfAnalysis(r: CareerSelfAnalysisResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.summary)) lines.push(`- 全体所感: ${str(r.summary)}`);
  if (str(r.careerDirection)) lines.push(`- キャリアの方向性: ${str(r.careerDirection)}`);
  if (r.strengths?.length) lines.push(`- 強み: ${r.strengths.join('、')}`);
  if (r.weaknesses?.length) lines.push(`- 弱み: ${r.weaknesses.join('、')}`);
  if (r.recommendedIndustries?.length) lines.push(`- 向いている業界: ${r.recommendedIndustries.join('、')}`);
  if (r.companySelectionCriteria?.length) lines.push(`- 企業選びの条件: ${r.companySelectionCriteria.join('、')}`);
  if (r.gakuchikaIdeas?.length) lines.push(`- ガクチカ候補: ${r.gakuchikaIdeas.join('、')}`);
  return lines.join('\n');
}
function legacyRenderEs(r: CareerEsResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.headline)) lines.push(`- キャッチコピー: ${str(r.headline)}`);
  if (str(r.gakuchika)) lines.push(`- ガクチカ: ${str(r.gakuchika)}`);
  if (str(r.selfPr)) lines.push(`- 自己PR: ${str(r.selfPr)}`);
  if (str(r.motivation)) lines.push(`- 志望動機: ${str(r.motivation)}`);
  return lines.join('\n');
}
function legacyRenderInterview(r: CareerInterviewFinalResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.overallComment)) lines.push(`- 総合評価: ${str(r.overallComment)}`);
  if (r.strengths?.length) lines.push(`- 良かった点: ${r.strengths.join('、')}`);
  if (r.improvements?.length) lines.push(`- 改善点: ${r.improvements.join('、')}`);
  if (r.deepDiveTopics?.length) lines.push(`- さらに深掘りされそうな論点: ${r.deepDiveTopics.join('、')}`);
  if (r.nextActions?.length) lines.push(`- 次にやるべきこと: ${r.nextActions.join('、')}`);
  if (str(r.companyFit)) lines.push(`- 想定企業との相性: ${str(r.companyFit)}`);
  return lines.join('\n');
}
function legacyRenderPresentation(r: CareerPresentationFinalResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (typeof r.totalScore === 'number' && r.rank) lines.push(`- 総合: ${r.totalScore}点（${r.rank}ランク）`);
  if (str(r.overallComment)) lines.push(`- 総評: ${str(r.overallComment)}`);
  if (r.goodPoints?.length) lines.push(`- 良かった点: ${r.goodPoints.join('、')}`);
  if (r.improvements?.length) lines.push(`- 改善点: ${r.improvements.join('、')}`);
  if (r.priorityImprovements?.length) lines.push(`- 優先改善: ${r.priorityImprovements.join('、')}`);
  if (r.nextPractice?.length) lines.push(`- 次の練習: ${r.nextPractice.join('、')}`);
  if (r.expectedQuestions?.length) lines.push(`- 想定質問: ${r.expectedQuestions.join('、')}`);
  if (str(r.passLikelihood)) lines.push(`- 選考通過可能性: ${str(r.passLikelihood)}`);
  if (str(r.companyFit)) lines.push(`- 企業/職種との相性: ${str(r.companyFit)}`);
  return lines.join('\n');
}
function legacyRenderCompanyResearch(snapshots: CompanyResearchSnapshot[]): string {
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

function legacyBuildSystem(
  profile: CareerProfileInput | null,
  activity: CareerActivityInput | null,
  values: CareerValuesInput | null,
  cf: ConsultationCrossFeatureInput,
  eventSignalsBlock: string,
): string {
  const context = buildCareerAiContext({
    featureKey: LEGACY_FEATURE_KEY,
    profile,
    activity,
    values,
    userInput: '',
  });
  const orchestrated = buildCareerContextForPurpose('consultation', context); // 旧: 2 引数（extras なし）

  const withHeader = (header: string, body: string) => (body ? `${header}\n${body}` : '');
  const selfAnalysisBlock = cf.selfAnalysisHistory.length
    ? formatSelfAnalysisHistoryForPrompt(cf.selfAnalysisHistory)
    : withHeader('# 直近の自己分析結果', legacyRenderSelfAnalysis(cf.selfAnalysis));
  const esBlock = cf.esHistory.length
    ? formatEsHistoryForPrompt(cf.esHistory)
    : withHeader('# 直近の ES ドラフト', legacyRenderEs(cf.es));
  const interviewBlock = cf.interviewHistory.length
    ? formatInterviewHistoryForPrompt(cf.interviewHistory)
    : withHeader('# 直近の面接練習の結果', legacyRenderInterview(cf.interviewResult));
  const presentationBlock = cf.presentationHistory.length
    ? formatPresentationHistoryForPrompt(cf.presentationHistory)
    : withHeader('# 直近のプレゼン練習の結果', legacyRenderPresentation(cf.presentationResult));
  const companyResearchBlock = legacyRenderCompanyResearch(cf.companyResearch);
  const gdBlock = formatGdConsultationForPrompt(cf.gd);
  const gdRoomBlock = formatGdRoomSignalsForConsultation(cf.gdRoom);
  const matchingBlock = formatMatchingConsultationForPrompt(cf.matching);

  return [
    LEGACY_COMMANDER_PERSONA,
    orchestrated.systemPrompt,
    selfAnalysisBlock,
    esBlock,
    interviewBlock,
    presentationBlock,
    companyResearchBlock,
    gdBlock,
    gdRoomBlock,
    matchingBlock,
    eventSignalsBlock,
    LEGACY_OUTPUT_FORMAT_INSTRUCTION,
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}

// ══════════════════════════════════════════════════════════════════════════
//  Personal Memory fixtures（決定的・typed）
// ══════════════════════════════════════════════════════════════════════════
const emptyCf = (): ConsultationCrossFeatureInput => ({
  selfAnalysisHistory: [], esHistory: [], interviewHistory: [], presentationHistory: [],
  companyResearch: [], gd: [], gdRoom: [], matching: [],
});

// 各 fixture は raw（flat）を **本番の normalizer** に通して typed snapshot にする（route と同一手順・shape 保証）。
const nn = <T>(arr: (T | null)[]): T[] => arr.filter((x): x is T => x !== null);
const saLatest = (): CareerSelfAnalysisResult =>
  cast({ summary: '全体所感', careerDirection: '方向性', strengths: ['強みA', '強みB'], weaknesses: ['弱み'], recommendedIndustries: ['IT'], companySelectionCriteria: ['裁量'], gakuchikaIdeas: ['ガクチカ'] });
const saHistory = (n: number) =>
  normalizeSelfAnalysisHistory(Array.from({ length: n }, (_, i) => ({ createdAt: `2026-07-0${i + 1}`, summary: `所感${i}`, careerDirection: `方向${i}`, strengths: [`強み${i}`], weaknesses: [`弱${i}`], recommendedIndustries: ['IT'], recommendedJobs: ['eng'], companySelectionCriteria: ['裁量'], gakuchikaIdeas: [`ガク${i}`] })));
const esLatest = (): CareerEsResult => cast({ headline: 'キャッチ', gakuchika: 'ガクチカ本文', selfPr: '自己PR本文', motivation: '志望動機本文' });
const esHistoryF = (n: number) => normalizeEsHistory(Array.from({ length: n }, (_, i) => ({ createdAt: `2026-06-0${i + 1}`, companyName: `Co${i}`, question: `q${i}`, headline: `h${i}`, gakuchika: `g${i}`, selfPr: `p${i}`, motivation: `m${i}`, appealPoints: [`ap${i}`] })));
const ivLatest = (): CareerInterviewFinalResult => cast({ overallComment: '総合評価', strengths: ['良点'], improvements: ['改善'], deepDiveTopics: ['論点'], nextActions: ['次'], companyFit: '相性' });
const ivHistoryF = (n: number) => normalizeInterviewHistory(Array.from({ length: n }, (_, i) => ({ createdAt: `2026-05-0${i + 1}`, mode: 'real', overallComment: `oc${i}`, strengths: [`s${i}`], improvements: [`imp${i}`], deepDiveTopics: [`dt${i}`], nextActions: [`na${i}`], companyFit: `fit${i}` })));
const prLatest = (): CareerPresentationFinalResult => cast({ totalScore: 82, rank: 'A', overallComment: '総評', goodPoints: ['良点'], improvements: ['改善'], priorityImprovements: ['優先'], nextPractice: ['練習'], expectedQuestions: ['質問'], passLikelihood: '通過所見', companyFit: '相性' });
const prHistoryF = (n: number) => normalizePresentationHistory(Array.from({ length: n }, (_, i) => ({ createdAt: `2026-04-0${i + 1}`, presentationType: 'theme', theme: `t${i}`, totalScore: 70 + i, rank: 'B', overallComment: `oc${i}`, improvements: [`imp${i}`], priorityImprovements: [`pr${i}`], expectedQuestions: [`eq${i}`], nextPractice: [`np${i}`], companyFit: `fit${i}` })));
const crF = (n: number): CompanyResearchSnapshot[] =>
  nn(Array.from({ length: n }, (_, i) => normalizeCompanyResearchSnapshot({ logId: `log${i}`, companyName: `サンプル${i}株式会社`, industry: 'IT・通信', interestLevel: 'high', updatedAt: `2026-07-0${i + 1}T00:00:00.000Z`, verifiedResearchTextPreview: `抜粋${i}`, reviewSummary: `添削${i}`, fitSummary: `適合${i}`, interviewContextSummary: `面接メモ${i}` })));
const gdF = (n: number) => nn(Array.from({ length: n }, (_, i) => normalizeGdConsultationSnapshot({ createdAt: `2026-03-0${i + 1}`, theme: `テーマ${i}`, totalScore: 75 + i, rank: 'B', overallComment: `oc${i}`, strengths: [`s${i}`], improvements: [`imp${i}`], role: '進行役' })));
const gdRoomF = (n: number) => nn(Array.from({ length: n }, (_, i) => normalizeGdRoomSignal({ createdAt: `2026-02-0${i + 1}`, theme: `お題${i}`, axisScores: { logic: 70, communication: 72, leadership: 68, teamwork: 74, contribution: 71, structuring: 69 }, overallComment: `oc${i}` })));
const matchF = (n: number) => nn(Array.from({ length: n }, (_, i) => normalizeMatchingConsultationSnapshot({ createdAt: `2025-12-0${i + 1}`, careerType: `タイプ${i}`, recommendedIndustries: ['IT'], recommendedJobs: ['eng'], developmentAreas: ['定量化'], nextSteps: ['次'], topCompanies: [{ company: `会社${i}`, matchScore: 80, readinessScore: 60, matchReasons: ['理由'], attentionPoints: ['注意'], avoidanceHits: [] }] })));

const profilePii = cast<CareerProfileInput>({ name: '山田太郎', university: '東京大学', faculty: '工学部', email: 'yamada@example.com', phone: '090-1234-5678' });
const baseProfile = cast<CareerProfileInput>({ name: '本人', targetIndustries: ['IT'] });
const activityMulti = cast<CareerActivityInput>({ academics: { detail: '研究' }, extracurricular: { detail: 'サークル' }, work: { detail: 'インターン' } });
const valuesMulti = cast<CareerValuesInput>({ selections: { priorities: ['成長', '社会貢献', '裁量'] }, overallNote: '裁量重視' });

type Fixture = { name: string; profile: CareerProfileInput | null; activity: CareerActivityInput | null; values: CareerValuesInput | null; cf: ConsultationCrossFeatureInput };
const mk = (name: string, over: Partial<Fixture>): Fixture => ({ name, profile: baseProfile, activity: null, values: null, cf: emptyCf(), ...over });

const FIXTURES: Fixture[] = [
  mk('normal', { cf: { ...emptyCf(), selfAnalysis: saLatest(), es: esLatest(), matching: matchF(1) } }),
  mk('heavy', { profile: profilePii, activity: activityMulti, values: valuesMulti, cf: { selfAnalysisHistory: saHistory(3), esHistory: esHistoryF(2), interviewHistory: ivHistoryF(2), presentationHistory: prHistoryF(2), companyResearch: crF(3), gd: gdF(2), gdRoom: gdRoomF(2), matching: matchF(2) } }),
  mk('missing', {}),
  mk('pii-profile', { profile: profilePii }),
  mk('activity-multi-section', { activity: activityMulti }),
  mk('values-multi', { values: valuesMulti }),
  mk('self-analysis-multi', { cf: { ...emptyCf(), selfAnalysisHistory: saHistory(3) } }),
  mk('es-multi', { cf: { ...emptyCf(), esHistory: esHistoryF(3) } }),
  mk('interview-multi', { cf: { ...emptyCf(), interviewHistory: ivHistoryF(3) } }),
  mk('presentation-multi', { cf: { ...emptyCf(), presentationHistory: prHistoryF(3) } }),
  mk('matching-multi', { cf: { ...emptyCf(), matching: matchF(2) } }),
  mk('company-research', { cf: { ...emptyCf(), companyResearch: crF(3) } }),
  mk('gd-history', { cf: { ...emptyCf(), gd: gdF(2), gdRoom: gdRoomF(2) } }),
  mk('previous-consultation', { cf: { ...emptyCf(), selfAnalysis: saLatest(), interviewResult: ivLatest(), presentationResult: prLatest() } }),
  mk('all-context', { profile: profilePii, activity: activityMulti, values: valuesMulti, cf: { selfAnalysisHistory: saHistory(3), esHistory: esHistoryF(2), interviewHistory: ivHistoryF(2), presentationHistory: prHistoryF(2), companyResearch: crF(3), gd: gdF(2), gdRoom: gdRoomF(2), matching: matchF(2) } }),
];

// ══════════════════════════════════════════════════════════════════════════
//  Event Signal states（本番 resolver で block 文字列を生成）
// ══════════════════════════════════════════════════════════════════════════
const validSummary: CareerEventSignalSummary = cast({
  version: 1,
  recentFeatures: ['matching', 'consultation', 'interview', 'es', 'presentation'],
  featureUsage: { matching: '4+', consultation: '4+', interview: '2-3', es: '1', presentation: '1' },
  latestBands: { matching: { band: 'A', recency: '30d' }, presentation: { band: 'B', recency: '30d' }, gd: { band: 'C', recency: '30d' } },
});
type SignalState = { name: string; block: string };
const SIGNAL_STATES: SignalState[] = [
  { name: 'OFF', block: resolveConsultationEventSignalsBlock(false, validSummary) },
  { name: 'ON-valid', block: resolveConsultationEventSignalsBlock(true, validSummary) },
  { name: 'ON-empty', block: resolveConsultationEventSignalsBlock(true, {}) },
  { name: 'ON-malformed', block: resolveConsultationEventSignalsBlock(true, 'not-an-object') },
  { name: 'rejected', block: resolveConsultationEventSignalsBlock(false, validSummary) }, // guard reject = OFF path
];

// 検証する (fixture, signalState) の組（要件の最低組合せを網羅）。
const PAIRS: Array<{ fixture: Fixture; sig: SignalState }> = [];
for (const f of FIXTURES) {
  // 全 fixture は OFF で検証。
  PAIRS.push({ fixture: f, sig: SIGNAL_STATES[0] });
}
for (const name of ['normal', 'all-context', 'pii-profile']) {
  PAIRS.push({ fixture: FIXTURES.find((f) => f.name === name)!, sig: SIGNAL_STATES[1] }); // ON-valid
}
PAIRS.push({ fixture: FIXTURES.find((f) => f.name === 'missing')!, sig: SIGNAL_STATES[2] }); // ON-empty
PAIRS.push({ fixture: FIXTURES.find((f) => f.name === 'all-context')!, sig: SIGNAL_STATES[3] }); // ON-malformed
PAIRS.push({ fixture: FIXTURES.find((f) => f.name === 'all-context')!, sig: SIGNAL_STATES[4] }); // rejected

const EVENT_SIGNAL_HEADING = '【参考：最近30日の利用傾向】';
const PII_ITEMS: Record<string, string> = { 氏名: '山田太郎', 大学: '東京大学', 学部: '工学部', メール: 'yamada@example.com', 電話: '090-1234-5678' };

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const countOccur = (s: string, sub: string) => (sub === '' ? 0 : s.split(sub).length - 1);
const lineCount = (s: string) => s.split('\n').length;

type Metrics = { bytes: number; hash: string; lines: number; pii: Record<string, number>; signalHeading: number; signalPos: number };
function metricsOf(sys: string): Metrics {
  const pii: Record<string, number> = {};
  for (const [k, v] of Object.entries(PII_ITEMS)) pii[k] = countOccur(sys, v);
  return { bytes: bytes(sys), hash: sha256(sys), lines: lineCount(sys), pii, signalHeading: countOccur(sys, EVENT_SIGNAL_HEADING), signalPos: sys.indexOf(EVENT_SIGNAL_HEADING) };
}

const key = (f: string, s: string) => `${f}__${s}`;
const goldenPath = (k: string) => join(GOLDEN_DIR, `${k}.txt`);
const metricsPath = (k: string) => join(GOLDEN_DIR, `${k}.metrics.json`);
if (UPDATE && !existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

let failures = 0;
const note = (ok: boolean, msg: string) => { if (!ok) { console.log(`❌ ${msg}`); failures++; } };

// ── Event Signal 隔離（静的 import 検証） ──
console.log('# Event Signal isolation (static)');
{
  const orch = readFileSync(join(ROOT, 'lib/careerContext/orchestrator.ts'), 'utf8');
  note(!/renderEventSignals|eventSignalPilotGuard|loadEventSignals|resolveConsultationEventSignalsBlock/.test(orch), 'orchestrator が Event Signal module を import しない');
  const cf = readFileSync(join(ROOT, 'lib/careerMemory/renderers/consultationCrossFeature.ts'), 'utf8');
  note(!/renderEventSignals|eventSignalPilotGuard|loadEventSignals|eventSignals|resolveConsultationEventSignalsBlock/.test(cf), 'consultation canonical renderer が Event Signal module を import しない');
  const cp = readFileSync(join(ROOT, 'app/api/career/consultation/consultationPrompt.ts'), 'utf8');
  note(!/renderEventSignals|eventSignalPilotGuard|loadEventSignals|resolveConsultationEventSignalsBlock/.test(cp), 'consultation prompt builder が Event Signal module を import しない');
  note(!/eventSignal/i.test(cf), 'ConsultationCrossFeatureInput 周辺に eventSignal フィールドが無い');
}

console.log('');
console.log('| Fixture | Signal | bytes | lines | hash | 氏名 | signalPos | legacy==prod | golden |');
console.log('|---|---|---:|---:|---|---:|---:|---|---|');

for (const { fixture: f, sig } of PAIRS) {
  const prod = buildConsultationSystemPrompt({ profile: f.profile, activity: f.activity, values: f.values, crossFeature: f.cf, eventSignalsBlock: sig.block });
  const legacy = legacyBuildSystem(f.profile, f.activity, f.values, f.cf, sig.block);
  const m = metricsOf(prod);
  const mL = metricsOf(legacy);
  const k = key(f.name, sig.name);

  const byteEqual = Buffer.compare(Buffer.from(prod, 'utf8'), Buffer.from(legacy, 'utf8')) === 0;
  const piiEqual = Object.keys(PII_ITEMS).every((key2) => m.pii[key2] === mL.pii[key2]);
  const sigPosEqual = m.signalPos === mL.signalPos && m.signalHeading === mL.signalHeading;
  note(byteEqual, `legacy==production (byte) | ${k}`);
  note(piiEqual, `PII 項目別件数一致 | ${k}`);
  note(sigPosEqual, `Event Signal 位置・見出し数一致 | ${k}`);

  // golden（回帰安定）
  const combined = prod;
  let goldenV = 'n/a';
  if (UPDATE) {
    writeFileSync(goldenPath(k), combined, 'utf8');
    writeFileSync(metricsPath(k), JSON.stringify(m, null, 2) + '\n', 'utf8');
    goldenV = 'WROTE';
  } else if (!existsSync(goldenPath(k)) || !existsSync(metricsPath(k))) {
    note(false, `golden 欠落 | ${k}`); goldenV = 'NO_GOLDEN';
  } else {
    const g = readFileSync(goldenPath(k), 'utf8');
    const gm = cast<Metrics>(JSON.parse(readFileSync(metricsPath(k), 'utf8')));
    const gByte = Buffer.compare(Buffer.from(combined, 'utf8'), Buffer.from(g, 'utf8')) === 0;
    const gPii = Object.keys(PII_ITEMS).every((key2) => m.pii[key2] === gm.pii[key2]);
    const gSig = m.signalPos === gm.signalPos && m.signalHeading === gm.signalHeading;
    const gBudget = m.bytes <= gm.bytes;
    note(gByte, `golden byte 一致 | ${k}`); note(gPii, `golden PII 一致 | ${k}`); note(gSig, `golden Signal 位置一致 | ${k}`); note(gBudget, `golden budget 増加なし | ${k}`);
    goldenV = gByte && gPii && gSig && gBudget ? 'MATCH' : 'DIFF';
  }

  const verdict = byteEqual && piiEqual && sigPosEqual ? 'EXACT_MATCH' : 'DIFF';
  console.log(`| ${f.name} | ${sig.name} | ${m.bytes} | ${m.lines} | ${m.hash.slice(0, 8)} | ${m.pii['氏名']} | ${m.signalPos} | ${verdict} | ${goldenV} |`);

  if (!byteEqual) {
    let i = 0; while (i < prod.length && i < legacy.length && prod[i] === legacy[i]) i++;
    console.log(`   first diff at char ${i}: prod=${JSON.stringify(prod.slice(Math.max(0, i - 15), i + 35))} legacy=${JSON.stringify(legacy.slice(Math.max(0, i - 15), i + 35))}`);
  }
}

console.log('');
if (UPDATE) { console.log('GOLDEN_WRITTEN'); process.exit(0); }
console.log(failures === 0 ? 'ALL_EXACT_MATCH' : `FAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
