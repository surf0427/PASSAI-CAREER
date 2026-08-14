// PASSAI 就活版 — GD Phase2 マルチGD 本格 feedback 採点（STEP-GD-15・server-only）。
//
// 役割: room の messages 本文を根拠に、人間参加者のみを AI で評価する。
//   - AI は 6 軸の 0〜100 スコア + 根拠テキスト（強み/弱み/改善/良かった発言抜粋）+ 就活マッチング傾向を返す。
//   - 合計スコア(overallScore) / ランク(S〜D) / 企業コミュ適性グレード は AI に決めさせず、
//     server が axisScores から**決定論**で算出する（AI の自由判断でランクを付けない）。
//   - goodQuotes は「実際の発言抜粋」であることを server 側で検証（本文に含まれない引用は捨てる）。
//   - 発言量は補助指標のみ。評価の主根拠は発言本文。空議論・本人発言0件は採点不能扱い（呼び出し側）。
//
// AI participant は採点対象外（文脈としてのみ渡す）。
// ステートレスな純ロジック + AI 呼び出し。DB 操作は呼び出し側（result route）が行う。

import 'server-only';
import type {
  GdCompanyGrade,
  CareerGdAxisKey,
  CareerGdAxisScores,
  CareerGdRoomOverallEvaluation,
  CareerGdRoomRoleEstimate,
} from '@/types/careerGd';
import { anthropic, extractJson } from '@/lib/ai';
import {
  AI_BUDGET_PRESET_80S_WALL,
  createAiCallBudget,
  createTimeoutSignal,
} from '@/lib/aiTimeout';
import { CAREER_GD_MODEL } from '../gdPrompt';
import { CAREER_GD_EVAL_AXIS_LABELS } from '@/app/career/gd/gdRoles';

// ラベルは gdRoles.ts が単一ソース（client/server 共通）。desc は採点プロンプト専用。
const AXIS_DESCS: Record<CareerGdAxisKey, string> = {
  logicalThinking: '話の筋が通っているか・根拠があるか・因果関係が明確か',
  collaboration: '他者の意見に反応したか・傾聴できたか・議論を促進したか',
  initiative: '議論を動かしたか・発言をリードしたか',
  creativity: '新しい視点を出したか・アイデアの量があるか',
  persuasiveness: '発言に納得感があるか・具体的か',
  discussionSkill: '全体を見ているか・話題を整理したか・時間を意識したか',
};

export const CAREER_GD_EVAL_AXES: { key: CareerGdAxisKey; label: string; desc: string }[] = (
  Object.keys(AXIS_DESCS) as CareerGdAxisKey[]
).map((key) => ({ key, label: CAREER_GD_EVAL_AXIS_LABELS[key], desc: AXIS_DESCS[key] }));

const CAREER_GD_AXIS_LABELS = CAREER_GD_EVAL_AXIS_LABELS;

// 合計スコアの重み（合計 1.0）。論理性・説得力をやや重視しつつ全軸を評価に反映。
const OVERALL_WEIGHTS: Record<CareerGdAxisKey, number> = {
  logicalThinking: 0.2,
  persuasiveness: 0.2,
  discussionSkill: 0.15,
  collaboration: 0.15,
  initiative: 0.15,
  creativity: 0.15,
};

// 企業コミュ適性（会議・顧客折衝・チーム業務との相性）の重み。協調性・説得力・GD適応力を重視。
const COMM_WEIGHTS: Record<CareerGdAxisKey, number> = {
  collaboration: 0.3,
  persuasiveness: 0.25,
  discussionSkill: 0.25,
  logicalThinking: 0.2,
  initiative: 0,
  creativity: 0,
};

// ── 決定論スコアリング ─────────────────────────────────────────────

function clamp100(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(100, Math.max(0, n)));
}

