// PASSAI CAREER — purpose 対応表（P5-B: type-only mapping / 未接続）。
//
// 目的（P5-A の発見1への対処の第一歩）:
//   purpose registry が二重に存在する:
//     - live : lib/careerContext/purpose.ts の CareerContextPurpose + CAREER_CONTEXT_REGISTRY
//              （route 側 buildCareerContextForPurpose() が base system prompt 生成に使用中）
//     - design: lib/careerMemory/types.ts の CareerMemoryPurpose + CareerMemoryPurposePolicy（未接続）
//   本ファイルは両者を **統一せず**、対応関係を型安全に明示するだけの「共存のための対応表」。
//
// 厳守（P5-B）:
//   - live registry を置き換えない・変更しない。runtime flow に接続しない。
//   - 純粋な const/type のみ（I/O なし・副作用なし・既存挙動不変）。
//   - 1:1 でない対応（interview / gd）は無理に統一せず、配列で「N 対応」を明示する。

import type { CareerMemoryPurpose } from './types';
import type { CareerContextPurpose } from '@/lib/careerContext/purpose';

// memory purpose → live context purpose（複数対応・非対応を許容）。
//   - value が配列: 1 つの memory purpose が複数の live purpose に跨る（統一しない証拠）。
//   - value が null: live 側に対応する purpose が無い（memory 側の細分 / 予約）。
export type CareerMemoryPurposeMapping = {
  memory: CareerMemoryPurpose;
  // 対応する live purpose。1:N は配列、非対応は空配列で表す。
  context: CareerContextPurpose[];
  // 1:1 か。false のものは P5 で「共存対応表」として扱い、registry 統合は保留。
  oneToOne: boolean;
  note: string;
};

// 対応表（正本）。統一ではなく対応の宣言。runtime では未使用（型検査・監査用）。
export const CAREER_MEMORY_PURPOSE_MAP = [
  {
    memory: 'consultation',
    context: ['consultation'],
    oneToOne: true,
    note: '司令塔。名称一致。',
  },
  {
    memory: 'self_analysis',
    context: ['self_analysis'],
    oneToOne: true,
    note: '名称一致。route は self-analysis/route.ts（B判定・非抽出）。',
  },
  {
    memory: 'self_analysis_deep_dive',
    context: ['self_analysis_deep_dive'],
    oneToOne: true,
    note: '名称一致。deep-dive 質問生成 builder。',
  },
  {
    memory: 'es_review',
    context: ['es_review'],
    oneToOne: true,
    note: '名称一致。base 不使用（静的 SYSTEM_PROMPT）。',
  },
  {
    memory: 'interview',
    // memory は 1 purpose だが live は practice / complete に分かれる（1:N）。
    context: ['interview_practice', 'interview_complete'],
    oneToOne: false,
    note: 'memory は interview 単一。live は start/turn を practice、最終評価を complete に分ける。統一しない。',
  },
  {
    memory: 'presentation',
    context: ['presentation_feedback'],
    oneToOne: false,
    note: '名称差（presentation ↔ presentation_feedback）。意味は 1:1 だが key 名は共存対応で吸収。',
  },
  {
    memory: 'matching',
    context: ['matching'],
    oneToOne: true,
    note: '名称一致。総合スコアは決定的エンジンが別計算。',
  },
  {
    memory: 'company_research',
    context: ['company_research_review'],
    oneToOne: false,
    note: '名称差（company_research ↔ company_research_review）。company-research は B判定（非抽出）。',
  },
  {
    memory: 'gd_solo',
    // live は gd_feedback 1 本。memory は solo / multiplayer_result に細分（N:1）。
    context: ['gd_feedback'],
    oneToOne: false,
    note: 'memory は gd_solo / gd_multiplayer_result に細分。live は gd_feedback 1 本。統一しない。',
  },
  {
    memory: 'gd_multiplayer_result',
    context: ['gd_feedback'],
    oneToOne: false,
    note: 'gd_solo と同じ live purpose を共有（N:1）。memory 側だけ solo/room を区別する。',
  },
  {
    memory: 'mypage',
    context: ['mypage_summary'],
    oneToOne: false,
    note: '名称差（mypage ↔ mypage_summary）。live 側は route 未実装（予約）。',
  },
] as const satisfies readonly CareerMemoryPurposeMapping[];

// 逆引き・検証用ヘルパ（純関数）。未対応 memory purpose は空配列を返す。
export function contextPurposesForMemoryPurpose(
  purpose: CareerMemoryPurpose,
): readonly CareerContextPurpose[] {
  return CAREER_MEMORY_PURPOSE_MAP.find((m) => m.memory === purpose)?.context ?? [];
}

// 1:1 でない（＝共存対応が必要な）memory purpose の一覧（監査・レビュー用）。
export const CAREER_MEMORY_PURPOSE_NON_11 = CAREER_MEMORY_PURPOSE_MAP.filter(
  (m) => !m.oneToOne,
).map((m) => m.memory);
