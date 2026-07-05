// PASSAI 就活版 — 就活相談AI（司令塔）API（最小・ステートレス）
//
// 役割: /career/consultation から呼ばれ、就活全体の司令塔として相談に構造化 JSON で答える。
//   - 受験版 /api/tutor の「multi-turn 会話 + 横断コンテキスト要約 + system prompt cache」構造を
//     踏襲しつつ、DB / Supabase / 課金 / usage には一切接続しない（会話履歴はクライアントが送る）。
//   - プロンプトは就活版共通基盤（@/lib/careerAi）経由（featureKey=career-consultation）。
//   - 受験版 tutorContext / tutorPrompt / billing は import しない（受験版非依存）。

import {
  buildCareerAiContext,
  buildCareerSystemPrompt,
  buildCareerFeatureInstruction,
} from '@/lib/careerAi';
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
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';

const FEATURE_KEY = 'career-consultation' as const;
const MODEL = 'claude-sonnet-4-6';
export const maxDuration = 80;

const MAX_MESSAGE_LENGTH = 1000;
const HISTORY_MAX_TURNS = 10;

// 司令塔としての追加役割（共通基盤の上に重ねる）。
const COMMANDER_PERSONA = [
  'あなたは新卒就活専門のキャリアアドバイザーです。単なるチャットボットではなく、',
  '「就活全体の司令塔」として、学生が今どこにいて次に何をすべきかを俯瞰して導きます。',
  'PASSAI CAREER には、活動整理・自己分析・就活軸整理・企業マッチング・企業研究・ES・面接・GD・',
  'プレゼンの各機能があり、その結果が下記コンテキストとして渡されます。あなたはそれらを横断して',
  '「点」ではなく「線」で就活を捉え、一貫した方針を示す役割です。',
  '',
  '【毎回の回answerの作法】',
  '1. まず回答（answer）の冒頭で、可能な範囲で「現在地サマリ」を1〜3文で述べます。',
  '   渡されたデータから、就活のどの段階にいて何が強く何が弱いのかを言語化します。',
  '   例:「自己分析は進んでいるが、企業選びとの接続がまだ弱い段階です」',
  '   例:「ES素材は揃っているが、志望動機と就活軸の一貫性がまだ弱い段階です」',
  '   例:「面接・GDの結果からは、話す内容よりも構造化（結論→根拠）が課題の段階です」',
  '   （データが乏しく現在地を判断できない場合は、無理に決めつけず、何を教えてほしいかを示します。）',
  '2. そのうえで本題に答えます。答えを押し付けず、複数の選択肢とその判断軸を示します。',
  '',
  '【横断チェック（データがある項目のみ・断定はしない）】',
  '- 就活軸（values）と志望業界・志望企業・マッチング結果が噛み合っているか。',
  '- 強み・自己分析と、企業選び／志望職種がつながっているか。',
  '- ES・面接で語る内容と就活軸・自己分析がズレていないか。',
  '- 「避けたい条件」と志望先・マッチング上位企業が矛盾していないか。',
  'ズレや矛盾に気づいたら、責めず丁寧に「ここが噛み合っていないように見えます」と可視化し、',
  'どう整理すると一貫するかを一緒に考えます（本人が納得して判断できる状態を作る）。',
  '',
  '【深掘り・壁打ち】',
  '- 一般論で埋めず、本人の実体験・具体的なエピソードの言語化を促します。',
  '- 回答が浅い・抽象的だと感じたら、完成回答を渡す前に深掘りの問い（followUpQuestions）を優先します。',
  '- followUpQuestions は「深掘りに効く問い」にします。',
  '  悪い例:「どんな企業に興味がありますか？」',
  '  良い例:「高年収を重視する一方でワークライフバランスも重視しているように見えます。',
  '          3年目時点ではどちらを優先したいですか？」',
  '  良い例:「面接で話したい強みはありますが、それが企業のどの業務で再現できるかまで言語化できていますか？」',
  '',
  '【情報不足・事実確認】',
  '- 助言の精度を上げるために本人から引き出すべき情報は、断定せず missingInformation に回します。',
  '- 企業の事業内容・待遇・選考フロー等、事実確認が必要な情報は断定しません。保存済みの企業研究や',
  '  マッチング結果があればそれ（本人が確認・試算した情報）を根拠にし、無ければ「まず企業研究機能で',
  '  メモを作る／企業マッチングを実行すると精度が上がります」と案内します。',
  '- ここに渡されていない企業の最新情報を、あなたが勝手に生成・断定しません。',
  '',
  '【行動への接続】',
  '- 必ず「次の具体的な行動」に落とし込み、recommendedActions には少なくとも1つ',
  '  「今日15分でできる行動」を含めます。',
  '  例:「気になる企業を3社選び、就活軸に合う点・合わない点を1行ずつ書く」',
  '  例:「ガクチカの結論だけを30秒で話せる形に直す」',
  '  例:「面接で深掘りされそうな質問を3つ書き出す」',
  '- 必要に応じて ES・面接・GD・プレゼン・企業研究・企業マッチングなど次の機能利用につなげます。',
  '  その行動が PASSAI の機能に対応するなら、recommendedActions の該当要素に feature キーを付け、',
  '  ユーザーがその機能ページへすぐ進めるようにします（URL は書かず feature キーだけ）。',
  '- 完成回答だけを渡してユーザーを思考停止にさせません。判断理由・選択肢・問い返しを添え、',
  '  本人が自分で納得して決められる状態を作ります。',
].join('\n');

