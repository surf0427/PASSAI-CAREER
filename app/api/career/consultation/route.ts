// PASSAI 就活版 — 就活相談AI（司令塔）API（最小・ステートレス）
//
// 役割: /career/consultation から呼ばれ、就活全体の司令塔として相談に構造化 JSON で答える。
//   - 受験版 /api/tutor の「multi-turn 会話 + 横断コンテキスト要約 + system prompt cache」構造を
//     踏襲しつつ、DB / Supabase / 課金 / usage には一切接続しない（会話履歴はクライアントが送る）。
//   - プロンプトは就活版共通基盤（@/lib/careerAi）経由（featureKey=career-consultation）。
//   - 受験版 tutorContext / tutorPrompt / billing は import しない（受験版非依存）。

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
import type {
  CareerConsultationResult,
  CareerConsultationRecommendedAction,
  CareerConsultationActionPriority,
} from '@/types/careerConsultation';
import { isCareerConsultationActionFeature } from '@/lib/careerConsultation/actionLinks';
import type { CompanyResearchSnapshot } from '@/types/careerCompanyResearch';
import {
  normalizeCompanyResearchSnapshot,
  formatCompanyResearchContextForPrompt,
} from '@/lib/careerCompanyResearch/context';
import {
  normalizeGdConsultationSnapshot,
  formatGdConsultationForPrompt,
  normalizeGdRoomSignal,
  formatGdRoomSignalsForConsultation,
  type GdConsultationSnapshot,
  type GdRoomSignalSnapshot,
} from '@/lib/careerGd/context';
import {
  normalizeMatchingConsultationSnapshot,
  formatMatchingConsultationForPrompt,
  type MatchingConsultationSnapshot,
} from '@/lib/careerMatching/consultationContext';
import {
  normalizeSelfAnalysisHistory,
  normalizeEsHistory,
  normalizeInterviewHistory,
  normalizePresentationHistory,
  formatSelfAnalysisHistoryForPrompt,
  formatEsHistoryForPrompt,
  formatInterviewHistoryForPrompt,
  formatPresentationHistoryForPrompt,
  compressCareerActivityForConsultation,
} from '@/lib/careerConsultation/historySnapshots';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
// P4-B: str を共通 util へ集約（strArray は route 固有のため local 維持・内部で共通 str を使用）。
import { str } from '@/lib/careerMemory/summaryUtils';

const FEATURE_KEY = 'career-consultation' as const;
const MODEL = 'claude-sonnet-4-6';
export const maxDuration = 80;

const MAX_MESSAGE_LENGTH = 1000;
const HISTORY_MAX_TURNS = 10;

// 司令塔としての追加役割（共通基盤の上に重ねる）。
const COMMANDER_PERSONA = [
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

// 出力 JSON スキーマの指示。
const OUTPUT_FORMAT_INSTRUCTION = [
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

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v) => v !== '');
}

// 直近の自己分析を可読テキストに整形。
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

// 直近の ES を可読テキストに整形。
function renderEs(r: CareerEsResult | null | undefined): string {
  if (!r) return '';
  const lines: string[] = [];
  if (str(r.headline)) lines.push(`- キャッチコピー: ${str(r.headline)}`);
  if (str(r.gakuchika)) lines.push(`- ガクチカ: ${str(r.gakuchika)}`);
  if (str(r.selfPr)) lines.push(`- 自己PR: ${str(r.selfPr)}`);
  if (str(r.motivation)) lines.push(`- 志望動機: ${str(r.motivation)}`);
  return lines.join('\n');
}

// 直近の面接結果を可読テキストに整形。
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

// 直近のプレゼン練習結果を可読テキストに整形（旧データ・欠損も guarded）。
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

