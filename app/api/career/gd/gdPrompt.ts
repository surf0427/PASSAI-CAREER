// PASSAI 就活版 — GD（グループディスカッション）AI 共通プロンプト組み立て
// （theme / turn / feedback の 3 route が共有する）。
//
//   - 役割: 新卒就活の GD（グループディスカッション）。大学受験・AO/推薦・大学評価軸は持ち込まない。
//   - ステートレス。会話状態（transcript）はクライアントが送る。DB / 課金 / usage 非接続。
//   - 順位・企業評価の「合計値」は AI に作らせず、サーバ側で決定的に算出する（score_contract 準拠）。
//     AI は軸別スコア（0〜100）+ 根拠 + 行動特性のみ返す。
// 本ファイルは route ではない（共有モジュール）。

import type {
  GdFormat,
  GdRole,
  GdParticipant,
  GdUtterance,
  GdBehaviorTrait,
} from '@/types/careerGd';
import {
  GD_ROLE_LABELS,
  GD_ROLE_DESCRIPTIONS,
  GD_FORMAT_LABELS,
  GD_FORMAT_DESCRIPTIONS,
  GD_BEHAVIOR_TRAIT_LABELS,
} from '@/app/career/gd/gdRoles';

// 受験版/就活版の他 AI と同系の Sonnet を使用（課金/usage には接続しない）。
export const CAREER_GD_MODEL = 'claude-sonnet-4-6';

// 就活 GD の全体像（発言の総数上限）。強すぎない AI・ユーザーの発言機会確保のための土台。
export const CAREER_GD_MAX_UTTERANCES = 20;

// 就活 GD の面接官（＝採点者）としての共通土台。
const GD_EVALUATOR_BASE = [
  'あなたは新卒採用の選考で、学生のグループディスカッション（GD）を観察・評価する採用担当者です。',
  '大学受験（総合型選抜・学校推薦型選抜・一般入試）の文脈や大学の評価軸は一切持ち込みません。',
  '評価は「優しいが甘すぎない」姿勢で、企業の GD 選考で実際に見られる観点に沿って行います。',
  '煽り・人格否定はせず、就活生の成長を支援する建設的なトーンを保ちます。',
].join('\n');

// AI 参加者（＝他の就活生役）としての共通土台。
const GD_PARTICIPANT_BASE = [
  'あなたは新卒就活のグループディスカッション（GD）に参加している就活生の 1 人を演じます。',
  '就活 GD らしい、論理的で協調的な発言をします。ただし議論を独占しません。',
  '発言は簡潔に（日本語で 1〜3 文）。専門用語を並べすぎず、自然な話し言葉にします。',
  '他の参加者（特に人間の参加者）の発言を尊重し、意見を引き出す姿勢を持ちます。',
].join('\n');

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ── テーマ生成 ────────────────────────────────────────────────────

export function buildThemeSystem(): string {
  return [
    GD_EVALUATOR_BASE,
    '',
    '新卒就活の GD 選考で実際に出そうな「議論しやすく、かつ深められる」テーマを 1 つ作ってください。',
    '特定企業の内部情報や、事実確認が必要な最新データを前提にしない（一般的な知識で議論できる範囲にする）。',
  ].join('\n');
}

export function buildThemeUser(input: {
  format: GdFormat;
  participantCount: number;
  timeLimitSec: number;
}): string {
  const minutes = Math.round(input.timeLimitSec / 60);
  return [
    `GD 形式: ${GD_FORMAT_LABELS[input.format]}（${GD_FORMAT_DESCRIPTIONS[input.format]}）`,
    `参加人数: ${input.participantCount}人 / 制限時間: 約${minutes}分`,
    '',
    '上記に合うテーマを 1 つ作ってください。',
    input.format === 'case'
      ? 'ケース型なので、簡単な与件（前提条件）も 2〜3 個添えてください。'
      : input.format === 'abstract'
        ? '抽象型なので、正解のない考えを深められるお題にしてください。与件は不要です。'
        : '自由討論型なので、身近で全員が意見を持ちやすいお題にしてください。与件は不要です。',
    '',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '{',
    '  "title": string,          // テーマの短いタイトル',
    '  "description": string,    // 何を議論するかの説明（2〜3文）',
    '  "constraints": string[]   // 与件・前提条件（不要なら空配列）',
    '}',
  ].join('\n');
}

