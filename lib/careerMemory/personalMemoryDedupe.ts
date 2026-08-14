// PASSAI CAREER — Personal Memory / request-body bridge の重複注入防止（Batch 1 / `D-S5`）。
//
// 問題:
//   Personal Memory を prompt へ載せる purpose が、同じ情報を request-body bridge からも
//   受け取っていると、**同一情報が 2 回 prompt に入る**。
//   例（company_research_review・canary ON 時に実在した欠陥）:
//     - `orchestrated.systemPrompt` が body の profile/activity/values を描画
//       ＋ Personal Memory `base` が同じ内容の projection を描画  → 重複
//     - `renderSelfAnalysis(b.selfAnalysis)` ＋ Personal Memory `self_analysis` → 重複
//   重複は prompt を膨らませ、AI に「別々の根拠」と誤認させる。
//
// 方針（**bridge wins / memory fills gaps**）:
//   その section に対応する bridge context が **存在するなら memory section を落とす**。
//   bridge が無いところだけ memory で埋める。
//
//   この方向を選ぶ理由:
//     - prompt 内容が「増える」方向にしか変わらない（bridge があるケースは従来と完全に同じ）。
//       ＝ 既存の parity / 品質を壊さない最小の変更。
//     - bridge 退役が進むほど自動的に memory へ主権が移る（migration が単調に進む）。
//     - 逆向き（memory 優先で bridge を落とす）は、memory が compact projection のため
//       bridge より情報が減りうる。canary 段階で品質を落とす方向は取らない。
//
// 純関数 / deterministic / never-throw。I/O・env 非依存。

import type {
  CareerPersonalMemorySection,
  CareerPersonalMemorySectionKey,
} from './persistence/schema';

/**
 * 「その section に相当する context を request-body bridge から既に受け取っているか」。
 * route が自分の body の実状から組む（true = bridge にある = memory は落とす）。
 */
export type BridgeContextPresence = Readonly<
  Partial<Record<CareerPersonalMemorySectionKey, boolean>>
>;

export type PersonalMemoryDedupeResult = {
  /** prompt へ載せてよい section（bridge と重複しないもの）。 */
  sections: CareerPersonalMemorySection[];
  /** 重複のため落とした section（観測用・PII なし）。 */
  suppressed: CareerPersonalMemorySectionKey[];
};

/**
 * bridge と重複する Personal Memory section を落とす（純関数・never-throw）。
 *
 * ★ 呼び出し側の責務: `presence` は **実際に prompt へ載る bridge block の有無** を反映すること。
 *   「body に field がある」ではなく「その block を実際に描画する」で判定する
 *   （空文字で描画されない block は presence=false）。
 */
export function dedupePersonalMemorySections(
  sections: readonly CareerPersonalMemorySection[] | null | undefined,
  presence: BridgeContextPresence,
): PersonalMemoryDedupeResult {
  try {
    if (!Array.isArray(sections) || sections.length === 0) {
      return { sections: [], suppressed: [] };
    }
    const kept: CareerPersonalMemorySection[] = [];
    const suppressed: CareerPersonalMemorySectionKey[] = [];
    for (const s of sections) {
      if (!s) continue;
      const key: CareerPersonalMemorySectionKey = s.sectionKey;
      if (presence[key] === true) suppressed.push(key);
      else kept.push(s);
    }
    return { sections: kept, suppressed };
  } catch {
    // never-throw: 判定不能なら **memory を落とす**（重複させない側へ倒す）。
    return { sections: [], suppressed: [] };
  }
}
