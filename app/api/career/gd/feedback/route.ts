// PASSAI 就活版 — GD フィードバック生成 route（ステートレス）。
//
// 役割: GD 全ログから各参加者の個別フィードバックを生成し、
//   - 軸別スコア（AI）→ 合計スコア（サーバ計算）→ 企業評価 S/A/B/C/D（サーバ写像）
//   - 行動特性（AI・列挙で検証）
//   - matchingHints（本人ぶん・他機能連携用）
//   - ranking（マルチのみ。ソロは付けない）
//   を返す。DB / 課金 / usage 非接続。合計・順位・合否は AI に作らせない（score_contract 準拠）。

import type {
  GdParticipant,
  GdUtterance,
  GdRole,
  GdCompanyGrade,
  GdAxisScores,
  GdParticipantFeedback,
  GdRankingEntry,
  GdMatchingHints,
  GdParticipationMode,
} from '@/types/careerGd';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import {
  CAREER_GD_MODEL,
  buildFeedbackSystem,
  buildFeedbackUser,
  clampScore,
  sanitizeTraits,
} from '../gdPrompt';

export const maxDuration = 80;

const ROLES: GdRole[] = ['facilitator', 'scribe', 'timekeeper', 'presenter', 'member'];

// 合計スコアの重み（合計 1.0）。発言量(volume)は最適域評価のため軽め。
const WEIGHTS: Record<keyof GdAxisScores, number> = {
  logic: 0.25,
  drive: 0.2,
  cooperation: 0.15,
  roleExecution: 0.15,
  listening: 0.15,
  volume: 0.1,
};

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

// 軸別スコアから合計スコア（0〜100）を決定的に算出する。
function computeTotal(axis: GdAxisScores): number {
  let total = 0;
  (Object.keys(WEIGHTS) as (keyof GdAxisScores)[]).forEach((k) => {
    total += axis[k] * WEIGHTS[k];
  });
  return Math.round(total);
}

// 合計スコア → 企業評価ランクの決定的写像。
function toGrade(total: number): GdCompanyGrade {
  if (total >= 85) return 'S';
  if (total >= 70) return 'A';
  if (total >= 55) return 'B';
  if (total >= 40) return 'C';
  return 'D';
}

function normalizeParticipant(raw: unknown): GdParticipant | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const p: GdParticipant = {
    id: r.id,
    type: r.type === 'ai' ? 'ai' : 'user',
    displayName: str(r.displayName) || '参加者',
    role: ROLES.includes(r.role as GdRole) ? (r.role as GdRole) : 'member',
  };
  if (r.isSelf === true) p.isSelf = true;
  return p;
}

function normalizeTranscript(raw: unknown): GdUtterance[] {
  if (!Array.isArray(raw)) return [];
  const out: GdUtterance[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.participantId !== 'string') continue;
    out.push({
      id: r.id,
      participantId: r.participantId,
      content: str(r.content),
      createdAt: str(r.createdAt),
      ...(r.kind === 'system' ? { kind: 'system' as const } : {}),
    });
  }
  return out;
}

