// PASSAI CAREER — purpose 別に「どの Source kind の同期 claim を送るか」の宣言（D-R2 closure）。
//
// client は必要な kind の revision だけを計算・送信する（不要な localStorage read と header 肥大を避ける）。
// server 側の要求 kind と食い違うと unclaimed → veto（＝安全側に倒れるだけで危険は生じない）が、
// 意図せず機能が無効化されるので、両者は本ファイルを **単一の宣言** として共有する。
//
// 純粋な定数のみ（I/O / env 非依存・browser 兼用）。

import type { CareerSourceKind } from '@/lib/careerSourceData/types';

/**
 * Personal Memory（Layer 2）の 4 section が由来する Source kind の和集合。
 * sourceProjection.SECTION_SOURCE_KINDS と一致させる
 * （drift は scripts/career-source-sync-veto-qa.ts が assert する）。
 */
export const PERSONAL_MEMORY_SYNC_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
  'self_analysis',
  'es',
  'interview',
];

/** server-driven base context（NEXT-6）が使う Source kind。 */
export const BASE_CONTEXT_SYNC_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
];