// ── 発言（AI 参加者 1 名の次発言）生成 ─────────────────────────────

function participantRoster(participants: GdParticipant[]): string {
  return participants
    .map((p) => {
      const who = p.isSelf ? '（人間の参加者）' : p.type === 'ai' ? '（AI）' : '';
      return `- ${p.displayName}${who}: ${GD_ROLE_LABELS[p.role]}`;
    })
    .join('\n');
}

function transcriptText(participants: GdParticipant[], transcript: GdUtterance[]): string {
  if (transcript.length === 0) return '（まだ発言はありません。あなたが口火を切ります）';
  const nameOf = (id: string) =>
    participants.find((p) => p.id === id)?.displayName ?? '参加者';
  return transcript
    .map((u) => (u.kind === 'system' ? `【進行】${u.content}` : `${nameOf(u.participantId)}: ${u.content}`))
    .join('\n');
}

export function buildTurnSystem(speaker: GdParticipant, format: GdFormat): string {
  const assertiveness = speaker.persona?.assertiveness ?? 2;
  const style = speaker.persona?.style ?? '一般型';
  const strengthNote =
    assertiveness >= 3
      ? '議論を前に進める積極的な発言をしてよいですが、結論を独り占めせず、他の人にも話を振ってください。'
      : assertiveness === 2
        ? '適度に自分の意見を述べつつ、他の人の意見にも反応してください。'
        : '控えめに、要点を絞って発言してください。人の意見を受けて補足する形でも構いません。';
  const roleNote =
    speaker.role === 'facilitator'
      ? '司会として、論点を整理し、まだ発言していない人（特に人間の参加者）に「〇〇さんはどう思いますか?」と話を振る発言を適度に混ぜてください。'
      : speaker.role === 'timekeeper'
        ? 'タイムキーパーとして、必要なら残り時間や議論の進み具合に触れてください。'
        : speaker.role === 'scribe'
          ? '書記として、出た意見を短く整理・要約する発言をしてもよいです。'
          : speaker.role === 'presenter'
            ? '発表者として、結論に向けて意見をまとめる方向の発言をしてもよいです。'
            : '一般参加者として、自分の意見や他者への反応を述べてください。';
  return [
    GD_PARTICIPANT_BASE,
    '',
    `あなたの名前: ${speaker.displayName}`,
    `あなたの役割: ${GD_ROLE_LABELS[speaker.role]}（${GD_ROLE_DESCRIPTIONS[speaker.role]}）`,
    `あなたの発言スタイル: ${style}`,
    `GD 形式: ${GD_FORMAT_LABELS[format]}`,
    strengthNote,
    roleNote,
    '',
    '重要: 人間の参加者の発言機会を奪わないでください。長い演説をせず、1〜3 文で簡潔に。',
  ].join('\n');
}

export function buildTurnUser(input: {
  theme: { title: string; description: string; constraints?: string[] };
  speaker: GdParticipant;
  participants: GdParticipant[];
  transcript: GdUtterance[];
  wrapUp: boolean;
}): string {
  const { theme } = input;
  const lines = [
    `GD テーマ: ${theme.title}`,
    theme.description,
  ];
  if (theme.constraints && theme.constraints.length > 0) {
    lines.push('与件:', ...theme.constraints.map((c) => `- ${c}`));
  }
  lines.push(
    '',
    '参加者と役割:',
    participantRoster(input.participants),
    '',
    'これまでの議論:',
    transcriptText(input.participants, input.transcript),
    '',
    input.wrapUp
      ? '議論はまとめの段階です。結論に向けて意見を収束させる発言を 1 回してください。'
      : `あなた（${input.speaker.displayName}）として、次の発言を 1 回してください。同じ主張の繰り返しは避けます。`,
    '出力は発言内容の本文だけ（名前・前置き・引用符・記号は付けない）。',
  );
  return lines.join('\n');
}

// ── フィードバック（個別評価・企業評価・行動特性・matchingHints） ────

const TRAIT_KEYS = Object.keys(GD_BEHAVIOR_TRAIT_LABELS) as GdBehaviorTrait[];

