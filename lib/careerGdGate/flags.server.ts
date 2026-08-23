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
 * ★ 適用範囲（STEP-CAREER-PUBLIC-SPEC / P2-2 で page 側も閉じた）:
 *   OFF のとき `/career/gd` と `/career/gd/**` は **すべて 404**
 *   （app/career/gd/layout.tsx が notFound()。履歴閲覧の /career/gd/view も含む）。
 *   server 側の履歴 hydrate API（`/api/career/gd/room/results`）も同じく 404。
 *   これにより「OFF = GD は存在しない」が page / API を通じた単純な 1 規則で成立する。
 *
 *   ★ 以前ここには「OFF でも /career/gd/view だけは閲覧を妨げない」と書いてあったが、
 *     その例外は実装されたことが無く（page 側に gate 自体が無かった）、結果として
 *     「全 page が 200 なのに API は全部 404」という最悪の組合せになっていた。
 *     既存の企業マッチング（app/career/matching/layout.tsx が result 画面ごと 404 に
 *     する）と同じ規則へ揃え、例外を持たない形にした。
 *     ★ データは何も消さないので、flag を ON に戻せば履歴もそのまま再表示される。
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
