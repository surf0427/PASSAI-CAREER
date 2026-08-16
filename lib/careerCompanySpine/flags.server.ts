/**
 * Company Data Spine — server-only feature flags（Phase A / R1）。
 *
 * 既存 `lib/careerDataSpineGate/flags.server.ts` と同方針:
 *   - `import 'server-only'`（client bundle に紛れたら build error）
 *   - **code default OFF**（env に明示的な 'true' がある時だけ有効）
 *   - secret / 実 user ID を書かない
 *
 * ★ flag は 1 つだけに絞る。Phase A（R1〜R6）は Company Identity の有効化が
 *   すべての入口であり、機能ごとの flag を増やしても rollback 粒度は改善しない
 *   （UI 側は常に free-text fallback を持つため、flag OFF で自然に旧挙動へ戻る）。
 *   Official Facts（R7）/ Company Context injection（R8-R9）の flag は
 *   **その slice を実装するときに足す**（先回りして作らない）。
 */

import 'server-only';

/**
 * Company Identity（企業マスタ / Resolver / 企業登録）が有効か。
 *
 * OFF のとき:
 *   - resolve / register / lookup は `available:false` を返す（HTTP 200）
 *   - CompanyPicker は free-text 入力のみになる
 *   - 既存機能（企業研究 / ES / 面接 / プレゼン）は **完全に従来どおり動く**
 */
export function isCompanyIdentityEnabled(): boolean {
  return process.env.CAREER_COMPANY_IDENTITY_ENABLED === 'true';
}

/** flag 変数名の一覧（.env.example / operator packet 用・値は含めない）。 */
export const COMPANY_SPINE_FLAG_NAMES: readonly string[] = [
  'CAREER_COMPANY_IDENTITY_ENABLED',
];
