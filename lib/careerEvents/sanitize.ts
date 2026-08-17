/**
 * career_user_events の書き込み前 sanitize（STEP-CAREER-EVENTLOG-P1）。
 *
 * Event Log は「本文を持たない観測ログ」。ここで本文の混入を機械的に止める:
 *   - metadata は **allowlist 方式**（既知の低リスク key のみ通す）。
 *   - denylist に一致する key は allowlist にあっても drop（二重防御）。
 *   - 値はスカラー（string / number / boolean）のみ。object / array は drop。
 *   - 文字列は短く truncate。key 数も上限を設ける。
 *   - 短いラベル（industry / job_type 等）も自由記述っぽい値（長い・改行含む）は drop。
 *   - 生スコアは保存しない。toScoreBand で S/A/B/C/D に変換したものだけを渡す。
 *
 * これらは types/careerEvents.ts の CareerEventMetadata / CareerScoreBand と対で運用する。
 */

import type {
  CareerEventMetadata,
  CareerEventMetadataValue,
  CareerScoreBand,
} from '@/types/careerEvents';

// metadata に通してよい既知 key（低リスク・enum/カウント系のみ）。ここに無い key は保存しない。
const ALLOWED_METADATA_KEYS: ReadonlySet<string> = new Set([
  'count',
  'companyCount',
  'industryCount',
  'jobCount',
  'turnCount',
  'messageCount',
  'revisionCount',
  'mode',
  'interviewType',
  'selectionType',
  'format',
  'participationMode',
  'durationSec',
  'timeLimitSec',
  'charLimit',
  'threadCount',
  // P9-C: presentation / company_research wiring 用の低リスク enum（本文なし・denylist は不変で継続適用）。
  // ★ scenario は「想定シーン」廃止により**新規の書き込み元が無い**。既に記録済みの
  //   イベント行を timeline が描画できるよう、read 互換のためだけに allowlist へ残す。
  'scenario',
  'sourceType', // company_research の情報源 enum（file / paste / manual / mixed）
  // P9-E: GD wiring 用の低リスク カウント（本文なし・小さな整数）。
  'participantCount', // GD の総参加者数（人間＋AI）
]);

// allowlist を通過しても、本文が入りうる key 名は必ず drop する（大文字小文字・部分一致）。
const DENY_KEY_SUBSTRINGS: readonly string[] = [
  'text',
  'body',
  'content',
  'answer',
  'question',
  'transcript',
  'message',
  'memo',
  'raw',
  'verified',
  'prompt',
  'response',
  'result',
  'email',
  'name',
  'note',
  'comment',
  'summary',
  'description',
  'reason',
];

const MAX_METADATA_KEYS = 12;
const MAX_METADATA_STRING_LEN = 64;
const MAX_LABEL_LEN = 48;

function isDeniedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return DENY_KEY_SUBSTRINGS.some((bad) => lower.includes(bad));
}

/**
 * 短いラベル（industry / job_type / selection_phase / weakness_category / next_action 等）を
 * 安全化する。空・長すぎ・改行入り（自由記述っぽい）は null（＝保存しない）。
 */
export function sanitizeLabel(value: unknown, max: number = MAX_LABEL_LEN): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) return null; // 長い値は自由記述の疑い → drop
  if (/[\r\n]/.test(trimmed)) return null; // 改行入りは本文の疑い → drop
  return trimmed;
}

/**
 * metadata を allowlist で絞り込み、スカラーのみ・truncate 済みで返す。
 * 不明 key / denylist key / object / array / 長文はすべて drop。
 */
export function sanitizeMetadata(raw: unknown): CareerEventMetadata {
  const out: CareerEventMetadata = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_METADATA_KEYS) break;
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    if (isDeniedKey(key)) continue;

    let safe: CareerEventMetadataValue | null = null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      safe = value;
    } else if (typeof value === 'boolean') {
      safe = value;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '' && !/[\r\n]/.test(trimmed)) {
        safe = trimmed.slice(0, MAX_METADATA_STRING_LEN);
      }
    }
    // object / array / null / 空文字 / 改行入りは drop（本文混入防止）。
    if (safe === null) continue;

    out[key] = safe;
    count += 1;
  }
  return out;
}

/**
 * 生スコア（0〜100）を S/A/B/C/D の band に変換する。生スコアは保存せず band のみ保存する。
 * 90+ = S / 80+ = A / 70+ = B / 60+ = C / それ未満 = D。
 */
export function toScoreBand(score: unknown): CareerScoreBand | null {
  const n = typeof score === 'number' ? score : Number(score);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(0, Math.min(100, n));
  if (clamped >= 90) return 'S';
  if (clamped >= 80) return 'A';
  if (clamped >= 70) return 'B';
  if (clamped >= 60) return 'C';
  return 'D';
}
