// PASSAI 就活版 — 就活相談AI（司令塔）API（最小・ステートレス）
//
// 役割: /career/consultation から呼ばれ、就活全体の司令塔として相談に構造化 JSON で答える。
//   - 受験版 /api/tutor の「multi-turn 会話 + 横断コンテキスト要約 + system prompt cache」構造を
//     踏襲しつつ、DB / Supabase / 課金 / usage には一切接続しない（会話履歴はクライアントが送る）。
//   - プロンプトは就活版共通基盤（@/lib/careerAi）経由（featureKey=career-consultation）。
//   - 受験版 tutorContext / tutorPrompt / billing は import しない（受験版非依存）。

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
import { normalizeCompanyResearchSnapshot } from '@/lib/careerCompanyResearch/context';
import {
  normalizeGdConsultationSnapshot,
  normalizeGdRoomSignal,
  type GdConsultationSnapshot,
  type GdRoomSignalSnapshot,
} from '@/lib/careerGd/context';
import {
  normalizeMatchingConsultationSnapshot,
  type MatchingConsultationSnapshot,
} from '@/lib/careerMatching/consultationContext';
import {
  normalizeSelfAnalysisHistory,
  normalizeEsHistory,
  normalizeInterviewHistory,
  normalizePresentationHistory,
  compressCareerActivityForConsultation,
} from '@/lib/careerConsultation/historySnapshots';
// P15-D: Personal Memory 由来の横断 context 組み立て + system prompt 組み立ては pure builder へ抽出。
//   Event Signal は本 route が現行どおり resolve し、builder へ block 文字列として渡す（境界維持）。
import { buildConsultationSystemPrompt } from './consultationPrompt';
// Batch 1: base context（profile/activity/values）を canary + Source-Sync verified のときだけ
//   Layer 1 server read へ切り替える。未証明・非 canary では従来どおり request body bridge。
import { resolveConsultationContextInputs } from './resolveContextInputs';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
// P10-D: L2 Event Signal を「最近の準備状況を踏まえた次アクション提案の補助」としてのみ描画する。
//   構造化 summary（bucket/band のみ）を server 側で固定ラベルへ render する（生 JSON は prompt に出さない）。
// P10-F: server-authoritative な guard で解決する（無効なら client 強制 body を無視して空文字）。
import { resolveConsultationEventSignalsBlock } from '@/lib/careerMemory/renderEventSignals';
import { isConsultationEventSignalPilotEnabled } from '@/lib/careerMemory/eventSignalPilotGuard';
// P17-E: Layer 4 Aggregated Insight の consultation shadow read（fire-and-forget・prompt/response 不変）。
//   flag OFF（code default）では DB query 0。gate 通過時のみ synthetic shadow を実行し safe evidence を記録。
import { dispatchAggregatedInsightConsultationShadow } from '@/lib/careerAggregate/shadowDispatcher.server';
// P4-B: str を共通 util へ集約（strArray は route 固有のため local 維持・内部で共通 str を使用）。
import { str } from '@/lib/careerMemory/summaryUtils';

const MODEL = 'claude-sonnet-4-6';
export const maxDuration = 80;

const MAX_MESSAGE_LENGTH = 1000;
const HISTORY_MAX_TURNS = 10;

