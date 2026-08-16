/**
 * Company Identity — 企業名解決 API（Phase A / R1）。
 *
 * POST /api/career/company/resolve  { name: string }
 *   → { available: true, data: CompanyResolveResult }
 *   → { available: false, reason }   ← flag OFF / env 未設定 / 未認証 / 取得失敗（HTTP 200）
 *
 * 厳守:
 *   - 企業判定ロジックをここに書かない（既存 `resolveCompany` へ委譲）。
 *   - `ambiguous` を勝手に確定しない。
 *   - AI / prompt / Layer 5 Community へ一切接続しない。
 *   - 失敗しても HTTP 200 + available:false（呼び出し側は free-text へ倒す）。
 */

import { evaluateCompanyIdentityGate, unavailableResponse } from '@/lib/careerCompanyIdentity/gate.server';
import { findCompanyCandidates } from '@/lib/careerCompanyIdentity/repository.server';
import { buildCompanyResolveResult } from '@/lib/careerCompanyIdentity/resolution';

export const dynamic = 'force-dynamic';

/** 企業名の受け入れ上限（極端な入力を DB クエリへ通さない）。 */
const MAX_NAME_CHARS = 120;

export async function POST(req: Request): Promise<Response> {
  const gate = await evaluateCompanyIdentityGate();
  if (!gate.ok) return unavailableResponse(gate.reason);

  let name = '';
  try {
    const body = (await req.json()) as { name?: unknown };
    name = typeof body?.name === 'string' ? body.name.trim().slice(0, MAX_NAME_CHARS) : '';
  } catch {
    name = '';
  }

  if (name === '') {
    return Response.json(
      { available: true, data: { status: 'unresolved', suggestions: [] } },
      { status: 200 },
    );
  }

  const candidates = await findCompanyCandidates(name);
  // null = 取得できなかった（env / 失敗）。free-text へ倒す。
  if (candidates === null) return unavailableResponse('lookup_error');

  return Response.json(
    { available: true, data: buildCompanyResolveResult(name, candidates) },
    { status: 200 },
  );
}
