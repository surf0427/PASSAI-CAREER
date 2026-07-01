// PASSAI 就活版 — GD Phase2 マルチGD の AI 補完メンバー生成（server-side helper）。
//
// 役割: host が開始した瞬間、`planned - 参加人数` を AI で補完する（STEP-GD-13）。
// 本モジュールは persona プール定義と「不足分だけ・重複なし・deterministic に選ぶ」補完ロジックを分離する。
//
// 設計方針（AGENTS.md / このファイルのコメント参照）:
//   - MBTI は使わない。就活GD 練習に必要な 10 タイプ（persona_key はスネークケース）。
//   - 毎回完全ランダムではなく roomId を seed にして deterministic に選ぶ（同じ room は同じ並び）。
//   - 実用タイプ（leader / logical / idea / cautious / cooperative）を優先し、
//     人数が多い・難易度を上げるときに noise 役（critical / quiet / runaway / indecisive）を混ぜる。
//   - 同一 room 内で persona_key は重複させない。既存 AI members の persona_key は除外して不足分だけ補完。
//   - runaway / indecisive は難易度ノイズ役だが、議論を壊しすぎないよう weaknesses に制御説明を持たせる。
//
// 純粋ロジック（DOM / localStorage / Supabase / Math.random 非依存）。Supabase への insert は呼び出し側で行う。

import type { GdRole } from '@/types/careerGd';

// ── persona 型 ────────────────────────────────────────────────────

export type CareerGdAiPersonaKey =
  | 'leader'
  | 'logical'
  | 'idea'
  | 'cautious'
  | 'data'
  | 'cooperative'
  | 'critical'
  | 'quiet'
  | 'runaway'
  | 'indecisive';

export type CareerGdAiPersona = {
  persona_key: CareerGdAiPersonaKey;
  display_name: string;
  role: string; // 議論上の役回り（GdRole とは別。プロンプト用の説明）
  persona_summary: string;
  speaking_style: string;
  strengths: string[];
  weaknesses: string[];
  // 既存 CareerGdRoomMember.persona 型（{assertiveness, style}）との後方互換用。
  // 押しの強さ 1〜3。AI が議論を独占しないよう、強め(3)は少数タイプに限る。
  assertiveness: 1 | 2 | 3;
  style: string;
};

// ── persona プール（10 タイプ） ───────────────────────────────────

export const CAREER_GD_AI_PERSONAS: readonly CareerGdAiPersona[] = [
  {
    persona_key: 'leader',
    display_name: 'AIリーダー',
    role: '進行・整理',
    persona_summary: '議論の流れを整理し、時間配分や次の論点を提示する。',
    speaking_style: '落ち着いて全体を見ながら、要点を短く整理して話す。',
    strengths: ['進行管理', '論点整理', '結論誘導'],
    weaknesses: ['自分でまとめすぎる', '他者の深掘りを急ぎがち'],
    assertiveness: 3,
    style: '推進型',
  },
  {
    persona_key: 'logical',
    display_name: 'AI論理派',
    role: '根拠・因果確認',
    persona_summary: '意見の根拠、因果関係、前提条件を確認する。',
    speaking_style: 'なぜそう言えるのかを確認しながら、筋道立てて話す。',
    strengths: ['論理性', '前提確認', '矛盾指摘'],
    weaknesses: ['発想が固くなりやすい', '議論の勢いを止めることがある'],
    assertiveness: 2,
    style: '論理型',
  },
  {
    persona_key: 'idea',
    display_name: 'AIアイデアマン',
    role: '発想・選択肢拡張',
    persona_summary: '新しい案や別視点を積極的に出す。',
    speaking_style: '明るくテンポよく、複数の案を出す。',
    strengths: ['発想力', '選択肢拡張', '場の活性化'],
    weaknesses: ['現実性が甘くなる', '論点が散らかることがある'],
    assertiveness: 2,
    style: 'アイデア発散型',
  },
  {
    persona_key: 'cautious',
    display_name: 'AI慎重派',
    role: 'リスク・課題確認',
    persona_summary: '案の弱点、実行上の課題、失敗リスクを指摘する。',
    speaking_style: '丁寧に懸念点を出し、実現可能性を確認する。',
    strengths: ['リスク管理', '課題発見', '実行性確認'],
    weaknesses: ['前向きな流れを止めがち', '否定的に見えることがある'],
    assertiveness: 1,
    style: '慎重型',
  },
  {
    persona_key: 'data',
    display_name: 'AIデータ担当',
    role: '数字・事例提示',
    persona_summary: '数字、仮説、事例を使って議論を具体化する。',
    speaking_style: '具体例や数値感を交えて、説得力を補強する。',
    strengths: ['具体化', '数字感覚', '事例提示'],
    weaknesses: ['データがない場面で発言が弱い', '細部に寄りすぎることがある'],
    assertiveness: 2,
    style: '論理型',
  },
  {
    persona_key: 'cooperative',
    display_name: 'AI協調役',
    role: '合意形成・橋渡し',
    persona_summary: '対立する意見をつなぎ、全員が話しやすい空気を作る。',
    speaking_style: '柔らかく受け止めながら、共通点を探して話す。',
    strengths: ['合意形成', '傾聴', '場作り'],
    weaknesses: ['結論を強く押し出しにくい', '対立を避けすぎることがある'],
    assertiveness: 1,
    style: '共感型',
  },
  {
    persona_key: 'critical',
    display_name: 'AI批判役',
    role: '反論・検証',
    persona_summary: 'あえて反対意見を出し、案の弱点を検証する。',
    speaking_style: '少し鋭く、前提や結論に反論する。',
    strengths: ['反論力', '検証力', '穴の発見'],
    weaknesses: ['場の空気を悪くしやすい', '建設的提案が少なくなることがある'],
    assertiveness: 3,
    style: '批判型',
  },
  {
    persona_key: 'quiet',
    display_name: 'AI寡黙枠',
    role: '無口な参加者',
    persona_summary: '本番にありがちな発言量の少ない参加者を再現する。',
    speaking_style: '促されるまで短く話し、発言頻度は低い。',
    strengths: ['本番再現性', '聞き役', '簡潔な発言'],
    weaknesses: ['議論への貢献が少ない', '意見を引き出す必要がある'],
    assertiveness: 1,
    style: '寡黙型',
  },
  {
    persona_key: 'runaway',
    display_name: 'AI暴走枠',
    role: '脱線・過剰主張',
    persona_summary: 'やや的外れな方向に話を広げ、議論の軌道修正練習を発生させる。',
    speaking_style: '勢いよく話すが、論点から少しズレることがある。',
    strengths: ['対応力訓練', '軌道修正練習', '場の揺さぶり'],
    // 制御用: 脱線はするが議論全体を破壊しない範囲に留める（難易度ノイズ役）。
    weaknesses: ['議論を脱線させる', '結論形成を遅らせる'],
    assertiveness: 2,
    style: '発散型',
  },
  {
    persona_key: 'indecisive',
    display_name: 'AI優柔不断枠',
    role: '迷い・結論保留',
    persona_summary: '複数案の間で迷い、結論を出す難しさを再現する。',
    speaking_style: 'どちらも良いと迷いながら、決定を先延ばしにしがち。',
    strengths: ['比較検討', '慎重な判断', '多面的視点'],
    // 制御用: 迷うが議論を止めない範囲に留める（難易度ノイズ役）。
    weaknesses: ['決断が遅い', '結論を曖昧にしやすい'],
    assertiveness: 1,
    style: '優柔不断型',
  },
] as const;