export function normalizeAxisScores(raw: unknown): CareerGdAxisScores {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    logicalThinking: clamp100(r.logicalThinking),
    collaboration: clamp100(r.collaboration),
    initiative: clamp100(r.initiative),
    creativity: clamp100(r.creativity),
    persuasiveness: clamp100(r.persuasiveness),
    discussionSkill: clamp100(r.discussionSkill),
  };
}

function weightedScore(axis: CareerGdAxisScores, weights: Record<CareerGdAxisKey, number>): number {
  let total = 0;
  (Object.keys(weights) as CareerGdAxisKey[]).forEach((k) => {
    total += axis[k] * weights[k];
  });
  return Math.round(total);
}

export function computeOverallScore(axis: CareerGdAxisScores): number {
  return weightedScore(axis, OVERALL_WEIGHTS);
}

// 0〜100 → S/A/B/C/D の決定論写像（90+ S / 80+ A / 70+ B / 60+ C / else D）。
export function toRank(score: number): GdCompanyGrade {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}

// 企業コミュ適性グレード（就活: 会議/顧客折衝/チーム業務との相性）。決定論。
export function computeCommunicationGrade(axis: CareerGdAxisScores): GdCompanyGrade {
  return toRank(weightedScore(axis, COMM_WEIGHTS));
}