// client から渡る会話履歴を {role, content} の交互列に整える（受験版 sanitizeTutorHistory 同型）。
function sanitizeHistory(
  raw: unknown,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(raw)) return [];
  const valid: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (rec.role !== 'user' && rec.role !== 'assistant') continue;
    const content = str(rec.content);
    if (!content || content.length > MAX_MESSAGE_LENGTH) continue;
    valid.push({ role: rec.role, content });
  }
  // user 始まり + 交互整列。
  const alternated: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of valid) {
    if (alternated.length === 0) {
      if (m.role !== 'user') continue;
      alternated.push(m);
      continue;
    }
    const last = alternated[alternated.length - 1];
    if (last.role !== m.role) alternated.push(m);
    else alternated[alternated.length - 1] = m;
  }
  let truncated =
    alternated.length > HISTORY_MAX_TURNS ? alternated.slice(-HISTORY_MAX_TURNS) : alternated;
  if (truncated[0]?.role === 'assistant') truncated = truncated.slice(1);
  // 末尾が user なら落とす（直後に今回の user を append するため）。
  if (truncated.length > 0 && truncated[truncated.length - 1].role === 'user') {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

// 保存済み企業研究（複数）を相談AI用の指示ブロックに整形する。空なら空文字。
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

// priority を high/medium/low のみに正規化（不正なら undefined）。
function normalizePriority(value: unknown): CareerConsultationActionPriority | undefined {
  return value === 'high' || value === 'medium' || value === 'low' ? value : undefined;
}

// recommendedActions を「string（旧互換） / object（機能導線つき）」の配列に安全化する。
// - AI の JSON 揺れに強く: string[] でも object[] でも受ける。
// - label が空なら除外。feature は許可リスト外なら落とす。priority が不正なら省略。
// - AI が返した href は一切採用しない（href は client 側で feature から解決する）。
function normalizeRecommendedActions(value: unknown): CareerConsultationRecommendedAction[] {
  if (!Array.isArray(value)) return [];
  const out: CareerConsultationRecommendedAction[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const label = item.trim();
      if (label) out.push(label);
      continue;
    }
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const label = str(rec.label);
      if (!label) continue;
      const feature = isCareerConsultationActionFeature(rec.feature) ? rec.feature : undefined;
      const reason = str(rec.reason);
      const priority = normalizePriority(rec.priority);
      out.push({
        label,
        ...(feature ? { feature } : {}),
        ...(reason ? { reason } : {}),
        ...(priority ? { priority } : {}),
      });
    }
  }
  // 暴走防止に上限を設ける（プロンプトは 3〜5 件を要求）。
  return out.slice(0, 6);
}

// 現在地サマリを安全化: string を trim、長すぎれば ~200字で truncate、空/非string は undefined。
function normalizeCurrentStatusSummary(value: unknown): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  return s.length > 200 ? `${s.slice(0, 200).trim()}…` : s;
}