const PERSONA_BY_KEY: ReadonlyMap<CareerGdAiPersonaKey, CareerGdAiPersona> = new Map(
  CAREER_GD_AI_PERSONAS.map((p) => [p.persona_key, p]),
);

// 選択の優先ティア（実用タイプ → 中間 → 難易度ノイズ役）。
// 補完人数が少ないほど上位ティアだけで埋まり、多いほど下位（ノイズ役）まで混ざる。
const PERSONA_TIERS: readonly CareerGdAiPersonaKey[][] = [
  // Tier1: まず埋める実用タイプ。
  ['leader', 'logical', 'idea', 'cautious', 'cooperative'],
  // Tier2: 具体化を足す中間タイプ。
  ['data'],
  // Tier3: 練習難易度を上げるノイズ役（人数が多いときだけ届く）。
  ['critical', 'quiet', 'runaway', 'indecisive'],
];

// ── deterministic な seed / PRNG / shuffle ────────────────────────

// 文字列 → 32bit seed（xmur3 相当）。roomId から決定的な種を作る。
function seedFromString(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

// mulberry32: seed から決定的な [0,1) 乱数列を返す。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 決定的 Fisher-Yates（同じ rand なら同じ並び）。
function seededShuffle<T>(input: readonly T[], rand: () => number): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── persona 選択 ──────────────────────────────────────────────────

// roomId を seed に、不足分だけ persona を deterministic に選ぶ。
//   - 既存 AI の persona_key（existingPersonaKeys）は除外して重複させない。
//   - ティア順（実用 → 中間 → ノイズ）を保ちつつ、各ティア内は roomId seed で並べ替える。
//   - neededCount が全 persona 数を超える場合でも重複はさせず、選べるだけ返す。
export function selectAiPersonasForRoom(
  roomId: string,
  neededCount: number,
  existingPersonaKeys: readonly string[] = [],
): CareerGdAiPersona[] {
  const need = Math.max(0, Math.floor(neededCount));
  if (need === 0) return [];

  const excluded = new Set(existingPersonaKeys);
  const rand = mulberry32(seedFromString(roomId || 'room'));

  const ordered: CareerGdAiPersona[] = [];
  for (const tier of PERSONA_TIERS) {
    const candidates = tier.filter((k) => !excluded.has(k));
    for (const key of seededShuffle(candidates, rand)) {
      const persona = PERSONA_BY_KEY.get(key);
      if (persona) ordered.push(persona);
    }
  }
  return ordered.slice(0, need);
}

// ── insert 用メンバー行の生成 ─────────────────────────────────────

// career_gd_room_members へ insert する AI 行の形（room_id は呼び出し側で付与）。
// participant_id / persona は transcript 突合・プロンプト生成に使う。
export type AiRoomMemberInsert = {
  user_id: null; // AI は user_id NULL
  is_ai: true;
  is_host: false;
  participant_id: string;
  display_name: string;
  role: GdRole; // 'member' 固定。開始時に assignRoles で再割当される。
  persona: CareerGdAiPersona; // jsonb。{assertiveness, style} を含むため既存 mapMemberRow と後方互換。
};

// 不足人数ぶんの AI メンバー insert 行を作る（room_id は付けない）。
//   caller 例: admin.from('career_gd_room_members').insert(rows.map(r => ({ ...r, room_id })))
//   participant_id は roomId + persona_key から決定的に作る（開始リトライ時も同じ ID）。
export function buildAiRoomMembers(
  roomId: string,
  neededCount: number,
  existingPersonaKeys: readonly string[] = [],
): AiRoomMemberInsert[] {
  const personas = selectAiPersonasForRoom(roomId, neededCount, existingPersonaKeys);
  return personas.map((persona) => ({
    user_id: null,
    is_ai: true,
    is_host: false,
    participant_id: `gdai-${roomId}-${persona.persona_key}`,
    display_name: persona.display_name,
    role: 'member',
    persona,
  }));
}