// goodQuotes を「実際の発言抜粋」に限定する（本文に含まれない引用＝AI 捏造を捨てる）。
export function verifyQuotes(quotes: unknown, ownMessages: string[]): string[] {
  if (!Array.isArray(quotes)) return [];
  const haystack = ownMessages.join('\n');
  const norm = (s: string) => s.replace(/\s+/g, '').replace(/[「」『』"”“]/g, '');
  const normHay = norm(haystack);
  const out: string[] = [];
  for (const q of quotes) {
    if (typeof q !== 'string') continue;
    const t = q.trim().slice(0, 120);
    if (!t) continue;
    // 引用符を除いた正規化ベースで本文に含まれるものだけ採用。
    if (normHay.includes(norm(t)) && !out.includes(t)) out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}

// ── プロンプト ─────────────────────────────────────────────────────

const EVAL_BASE = [
  'あなたは新卒採用の選考で、学生のグループディスカッション（GD）を観察・評価する採用担当者です。',
  '大学受験（総合型選抜・学校推薦型選抜・一般入試）の文脈や大学の評価軸は一切持ち込みません。',
  '評価は「優しいが甘すぎない」姿勢で、企業のGD選考で実際に見られる観点に沿って行います。',
  '煽り・人格否定はせず、就活生の成長を支援する建設的なトーンを保ちます。',
  '重要: 評価は必ず「実際の発言内容」を根拠にします。根拠のない称賛・根拠のない批判はしません。',
  '数値の合計スコア・ランク・合否はあなたが決めません（サーバが算出します）。各軸の0〜100スコアと根拠のみ返します。',
].join('\n');

export function buildRoomFeedbackSystem(): string {
  return [
    EVAL_BASE,
    '',
    '評価軸（各0〜100で採点）:',
    ...CAREER_GD_EVAL_AXES.map((a) => `- ${a.key}（${a.label}）: ${a.desc}`),
    '',
    '採点の注意:',
    '- 発言の「量」だけで判断しない。少ない発言でも質が高ければ高く、多くても中身がなければ低く採点する。',
    '- 発言が全く無い、または議論が成立していない参加者は、当該軸を低め（0〜30目安）にし、根拠に「発言が少ない/確認できない」と明記する。',
  ].join('\n');
}

type PromptParticipant = { participantId: string; displayName: string; isAi: boolean };
type PromptUtterance = { participantId: string; content: string; kind: 'speech' | 'system' };

// ⑭ コスト・トークン対策: AI へ渡す発言ログの上限。1 発言あたり・全体の文字数を制限し、
// 超過時は「古い発言」から落として最新側を残す（議論の結論に近い部分を優先）。
const TRANSCRIPT_MAX_CHARS = 24000;
const MSG_MAX_CHARS = 600;

// 発言ログを整形しつつ上限内に収める。truncated=true なら一部を省略している。
function buildTranscript(
  participants: PromptParticipant[],
  transcript: PromptUtterance[],
): { text: string; truncated: boolean } {
  if (transcript.length === 0) return { text: '（発言はありません）', truncated: false };
  const nameOf = (id: string) => {
    const p = participants.find((x) => x.participantId === id);
    return p ? `${p.displayName}${p.isAi ? '(AI)' : '(人間)'}` : '参加者';
  };
  const all = transcript.map((u) =>
    u.kind === 'system'
      ? `【進行】${u.content.slice(0, MSG_MAX_CHARS)}`
      : `${nameOf(u.participantId)}: ${u.content.slice(0, MSG_MAX_CHARS)}`,
  );
  // 末尾（最新）から上限まで詰め、超えたら古い側を落とす。
  const kept: string[] = [];
  let total = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const line = all[i];
    const len = line.length + 1;
    if (total + len > TRANSCRIPT_MAX_CHARS && kept.length > 0) break;
    kept.push(line);
    total += len;
  }
  kept.reverse();
  const truncated = kept.length < all.length;
  const lines = truncated ? ['（前半の発言は文字数上限のため省略）', ...kept] : kept;
  return { text: lines.join('\n'), truncated };
}

// ── 文字列正規化ヘルパー（overall 評価用）─────────────────────────────
function s(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function sArr(v: unknown, max = 3): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, max);
}

export function buildRoomFeedbackUser(input: {
  theme: { title: string; description: string; constraints?: string[] };
  humans: PromptParticipant[]; // 評価対象（人間のみ）
  ais: PromptParticipant[]; // 文脈のみ（採点対象外）
  transcript: PromptUtterance[];
}): string {
  const allParticipants = [...input.humans, ...input.ais];
  const lines = [
    `GD テーマ: ${input.theme.title}`,
    input.theme.description,
  ];
  if (input.theme.constraints && input.theme.constraints.length > 0) {
    lines.push('与件:', ...input.theme.constraints.map((c) => `- ${c}`));
  }
  lines.push(
    '',
    '評価対象（この人たちだけを採点する。AI参加者は文脈用で採点しない）:',
    ...input.humans.map((h) => `- id="${h.participantId}" ${h.displayName}`),
    '',
    'GD のやり取り（全ログ）:',
    buildTranscript(allParticipants, input.transcript).text,
    '',
    '上記の発言内容を根拠に、評価対象の各人について評価してください。',
    'goodQuotes は評価対象本人の「実際の発言」からの短い抜粋のみ（作文しない・言い換えない・原文どおり）。',
    'matchingHints は就活のマッチング傾向（例: 戦略コンサル/営業/PM/マーケ/人事 との相性）。',
    '  ただし断定は禁止。「傾向として〜の可能性がある」レベルの表現に必ず留める。1〜3個。',
    'overall は議論そのもの（room 全体）への評価。roleEstimates は評価対象（人間）の役割傾向を、',
    '  発言の根拠がある範囲でのみ推定する（断定しない・根拠が薄ければ空配列でよい・AI参加者は含めない）。',
    '',
    '出力は次の JSON のみ（前後に説明文やコードブロック記号を付けない）:',
    '{',
    '  "participants": [',
    '    {',
    '      "participantId": string,',
    '      "axisScores": { "logicalThinking": 0-100, "collaboration": 0-100, "initiative": 0-100, "creativity": 0-100, "persuasiveness": 0-100, "discussionSkill": 0-100 },',
    '      "strengths": string[],        // 実発言が根拠（1〜3個）',
    '      "weaknesses": string[],       // 実発言が根拠（1〜3個）',
    '      "improvements": string[],     // 建設的な改善提案（1〜3個）',
    '      "goodQuotes": string[],       // 本人の実発言の短い抜粋（0〜3個・原文）',
    '      "overallComment": string,     // 就活視点の総合講評（2〜3文・断定しすぎない）',
    '      "matchingHints": string[],    // 就活マッチング傾向（1〜3個・断定禁止）',
    '      "matchingSummary": string     // 相談AI等へ渡す1〜2文の要約',
    '    }',
    '    // ... 評価対象の人数分',
    '  ],',
    '  "overall": {',
    '    "summary": string,              // 議論全体の要約（2〜4文）',
    '    "pointOrganization": string,    // 論点整理ができていたか（1〜2文）',
    '    "conclusionClarity": string,    // 結論が明確だったか（1〜2文）',
    '    "processComment": string,       // 議論の進め方（時間配分・役割分担など・1〜2文）',
    '    "goodPoints": string[],         // 議論全体として良かった点（1〜3個）',
    '    "improvements": string[],       // 議論全体の改善点（1〜3個）',
    '    "nextThemes": string[],         // 次回の練習テーマ（1〜3個）',
    '    "roleEstimates": [              // 役割傾向（人間のみ・根拠が薄ければ [] ・断定しない）',
    '      { "participantId": string, "role": "進行役|アイデア出し役|分析役|調整役|結論形成役|傾聴支援役 等", "note": string }',
    '    ]',
    '  }',
    '}',
  );
  return lines.join('\n');
}

// AI overall 出力 → 正規化済み CareerGdRoomOverallEvaluation（人間のみ・上限・断定回避）。
// 中身が空なら null（UI 非表示）。roleEstimates は既知の人間 participantId のみ採用。
export function normalizeRoomOverall(
  raw: unknown,
  humans: { participantId: string; displayName: string }[],
  truncated: boolean,
): CareerGdRoomOverallEvaluation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const nameByPid = new Map(humans.map((h) => [h.participantId, h.displayName]));
  const roleEstimates: CareerGdRoomRoleEstimate[] = (Array.isArray(r.roleEstimates) ? r.roleEstimates : [])
    .map((e): CareerGdRoomRoleEstimate | null => {
      if (!e || typeof e !== 'object') return null;
      const o = e as Record<string, unknown>;
      const pid = s(o.participantId);
      const displayName = nameByPid.get(pid);
      if (!pid || !displayName) return null; // 人間のみ・存在する pid のみ（AI/捏造を除外）
      const role = s(o.role).slice(0, 24);
      if (!role) return null;
      const note = s(o.note).slice(0, 120);
      return { participantId: pid, displayName, role, ...(note ? { note } : {}) };
    })
    .filter((x): x is CareerGdRoomRoleEstimate => x !== null)
    .slice(0, humans.length);

  const overall: CareerGdRoomOverallEvaluation = {
    version: 1,
    summary: s(r.summary).slice(0, 800),
    pointOrganization: s(r.pointOrganization).slice(0, 600),
    conclusionClarity: s(r.conclusionClarity).slice(0, 600),
    processComment: s(r.processComment).slice(0, 600),
    goodPoints: sArr(r.goodPoints),
    improvements: sArr(r.improvements),
    nextThemes: sArr(r.nextThemes),
    roleEstimates,
    ...(truncated ? { truncated: true } : {}),
  };
  const hasContent =
    overall.summary ||
    overall.pointOrganization ||
    overall.conclusionClarity ||
    overall.processComment ||
    overall.goodPoints.length > 0 ||
    overall.improvements.length > 0 ||
    overall.nextThemes.length > 0 ||
    overall.roleEstimates.length > 0;
  return hasContent ? overall : null;
}

