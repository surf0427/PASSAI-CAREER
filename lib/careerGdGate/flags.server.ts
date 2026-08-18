/**
 * GD 公開ゲート — server-only の**実行権限** flag。
 *
 * 既存 `lib/careerMatchingGate/flags.server.ts` と同方針:
 *   - `import 'server-only'`（client bundle に紛れたら build error）
 *   - **code default OFF**（env に明示的な 'true' がある時だけ有効）
 *   - secret / 実 user ID を書かない
 *
 * ★ 本 flag が GD の最終権限。OFF のとき:
 *   - `/api/career/gd/**` の mutation / AI / room 参照 API … `gdDisabledResponse()` で 404
 *     （body parse・auth・DB read より前に返す＝Claude API 未呼び出し・DB write 無し）
 *   本 flag は `NEXT_PUBLIC_*` を読まない。UI flag が誤って ON でも実行は解禁されない。
 *
 * ★ 温存対象（本 gate は「止める」だけで、何も消さない）:
 *   career_gd_* テーブル一式、localStorage `careerGdResults` / `careerGdRoomLogs`、
 *   ソロ GD の localStorage 履歴、GD QA / E2E 一式。
 *
 * ★ 履歴表示の扱い:
 *   OFF でも **既に手元にある結果（localStorage）** の閲覧は妨げない（/career/gd/view）。
 *   ただし server 側の履歴 hydrate API（`/api/career/gd/room/results`）は
 *   「GD 機能の一部」として同じく 404 にする（OFF 中に DB を読ませない）。
 *   これにより「OFF = server 側 GD I/O ゼロ」が単純な 1 規則で成立する。
 */

import 'server-only';

import { evalCareerGdFlag } from './flag';

/**
 * GD の **実行**（API route）が有効か。
 * 未設定 = OFF。本番で有効化するには `CAREER_GD_ENABLED=true` を明示設定する。
 */
export function isCareerGdEnabled(): boolean {
  return evalCareerGdFlag(process.env.CAREER_GD_ENABLED);
}

/**
 * OFF 時に返す共通レスポンス。
 *
 * 404 を選ぶ理由: 403 だと「存在するが権限が無い」という情報を与える。GD を止めている間は
 * 「そんな API は無い」に見せるのが最も情報が漏れない（既存 matching gate と同じ判断）。
 * detail に env 名・理由を書かない（運用情報を外へ出さない）。
 */
export function gdDisabledResponse(): Response {
  return Response.json({ error: 'NOT_FOUND', detail: 'ページが見つかりません。' }, { status: 404 });
}

/**
 * route 先頭で 1 行で使うための guard。
 * `const gate = requireCareerGdEnabled(); if (gate) return gate;`
 */
export function requireCareerGdEnabled(): Response | null {
  return isCareerGdEnabled() ? null : gdDisabledResponse();
}
