/**
 * Company Prefetch — 既存 route から使う内部 trigger（server-only・never-throw）。
 *
 * 用途（監査の T1）:
 *   ES / 企業研究 / 面接 / プレゼンの AI route には **既に企業名が server まで届いている**。
 *   その地点で 1 行呼ぶだけで prefetch を起動できる（client の変更ゼロ）。
 *   T2（CompanyPicker の onBlur）と二重に走っても、company-scoped idempotency が
 *   外部取得を 1 回へ畳むので問題にならない。
 *
 * 契約:
 *   - **呼び出し元の処理時間に影響しない**（`after()` に載せるだけで即 return）。
 *   - throw しない・戻り値を持たない。prefetch の不調で既存機能を壊さない。
 *   - flag OFF のときは gate で止まり、Supabase にも外部にも一切触れない。
 */

import 'server-only';

import { after } from 'next/server';

import { devWarn } from '@/lib/devLog';
import { evaluateCompanyPrefetchGate } from './gate.server';
import { runCompanyPrefetch } from './prefetchJobService';
import { buildCompanyPrefetchDeps } from './runtime.server';

/**
 * 企業名を prefetch 対象として登録する（fire & forget）。
 *
 * @param companyName ユーザーが入力した free-text 企業名
 * @param req rate limit のための元 request（省略可）
 */
export function triggerCompanyPrefetch(companyName: string, req?: Request): void {
  const name = typeof companyName === 'string' ? companyName.trim().slice(0, 120) : '';
  if (name.length < 2) return;

  try {
    after(async () => {
      try {
        // ★ gate はここ（background）で評価する。flag OFF なら Supabase にも触れない。
        const gate = await evaluateCompanyPrefetchGate(req);
        if (!gate.ok) return;

        const deps = buildCompanyPrefetchDeps();
        const outcome = await runCompanyPrefetch(deps, name);
        devWarn('[companyPrefetch] trigger outcome', outcome.kind);
      } catch (err) {
        devWarn('[companyPrefetch] trigger aborted', err instanceof Error ? err.name : 'unknown');
      }
    });
  } catch {
    // `after()` が使えない実行文脈（テスト等）でも呼び出し元を壊さない。
  }
}