function axisFrom(raw: unknown): GdAxisScores {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    logic: clampScore(r.logic),
    cooperation: clampScore(r.cooperation),
    volume: clampScore(r.volume),
    roleExecution: clampScore(r.roleExecution),
    drive: clampScore(r.drive),
    listening: clampScore(r.listening),
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
    theme?: { title?: unknown; description?: unknown };
    participants?: unknown;
    transcript?: unknown;
    participationMode?: unknown;
  };

  const theme = { title: str(b.theme?.title), description: str(b.theme?.description) };
  if (!theme.title) {
    return Response.json({ error: 'テーマがありません。' }, { status: 400 });
  }
  const participants = Array.isArray(b.participants)
    ? b.participants.map(normalizeParticipant).filter((p): p is GdParticipant => p !== null)
    : [];
  const self = participants.find((p) => p.isSelf);
  if (!self) {
    return Response.json({ error: '本人（自分）の参加者が特定できません。' }, { status: 400 });
  }
  const transcript = normalizeTranscript(b.transcript);
  if (transcript.filter((u) => u.participantId === self.id && u.kind !== 'system').length === 0) {
    return Response.json({ error: '自分の発言がありません。' }, { status: 409 });
  }
  const participationMode: GdParticipationMode =
    b.participationMode === 'multi' ? 'multi' : 'solo';

  const system = buildFeedbackSystem();
  const user = buildFeedbackUser({
    theme,
    participants,
    transcript,
    selfParticipantId: self.id,
    selfRole: self.role,
  });

  try {
    let parsed: Record<string, unknown> | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: CAREER_GD_MODEL,
          max_tokens: 4096,
          temperature: attempt === 2 ? 0 : 0.4,
          system,
          messages: [{ role: 'user', content: user }],
        },
        { signal: createTimeoutSignal() },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';
      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_GD_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }
      try {
        parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
        if (Array.isArray(parsed.feedbacks)) break;
        parsed = null;
      } catch {
        parsed = null;
      }
      if (attempt === 2 && !parsed) {
        return Response.json(
          { error: 'AI_GD_PARSE_FAILED', detail: '評価を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }
    if (!parsed) {
      return Response.json(
        { error: 'AI_GD_PARSE_FAILED', detail: '評価を解釈できませんでした。' },
        { status: 502 },
      );
    }

    const rawFeedbacks = Array.isArray(parsed.feedbacks) ? parsed.feedbacks : [];
    const validIds = new Set(participants.map((p) => p.id));

    const feedbacks: GdParticipantFeedback[] = [];
    for (const rf of rawFeedbacks) {
      if (!rf || typeof rf !== 'object') continue;
      const r = rf as Record<string, unknown>;
      const pid = str(r.participantId);
      if (!validIds.has(pid)) continue;
      const axisScores = axisFrom(r.axisScores);
      const totalScore = computeTotal(axisScores);
      const hints = r.crossFeatureHints && typeof r.crossFeatureHints === 'object'
        ? (r.crossFeatureHints as Record<string, unknown>)
        : {};
      const cross: GdParticipantFeedback['crossFeatureHints'] = {};
      if (str(hints.matching)) cross.matching = str(hints.matching);
      if (str(hints.interview)) cross.interview = str(hints.interview);
      if (str(hints.es)) cross.es = str(hints.es);
      if (str(hints.selfAnalysis)) cross.selfAnalysis = str(hints.selfAnalysis);
      feedbacks.push({
        participantId: pid,
        axisScores,
        totalScore,
        companyGrade: toGrade(totalScore),
        companyImpression: str(r.companyImpression),
        behaviorTraits: sanitizeTraits(r.behaviorTraits),
        improvements: strArray(r.improvements),
        nextPracticeTasks: strArray(r.nextPracticeTasks),
        crossFeatureHints: cross,
      });
    }

    const selfFeedback = feedbacks.find((f) => f.participantId === self.id);
    if (!selfFeedback) {
      return Response.json(
        { error: 'AI_GD_PARSE_FAILED', detail: '本人の評価が得られませんでした。' },
        { status: 502 },
      );
    }

    // matchingHints（本人ぶん）。self ブロックが無くても本人 feedback から埋める。
    const selfBlock = parsed.self && typeof parsed.self === 'object'
      ? (parsed.self as Record<string, unknown>)
      : {};
    const matchingHints: GdMatchingHints = {
      behaviorTraits: selfFeedback.behaviorTraits,
      strengthKeywords: strArray(selfBlock.strengthKeywords),
      suggestedEnvironments: strArray(selfBlock.suggestedEnvironments),
      companyGrade: selfFeedback.companyGrade,
      summary: str(selfBlock.matchingSummary) || selfFeedback.companyImpression,
    };

    // ranking（マルチのみ・合計スコア降順）。ソロは付けない。
    let ranking: GdRankingEntry[] | undefined;
    if (participationMode === 'multi') {
      ranking = [...feedbacks]
        .sort((a, b2) => b2.totalScore - a.totalScore)
        .map((f, i) => {
          const p = participants.find((x) => x.id === f.participantId);
          return {
            participantId: f.participantId,
            rank: i + 1,
            totalScore: f.totalScore,
            companyGrade: f.companyGrade,
            reason:
              `${p?.displayName ?? '参加者'}: ` +
              (f.companyImpression || '議論への貢献をもとに順位付けしました。'),
          };
        });
    }

    return Response.json({
      feedbacks,
      selfCompanyGrade: selfFeedback.companyGrade,
      overallSummary: str(parsed.overallSummary),
      matchingHints,
      ...(ranking ? { ranking } : {}),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career GD feedback API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '評価の生成に失敗しました。' },
      { status: 500 },
    );
  }
}