export function buildFeedbackSystem(): string {
  return [
    GD_EVALUATOR_BASE,
    '',
    'GD 全体のログをもとに、各参加者について新卒就活の GD 選考の観点で個別フィードバックを作成します。',
    '数値の「合計スコア」「順位」「合否」はあなたが決めません（サーバが算出します）。あなたは各軸の 0〜100 の小スコアと根拠のみを出します。',
    '評価は実際の発言内容に即し、テンプレ文を避けます。事実確認が必要な企業・業界情報は断定しません。',
  ].join('\n');
}

// 行動特性の選択肢を提示するテキスト。
function traitOptions(): string {
  return TRAIT_KEYS.map((k) => `${k}（${GD_BEHAVIOR_TRAIT_LABELS[k]}）`).join(' / ');
}

export function buildFeedbackUser(input: {
  theme: { title: string; description: string };
  participants: GdParticipant[];
  transcript: GdUtterance[];
  selfParticipantId: string;
  selfRole: GdRole;
}): string {
  const roster = input.participants
    .map(
      (p) =>
        `- id="${p.id}" ${p.displayName}${p.isSelf ? '（★この人が評価対象の本人=あなた）' : p.type === 'ai' ? '（AI）' : ''}: ${GD_ROLE_LABELS[p.role]}`,
    )
    .join('\n');
  return [
    `GD テーマ: ${input.theme.title}`,
    input.theme.description,
    '',
    '参加者と役割:',
    roster,
    '',
    'GD のやり取り（全ログ）:',
    transcriptText(input.participants, input.transcript),
    '',
    '上記をもとに、全参加者ぶんの個別フィードバックを作成してください。',
    '各軸スコアは 0〜100。発言量(volume)は「多いほど高い」ではなく、議論に適した量を100に近づけ、過多・過少は下げる。',
    `行動特性(behaviorTraits)は次から各参加者につき 1〜2 個選ぶ: ${traitOptions()}`,
    '',
    `本人（id="${input.selfParticipantId}"・役割 ${GD_ROLE_LABELS[input.selfRole]}）については、他機能連携のため self ブロックも作成してください。`,
    '',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '{',
    '  "feedbacks": [',
    '    {',
    '      "participantId": string,',
    '      "axisScores": { "logic": number, "cooperation": number, "volume": number, "roleExecution": number, "drive": number, "listening": number },',
    '      "companyImpression": string,        // 企業選考での評価のされやすさ（2〜3文・断定しない）',
    '      "behaviorTraits": string[],         // 上の選択肢キーから1〜2個',
    '      "improvements": string[],           // 改善点（2〜4個）',
    '      "nextPracticeTasks": string[],      // 次回の練習課題（2〜3個）',
    '      "crossFeatureHints": { "matching": string, "interview": string, "es": string, "selfAnalysis": string }',
    '    }',
    '    // ... 参加者全員分',
    '  ],',
    '  "self": {',
    '    "strengthKeywords": string[],         // GDで顕在化した強み（2〜4個）',
    '    "suggestedEnvironments": string[],    // 向いてそうな環境・チーム役割（2〜3個）',
    '    "matchingSummary": string             // careerMatching へ渡す1〜2文の要約',
    '  },',
    '  "overallSummary": string                // GD全体の総括（本人視点。ソロなのでAI参加者との比較も含める・3〜5文）',
    '}',
  ].join('\n');
}

// ── パース補助（route から使う） ─────────────────────────────────

export function parseThemeJson(raw: unknown): {
  title: string;
  description: string;
  constraints: string[];
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const description = typeof r.description === 'string' ? r.description.trim() : '';
  if (!title || !description) return null;
  const constraints = Array.isArray(r.constraints)
    ? r.constraints.filter((c): c is string => typeof c === 'string').map((c) => c.trim())
    : [];
  return { title, description, constraints };
}

// 生スコアを 0〜100 にクランプ。
export function clampScore(value: unknown): number {
  const n = num(value);
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

// 行動特性キーの検証。
export function sanitizeTraits(value: unknown): GdBehaviorTrait[] {
  if (!Array.isArray(value)) return [];
  const out: GdBehaviorTrait[] = [];
  for (const v of value) {
    if (typeof v === 'string' && (TRAIT_KEYS as string[]).includes(v)) {
      if (!out.includes(v as GdBehaviorTrait)) out.push(v as GdBehaviorTrait);
    }
    if (out.length >= 2) break;
  }
  return out;
}
