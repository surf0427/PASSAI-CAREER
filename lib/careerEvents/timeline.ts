/**
 * career_user_events を「本人向け利用履歴タイムライン」の表示モデルへ変換する純関数（P9-B）。
 *
 * 位置づけ:
 *   - Event Log は write-only だった。P9-B で **本人専用（owner-scoped）read path** を初めて開通する。
 *   - 本モジュールは **表示専用の純変換**。DB / Supabase / env / secret / React に依存しない
 *     （QA から決定論的に import できる）。取得は lib/careerEvents/read.ts。
 *   - AI prompt / context / body / CareerMemorySnapshot / BaseMemorySummary には一切接続しない。
 *
 * 安全方針（本文・PII を UI に出さない二重防御）:
 *   - 表示するのは feature / event_type の enum ラベル・score band・短ラベル・allowlist metadata のみ。
 *   - metadata は **表示側 allowlist**（sanitize.ts の ALLOWED_METADATA_KEYS の部分集合）で絞る。
 *     allowlist に無い key・denylist に一致する key・非スカラー・長文・改行入りは表示しない。
 *   - 生スコアは持たない（score_band = S/A/B/C/D のみ）。company_id / user_id は扱わない。
 */

import type { CareerScoreBand } from '@/types/careerEvents';

// career_user_events から owner scope で読む最小行（read.ts の select と対）。
// user_id / company_id / created_at は取得しない（本人表示に不要 & 特定リスク低減）。
export type RecentCareerEventRow = {
  id: string;
  event_type: string;
  feature: string;
  industry: string | null;
  job_type: string | null;
  selection_phase: string | null;
  score_band: string | null;
  weakness_category: string | null;
  next_action: string | null;
  completion_status: string | null;
  metadata: unknown;
  occurred_at: string;
};

export type EventTimelineMetaChip = { key: string; label: string; value: string };

// UI が描画する安全な表示モデル（ラベル / enum / band / allowlist metadata のみ）。
export type EventTimelineItem = {
  id: string;
  featureLabel: string;
  eventTypeLabel: string;
  occurredAtLabel: string; // 人間可読 JST（YYYY/MM/DD HH:mm）
  scoreBand: CareerScoreBand | null;
  industry: string | null;
  jobType: string | null;
  selectionPhase: string | null;
  metaChips: EventTimelineMetaChip[];
};

// feature の日本語ラベル。未知値は安全な短トークンとしてそのまま出す（列は enum 検証済み書き込み）。
const FEATURE_LABELS: Record<string, string> = {
  matching: 'マッチング',
  consultation: '相談AI',
  interview: '面接',
  es: 'ES',
  presentation: 'プレゼン',
  company_research: '企業研究',
  gd: 'GD',
  self_analysis: '自己分析',
  profile: '基本情報',
  activity: '活動整理',
  values: '就活軸',
};

// event_type の日本語ラベル。
const EVENT_TYPE_LABELS: Record<string, string> = {
  feature_started: '開始',
  feature_completed: '完了',
  feature_abandoned: '中断',
  ai_generated: 'AI生成',
  ai_reviewed: 'AI添削',
  score_recorded: 'スコア記録',
  weakness_identified: '弱み検出',
  action_suggested: '次アクション提案',
  company_researched: '企業研究',
  matching_run: 'マッチング実行',
  consultation_asked: '相談',
};

// 表示してよい metadata key（sanitize.ts ALLOWED_METADATA_KEYS の部分集合・日本語ラベル付き）。
// この map に無い key は UI に一切出さない（想定外 key の完全遮断）。
const META_DISPLAY: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'companyCount', label: '企業数' },
  { key: 'industryCount', label: '業界数' },
  { key: 'jobCount', label: '職種数' },
  { key: 'threadCount', label: 'スレッド数' },
  { key: 'turnCount', label: 'ターン数' },
  { key: 'participantCount', label: '参加人数' }, // P9-E: GD の参加者数
  // 注: 'messageCount' は sanitize.ts の denylist 'message' に一致して書き込み側で必ず落ちる
  //   （allowlist に在っても denylist が勝つ）。DB に入り得ないため表示側でも扱わない。
  { key: 'revisionCount', label: '修正回数' },
  { key: 'count', label: '件数' },
  { key: 'mode', label: 'モード' },
  { key: 'interviewType', label: '面接種別' },
  { key: 'selectionType', label: '選考種別' },
  // scenario は presentation の「想定シーン」廃止で新規書き込みは無い（旧イベント行の描画用に残す）。
  { key: 'scenario', label: 'シーン' },
  { key: 'sourceType', label: '情報源' }, // P9-C: company_research の情報源
  { key: 'format', label: '形式' }, // GD の議論形式（presentation の発表形式は廃止済み）
  { key: 'participationMode', label: '参加形態' },
  { key: 'charLimit', label: '文字数上限' },
  { key: 'timeLimitSec', label: '制限時間(秒)' },
  { key: 'durationSec', label: '所要時間(秒)' },
];