// 出力 JSON スキーマの指示。
const OUTPUT_FORMAT_INSTRUCTION = [
  '# 出力形式（厳守）',
  '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
  '各フィールドは日本語。配列は該当が無ければ空配列 [] にする（キーは省略しない）。',
  '',
  '{',
  '  "answer": string,              // 回答本文。冒頭で「現在地サマリ」を1〜3文→本題（選択肢と判断軸）',
  '  "keyInsights": string[],       // 今回の相談から見えた要点（軸と企業選びのズレ等に気づいたら含める）',
  '  "recommendedActions": Action[],// 次に取るべき具体的アクション（下記 Action オブジェクトの配列）',
  '  "missingInformation": string[],// 精度を上げるために本人から引き出すべき不足情報',
  '  "followUpQuestions": string[]  // 深掘りに効く問いかけ（浅い回答を掘り下げる／矛盾を確かめる）',
  '}',
  '',
  '# recommendedActions（Action）の形式',
  '各要素は次のオブジェクト。3〜5件。最低1件は「今日15分でできる行動」を含める。',
  '{',
  '  "label": string,      // 具体的な行動（必須）',
  '  "feature"?: string,   // 対応機能。下の許可リストのキーだけ。無理に付けない（雑談・整理だけなら省略）',
  '  "reason"?: string,    // なぜやるべきか（短く1文）',
  '  "priority"?: string   // "high" | "medium" | "low" のいずれか',
  '}',
  '',
  'feature の許可リスト（この文字列以外は使わない。URL は書かない＝アプリ側で導線を決める）:',
  '  profile（基本情報） / activity（活動整理） / values（就活軸整理） / selfAnalysis（自己分析） /',
  '  matching（企業マッチング） / es（ES作成） / interview（面接練習） / gd（GD練習） /',
  '  presentation（プレゼン対策） / companyResearch（企業研究） / consultation（就活相談） / home（ホーム）',
  '例: {"label":"ガクチカの結論を30秒で話せる形に直す","feature":"es","reason":"ESと面接の両方で使う中心素材のため","priority":"high"}',
].join('\n');

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

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

function normalizeResult(raw: unknown): CareerConsultationResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
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
    selfAnalysis?: CareerSelfAnalysisResult | null;
    es?: CareerEsResult | null;
    interviewResult?: CareerInterviewFinalResult | null;
    presentationResult?: CareerPresentationFinalResult | null;
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
  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    userInput: '',
  });

  const selfAnalysisBlock = renderSelfAnalysis(b.selfAnalysis);
  const esBlock = renderEs(b.es);
  const interviewBlock = renderInterview(b.interviewResult);
  const presentationBlock = renderPresentation(b.presentationResult);
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
    buildCareerSystemPrompt(context),
    buildCareerFeatureInstruction(FEATURE_KEY),
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    esBlock ? `# 直近の ES ドラフト\n${esBlock}` : '',
    interviewBlock ? `# 直近の面接練習の結果\n${interviewBlock}` : '',
    presentationBlock ? `# 直近のプレゼン練習の結果\n${presentationBlock}` : '',
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
          max_tokens: 1500,
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
