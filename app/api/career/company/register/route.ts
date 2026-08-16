/**
 * Company Identity — 企業登録 API（Phase A / R1）。
 *
 * POST /api/career/company/register  { displayName: string, aliases?: string[] }
 *   → { available: true, data: { companyId, displayName, created } }
 *   → { available: false, reason }   ← flag OFF / env 未設定 / 未認証 / 失敗（HTTP 200）
 *
 * 厳守:
 *   - 必須入力は **企業名のみ**（業界 / URL を必須にしない）。
 *   - `normalized_name` は server が displayName から再計算する（client 申告を信用しない）。
 *   - 同一 normalized 企業が既にあれば **新規作成せず既存 ID を返す**（created:false）。
 *   - 書き込みは service_role のみ（client から企業マスタへ直接書かせない）。
 */

import { evaluateCompanyIdentityGate, unavailableResponse } from '@/lib/careerCompanyIdentity/gate.server';
import { registerCompany } from '@/lib/careerCompanyIdentity/repository.server';

export const dynamic = 'force-dynamic';

const MAX_NAME_CHARS = 120;
const MAX_ALIASES = 5;

export async function POST(req: Request): Promise<Response> {
  const gate = await evaluateCompanyIdentityGate();
  if (!gate.ok) return unavailableResponse(gate.reason);

  let displayName = '';
  let aliases: string[] = [];
  try {
    const body = (await req.json()) as { displayName?: unknown; aliases?: unknown };
    displayName =
      typeof body?.displayName === 'string' ? body.displayName.trim().slice(0, MAX_NAME_CHARS) : '';
    aliases = Array.isArray(body?.aliases)
      ? body.aliases
          .filter((a): a is string => typeof a === 'string')
          .map((a) => a.trim().slice(0, MAX_NAME_CHARS))
          .filter((a) => a !== '')
          .slice(0, MAX_ALIASES)
      : [];
  } catch {
    displayName = '';
  }

  if (displayName === '') return unavailableResponse('lookup_error');

  const result = await registerCompany(displayName, aliases);
  if (!result) return unavailableResponse('lookup_error');

  return Response.json({ available: true, data: result }, { status: 200 });
}
