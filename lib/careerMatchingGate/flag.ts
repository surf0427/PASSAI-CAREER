/**
 * 企業マッチング公開ゲート — env 判定の共有プリミティブ（client / server 双方から import 可）。
 *
 * 背景:
 *   企業マッチング（/career/matching・/api/career/matching）は初回リリース対象外。
 *   コード・DB・型・QA はすべて温存したまま、**到達不能かつ実行不能**にするための gate。
 *   再開時は flag を ON にするだけで旧挙動へ戻る（削除しないのはこのため）。
 *
 * flag は 2 本立て。役割を混ぜないこと:
 *   - `NEXT_PUBLIC_CAREER_COMPANY_MATCHING_ENABLED` … **UI 導線の表示可否のみ**。
 *     client bundle に build 時 inline される（= secret ではない前提の値しか置かない）。
 *   - `CAREER_COMPANY_MATCHING_ENABLED` … **実行権限（route / API）**。server-only。
 *     判定は lib/careerMatchingGate/flags.server.ts が持つ。
 *
 * ★ Safety rule: **server flag OFF が最終権限**。
 *   UI flag が誤って ON でも、server flag が OFF なら route は notFound()、API は 404 で
 *   AI 処理へ到達しない（＝AI コスト 0）。逆向き（server だけ ON）でも導線が生えないだけで安全。
 *   したがって「片方だけ ON」はどちらの向きでも fail-closed に倒れる。
 *
 * 判定規則は本ファイルの 1 関数に集約する。UI 側と server 側でパースがずれると
 * 「見えるのに使えない」状態の原因が env の書式差になり切り分け不能になるため、
 * 両者は必ず同じ evaluator を通す（受理値は厳密に 'true' のみ）。
 */

/**
 * env 生値 → 有効/無効の純粋判定（QA 可能）。
 * 受理するのは trim + 小文字化して 'true' のときだけ。
 * 未設定 / 空 / '1' / 'yes' / 非文字列はすべて **fail-closed = false**。
 * （既存 lib/careerCompanySpine/flags.server.ts・lib/careerDataSpineGate/flags.server.ts の
 *   `=== 'true'` 規約に合わせる。受理値を広げると server/UI で解釈差が生まれる。）
 */
export function evalCareerCompanyMatchingFlag(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  return raw.trim().toLowerCase() === 'true';
}

let cachedUiEnabled: boolean | undefined;

/**
 * 企業マッチングの **UI 導線** を表示してよいか（build-time env・1 回読んでキャッシュ）。
 *
 * ここが true でも実行が許可されるわけではない（実行可否は server flag が単独で決める）。
 * 呼び出し側は Home / マイページ / GD 結果などの link・CTA の出し分けにのみ使う。
 */
export function isCareerCompanyMatchingUiEnabled(): boolean {
  if (cachedUiEnabled === undefined) {
    cachedUiEnabled = evalCareerCompanyMatchingFlag(
      process.env.NEXT_PUBLIC_CAREER_COMPANY_MATCHING_ENABLED,
    );
  }
  return cachedUiEnabled;
}
