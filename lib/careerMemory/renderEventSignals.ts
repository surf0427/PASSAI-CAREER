/**
 * L2 Event Signal の compact human-readable renderer（P10-D consultation pilot）。
 *
 * 位置づけ:
 *   CareerEventSignalSummary（bucket/band/recency のみ）を、相談 AI の **次アクション提案の補助**
 *   に使う短い参考ブロックへ変換する純関数。**生 JSON を貼らず**、固定見出し・固定ラベルのみ出力する。
 *
 * 安全方針（防御的・untrusted 入力可）:
 *   - 入力は unknown 受け。version!==1 / 非 object / 描画可能データなし → 空文字（＝ブロック非表示）。
 *   - feature は固定日本語ラベルへ変換（未知 feature は表示しない）。band は S/A/B/C/D のみ。
 *     recency は固定ラベルのみ。exact count / exact timestamp / raw event / id / metadata は出さない。
 *   - 改行入りの自由値・想定外 key は構造的に混入しない（固定語彙のみ組み立てる）。
 *   - 末尾に固定の誤推論防止 note を必ず付ける（能力・意欲・適性を示さない / 本人入力優先 / 補助限定）。
 *   - 構造的 line cap（最大5行）+ byte cap。超過時は latestBands→featureUsage→recentFeatures→
 *     ブロック全体 の順に行 drop（文字列は途中切断しない）。note だけが残る状態にはしない。
 *
 * 初期 pilot で render する field: recentFeatures / featureUsage / latestBands のみ
 * （activeAreaCount / lastActivityRecency は schema 保持だが未描画）。
 */

// feature → 固定日本語ラベル（signals に現れうる CareerEventFeature の全集合）。
const FEATURE_LABELS: Record<string, string> = {
  matching: 'マッチング',
  consultation: '相談AI',
  interview: '面接',
  es: 'ES',
  presentation: 'プレゼン',
  company_research: '企業研究',
  self_analysis: '自己分析',
  gd: 'GD',
  profile: '基本情報',
  activity: '活動整理',
  values: '就活軸',
};
// featureUsage の canonical 補完順（recentFeatures 順を優先し、残りをこの順で並べる）。
const CANONICAL_FEATURE_ORDER: readonly string[] = [
  'matching', 'consultation', 'interview', 'es', 'presentation',
  'company_research', 'self_analysis', 'gd', 'profile', 'activity', 'values',
];
// latestBands は matching → presentation → gd の固定順。
const BAND_FEATURE_ORDER: readonly string[] = ['matching', 'presentation', 'gd'];
const BAND_RECENCY_LABELS: Record<string, string> = { '7d': '7日以内', '30d': '30日以内' };
const USAGE_BUCKETS: ReadonlySet<string> = new Set(['1', '2-3', '4+']);
const SCORE_BANDS: ReadonlySet<string> = new Set(['S', 'A', 'B', 'C', 'D']);

const HEADING = '【参考：最近30日の利用傾向】';
const NOTE =
  '※利用量や評価帯は能力・意欲・適性を示しません。本人の入力を優先し、次の準備提案の補助にのみ使用してください。';

// 構造 cap。
const MAX_TOTAL_BYTES = 700; // hard upper bound（target 600・ラベル長で微超過し得るため 700 を上限）
const MAX_LIST_FEATURES = 5;

// UTF-8 byte 数（Node / browser 共通。Buffer には依存しない）。
function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

function featureLabel(feature: unknown): string | null {
  return typeof feature === 'string' && FEATURE_LABELS[feature] ? FEATURE_LABELS[feature] : null;
}

// recentFeatures → 既知 feature のみ・dedup・最大5・日本語ラベル。
function renderRecentLine(recent: unknown): string | null {
  if (!Array.isArray(recent)) return null;
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const f of recent) {
    if (typeof f !== 'string' || seen.has(f)) continue;
    const label = featureLabel(f);
    if (!label) continue;
    seen.add(f);
    labels.push(label);
    if (labels.length >= MAX_LIST_FEATURES) break;
  }
  return labels.length ? `・直近利用：${labels.join('、')}` : null;
}

// featureUsage → recentFeatures 順を優先、残りは canonical 順。既知 feature・既知 bucket のみ。
function renderUsageLine(usage: unknown, recent: unknown): string | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  const orderedKeys: string[] = [];
  const pushKey = (k: string) => {
    if (!orderedKeys.includes(k) && Object.prototype.hasOwnProperty.call(u, k)) orderedKeys.push(k);
  };
  if (Array.isArray(recent)) for (const f of recent) if (typeof f === 'string') pushKey(f);
  for (const f of CANONICAL_FEATURE_ORDER) pushKey(f);

  const parts: string[] = [];
  for (const k of orderedKeys) {
    const label = featureLabel(k);
    const bucket = u[k];
    if (!label || typeof bucket !== 'string' || !USAGE_BUCKETS.has(bucket)) continue;
    parts.push(`${label} ${bucket}`);
    if (parts.length >= MAX_LIST_FEATURES) break;
  }
  return parts.length ? `・利用量の目安：${parts.join('、')}` : null;
}

// latestBands → matching/presentation/gd 固定順・band S-D・recency 固定ラベル。
function renderBandsLine(bands: unknown): string | null {
  if (!bands || typeof bands !== 'object' || Array.isArray(bands)) return null;
  const b = bands as Record<string, unknown>;
  const parts: string[] = [];
  for (const f of BAND_FEATURE_ORDER) {
    const entry = b[f];
    if (!entry || typeof entry !== 'object') continue;
    const band = (entry as Record<string, unknown>).band;
    const recency = (entry as Record<string, unknown>).recency;
    const label = featureLabel(f);
    if (!label || typeof band !== 'string' || !SCORE_BANDS.has(band)) continue;
    const recencyLabel = typeof recency === 'string' ? BAND_RECENCY_LABELS[recency] : undefined;
    parts.push(recencyLabel ? `${label} ${band}（${recencyLabel}）` : `${label} ${band}`);
  }
  return parts.length ? `・最新評価帯（練習時点）：${parts.join('、')}` : null;
}

function assemble(dataLines: string[]): string {
  if (dataLines.length === 0) return '';
  return [HEADING, ...dataLines, NOTE].join('\n');
}

/**
 * CareerEventSignalSummary → 相談用 compact 参考ブロック（純関数・防御的）。
 * 描画可能データが無い / version!==1 / 非 object の場合は空文字（ブロック非表示）。
 */
export function renderCareerEventSignalsCompact(summary: unknown): string {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return '';
  const s = summary as Record<string, unknown>;
  if (s.version !== 1) return '';

  const recentLine = renderRecentLine(s.recentFeatures);
  const usageLine = renderUsageLine(s.featureUsage, s.recentFeatures);
  const bandsLine = renderBandsLine(s.latestBands);

  // 全 data 行（表示順）。
  let dataLines = [recentLine, usageLine, bandsLine].filter((l): l is string => l !== null);
  if (dataLines.length === 0) return ''; // note だけの状態にしない

  let out = assemble(dataLines);
  // byte cap 超過時は行単位で drop（latestBands → featureUsage → recentFeatures → ブロック全体）。
  if (byteLen(out) > MAX_TOTAL_BYTES) {
    for (const drop of [bandsLine, usageLine, recentLine]) {
      dataLines = dataLines.filter((l) => l !== drop);
      out = assemble(dataLines);
      if (dataLines.length === 0) return '';
      if (byteLen(out) <= MAX_TOTAL_BYTES) break;
    }
    if (byteLen(out) > MAX_TOTAL_BYTES) return ''; // それでも超えるなら全体 drop
  }
  return out;
}
