// PASSAI 就活版 — GD 参加人数の正本（single source of truth）。
//
// GD は全モード共通で参加人数を 4 / 6 / 8 の 3 択に固定する（STEP-GD-20-I）。
//   - ソロ:            自分 1 人 + AI で planned まで補完（AI = planned - 1）
//   - フレンド/合言葉:  room capacity = planned。start 時に人間不足分を AI 補完
//   - 公開ロビー:       公開 room 作成時に 4/6/8 を選択。参加上限 = planned
//   - ランダムマッチ:   将来は人数別キュー（4/6/8）に分ける（本 STEP では型/定数/TODO のみ）
//
// UI / API / DB / テストは必ず本モジュールを参照する（重複定義禁止）。
// server-only 依存を持たない純モジュール（client からも import 可）。

export const CAREER_GD_ALLOWED_PARTICIPANT_COUNTS = [4, 6, 8] as const;

export type CareerGdParticipantCount =
  (typeof CAREER_GD_ALLOWED_PARTICIPANT_COUNTS)[number];

// planned 未指定時の既定値（原則 4）。
export const DEFAULT_CAREER_GD_PARTICIPANT_COUNT: CareerGdParticipantCount = 4;

// 値が許可された参加人数（4/6/8）か。
export function isCareerGdParticipantCount(
  value: unknown,
): value is CareerGdParticipantCount {
  return (
    typeof value === 'number' &&
    (CAREER_GD_ALLOWED_PARTICIPANT_COUNTS as readonly number[]).includes(value)
  );
}

// API 入力の判定結果。
//   - undefined/null（未指定）は既定値 4 を採用（後方互換）。
//   - 指定ありで 4/6/8 以外は不正（silently fallback しない）。
export type ParsedParticipantCount =
  | { ok: true; value: CareerGdParticipantCount }
  | { ok: false };

// API バリデーション用。未指定は既定値、指定不正は { ok:false }。
export function parseParticipantCount(input: unknown): ParsedParticipantCount {
  if (input === undefined || input === null || input === '') {
    return { ok: true, value: DEFAULT_CAREER_GD_PARTICIPANT_COUNT };
  }
  const n = typeof input === 'number' ? input : Number(input);
  if (isCareerGdParticipantCount(n)) return { ok: true, value: n };
  return { ok: false };
}

// UI や表示で「不正なら既定値」に丸めたい場合のみ使う（バリデーションには使わない）。
export function coerceParticipantCount(input: unknown): CareerGdParticipantCount {
  const parsed = parseParticipantCount(input);
  return parsed.ok ? parsed.value : DEFAULT_CAREER_GD_PARTICIPANT_COUNT;
}

// ── ランダムマッチング（将来）: 人数別キュー ─────────────────────────
// 本 STEP では本体は実装しない。将来キューを 4/6/8 で分けるための型/定数のみ用意する。
// TODO(STEP-GD-21+): career_gd_match_queue を人数別に分割し、下記キーでキュー投入/取り出しを行う。
export type CareerGdMatchQueueSize = CareerGdParticipantCount;

export const CAREER_GD_MATCH_QUEUE_KEY: Record<CareerGdParticipantCount, string> = {
  4: 'career_gd_match_queue_4',
  6: 'career_gd_match_queue_6',
  8: 'career_gd_match_queue_8',
};
