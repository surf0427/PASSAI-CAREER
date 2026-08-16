/**
 * Company Prefetch — server-only feature flags。
 *
 * 既存 `lib/careerCompanySpine/flags.server.ts` / `lib/careerGenerationJob/flag.server.ts` と同方針:
 *   - `import 'server-only'`（client bundle に紛れたら build error）
 *   - **code default OFF**（env に明示的な 'true' があるときだけ有効）
 *   - secret / 実 user ID を書かない
 *
 * ★ 既存 flag との関係（最重要）:
 *   本 module は `CAREER_COMPANY_IDENTITY_ENABLED` も `CAREER_COMPANY_MATCHING_ENABLED` も
 *   **参照しない**。理由:
 *     - `CAREER_COMPANY_IDENTITY_ENABLED` は「`/career/company` segment を公開するか」
 *       「3 本の public Identity API を開けるか」だけを守る UI/API 露出の flag であり、
 *       `lib/careerCompanyIdentity/repository.server.ts` の関数自体は flag を見ない。
 *       よって Identity UI を 404 のまま伏せた状態で、server 内部からだけ resolver を使える。
 *     - Company Matching は本機能と一切関係が無い（推薦ロジックへ触れない）。
 *   → **Matching OFF / Identity UI OFF のまま、本 flag だけで prefetch を ON にできる。**
 *
 * flag を 2 段に分ける理由:
 *   「identity は解決したいが外部 I/O は止めたい」という中間状態が運用上必ず要る
 *   （provider 障害時・コスト暴走時）。1 flag だと全部落とすしかない。
 */

import 'server-only';

import { isPilotEnabledForUser } from '@/lib/careerGenerationJob/pilotTargeting';

/**
 * Company Prefetch（intent 受付 / identity 解決 / Data Spine 書き込み）が有効か。
 *
 * OFF のとき:
 *   - `POST /api/career/company/intent` は `{accepted:false, reason:'flag_off'}`（HTTP 200）
 *   - 外部 I/O・AI 呼び出し・DB 書き込みは **一切発生しない**
 *   - 既存機能（企業研究 / ES / 面接 / プレゼン）は完全に従来どおり動く
 */
export function isCompanyPrefetchEnabled(): boolean {
  return process.env.CAREER_COMPANY_PREFETCH_ENABLED === 'true';
}

/**
 * 外部ネットワーク取得（corporate registry / 検索 provider / 公式サイト）を許可するか。
 *
 * OFF のとき（既定）:
 *   - identity 解決（内部 registry 照合 = DB のみ）までは動く
 *   - `safeFetch` を伴う provider は呼ばれない → **outbound I/O ゼロ**
 *   - job は `partial`（identity のみ）で終わる。取れた fact は捨てない
 *
 * ★ 本 flag が ON でも `isCompanyPrefetchEnabled()` が OFF なら何も起きない（AND 条件）。
 */
export function isCompanyPrefetchExternalFetchEnabled(): boolean {
  return (
    isCompanyPrefetchEnabled() &&
    process.env.CAREER_COMPANY_PREFETCH_EXTERNAL_FETCH_ENABLED === 'true'
  );
}

/**
 * 指定 user が prefetch の対象か（**fail-closed**）。
 *
 * 判定は既存の pure evaluator（`lib/careerGenerationJob/pilotTargeting.ts`）へ完全委譲する
 * （同じ fail-closed 規約を 2 つ書かない）:
 *   - flag OFF → false
 *   - allowlist 未設定 / 空 / malformed / wildcard → false（誰も対象にならない）
 *   - valid allowlist → 掲載 UUID に exact 一致した member のみ true
 *
 * env 値（UUID）は戻り値・log へ露出しない。
 */
export function isCompanyPrefetchEnabledForUser(userId: string): boolean {
  return isPilotEnabledForUser({
    flagEnabled: isCompanyPrefetchEnabled(),
    rawAllowlist: process.env.CAREER_COMPANY_PREFETCH_CANARY_USER_IDS,
    userId,
  });
}

/** flag 変数名の一覧（.env.example / operator packet 用・値は含めない）。 */
export const COMPANY_PREFETCH_FLAG_NAMES: readonly string[] = [
  'CAREER_COMPANY_PREFETCH_ENABLED',
  'CAREER_COMPANY_PREFETCH_EXTERNAL_FETCH_ENABLED',
  'CAREER_COMPANY_PREFETCH_CANARY_USER_IDS',
];
