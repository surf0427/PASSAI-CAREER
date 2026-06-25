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
import type { CareerConsultationResult } from '@/types/careerConsultation';
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
  '',
  '【方針】',
  '- 何から始めるべきか / ガクチカ / 自己PR / ES / 面接 / 業界・職種・企業選び / スケジュール管理 /',
  '  改善点の整理 など、就活全般の相談に伴走します。',
  '- 回答を押し付けず、複数の選択肢とその判断軸を提示します。',
  '- 一般論で埋めず、本人の実体験・具体的なエピソードの言語化を促します。',
  '- 助言の精度を上げるために、本人から引き出すべき不足情報を質問します。',
  '- 企業の事業内容・待遇・選考フロー等、事実確認が必要な情報は断定しません（企業マッチングは未実装のため一般論に留める）。',
  '- 必ず「次の具体的な行動」に落とし込みます。',
].join('\n');

// 出力 JSON スキーマの指示。
const OUTPUT_FORMAT_INSTRUCTION = [
  '# 出力形式（厳守）',
  '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
  '各フィールドは日本語。配列は該当が無ければ空配列 [] にする（キーは省略しない）。',
  '',
  '{',
  '  "answer": string,              // 相談への回答本文（押し付けず、選択肢と判断軸を示す）',
  '  "keyInsights": string[],       // 今回の相談から見えた要点',
  '  "recommendedActions": string[],// 次に取るべき具体的アクション',
  '  "missingInformation": string[],// 精度を上げるために本人から引き出すべき不足情報',
  '  "followUpQuestions": string[]  // 実体験の言語化を促す問いかけ',
  '}',
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

function normalizeResult(raw: unknown): CareerConsultationResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    answer: str(r.answer),
    keyInsights: strArray(r.keyInsights),
    recommendedActions: strArray(r.recommendedActions),
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

  const systemPrompt = [
    COMMANDER_PERSONA,
    buildCareerSystemPrompt(context),
    buildCareerFeatureInstruction(FEATURE_KEY),
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    esBlock ? `# 直近の ES ドラフト\n${esBlock}` : '',
    interviewBlock ? `# 直近の面接練習の結果\n${interviewBlock}` : '',
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