// P15-D: 司令塔 persona / 出力形式 / Personal Memory 由来の横断 renderer は
//   ./consultationPrompt（buildConsultationSystemPrompt）と
//   lib/careerMemory/renderers/consultationCrossFeature へ移設した（byte-identical）。
//   本 route は request 検証・正規化・Event Signal resolve・AI 実行・response 正規化に専念する。

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v) => v !== '');
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
    // P10-D: L2 Event Signal（構造化 summary。client の member 時のみ付与・supplemental）。
    eventSignals?: unknown;
  };

  const message = str(b.message);
  if (!message) {
    return Response.json({ error: 'メッセージを入力してください。' }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: 'メッセージが長すぎます。' }, { status: 400 });
  }

  const history = sanitizeHistory(b.history);

  // STEP-CONSULT-06: 最新3件の推移スナップショット（新クライアント）。
  // 無ければ旧クライアント互換で「最新1件」ブロックにフォールバックする（block 化は builder 側）。
  const selfAnalysisHistory = normalizeSelfAnalysisHistory(b.selfAnalysisHistory);
  const esHistory = normalizeEsHistory(b.esHistory);
  const interviewHistory = normalizeInterviewHistory(b.interviewHistory);
  const presentationHistory = normalizePresentationHistory(b.presentationHistory);
  // 保存済み企業研究（最大5件・軽量スナップショット）。
  const companyResearch: CompanyResearchSnapshot[] = Array.isArray(b.companyResearch)
    ? b.companyResearch
        .map((s) => normalizeCompanyResearchSnapshot(s))
        .filter((s): s is CompanyResearchSnapshot => s !== null)
        .slice(0, 5)
    : [];
  // 直近のGD練習結果（最新2件）。
  const gdSnapshots = Array.isArray(b.gd)
    ? b.gd
        .map((s) => normalizeGdConsultationSnapshot(s))
        .filter((s): s is GdConsultationSnapshot => s !== null)
        .slice(0, 3)
    : [];
  // STEP-GD-17: マルチGD の 6 軸評価（最新3件・圧縮・断定回避）。
  const gdRoomSignals = Array.isArray(b.gdRoom)
    ? b.gdRoom
        .map((s) => normalizeGdRoomSignal(s))
        .filter((s): s is GdRoomSignalSnapshot => s !== null)
        .slice(0, 3)
    : [];
  // STEP-CONSULT-03: 企業マッチング結果（最新2件・軽量スナップショット）。
  const matchingSnapshots = Array.isArray(b.matching)
    ? b.matching
        .map((s) => normalizeMatchingConsultationSnapshot(s))
        .filter((s): s is MatchingConsultationSnapshot => s !== null)
        .slice(0, 2)
    : [];

  // P10-D/F: L2 Event Signal（最下位・補助ブロック）。★ Orchestrator へは入れず route が現行どおり resolve する。
  //   P10-F guard が無効なら client が eventSignals を強制付与していても server 側で無視して空文字
  //   （renderer 非実行・迂回不可）。有効時のみ render し、summary が無い / 不正 / 描画不能なら空文字。
  //   空文字は builder 内の filter で除去され Signal なし prompt は完全不変（既存 golden 維持）。
  const eventSignalsBlock = resolveConsultationEventSignalsBlock(
    isConsultationEventSignalPilotEnabled(),
    b.eventSignals,
  );

  // 就活版共通基盤 + 司令塔 persona + Personal Memory 横断（Orchestrator 経由）+ Event Signal（現行位置）を
  //   pure builder で組む。activity は相談用に圧縮（各配列3件・各文字列160字）してから渡す。
  // Batch 1: canary + purpose ON + Source-Sync verified のときだけ server Layer 1 由来の base を使う。
  //   ★ activity は server 由来でも **同じ圧縮** を通す（context size を従来と同条件に保つ）。
  // Batch 2（`D-S6`）: base に加えて cross-feature も kind 単位で server / bridge を選ぶ。
  //   gd / gdRoom / eventSignals は対象外（mirror 非対象 / Layer 3）。
  const ctx = await resolveConsultationContextInputs(
    {
      profile: b.profile ?? null,
      activity: b.activity ?? null,
      values: b.values ?? null,
      selfAnalysisHistory,
      esHistory,
      interviewHistory,
      presentationHistory,
      companyResearch,
      matching: matchingSnapshots,
    },
    req,
  );
  const systemPrompt = buildConsultationSystemPrompt({
    profile: ctx.profile,
    activity: compressCareerActivityForConsultation(
      ctx.activity as Parameters<typeof compressCareerActivityForConsultation>[0],
    ) as CareerActivityInput | null,
    values: ctx.values,
    crossFeature: {
      selfAnalysis: b.selfAnalysis ?? null,
      es: b.es ?? null,
      interviewResult: b.interviewResult ?? null,
      presentationResult: b.presentationResult ?? null,
      selfAnalysisHistory: ctx.selfAnalysisHistory as typeof selfAnalysisHistory,
      esHistory: ctx.esHistory as typeof esHistory,
      interviewHistory: ctx.interviewHistory as typeof interviewHistory,
      presentationHistory: ctx.presentationHistory as typeof presentationHistory,
      companyResearch: ctx.companyResearch as typeof companyResearch,
      gd: gdSnapshots,
      gdRoom: gdRoomSignals,
      matching: ctx.matching as typeof matchingSnapshots,
    },
    eventSignalsBlock,
  });

  // P17-E: shadow read（本処理と独立・fire-and-forget）。systemPrompt / messages / response は不変。
  //   flag OFF では即 return（DB query 0）。shadow の失敗は consultation 本処理へ影響しない。
  void dispatchAggregatedInsightConsultationShadow({
    runId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  });

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
