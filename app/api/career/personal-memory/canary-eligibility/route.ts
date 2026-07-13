// PASSAI CAREER — Personal Memory canary eligibility API（P16-G / server-only）。
//
// 責務: client から { section } を受け、cookie session または Bearer access token から authenticated member を
//   server 側で確定し、server-only allowlist（user/section）と突き合わせて **eligible boolean だけ**を返す。
//
// ★ 厳守:
//   - client 申告の userId は受け取らない・信用しない（body は section のみ利用）。
//   - service role を使わない（getCareerServerSupabaseClient = anon + cookie/token 検証）。
//   - response に userId / allowlist / token / env / 詳細 deny 理由を含めない（eligible のみ）。
//   - token / user / env / auth error 本文を log しない。
//   - unauthenticated / invalid / server config 未設定 / auth 失敗はすべて eligible=false（write 不可）。

import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import { loadCanaryConfigFromEnv } from '@/lib/careerMemory/persistence/canaryConfig.server';
import {
  evaluateEligibility,
  type CanaryVerifyResult,
  type EligibilityDeps,
} from '@/lib/careerMemory/persistence/canaryEligibility';

export const runtime = 'nodejs';

// server 側 user 検証（never-throw）。accessToken があればそれを、無ければ cookie session を検証する。
//   member（メール登録・非 anonymous）以外は unauth。env 未設定は no-config。service role 不使用。
async function verifyCareerMember(accessToken: string | undefined): Promise<CanaryVerifyResult> {
  try {
    const client = await getCareerServerSupabaseClient();
    if (!client) return { kind: 'no-config' };
    const { data, error } = await client.auth.getUser(accessToken);
    if (error || !data?.user) return { kind: 'unauth' };
    if (data.user.is_anonymous) return { kind: 'unauth' };
    return { kind: 'member', userId: data.user.id };
  } catch {
    return { kind: 'unauth' };
  }
}

const realEligibilityDeps: EligibilityDeps = {
  verifyUser: verifyCareerMember,
  loadConfig: loadCanaryConfigFromEnv,
};

function extractBearer(req: Request): string | undefined {
  const auth = req.headers.get('authorization') ?? '';
  if (auth.length > 7 && auth.slice(0, 7).toLowerCase() === 'bearer ') {
    const token = auth.slice(7).trim();
    return token !== '' ? token : undefined;
  }
  return undefined;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const token = extractBearer(req);
    let section: unknown;
    try {
      const body = (await req.json()) as { section?: unknown } | null;
      section = body?.section;
    } catch {
      section = undefined; // malformed body → section 不明 → deny
    }
    const { eligible } = await evaluateEligibility(realEligibilityDeps, { section, accessToken: token });
    return Response.json({ eligible: eligible === true });
  } catch {
    // 予期せぬ失敗でも理由を返さず deny（never-throw boundary）。
    return Response.json({ eligible: false });
  }
}
