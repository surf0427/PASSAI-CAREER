// PASSAI CAREER — 面接 route 共有: base context 入力の解決（NEXT-6 / bridge retirement 第一 purpose）。
//
// 責務: start / turn / complete の 3 route が共有する「profile / activity / values をどこから取るか」の
//   1 箇所の分岐。既定は **従来どおり request body**（出力 byte 完全互換）。
//   `CAREER_SERVER_CONTEXT_PURPOSES` に `interview_practice` を含めたときだけ、Layer 1 の
//   owner-scoped server read（NEXT-2）へ切り替える。
//
// 厳守:
//   - never-throw / fail-open: server read の失敗・空・未認証はすべて request body へ fallback。
//   - request body の shape / 他 field（selfAnalysis / es / matching / companyResearch 等）は不変。
//     それらの bridge 退役は次の slice（本 slice は base context のみ）。
//   - route ではない共有 module（`route.ts` 以外なのでエンドポイント化されない）。

import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import { loadServerBaseContext } from '@/lib/careerServerContext/baseContext.server';
import type { BaseContextDecisionReason } from '@/lib/careerServerContext/baseContextPolicy';
// D-R2: client canonical revision（header 由来・veto 専用）。
import { readSourceSyncSignal } from '@/lib/careerSourceSync/request.server';

export type InterviewBaseInputs = {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  // 観測用（route 挙動には影響しない）。'server_source' 以外はすべて従来の request body 経路。
  source: BaseContextDecisionReason;
};

export type InterviewBodyBaseInputs = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
};

/**
 * base context を解決する（flag OFF なら Source read もせず request body をそのまま返す）。
 */
export async function resolveInterviewBaseInputs(
  b: InterviewBodyBaseInputs,
  req?: Request,
): Promise<InterviewBaseInputs> {
  const fallback: InterviewBaseInputs = {
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    source: 'flag_off',
  };
  try {
    const server = await loadServerBaseContext(
      'interview_practice',
      req ? readSourceSyncSignal(req) : undefined,
    );
    if (!server.context) return { ...fallback, source: server.reason };
    return { ...server.context, source: server.reason };
  } catch {
    return { ...fallback, source: 'source_unavailable' };
  }
}