// 表示側の二重防御 denylist（本文が入りうる key 名は allowlist にあっても弾く）。
// sanitize.ts の DENY_KEY_SUBSTRINGS と対（+ university を明示追加）。
const META_DENY_SUBSTRINGS: readonly string[] = [
  'text', 'body', 'content', 'answer', 'question', 'transcript', 'message',
  'memo', 'raw', 'verified', 'prompt', 'response', 'result', 'email', 'name',
  'note', 'comment', 'summary', 'description', 'reason', 'university',
];

const MAX_META_VALUE_LEN = 48;
const SCORE_BANDS: ReadonlySet<string> = new Set(['S', 'A', 'B', 'C', 'D']);

function isDeniedMetaKey(key: string): boolean {
  const lower = key.toLowerCase();
  return META_DENY_SUBSTRINGS.some((bad) => lower.includes(bad));
}

// スカラーのみ・短く改行なしの値だけ文字列化して返す（それ以外は null＝表示しない）。
function safeMetaValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === '') return null;
    if (/[\r\n]/.test(t)) return null; // 改行入り＝本文の疑い → drop
    if (t.length > MAX_META_VALUE_LEN) return null; // 長文 → drop
    return t;
  }
  return null; // object / array / null / undefined は表示しない
}

// 短ラベル（industry / job_type / selection_phase）。空・長文・改行入りは表示しない。
function shortLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t === '') return null;
  if (/[\r\n]/.test(t)) return null;
  if (t.length > MAX_META_VALUE_LEN) return null;
  return t;
}

function featureLabel(feature: string): string {
  if (FEATURE_LABELS[feature]) return FEATURE_LABELS[feature];
  return shortLabel(feature) ?? '—';
}

function eventTypeLabel(type: string): string {
  if (EVENT_TYPE_LABELS[type]) return EVENT_TYPE_LABELS[type];
  return shortLabel(type) ?? '—';
}

function toScoreBandOrNull(v: string | null): CareerScoreBand | null {
  return typeof v === 'string' && SCORE_BANDS.has(v) ? (v as CareerScoreBand) : null;
}

/**
 * occurred_at（ISO / timestamptz 文字列）を JST の YYYY/MM/DD HH:mm に整形する。
 * マシンのタイムゾーンに依存しない決定論的整形（UTC+9 を getUTC* で読む）。
 */
export function formatEventTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const jst = new Date(t + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  const h = String(jst.getUTCHours()).padStart(2, '0');
  const mi = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${y}/${mo}/${d} ${h}:${mi}`;
}

function toMetaChips(metadata: unknown): EventTimelineMetaChip[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const raw = metadata as Record<string, unknown>;
  const chips: EventTimelineMetaChip[] = [];
  for (const { key, label } of META_DISPLAY) {
    if (!(key in raw)) continue;
    if (isDeniedMetaKey(key)) continue; // 二重防御（allowlist にあっても弾く）
    const value = safeMetaValue(raw[key]);
    if (value === null) continue;
    chips.push({ key, label, value });
  }
  return chips;
}

/** owner scope で取得した行配列を、安全な表示モデル配列へ変換する（純関数）。 */
export function toEventTimelineItems(rows: RecentCareerEventRow[]): EventTimelineItem[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is RecentCareerEventRow =>
      Boolean(r) && typeof r === 'object' && typeof r.id === 'string' && r.id !== '',
    )
    .map((r) => ({
      id: r.id,
      featureLabel: featureLabel(r.feature),
      eventTypeLabel: eventTypeLabel(r.event_type),
      occurredAtLabel: formatEventTimestamp(r.occurred_at),
      scoreBand: toScoreBandOrNull(r.score_band),
      industry: shortLabel(r.industry),
      jobType: shortLabel(r.job_type),
      selectionPhase: shortLabel(r.selection_phase),
      metaChips: toMetaChips(r.metadata),
    }));
}
