/**
 * Company Prefetch — 志望企業 intent の受付 API。
 *
 * POST /api/career/company/intent  { companyName: string }
 *   → { accepted: true }                  … 受け付けて background 取得を登録した
 *   → { accepted: false, reason }         … flag OFF / 未認証 / 対象外 / rate limit（**HTTP 200**）
 *
 * 厳守（Requirement A: ユーザー入力をブロックしない）:
 *   - **結果を待たせない**。identity 解決も外部取得も `after()` で response 後に走る。
 *   - client は結果を見ない（fire & forget）。この API が失敗しても
 *     企業名の free-text 保存・ES / 企業研究 / 面接 / プレゼンは一切影響を受けない。
 *   - どんな失敗でも HTTP 200（4xx/5xx を返すと client 側で無用な error 表示に繋がる）。
 *
 * 厳守（信頼境界）:
 *   - client が `companyId` を申告しても **信用しない**（body で受け取らない）。
 *     canonical company id は server が resolve した結果のみ。
 *   - 企業名は正規化・照合の入力としてのみ使い、ログにも job 台帳にも残さない。
 *
 * ★ Company Identity の public API（/api/career/company/resolve|register|lookup）とは別経路。
 *   あちらは `CAREER_COMPANY_IDENTITY_ENABLED` が守る UI 向け API で、現在 OFF のまま。
 *   本 route は `CAREER_COMPANY_PREFETCH_ENABLED` だけで独立に制御される。
 */

import { after } from 'next/server';

import { evaluateCompanyPrefetchGate, notAcceptedResponse } from '@/lib/careerCompanyPrefetch/gate.server';
import { runCompanyPrefetch } from '@/lib/careerCompanyPrefetch/prefetchJobService';
import { buildCompanyPrefetchDeps } from '@/lib/careerCompanyPrefetch/runtime.server';
import { devWarn } from '@/lib/devLog';

// node:dns / node:crypto を使う（safeFetch / idempotency）ため Node ランタイム固定。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ★ Next.js の segment config は **静的リテラル**でなければならない（import した定数は不可）。
//   値は `lib/careerCompanyPrefetch/constants.ts` の `ROUTE_MAX_DURATION_SECONDS` と一致させること。
//   一致は `scripts/career-company-prefetch-qa.ts` の P-9g が静的に固定する。
export const maxDuration = 300;

/** 企業名の受け入れ上限（極端な入力を正規化・DB クエリへ通さない）。 */
const MAX_NAME_CHARS = 120;

export async function POST(req: Request): Promise<Response> {
  // ★ gate が flag OFF で落ちるときは Supabase にも外部にも一切触れない。
  const gate = await evaluateCompanyPrefetchGate(req);
  if (!gate.ok) return notAcceptedResponse(gate.reason);

  let companyName = '';
  try {
    const body = (await req.json()) as { companyName?: unknown };
    companyName =
      typeof body?.companyName === 'string' ? body.companyName.trim().slice(0, MAX_NAME_CHARS) : '';
  } catch {
    companyName = '';
  }

  if (companyName === '') return notAcceptedResponse('lookup_error');

  // deps の組み立て（service_role env 未設定なら例外 → 受け付けない）。
  let deps: ReturnType<typeof buildCompanyPrefetchDeps>;
  try {
    deps = buildCompanyPrefetchDeps();
  } catch {
    return notAcceptedResponse('not_configured');
  }

  // ★ response を待たせない。ここから先は background。
  after(async () => {
    try {
      const outcome = await runCompanyPrefetch(deps, companyName);
      // 観測は enum のみ（企業名・URL・本文は出さない）。
      devWarn('[companyPrefetch] intent outcome', outcome.kind);
    } catch (err) {
      // runCompanyPrefetch は never-throw だが、二重の保険（unhandled rejection を作らない）。
      devWarn('[companyPrefetch] background aborted', err instanceof Error ? err.name : 'unknown');
    }
  });

  return Response.json({ accepted: true }, { status: 202 });
}