// AI 呼び出し（parse 失敗時のみ temperature 0 で 1 回再試行）。
export async function generateRoomFeedback(input: {
  theme: { title: string; description: string; constraints?: string[] };
  humans: PromptParticipant[];
  ais: PromptParticipant[];
  transcript: PromptUtterance[];
}): Promise<{
  participants: Record<string, unknown>[];
  overall: Record<string, unknown> | null;
  truncated: boolean;
} | null> {
  const system = buildRoomFeedbackSystem();
  const user = buildRoomFeedbackUser(input);
  // overall（議論全体）ぶんの出力余地を確保するため上限を少し引き上げる（STEP-GD-27）。
  const { truncated } = buildTranscript([...input.humans, ...input.ais], input.transcript);
  // AI 合計時間予算（wall 80s の内側に固定）。retry ごとに満額 signal を再発行すると
  // 合計が wall を超えて 504（非JSON）になり、client には汎用エラーしか見えなくなる。
  const aiBudget = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const callTimeoutMs = aiBudget.nextCallTimeoutMs();
    // 残予算が retry に足りない → retry せず打ち切る（wall 超過による 504 を防ぐ）。
    if (callTimeoutMs === null) {
      return null;
    }
    const message = await anthropic.messages.create(
      {
        model: CAREER_GD_MODEL,
        max_tokens: 5120,
        temperature: attempt === 2 ? 0 : 0.4,
        system,
        messages: [{ role: 'user', content: user }],
      },
      { signal: createTimeoutSignal(callTimeoutMs) },
    );
    if (message.stop_reason === 'max_tokens') {
      if (attempt === 2) return null;
      continue;
    }
    const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';
    try {
      const parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
      if (Array.isArray(parsed.participants)) {
        // overall はオプション（欠落しても per-person 評価は成立させる＝非破壊）。
        const overall =
          parsed.overall && typeof parsed.overall === 'object'
            ? (parsed.overall as Record<string, unknown>)
            : null;
        return { participants: parsed.participants as Record<string, unknown>[], overall, truncated };
      }
    } catch {
      /* retry */
    }
  }
  return null;
}

