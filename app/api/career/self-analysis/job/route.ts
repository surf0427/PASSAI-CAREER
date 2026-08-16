// PASSAI 就活版 — 自己分析まとめ生成 job の status endpoint（Step2）。
//
// GET のみ。owner-scoped で自分の job の状態を返す。client polling / recovery の配線は Step3。
//
// 認証・owner scope:
//   - authenticated member 必須。client から user ID は受け取らない。
//   - 取得は **authenticated client + RLS**（owner SELECT policy）で行う。
//     RLS が auth.uid()=user_id を強制するうえ、明示的に user_id 条件も付ける（多重防御）。
//   - 他ユーザーの job は「存在を推測させない」ため not-found と同一 404。
//   - auth 確認失敗（infra）と未ログインを分離する。

import 'server-only';

import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import { mapOwnedJobToStatusResponse } from '@/lib/careerSelfAnalysis/summaryJobStatus';

export const runtime = 'nodejs';

const TABLE = 'career_generation_jobs';

function notFound(): Response {
  // 他 owner でも同じ 404（存在推測を防ぐ）。
  return Response.json({ status: 'not_found' }, { status: 404 });
}

function isUndefinedTable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === '42P01' ||
    (typeof e.message === 'string' && /relation .* does not exist/i.test(e.message))
  );
}

export async function GET(req: Request) {
  const jobId = new URL(req.url).searchParams.get('jobId');
  if (!jobId) {
    return Response.json({ error: 'BAD_REQUEST', detail: 'jobId is required' }, { status: 400 });
  }

  // auth 解決（infra 失敗 と 未ログイン を分離）。
  let client;
  try {
    client = await getCareerServerSupabaseClient();
  } catch {
    client = null;
  }
  if (!client) {
    return Response.json(
      { status: 'failed', errorCode: 'AUTH_TEMPORARILY_UNAVAILABLE', retryable: true },
      { status: 503 },
    );
  }

  let userId: string;
  try {
    const { data, error } = await client.auth.getUser();
    if (error) {
      return Response.json(
        { status: 'failed', errorCode: 'AUTH_TEMPORARILY_UNAVAILABLE', retryable: true },
        { status: 503 },
      );
    }
    if (!data.user || data.user.is_anonymous) {
      return Response.json({ error: 'LOGIN_REQUIRED' }, { status: 401 });
    }
    userId = data.user.id;
  } catch {
    return Response.json(
      { status: 'failed', errorCode: 'AUTH_TEMPORARILY_UNAVAILABLE', retryable: true },
      { status: 503 },
    );
  }

  // owner-scoped SELECT（RLS + 明示 user_id 条件）。lease_expires_at は recoveryAction 用。
  const { data, error } = await client
    .from(TABLE)
    .select('id, status, result, error_code, lease_expires_at')
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    if (isUndefinedTable(error)) {
      return Response.json(
        { status: 'failed', errorCode: 'GENERATION_JOB_STORAGE_UNAVAILABLE', retryable: true },
        { status: 503 },
      );
    }
    // RLS で弾かれた等は存在推測を防ぐため 404 に寄せる。
    return notFound();
  }
  if (!data) return notFound();

  const mapped = mapOwnedJobToStatusResponse(
    {
      status: data.status as string,
      result: data.result ?? null,
      errorCode: typeof data.error_code === 'string' ? data.error_code : null,
      leaseExpiresAt: typeof data.lease_expires_at === 'string' ? data.lease_expires_at : null,
    },
    jobId,
    Date.now(),
  );
  return Response.json(mapped.body, { status: mapped.httpStatus });
}
