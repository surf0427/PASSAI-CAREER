// PASSAI 就活版 — GD の役割・形式・評価ランク・行動特性のラベルと、
// ランダム役割振り分け / AI 補完参加者の生成ロジック。
//
// 純粋ロジック（DOM / localStorage / Supabase 非依存）。ラベル参照は client/server 双方から使う。
// Math.random は関数内でのみ使用（クライアントの setup で呼ぶ）。

import type {
  GdRole,
  GdFormat,
  GdCompanyGrade,
  GdBehaviorTrait,
  GdParticipant,
} from '@/types/careerGd';

// ── ラベル ────────────────────────────────────────────────────────

export const GD_ROLE_LABELS: Record<GdRole, string> = {
  facilitator: '司会',
  scribe: '書記',
  timekeeper: 'タイムキーパー',
  presenter: '発表者',
  member: '一般参加者',
};

export const GD_ROLE_DESCRIPTIONS: Record<GdRole, string> = {
  facilitator: '議論の進行・時間配分・意見の引き出しを担う',
  scribe: '出た意見を整理し、論点を構造化する',
  timekeeper: '残り時間を管理し、フェーズの切り替えを促す',
  presenter: '結論を分かりやすくまとめて発表する',
  member: '積極的に意見を出し、議論に貢献する',
};

export const GD_FORMAT_LABELS: Record<GdFormat, string> = {
  free: '自由討論型',
  case: 'ケース型',
  abstract: '抽象型',
};

export const GD_FORMAT_DESCRIPTIONS: Record<GdFormat, string> = {
  free: '身近なテーマについて自由に議論し、結論をまとめます。',
  case: 'ビジネス課題（与件つき）に対して施策を検討します。',
  abstract: '正解のない抽象的なお題について考えを深めます。',
};

export const GD_GRADE_LABELS: Record<GdCompanyGrade, string> = {
  S: 'かなり通過レベル',
  A: '通過可能性が高い',
  B: '平均的',
  C: '改善が必要',
  D: 'かなり改善が必要',
};

export const GD_BEHAVIOR_TRAIT_LABELS: Record<GdBehaviorTrait, string> = {
  leader: 'リーダー型',
  coordinator: '調整型',
  analytical: '分析型',
  ideator: 'アイデア型',
  listener: '傾聴型',
  driver: '推進型',
};

export const GD_AXIS_LABELS: Record<
  'logic' | 'cooperation' | 'volume' | 'roleExecution' | 'drive' | 'listening',
  string
> = {
  logic: '論理性',
  cooperation: '協調性',
  volume: '発言量',
  roleExecution: '役割遂行度',
  drive: '議論推進力',
  listening: '傾聴力',
};

// ── 役割セット（人数・形式で使う役割数を調整する） ──────────────────

// count 人ぶんの役割を返す（司会・書記を優先し、人数に応じて拡張する）。
export function roleSetFor(count: number, format: GdFormat): GdRole[] {
  const base: GdRole[] = ['facilitator', 'scribe', 'timekeeper', 'presenter'];
  const roles: GdRole[] = [];
  // ケース型は結論の発表を重視するため presenter を早めに含める。
  const order: GdRole[] =
    format === 'case'
      ? ['facilitator', 'scribe', 'presenter', 'timekeeper']
      : base;
  for (let i = 0; i < count; i++) {
    roles.push(i < order.length ? order[i] : 'member');
  }
  return roles;
}

// ── シャッフル（Fisher-Yates） ────────────────────────────────────

function shuffle<T>(input: T[]): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── ランダム役割振り分け ──────────────────────────────────────────

// 参加者に役割をランダムに割り当てる（役割セットをシャッフルして zip）。
export function assignRoles(
  participants: GdParticipant[],
  format: GdFormat,
): GdParticipant[] {
  const roles = shuffle(roleSetFor(participants.length, format));
  return participants.map((p, i) => ({ ...p, role: roles[i] ?? 'member' }));
}

// ── AI 補完参加者の生成 ───────────────────────────────────────────

// AI の発言スタイル候補（多様性を出すために分散させる）。
const AI_STYLES = ['論理型', '共感型', 'アイデア発散型', '慎重型', '推進型'];
const AI_NAMES = ['AI・さくら', 'AI・りく', 'AI・みなと', 'AI・ひなた', 'AI・あおい'];

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// 不足人数ぶんの AI 参加者を作る。
//   - style を分散し、assertiveness は最大 3 でも 1 人までに抑える（ユーザーの発言機会を奪わない）。
export function buildAiParticipants(count: number): GdParticipant[] {
  const styles = shuffle(AI_STYLES).slice(0, Math.max(count, 1));
  const names = shuffle(AI_NAMES).slice(0, Math.max(count, 1));
  const out: GdParticipant[] = [];
  for (let i = 0; i < count; i++) {
    // 押しの強さ: 1 人だけ 3、残りは 1〜2（AI が議論を独占しないようにする）。
    const assertiveness: 1 | 2 | 3 = i === 0 ? 3 : i % 2 === 0 ? 2 : 1;
    out.push({
      id: newId('gdai'),
      type: 'ai',
      displayName: names[i] ?? `AIメンバー${i + 1}`,
      role: 'member', // 役割は assignRoles で後から上書きされる
      persona: {
        assertiveness,
        style: styles[i] ?? '一般型',
      },
    });
  }
  return out;
}

// 自分（ユーザー）1 人 + AI 補完で、指定人数のソロGD 参加者一式を作る（役割割当済み）。
export function buildSoloParticipants(
  selfDisplayName: string,
  plannedCount: number,
  format: GdFormat,
): GdParticipant[] {
  const self: GdParticipant = {
    id: newId('gdself'),
    type: 'user',
    displayName: selfDisplayName || 'あなた',
    role: 'member',
    isSelf: true,
  };
  const aiCount = Math.max(plannedCount - 1, 1);
  const participants = [self, ...buildAiParticipants(aiCount)];
  return assignRoles(participants, format);
}
