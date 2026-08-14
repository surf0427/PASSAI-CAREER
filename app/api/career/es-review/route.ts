// PASSAI 就活版 — ES（エントリーシート）添削AI API
//
// 役割: /career/es/[id] エディタの「AI添削」から呼ばれ、就活 ES 回答 1 本を採点・添削して
//       JSON で返すだけ。ES本文はユーザーが書き、AIは添削のみ（本文・完成例は返さない）。
//
// 設計思想（受験版 app/api/essay-review を参考。ただしコードは流用せず就活ES専用に再設計）:
//   - スコアは AI に出させ、ランクは「スコアから決定論で」導出する（AI にランクを決めさせない）。
//   - overallScore も breakdown 6 軸の平均から決定論で導出し、AI の自己申告に依存しない。
//   - AI 出力は defensive に normalize し、余計な文章・JSON 崩れでも壊れないようにする。
//   - 事実を捏造させない（与えられた回答文の範囲だけで判断・書き直す）。
//
// 非接続方針（生成系と同一）:
//   - 課金 / quota・usage 記録・DB / Supabase / Stripe には接続しない。
//   - AI 呼び出し系の純粋ユーティリティ（@/lib/ai / @/lib/aiTimeout）のみ利用する。

import type {
  CareerEsReview,
  CareerEsReviewBreakdown,
  CareerEsRank,
} from '@/types/careerEs';
import {
  normalizeCompanyResearchSnapshot,
  formatCompanyResearchContextForPrompt,
} from '@/lib/careerCompanyResearch/context';
import { anthropic, extractJson } from '@/lib/ai';
import {
  AI_BUDGET_PRESET_80S_WALL,
  createAiCallBudget,
  createTimeoutSignal,
} from '@/lib/aiTimeout';

// 生成系と同系の Sonnet を使用（課金/usage には接続しない）。
const MODEL = 'claude-sonnet-4-6';

// Vercel 実行時間上限。AI timeout（60s）+ 余裕。runtime は既定 nodejs。
export const maxDuration = 80;

// 6軸スコア + 各種コメント（良かった点/改善点/不足要素/採用担当視点/優先改善）を収める。
const MAX_TOKENS = 3000;

// 6 軸の固定キー（AI 出力の照合・normalize に使う）。
const BREAKDOWN_KEYS = [
  'logic',
  'specificity',
  'originality',
  'readability',
  'persuasion',
  'companyFit',
] as const;

// ── 小さなヘルパー ───────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 0〜100 の整数へ丸める（範囲外・非数は 0）。
function clampScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function strArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => str(v))
    .filter((v) => v !== '')
    .slice(0, max);
}

// スコアからランクを決定論で導出する（AI には決めさせない）。
function deriveRank(score: number): CareerEsRank {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}

// 選考種別に応じた「重点的に見る評価観点」の追加指示ブロックを作る。
// 6 軸スコア（固定）は変えず、コメント・改善点・優先改善の着眼点を選考種別に寄せる。
// 未指定（none）は基本観点のみで汎用ES として評価するため空文字を返す。
function buildSelectionReviewInstruction(
  selectionType: 'main' | 'internship' | null,
): string {
  if (selectionType === 'main') {
    return [
      '# 選考種別: 本選考（重点評価観点）',
      'この ES は入社を前提とした本選考向けです。基本観点に加え、特に次を重視して添削してください:',
      '- 入社後の貢献度（経験から入社後の活躍・再現性が見えるか）。',
      '- 企業適合性（本人の強み・価値観と企業の方向性が結びついているか）。',
      '- 志望度の具体性（「なぜこの会社か」「なぜこの職種か」が伝わるか）。',
      '- 他社にも通用する汎用文になっていないか（差別化・具体性）。',
      '- 「学びたい」「成長したい」だけの受け身表現に寄りすぎていないか。',
      '- 採用担当が「採用する理由」を感じられるか。',
    ].join('\n');
  }
  if (selectionType === 'internship') {
    return [
      '# 選考種別: インターン応募（重点評価観点）',
      'この ES はインターンシップ応募向けです。基本観点に加え、特に次を重視して添削してください:',
      '- 参加目的の明確さ（インターンで何を得たいか・検証したい仮説があるか）。',
      '- 業界・企業への関心、業務理解への意欲。',
      '- 学習意欲・成長ポテンシャル・主体性（受け身でないか）。',
      '- 本選考につながる自然さがあるか。',
      '- 内定欲・入社意思が強すぎる断定表現になっていないか（応募段階はインターン参加）。',
    ].join('\n');
  }
  return '';
}

