/**
 * GD（グループディスカッション）公開ゲート — env 判定の共有プリミティブ
 * （client / server 双方から import 可）。
 *
 * 背景:
 *   オンライン GD（マルチプレイ）は Supabase を server 正本とする実マルチユーザー機能であり、
 *   room / member / message / result の DB write と AI 呼び出しを伴う。本番公開時に
 *   「段階公開」「即時停止（kill switch）」を行える単一の権限点が必要になる。
 *
 * flag は 2 本立て。役割を混ぜないこと（lib/careerMatchingGate と同型）:
 *   - `NEXT_PUBLIC_CAREER_GD_ENABLED` … **UI 導線の表示可否のみ**。
 *     client bundle に build 時 inline される（= secret ではない前提の値しか置かない）。
 *   - `CAREER_GD_ENABLED` … **実行権限（page route / API）**。server-only。
 *     判定は lib/careerGdGate/flags.server.ts が持つ。
 *
 * ★ Safety rule: **server flag OFF が最終権限**。
 *   UI flag が誤って ON でも、server flag が OFF なら API は 404 を返し、
 *   DB write / AI 呼び出しへ到達しない（＝AI コスト 0・room 汚染 0）。
 *   逆向き（server だけ ON）でも導線が生えないだけで安全。
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
 * （既存 lib/careerMatchingGate/flag.ts・lib/careerCompanySpine/flags.server.ts の
 *   `=== 'true'` 規約に合わせる。受理値を広げると server/UI で解釈差が生まれる。）
 */
export function evalCareerGdFlag(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  return raw.trim().toLowerCase() === 'true';
}

let cachedUiEnabled: boolean | undefined;

/**
 * GD の **UI 導線** を表示してよいか（build-time env・1 回読んでキャッシュ）。
 *
 * ここが true でも実行が許可されるわけではない（実行可否は server flag が単独で決める）。
 * 呼び出し側は Home / マイページ / 相談AI の link・CTA の出し分けにのみ使う。
 */
export function isCareerGdUiEnabled(): boolean {
  if (cachedUiEnabled === undefined) {
    cachedUiEnabled = evalCareerGdFlag(process.env.NEXT_PUBLIC_CAREER_GD_ENABLED);
  }
  return cachedUiEnabled;
}

/** QA 専用: モジュールキャッシュを捨てる（production code から呼ばない）。 */
export function __resetCareerGdUiFlagCacheForTest(): void {
  cachedUiEnabled = undefined;
}
