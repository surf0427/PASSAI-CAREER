// PASSAI 就活版 — GD Phase2 マルチGD 本格結果 API（STEP-GD-15）。
//
// POST /api/career/gd/room/[roomId]/result
//   - member ログイン必須。room 参加者（人間）のみ。room.status='finished' のときだけ。
//   - **messages 本文を根拠に AI で評価**（発言量ベースの暫定評価は廃止）。
//   - 評価対象は人間参加者のみ。AI participant は採点対象外（文脈のみ）。
//   - 6 軸(0〜100) は AI、overallScore/ランク/企業コミュ適性グレードは server が決定論算出。
//   - goodQuotes は実発言に含まれるものだけ採用（捏造引用を除去）。空議論・本人発言0件は採点不能。
//   - 初回呼び出しで room 内の全人間ぶんを評価・upsert（ranking を全員で共有・一貫化）。
//     既に評価済み(version=2)の本人行があれば AI を再呼び出しせず返す（二重実行に強い）。
//   - career_gd_room_results の既存カラムを活用（self_feedback / ranking / matching_hints /
//     self_company_grade / overall_summary）。jsonb 拡張のみで既存データは壊さない。
//   - 応答に service_role key / pepper / env 値は含めない。

import type {
  GdCompanyGrade,
  CareerGdEvaluation,
  CareerGdRankingEntry,
  CareerGdMatchingHints,
  CareerGdRoomResultView,
  CareerGdRoomOverallEvaluation,
} from '@/types/careerGd';
import {
  authenticateGdMember,
  getGdAdmin,
  isUndefinedTable,
  dbNotAppliedResponse,
} from '../../roomAuth';
import { loadRoomMessages } from '../../roomMessages';
import {
  generateRoomFeedback,
  normalizeAxisScores,
  computeOverallScore,
  toRank,
  computeCommunicationGrade,
  verifyQuotes,
  generateCareerGdSummary,
  normalizeRoomOverall,
} from '../../roomFeedback';

import { requireCareerGdEnabled } from '@/lib/careerGdGate/flags.server';
import { enforceRateLimit, CAREER_GD_RATE_LIMITS } from '@/lib/rateLimit';
import { enforceCareerDailyQuota } from '@/lib/careerQuota/enforce';
import { requireCareerAiAccessForUser } from '@/lib/careerBilling/aiAccess';
import { reportGdFailure } from '../../../gdObservability';
import { resolveGdContextInputs } from '../../../resolveContextInputs';
import { resolveGdCompanyOfficial } from '../../../resolveCompanyOfficial';
import { buildGdSpinePrompt } from '../../../gdSpinePrompt';
export const maxDuration = 80;

type Row = Record<string, unknown>;

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

/**
 * STEP-GD-31: room から「企業指定」を取り出す（現状は常に未指定）。
 *
 * career_gd_rooms には企業列が無く、GD の開始 UX を変えないため列も UI も追加していない
 * （要件 27）。theme jsonb に将来 `companyName` / `companyId` を持たせたときに
 * **ここ 1 箇所だけ**を変えれば Company Data Spine が通電するようにしてある。
 * 推測で企業を当てはめない（誤った企業の事実を評価へ混ぜる方が有害）。
 */
function gdCompanyTarget(roomRow: Row): { companyId: string | null; companyName: string | null } | null {
  const theme = roomRow.theme && typeof roomRow.theme === 'object' ? (roomRow.theme as Row) : null;
  const companyName = theme && typeof theme.companyName === 'string' ? theme.companyName.trim() : '';
  const companyId = theme && typeof theme.companyId === 'string' ? theme.companyId.trim() : '';
  if (!companyName && !companyId) return null;
  return { companyId: companyId || null, companyName: companyName || null };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function strArray(v: unknown, max = 3): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, max);
}

// 採点不能（空議論・本人発言0件）の評価を作る。
function unscoredEvaluation(selfCount: number, totalCount: number, reason: string): CareerGdEvaluation {
  return {
    version: 2,
    scored: false,
    unscoredReason: reason,
    axisScores: { logicalThinking: 0, collaboration: 0, initiative: 0, creativity: 0, persuasiveness: 0, discussionSkill: 0 },
    overallScore: 0,
    rank: 'D',
    companyCommunicationGrade: 'D',
    strengths: [],
    weaknesses: [],
    improvements: ['まずは自分の考えを一言でも発言することから始めましょう。'],
    goodQuotes: [],
    overallComment: '今回は発言が十分に確認できなかったため、採点は保留しています。次回はまず発言することを目標にしましょう。',
    speechCount: selfCount,
    totalSpeechCount: totalCount,
  };
}

