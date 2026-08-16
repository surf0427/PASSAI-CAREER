/**
 * 企業マッチング公開ゲート — server-only の**実行権限** flag。
 *
 * 既存 `lib/careerCompanySpine/flags.server.ts` / `lib/careerDataSpineGate/flags.server.ts` と同方針:
 *   - `import 'server-only'`（client bundle に紛れたら build error）
 *   - **code default OFF**（env に明示的な 'true' がある時だけ有効）
 *   - secret / 実 user ID を書かない
 *
 * ★ 本 flag が企業マッチングの最終権限。OFF のとき:
 *   - /career/matching・/career/matching/result … app/career/matching/layout.tsx が notFound()
 *   - POST /api/career/matching          … body parse より前に 404（Claude API 未呼び出し・DB write 無し）
 *   本 flag は `NEXT_PUBLIC_*` を読まない。UI flag が誤って ON でも実行は解禁されない。
 *
 * ★ 温存対象（本 gate は「隠す」だけで、何も消さない）:
 *   lib/careerMatching/ の決定的エンジン、career_matching_results テーブル、
 *   localStorage `careerMatchingResults`、matching_run / matching event、matching QA 一式。
 */

import 'server-only';

import { evalCareerCompanyMatchingFlag } from './flag';

/**
 * 企業マッチングの **実行**（page route / API）が有効か。
 * 未設定 = OFF。初回リリースでは env を一切設定しないことで OFF が成立する。
 */
export function isCareerCompanyMatchingEnabled(): boolean {
  return evalCareerCompanyMatchingFlag(process.env.CAREER_COMPANY_MATCHING_ENABLED);
}

/** flag 変数名の一覧（.env.example / operator packet 用・値は含めない）。 */
export const CAREER_MATCHING_FLAG_NAMES: readonly string[] = [
  // 実行権限（server-only・最終権限）
  'CAREER_COMPANY_MATCHING_ENABLED',
  // UI 導線の表示可否（client にも inline される）
  'NEXT_PUBLIC_CAREER_COMPANY_MATCHING_ENABLED',
];