// ── 相談AI 連携用の圧縮サマリー ────────────────────────────────────

const GRADE_LABEL: Record<GdCompanyGrade, string> = { S: 'かなり高い', A: '高い', B: '標準', C: 'やや課題', D: '課題あり' };

// GD結果を相談AI / careerMatching 等へ渡すための短い自然文サマリーを作る（保存可）。
export function generateCareerGdSummary(input: {
  themeTitle: string;
  displayName: string;
  scored: boolean;
  axisScores: CareerGdAxisScores;
  overallScore: number;
  rank: GdCompanyGrade;
  companyCommunicationGrade: GdCompanyGrade;
  strengths: string[];
  improvements: string[];
  matchingHints: string[];
}): string {
  if (!input.scored) {
    return `GD「${input.themeTitle}」では発言が十分に確認できず、採点は保留（採点不能）。次回は自分の考えを言葉にすることが最初の一歩。`;
  }
  const topAxes = (Object.keys(input.axisScores) as CareerGdAxisKey[])
    .sort((a, b) => input.axisScores[b] - input.axisScores[a])
    .slice(0, 2)
    .map((k) => `${CAREER_GD_AXIS_LABELS[k]}${input.axisScores[k]}`)
    .join('・');
  const parts = [
    `GD「${input.themeTitle}」の評価: 総合${input.overallScore}点（ランク${input.rank}）。`,
    `特に高い軸: ${topAxes}。`,
    `企業コミュニケーション適性: ${input.companyCommunicationGrade}（${GRADE_LABEL[input.companyCommunicationGrade]}）。`,
  ];
  if (input.strengths.length) parts.push(`強み: ${input.strengths.slice(0, 2).join(' / ')}。`);
  if (input.improvements.length) parts.push(`改善余地: ${input.improvements.slice(0, 2).join(' / ')}。`);
  if (input.matchingHints.length) parts.push(`就活傾向: ${input.matchingHints.slice(0, 2).join(' / ')}。`);
  return parts.join('');
}