// DB 行 → クライアント結果表現。
function toResultView(roomId: string, row: Row): CareerGdRoomResultView {
  const evaluation = (row.self_feedback && typeof row.self_feedback === 'object' ? row.self_feedback : {}) as CareerGdEvaluation;
  const ranking = Array.isArray(row.ranking) ? (row.ranking as CareerGdRankingEntry[]) : [];
  const mh = (row.matching_hints && typeof row.matching_hints === 'object' ? row.matching_hints : {}) as Partial<CareerGdMatchingHints>;
  return {
    roomId,
    participantId: str(row.participant_id),
    displayName: str((row as Row).display_name) || '参加者',
    evaluation,
    ranking,
    matchingHints: { hints: Array.isArray(mh.hints) ? mh.hints : [], summary: str(mh.summary) },
    consultationSummary: str(row.overall_summary),
    createdAt: str(row.created_at),
  };
}

export async function POST(req: Request, ctx: { params: Promise<{ roomId: string }> }) {
  // ── STEP-GD-31: GD kill switch（server flag が最終権限）──
  //    OFF なら body parse / auth / DB / AI へ到達する前に 404。UI flag は権限に影響しない。
  const gdGate = requireCareerGdEnabled();
  if (gdGate) return gdGate;

  const { roomId } = await ctx.params;
  if (!roomId) return jsonError('BAD_REQUEST', 'ルームIDが不正です。', 400);

  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;

  // STEP-GD-31: 評価生成は AI 課金に直結。冪等ではあるが連打の上限を掛ける。
  const limited = await enforceRateLimit(auth.userId, CAREER_GD_RATE_LIMITS.result);
  if (limited) return limited;
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // room。
  const { data: roomRow, error: roomErr } = await admin.from('career_gd_rooms').select('*').eq('id', roomId).maybeSingle();
  if (roomErr) {
    if (isUndefinedTable(roomErr)) return dbNotAppliedResponse();
    console.error('Career GD result: room lookup error', roomErr.message);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  if (!roomRow) return jsonError('ROOM_NOT_FOUND', 'ルームが見つかりません。', 404);
  if ((roomRow as Row).status !== 'finished') {
    return jsonError('ROOM_NOT_FINISHED', 'このルームはまだ終了していません。結果は終了後に表示できます。', 409);
  }

  // members。
  const { data: memberData, error: memberErr } = await admin
    .from('career_gd_room_members').select('*').eq('room_id', roomId).order('joined_at', { ascending: true });
  if (memberErr) {
    if (isUndefinedTable(memberErr)) return dbNotAppliedResponse();
    console.error('Career GD result: members lookup error', memberErr.message);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  const memberRows = (memberData ?? []) as Row[];
  const currentRow = memberRows.find((m) => m.user_id === auth.userId) ?? null;
  if (!currentRow) return jsonError('NOT_A_MEMBER', 'このルームの参加者ではありません。', 403);
  const selfParticipantId = String(currentRow.participant_id);

  // 冪等: 本人の評価済み行(version=2)があれば AI を呼ばずに返す。
  {
    const { data: existing } = await admin
      .from('career_gd_room_results').select('*').eq('room_id', roomId).eq('user_id', auth.userId).maybeSingle();
    const ev = existing?.self_feedback as { version?: number } | undefined;
    if (existing && ev && ev.version === 2) {
      return Response.json({ result: toResultView(roomId, { ...existing, display_name: currentRow.display_name }) });
    }
  }

  // 日次利用回数（PASSAI Career BASIC / GD = 1 セッション 1 回・ソロと共通 bucket）。
  //   ★ operation identity は **room 単位**。room 作成 / 参加 / 発言 / AI 発言 / heartbeat は
  //     消費せず、その room の評価が初めて生成されるときにだけ 1 消費する。
  //   ★ 上の冪等 return（評価済み room の再取得）より**後ろ**に置く＝ AI を呼ばない経路は
  //     消費しない。評価が途中で失敗して再実行しても room が同じなら +0。
  //   ★ roomId は参加者検証済みの server 側の値（client が名乗った id ではない）。
  // 有料ゲート（PASSAI CAREER 単一プラン）。**Quota consume より前**に置く
  //   （未契約者に Quota を消費させない）。
  //   ★ 上の冪等 return（評価済み room の再取得）より後ろに置いてあるので、
  //     既に生成済みの結果を読むだけの経路は契約が切れても閲覧できる。
  //     ここから先は AI を実際に呼ぶので契約が必要。
  const accessDenied = await requireCareerAiAccessForUser(auth.userId);
  if (accessDenied) return accessDenied;

  const quota = await enforceCareerDailyQuota({
    identity: { kind: 'member', userId: auth.userId },
    feature: 'gd',
    operationSource: { roomId },
  });
  if (quota.blocked) return quota.blocked;

  // messages。
  let messageRows: Row[];
  try {
    messageRows = await loadRoomMessages(admin, roomId, null);
  } catch (e) {
    if (isUndefinedTable(e)) return dbNotAppliedResponse();
    console.error('Career GD result: messages load error', e);
    return jsonError('ROOM_FETCH_FAILED', '発言の取得に失敗しました。', 500);
  }

  // 発言集計 + 参加者本文（goodQuotes 検証用）。
  const speechCount = new Map<string, number>();
  const ownMessages = new Map<string, string[]>();
  let totalSpeech = 0;
  for (const msg of messageRows) {
    if (msg.kind === 'system') continue;
    const pid = String(msg.participant_id);
    speechCount.set(pid, (speechCount.get(pid) ?? 0) + 1);
    const arr = ownMessages.get(pid) ?? [];
    arr.push(str(msg.content));
    ownMessages.set(pid, arr);
    totalSpeech += 1;
  }

  const humans = memberRows.filter((m) => m.is_ai !== true && m.left_at == null && m.user_id);
  const ais = memberRows.filter((m) => m.is_ai === true && m.left_at == null);
  const humansWithSpeech = humans.filter((m) => (speechCount.get(String(m.participant_id)) ?? 0) >= 1);

  const theme = (roomRow as Row).theme && typeof (roomRow as Row).theme === 'object' ? ((roomRow as Row).theme as Row) : {};
  const themeInput = {
    title: str(theme.title) || 'グループディスカッション',
    description: str(theme.description),
    constraints: Array.isArray(theme.constraints) ? (theme.constraints as unknown[]).filter((c): c is string => typeof c === 'string') : [],
  };

  // 評価マップ（participantId → CareerGdEvaluation）。
  const evalByPid = new Map<string, CareerGdEvaluation>();
  const matchByPid = new Map<string, CareerGdMatchingHints>();
  // STEP-GD-27: 議論全体（room 全体）の評価。AI 評価が走ったときのみ生成（空議論では null）。
  let overallEvaluation: CareerGdRoomOverallEvaluation | null = null;

  if (humansWithSpeech.length === 0) {
    // 空議論 or 人間の発言0件 → 全員採点不能。
    for (const h of humans) {
      const pid = String(h.participant_id);
      evalByPid.set(pid, unscoredEvaluation(speechCount.get(pid) ?? 0, totalSpeech, '議論の発言が確認できませんでした。'));
      matchByPid.set(pid, { hints: [], summary: '発言が少なくマッチング傾向は判定できませんでした。' });
    }
  } else {
    // ── STEP-GD-31: Data Spine 解決（never-throw / fail-open）──
    //    ★ I/O は route の責務（orchestrator / renderer は純関数）という既存分離を守る。
    //    ★ 解決できなくても評価は必ず成立する（block が '' になり prompt は従来と byte 一致）。
    //    ★ 企業は「呼び出し側が明示指定したときだけ」解決する。GD には企業指定 UI が無いため
    //      現状は常に null（＝一般 GD）。将来 UI が付いたときの受け口として配線だけ通しておく。
    const spineCtx = await resolveGdContextInputs(req);
    const companyOfficial = await resolveGdCompanyOfficial(gdCompanyTarget(roomRow as Row));
    const spine = buildGdSpinePrompt(spineCtx, companyOfficial);

    // AI 評価（人間のみ・発言本文が根拠。Spine は助言の宛先合わせにのみ使う）。
    const feedback = await generateRoomFeedback({
      theme: themeInput,
      humans: humansWithSpeech.map((m) => ({ participantId: String(m.participant_id), displayName: str(m.display_name) || '参加者', isAi: false })),
      ais: ais.map((m) => ({ participantId: String(m.participant_id), displayName: str(m.display_name) || 'AI', isAi: true })),
      transcript: messageRows.map((m) => ({ participantId: String(m.participant_id), content: str(m.content), kind: m.kind === 'system' ? 'system' : 'speech' })),
      spineBlock: spine.block,
    });
    if (!feedback) {
      reportGdFailure(new Error('gd room feedback generation returned null'), 'gd/room/result', 'AI_GD_EVAL_FAILED', 502);
      return jsonError('AI_GD_EVAL_FAILED', '評価の生成に失敗しました。時間をおいて再度お試しください。', 502);
    }
    // 議論全体の評価（人間参加者のみを roleEstimates の対象にする）。
    overallEvaluation = normalizeRoomOverall(
      feedback.overall,
      humans.map((m) => ({ participantId: String(m.participant_id), displayName: str(m.display_name) || '参加者' })),
      feedback.truncated,
    );
    const byPid = new Map<string, Row>();
    for (const p of feedback.participants) {
      if (p && typeof p === 'object' && typeof (p as Row).participantId === 'string') byPid.set((p as Row).participantId as string, p as Row);
    }
    for (const h of humans) {
      const pid = String(h.participant_id);
      const selfCount = speechCount.get(pid) ?? 0;
      if (selfCount === 0) {
        evalByPid.set(pid, unscoredEvaluation(0, totalSpeech, '発言が確認できませんでした。'));
        matchByPid.set(pid, { hints: [], summary: '発言が少なくマッチング傾向は判定できませんでした。' });
        continue;
      }
      const raw = byPid.get(pid);
      if (!raw) {
        evalByPid.set(pid, unscoredEvaluation(selfCount, totalSpeech, '評価を取得できませんでした。'));
        matchByPid.set(pid, { hints: [], summary: '' });
        continue;
      }
      const axisScores = normalizeAxisScores(raw.axisScores);
      const overallScore = computeOverallScore(axisScores);
      const rank = toRank(overallScore);
      const companyCommunicationGrade = computeCommunicationGrade(axisScores);
      const evaluation: CareerGdEvaluation = {
        version: 2,
        scored: true,
        axisScores,
        overallScore,
        rank,
        companyCommunicationGrade,
        strengths: strArray(raw.strengths),
        weaknesses: strArray(raw.weaknesses),
        improvements: strArray(raw.improvements),
        goodQuotes: verifyQuotes(raw.goodQuotes, ownMessages.get(pid) ?? []),
        overallComment: str(raw.overallComment),
        speechCount: selfCount,
        totalSpeechCount: totalSpeech,
      };
      evalByPid.set(pid, evaluation);
      matchByPid.set(pid, { hints: strArray(raw.matchingHints), summary: str(raw.matchingSummary) });
    }
  }

  // ranking（採点済みの人間のみ・overallScore 降順・全員で共有）。
  const ranking: CareerGdRankingEntry[] = humans
    .map((m) => ({ pid: String(m.participant_id), name: str(m.display_name) || '参加者', ev: evalByPid.get(String(m.participant_id)) }))
    .filter((x) => x.ev && x.ev.scored)
    .map((x) => ({ participantId: x.pid, displayName: x.name, overallScore: x.ev!.overallScore, grade: x.ev!.rank, rank: 0 }))
    .sort((a, b) => b.overallScore - a.overallScore)
    .map((entry, i) => ({ ...entry, rank: i + 1 }));

  // 全人間ぶんを upsert（ranking を共有・一貫化）。
  const nowIso = new Date().toISOString();
  const rowsToUpsert = humans.map((h) => {
    const pid = String(h.participant_id);
    const evaluation = evalByPid.get(pid)!;
    const matchingHints = matchByPid.get(pid) ?? { hints: [], summary: '' };
    const consultationSummary = generateCareerGdSummary({
      themeTitle: themeInput.title,
      displayName: str(h.display_name) || '参加者',
      scored: evaluation.scored,
      axisScores: evaluation.axisScores,
      overallScore: evaluation.overallScore,
      rank: evaluation.rank,
      companyCommunicationGrade: evaluation.companyCommunicationGrade,
      strengths: evaluation.strengths,
      improvements: evaluation.improvements,
      matchingHints: matchingHints.hints,
    });
    const selfCompanyGrade: GdCompanyGrade = evaluation.scored ? evaluation.rank : 'D';
    return {
      room_id: roomId,
      user_id: h.user_id as string,
      participant_id: pid,
      self_feedback: evaluation,
      ranking,
      self_company_grade: selfCompanyGrade,
      overall_summary: consultationSummary,
      matching_hints: matchingHints,
    };
  });

  const { error: upErr } = await admin
    .from('career_gd_room_results')
    .upsert(rowsToUpsert, { onConflict: 'room_id,user_id' });
  if (upErr) {
    if (isUndefinedTable(upErr)) return dbNotAppliedResponse();
    console.error('Career GD result: upsert error', upErr.message);
    return jsonError('RESULT_SAVE_FAILED', '結果の保存に失敗しました。時間をおいて再度お試しください。', 500);
  }

  const selfEval = evalByPid.get(selfParticipantId)!;
  const selfMatch = matchByPid.get(selfParticipantId) ?? { hints: [], summary: '' };
  const selfRow = rowsToUpsert.find((r) => r.participant_id === selfParticipantId)!;
  const result: CareerGdRoomResultView = {
    roomId,
    participantId: selfParticipantId,
    displayName: str(currentRow.display_name) || '参加者',
    evaluation: selfEval,
    ranking,
    matchingHints: selfMatch,
    consultationSummary: selfRow.overall_summary,
    overallEvaluation, // STEP-GD-27: 議論全体の評価（空議論・冪等再取得では null）
    createdAt: nowIso,
  };
  // 実行が成功した。以降、同じ入力で来た request は「ユーザーが明示的に
  //   実行し直した」＝ 新しい 1 回として消費される（retry は in_flight 中のみ +0）。
  await quota.settle();
  return Response.json({ result });
}
