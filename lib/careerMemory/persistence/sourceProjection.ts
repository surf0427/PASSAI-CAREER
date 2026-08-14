// PASSAI CAREER — Layer 1 Source → Layer 2 section projection（NEXT-3 / Data Spine）。
//
// 責務: server が読んだ Layer 1 Source bundle から、**section 別の期待 revision と payload** を
//   決定的に算出する純関数。これが「server-verified freshness」の土台になる。
//   ★ 保証範囲は **server が読める Layer 1（Supabase mirror）に対する freshness** であり、
//     localStorage canonical に対する freshness ではない（D-R2 / H-1 参照）。
//
// 厳守:
//   - 純関数 / deterministic / I/O・env・Supabase 非依存 / never-throw。
//   - section builder は既存 rebuild.ts を **そのまま再利用**（client shadow-write と同一実装＝
//     同一 Source なら同一 revision）。ここで別 projection を作らない。
//   - profile の PII 除去は既存 normalizeCareerProfileContext + buildBaseMemorySection の projection
//     に委譲する（氏名等は BaseMemorySummary が構造上持たない）。
//
// 依存方向: careerSourceData（Layer 1 型）→ 本 module → careerMemory/persistence（Layer 2）。

import { normalizeCareerProfileContext } from '@/lib/careerAi';
import type { CareerSourceBundle, CareerSourceKind } from '@/lib/careerSourceData/types';
import {
  buildBaseMemorySection,
  buildSelfAnalysisMemorySection,
  buildEsMemorySection,
  buildInterviewMemorySection,
  type SectionRebuildResult,
} from './rebuild';
import type { CareerPersonalMemorySectionKey } from './schema';

// section が由来する Layer 1 Source の集合（read すべき Source の source of truth）。
//   ★ ここに Event Log / Event Signal は **入れない**（D-L3: Layer 3 → Layer 2 は禁止辺）。
export const SECTION_SOURCE_KINDS: Readonly<
  Record<CareerPersonalMemorySectionKey, readonly CareerSourceKind[]>
> = {
  base: ['profile', 'activity', 'values'],
  self_analysis: ['self_analysis'],
  es: ['es'],
  interview: ['interview'],
};

/** section 集合 → 読むべき Source 集合（重複除去・宣言順）。 */
export function sourceKindsForSections(
  sectionKeys: readonly CareerPersonalMemorySectionKey[],
): CareerSourceKind[] {
  const out: CareerSourceKind[] = [];
  for (const key of sectionKeys) {
    for (const kind of SECTION_SOURCE_KINDS[key] ?? []) {
      if (!out.includes(kind)) out.push(kind);
    }
  }
  return out;
}

/**
 * Source bundle から 1 section を決定的に projection する（純関数・never-throw）。
 * 戻り値の sourceRevision が「その時点の Layer 1 から導かれる期待 revision」。
 */
export function projectSectionFromSource(
  sectionKey: CareerPersonalMemorySectionKey,
  bundle: CareerSourceBundle,
): SectionRebuildResult | null {
  try {
    switch (sectionKey) {
      case 'base':
        return buildBaseMemorySection(
          normalizeCareerProfileContext(bundle.profile),
          bundle.activity,
          bundle.values,
        );
      case 'self_analysis':
        return buildSelfAnalysisMemorySection(bundle.selfAnalysisLogs);
      case 'es':
        return buildEsMemorySection(bundle.esLogs);
      case 'interview':
        return buildInterviewMemorySection(bundle.interviewResults);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