// AI 出力（パース済み unknown）を CareerEsReview 形状に正規化する。
// overallScore / rank は AI の値を使わず、breakdown から決定論で再計算する。
function normalizeReview(raw: unknown): CareerEsReview {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawBreakdown =
    r.breakdown && typeof r.breakdown === 'object'
      ? (r.breakdown as Record<string, unknown>)
      : {};

  const breakdown = BREAKDOWN_KEYS.reduce((acc, key) => {
    acc[key] = clampScore(rawBreakdown[key]);
    return acc;
  }, {} as CareerEsReviewBreakdown);

  // overallScore は 6 軸の平均（決定論）。AI の自己申告 overallScore は採用しない。
  const sum = BREAKDOWN_KEYS.reduce((acc, key) => acc + breakdown[key], 0);
  const overallScore = Math.round(sum / BREAKDOWN_KEYS.length);

  return {
    overallScore,
    rank: deriveRank(overallScore),
    overallComment: str(r.overallComment),
    breakdown,
    strengths: strArray(r.strengths, 5),
    improvements: strArray(r.improvements, 5),
    missingElements: strArray(r.missingElements, 5),
    recruiterComments: strArray(r.recruiterComments, 5),
    priorityActions: strArray(r.priorityActions, 5),
  };
}

// ── system prompt（就活ES添削者） ────────────────────────────────

