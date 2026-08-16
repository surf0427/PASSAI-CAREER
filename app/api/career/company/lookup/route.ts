/**
 * Company Identity — companyId から企業を引く API（Phase A / R1）。
 *
 * GET /api/career/company/lookup?companyId=cmp_xxx
 *   → { available: true, data: { companyId, displayName } | null }
 *   → { available: false, reason }   ← flag OFF / env 未設定 / 未認証（HTTP 200）
 *
 * 企業詳細ページ / 表示キャッシュの再取得に使う。
 * data:null は「その companyId の企業が見つからない」（削除・別環境等）。呼び出し側は
 * 保存済みの free-text `companyName` へ倒すこと。
 */

import { evaluateCompanyIdentityGate, unavailableResponse } from '@/lib/careerCompanyIdentity/gate.server';
import { findCompanyById } from '@/lib/careerCompanyIdentity/repository.server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const gate = await evaluateCompanyIdentityGate();
  if (!gate.ok) return unavailableResponse(gate.reason);

  let companyId = '';
  try {
    companyId = new URL(req.url).searchParams.get('companyId')?.trim() ?? '';
  } catch {
    companyId = '';
  }
  if (companyId === '') {
    return Response.json({ available: true, data: null }, { status: 200 });
  }

  const record = await findCompanyById(companyId);
  return Response.json(
    {
      available: true,
      data: record ? { companyId: record.companyId, displayName: record.displayName } : null,
    },
    { status: 200 },
  );
}