function normalizeResult(raw: unknown): CareerConsultationResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const currentStatusSummary = normalizeCurrentStatusSummary(r.currentStatusSummary);
  return {
    ...(currentStatusSummary ? { currentStatusSummary } : {}),
    answer: str(r.answer),
    keyInsights: strArray(r.keyInsights),
    recommendedActions: normalizeRecommendedActions(r.recommendedActions),
    missingInformation: strArray(r.missingInformation),
    followUpQuestions: strArray(r.followUpQuestions),
  };
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'リクエストボディが不正です。' }, { status: 400 });
  }

  const b = (body && typeof body === 'object' ? body : {}) as {
    message?: unknown;
    history?: unknown;
    profile?: CareerProfileInput | null;
    activity?: CareerActivityInput | null;
    values?: CareerValuesInput | null;
    // 旧クライアント互換（最新1件）。新クライアントは *History 配列を送る。
    selfAnalysis?: CareerSelfAnalysisResult | null;
    es?: CareerEsResult | null;
    interviewResult?: CareerInterviewFinalResult | null;
    presentationResult?: CareerPresentationFinalResult | null;
    // STEP-CONSULT-06: 軽量な複数件＋推移（最新3件まで・圧縮済みスナップショット）。
    selfAnalysisHistory?: unknown;
    esHistory?: unknown;
    interviewHistory?: unknown;
    presentationHistory?: unknown;
    companyResearch?: unknown;
    gd?: unknown;
    gdRoom?: unknown;
    matching?: unknown;
  };

  const message = str(b.message);
  if (!message) {
    return Response.json({ error: 'メッセージを入力してください。' }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: 'メッセージが長すぎます。' }, { status: 400 });
  }

  const history = sanitizeHistory(b.history);

  // 就活版共通基盤でプロフィール+活動の土台を組み、司令塔役割と横断コンテキストを重ねる。
  // activity は 18 セクション全量だとトークンが重いため、相談用に圧縮（各配列3件・各文字列160字）してから渡す。
  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile: b.profile ?? null,
    activity: compressCareerActivityForConsultation(
      b.activity as Parameters<typeof compressCareerActivityForConsultation>[0],
    ) as CareerActivityInput | null,
    values: b.values ?? null,
    userInput: '',
  });
  // P3-C: base system prompt を Context Orchestrator（purpose=consultation）経由で取得する。
  //   委譲のため出力は現行と同一。手組みアグリゲート（横断スナップショット）は下記のまま維持。
  const orchestrated = buildCareerContextForPurpose('consultation', context);

  // STEP-CONSULT-06: 最新3件の推移スナップショット（新クライアント）。
  // 無ければ旧クライアント互換で「最新1件」ブロックにフォールバックする。
  const selfAnalysisHistory = normalizeSelfAnalysisHistory(b.selfAnalysisHistory);
  const esHistory = normalizeEsHistory(b.esHistory);
  const interviewHistory = normalizeInterviewHistory(b.interviewHistory);
  const presentationHistory = normalizePresentationHistory(b.presentationHistory);

  // history があれば推移ブロック（見出し込み）、無ければ旧「最新1件」ブロック（見出しを付ける）。
  const withHeader = (header: string, body: string) => (body ? `${header}\n${body}` : '');
  const selfAnalysisBlock = selfAnalysisHistory.length
    ? formatSelfAnalysisHistoryForPrompt(selfAnalysisHistory)
    : withHeader('# 直近の自己分析結果', renderSelfAnalysis(b.selfAnalysis));
  const esBlock = esHistory.length
    ? formatEsHistoryForPrompt(esHistory)
    : withHeader('# 直近の ES ドラフト', renderEs(b.es));
  const interviewBlock = interviewHistory.length
    ? formatInterviewHistoryForPrompt(interviewHistory)
    : withHeader('# 直近の面接練習の結果', renderInterview(b.interviewResult));
  const presentationBlock = presentationHistory.length
    ? formatPresentationHistoryForPrompt(presentationHistory)
    : withHeader('# 直近のプレゼン練習の結果', renderPresentation(b.presentationResult));
  // 保存済み企業研究（最大5件・軽量スナップショット）。
  const companyResearch: CompanyResearchSnapshot[] = Array.isArray(b.companyResearch)
    ? b.companyResearch
        .map((s) => normalizeCompanyResearchSnapshot(s))
        .filter((s): s is CompanyResearchSnapshot => s !== null)
        .slice(0, 5)
    : [];
  const companyResearchBlock = renderCompanyResearch(companyResearch);
  // 直近のGD練習結果（最新2件）。formatGdConsultationForPrompt が見出し・断定回避を含む。
  const gdSnapshots = Array.isArray(b.gd)
    ? b.gd
        .map((s) => normalizeGdConsultationSnapshot(s))
        .filter((s): s is GdConsultationSnapshot => s !== null)
        .slice(0, 3)
    : [];
  const gdBlock = formatGdConsultationForPrompt(gdSnapshots);
  // STEP-GD-17: マルチGD の 6 軸評価を「参考シグナル」として追加（最新3件・圧縮・断定回避）。
  const gdRoomSignals = Array.isArray(b.gdRoom)
    ? b.gdRoom
        .map((s) => normalizeGdRoomSignal(s))
        .filter((s): s is GdRoomSignalSnapshot => s !== null)
        .slice(0, 3)
    : [];
  const gdRoomBlock = formatGdRoomSignalsForConsultation(gdRoomSignals);
  // STEP-CONSULT-03: 企業マッチング結果（最新2件・軽量スナップショット）。
  // 「自己理解 × 企業理解」を横断し、就活軸とのズレ指摘に使う。
  const matchingSnapshots = Array.isArray(b.matching)
    ? b.matching
        .map((s) => normalizeMatchingConsultationSnapshot(s))
        .filter((s): s is MatchingConsultationSnapshot => s !== null)
        .slice(0, 2)
    : [];
  const matchingBlock = formatMatchingConsultationForPrompt(matchingSnapshots);

  const systemPrompt = [
    COMMANDER_PERSONA,
    // P3-C: 同一 system 内の feature instruction 二重 append を削除（純粋な重複除去）。
    orchestrated.systemPrompt,
    selfAnalysisBlock,
    esBlock,
    interviewBlock,
    presentationBlock,
    companyResearchBlock,
    gdBlock,
    gdRoomBlock,
    matchingBlock,
    OUTPUT_FORMAT_INSTRUCTION,
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する。
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message_ = await anthropic.messages.create(
        {
          model: MODEL,
          // answer は 500〜900字 + keyInsights/actions/missing/followUp の配列を含む。
          // QA で values+matching+企業研究のリッチ文脈時に 2200 では途中切れ（502
          // AI_CONSULTATION_TRUNCATED）が発生したため、余裕を持たせる（maxDuration 80s 内）。
          max_tokens: 3200,
          temperature: attempt === 2 ? 0 : 0.4,
          system: systemPrompt,
          messages: [...history, { role: 'user', content: message }],
        },
        { signal: createTimeoutSignal() },
      );

      const raw = message_.content[0]?.type === 'text' ? message_.content[0].text : '';

      if (message_.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_CONSULTATION_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        const result = normalizeResult(JSON.parse(extractJson(raw)));
        if (!result.answer) throw new Error('empty-answer');
        return Response.json({ result });
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          { error: 'AI_CONSULTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    return Response.json(
      { error: 'AI_CONSULTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
      { status: 502 },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career consultation API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '相談の生成に失敗しました。' },
      { status: 500 },
    );
  }
}