const SYSTEM_PROMPT = [
  'あなたは、日本の新卒就職活動のエントリーシート（ES）を添削する専門家です。',
  '学生が書いた ES 回答 1 本を採点・添削し、本人が自分で直せるように具体的に助言します。',
  '',
  '【評価する観点】',
  '次の観点で本文の質のみを評価してください（与えられた回答文の範囲だけで判断する）:',
  '- 設問に正面から答えているか',
  '- 結論が先にあるか（結論ファースト）',
  '- 主張の根拠が十分か',
  '- エピソードが具体的か（数字・固有名詞・行動が見えるか）',
  '- 学び・成長が言語化されているか',
  '- 入社後の活躍や仕事への接続があるか',
  '- 冗長でないか・一文が長すぎないか',
  '- 誤字脱字・表記の乱れ',
  '- 読みやすさ（構成・接続・リズム）',
  '- 企業名が与えられている場合は、その企業・業界との整合性',
  '',
  '【6 軸スコア（各 0〜100 の整数）】',
  '- logic: 論理性（結論→根拠→具体→学びの一貫性）',
  '- specificity: 具体性（エピソード・数字・行動の具体度）',
  '- originality: オリジナリティ（その人固有の経験・視点か、テンプレ的でないか）',
  '- readability: 読みやすさ（文の長さ・構成・誤字脱字）',
  '- persuasion: 説得力（採用担当が納得できるか）',
  '- companyFit: 企業適合性（企業名がある場合はその企業/業界との整合、ない場合は志望文脈への接続の自然さ）',
  '',
  '【絶対のルール】',
  '- 与えられた回答文に書かれていない事実（実績・数値・所属・体験）を捏造しない。',
  '- 本文の代筆・完成例・「こう書きましょう」という書き換え文を一切出さない。',
  '  あなたの役割は評価と助言であり、本人が自分で書き直せるようにすること。',
  '- 改善点・優先改善は「次に何をすればよいか」が分かる行動レベルの指示にする。',
  '  「具体性を上げましょう」のような抽象的な助言だけで終えない。',
  '- ランクや総合点は書かなくてよい（スコアから自動で決まる）。breakdown の 6 軸を必ず埋める。',
  '',
  '【missingElements（不足している要素）のルール】',
  '- この回答に足りていない観点・エピソード要素を指摘する（例:「成果を示す数字」「主体的に動いた具体行動」「なぜその会社かの根拠」）。',
  '- 本文を書き足すのではなく、「何が欠けているか」を要素として挙げる。',
  '',
  '【recruiterComments（採用担当視点コメント）のルール】',
  '- 採用担当がこの回答を読んだときにどう受け取るかを、担当者の視点で率直に述べる。',
  '  例:「行動力は伝わる」「主体性が弱い」「成果の具体性が不足」「志望理由が浅い」。',
  '- 良い受け取りも懸念も両方含めてよい。合否の断定はしない。',
  '',
  '【出力ルール】',
  '- 返答は必ず 1 つの JSON オブジェクトのみ。',
  '- JSON の前後に説明文・コメント・挨拶・コードブロック記号（```）を一切書かない。',
  '- 出力の 1 文字目が { 、最後の文字が } であること。',
  '- すべてのキー・文字列値をダブルクォートで囲むこと。',
  '',
  '出力形式:',
  '{',
  '  "overallComment": string,        // 総評（全体所感、2〜3文）',
  '  "breakdown": {',
  '    "logic": number,               // 0〜100',
  '    "specificity": number,         // 0〜100',
  '    "originality": number,         // 0〜100',
  '    "readability": number,         // 0〜100',
  '    "persuasion": number,          // 0〜100',
  '    "companyFit": number           // 0〜100',
  '  },',
  '  "strengths": string[],           // 良かった点（最大5件）',
  '  "improvements": string[],        // 改善点（行動レベル、最大5件）',
  '  "missingElements": string[],     // 不足している要素（最大5件）',
  '  "recruiterComments": string[],   // 採用担当視点コメント（最大5件）',
  '  "priorityActions": string[]      // 優先的に直すべき順（最大5件、0番目が最重要）',
  '}',
].join('\n');

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'リクエストボディが不正です。' }, { status: 400 });
  }

  const b = (body && typeof body === 'object' ? body : {}) as {
    answer?: string;
    question?: string;
    companyName?: string;
    charLimit?: number;
    selectionType?: unknown;
    industry?: string;
    jobType?: string;
    companyResearchContext?: unknown;
  };

  const answer = str(b.answer);
  const question = str(b.question);
  const companyName = str(b.companyName);
  const charLimit =
    typeof b.charLimit === 'number' && Number.isFinite(b.charLimit) && b.charLimit > 0
      ? Math.floor(b.charLimit)
      : null;
  // 応募メタ（添削時の企業適合性・整合性評価の文脈に使う）。未指定は許容する。
  const selectionType: 'main' | 'internship' | null =
    b.selectionType === 'main' || b.selectionType === 'internship'
      ? b.selectionType
      : null;
  // 選考種別に応じた追加の評価観点。未指定（none）は基本観点のみで汎用ESとして評価する。
  const selectionInstruction = buildSelectionReviewInstruction(selectionType);
  const industry = str(b.industry);
  const jobType = str(b.jobType);
  // 保存済み企業研究（任意・1 件）。あれば回答との整合性評価に使う。
  const researchSnapshot = normalizeCompanyResearchSnapshot(b.companyResearchContext);
  const researchBlock = researchSnapshot
    ? formatCompanyResearchContextForPrompt([researchSnapshot])
    : '';

  // 添削対象が無ければ弾く。
  if (answer === '') {
    return Response.json(
      { error: '添削する本文がありません。' },
      { status: 400 },
    );
  }

  // 保存済み企業研究を使う場合の評価指示（断定を避けた添削者の文体を維持）。
  const researchInstruction = researchBlock
    ? [
        '# 保存済みの企業研究（ユーザー本人が作成・確認したもの）',
        researchBlock,
        '',
        'この企業研究はユーザー自身が確認・保存した一次情報です。添削では次も評価してください:',
        '- 企業研究で注目している点が、回答（特に志望動機）に活かされているか（企業理解の深さ・志望動機の具体性）。',
        '- 企業研究ログで「不足・根拠不足」と指摘された点（競合比較など）が放置されていないか。',
        '- 自己分析 / 活動整理 / 就活軸との接続が取れているか。',
        'コメントは「あなたの企業研究メモを見る限り」「保存済み企業研究によると」という文体にし、',
        '企業情報を断定せず、根拠不足は公式情報・説明会資料での再確認を促してください。',
      ].join('\n')
    : '';

  // user メッセージ: 設問・企業名・文字数（あれば）+ 企業研究（あれば）+ 添削対象本文。
  const userMessage = [
    question ? `# ES設問\n${question}` : '',
    selectionInstruction,
    companyName ? `# 志望企業\n${companyName}` : '',
    industry ? `# 志望業界\n${industry}` : '',
    jobType ? `# 志望職種\n${jobType}` : '',
    charLimit ? `# 指定文字数\n${charLimit} 字（±10% 以内を目安）` : '',
    researchInstruction,
    `# 添削対象の回答本文\n${answer}`,
    '',
    '上記の回答本文を、指定の JSON 形式で添削してください。事実を捏造しないでください。',
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する（生成系と同方針）。
    let review: CareerEsReview | null = null;
    // AI 合計時間予算（wall 80s の内側に固定）。retry ごとに満額 signal を再発行すると
    // 合計が wall を超えて 504（非JSON）になり、client には汎用エラーしか見えなくなる。
    const aiBudget = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const callTimeoutMs = aiBudget.nextCallTimeoutMs();
      // 残予算が retry に足りない → retry せず打ち切る（wall 超過による 504 を防ぐ）。
      if (callTimeoutMs === null) {
        return Response.json(
          {
            error: 'AI_ES_REVIEW_PARSE_FAILED',
            detail: 'AI応答をJSONとして解釈できませんでした。',
          },
          { status: 502 },
        );
      }
      const message = await anthropic.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: attempt === 2 ? 0 : 0.4,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      // max_tokens 到達の途中切れは長さ起因なので retry せず明示エラーで返す。
      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_ES_REVIEW_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        review = normalizeReview(JSON.parse(extractJson(raw)));
        break;
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          {
            error: 'AI_ES_REVIEW_PARSE_FAILED',
            detail: 'AI応答をJSONとして解釈できませんでした。',
          },
          { status: 502 },
        );
      }
    }

    if (!review) {
      return Response.json(
        {
          error: 'AI_ES_REVIEW_PARSE_FAILED',
          detail: 'AI応答をJSONとして解釈できませんでした。',
        },
        { status: 502 },
      );
    }

    return Response.json({ review });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career ES review API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: 'ESの添削に失敗しました。' },
      { status: 500 },
    );
  }
}
