/**
 * Company Identity — 企業登録の判定（pure・決定論・never-throw）。Phase 1。
 *
 * 目的（重複企業の防止）:
 *   `任天堂` / `Nintendo` / `ニンテンドー` は `normalizeCompanyName` が script を跨がないため
 *   別 normalized token になる。これを「同じ企業」として扱う唯一の手段が **alias** であり、
 *   本 module は「alias まで見たうえで、新規作成するのか / 既存へ寄せるのか / 決めないのか」
 *   を決める純関数を提供する。
 *
 * ★ 判定だけを持ち、I/O を持たない（`repository.server.ts` が候補を集めて渡す）。
 *   既存の `resolution.ts`（解決の境界整形）と同じ分業で、repository は薄いままにする。
 *
 * 不変条件（QA が固定する）:
 *   - **ambiguous を resolved へ昇格させない。** 候補が 2 社以上なら必ず `ambiguous`。
 *   - **自動 merge しない。** 同一 alias が複数社に付いていても company を統合しない。
 *   - alias は「解決の signal」であって「同一性の証明」ではない。1 社に絞れたときだけ確定する。
 *   - transliteration（漢字→ローマ字等）を **実装しない**。ユーザーが明示した別表記だけを使う。
 */

import { normalizeCompanyName } from '@/lib/careerCompanyKnowledge/identity';

/** 判定に必要な最小の企業表現（内部 record 全体を持ち回らない）。 */
export type CompanyIdentityMatch = {
  companyId: string;
  displayName: string;
};

/**
 * 登録時の判定結果。
 *
 * - `existing`  : 既存企業に寄せる（新規作成しない / `created:false` で返す）
 * - `ambiguous` : 決めない。候補をユーザーへ提示する（★ 勝手に選ばない）
 * - `create`    : 一致する企業が無いので新規作成してよい
 */
export type RegistrationDecision =
  | { kind: 'existing'; companyId: string; displayName: string }
  | { kind: 'ambiguous'; candidates: readonly CompanyIdentityMatch[] }
  | { kind: 'create' };

/** 決定論順（表示名 → companyId）。QA が順序に依存できるようにする。 */
function sortMatches(list: readonly CompanyIdentityMatch[]): CompanyIdentityMatch[] {
  return [...list].sort((a, b) =>
    a.displayName === b.displayName
      ? a.companyId.localeCompare(b.companyId)
      : a.displayName.localeCompare(b.displayName),
  );
}

/**
 * 「入力名の normalized token に一致した企業群」から登録の可否を決める。
 *
 * @param matches `master.normalized_name` または `aliases.normalized_alias` が
 *                入力の normalized token と **完全一致**した企業（部分一致を含めないこと）。
 *                同一 companyId が重複して渡ってきても 1 社として扱う。
 */
export function decideRegistration(
  matches: readonly CompanyIdentityMatch[],
): RegistrationDecision {
  const byId = new Map<string, CompanyIdentityMatch>();
  for (const m of matches) {
    if (!m || typeof m.companyId !== 'string' || m.companyId.trim() === '') continue;
    // 先勝ち（同一 companyId が master 経由と alias 経由の両方で来ても 1 社）。
    if (!byId.has(m.companyId)) {
      byId.set(m.companyId, {
        companyId: m.companyId,
        displayName: typeof m.displayName === 'string' ? m.displayName : '',
      });
    }
  }

  const unique = Array.from(byId.values());
  if (unique.length === 0) return { kind: 'create' };
  if (unique.length === 1) {
    return { kind: 'existing', companyId: unique[0].companyId, displayName: unique[0].displayName };
  }
  // ★ 2 社以上は絶対に確定しない（誤 merge は duplicate より危険）。
  return { kind: 'ambiguous', candidates: sortMatches(unique) };
}

// ── alias の保存可否 ────────────────────────────────────────────────

/**
 * normalized token → その token を既に占有している companyId。
 *
 * `master.normalized_name` と `aliases.normalized_alias` の **両方**から作ること。
 * 片方だけだと「別企業の正式名を alias として奪う」経路が残る。
 */
export type AliasOccupancy = ReadonlyMap<string, string>;

/** 保存してよい alias（server が再計算した normalized 値を必ず伴う）。 */
export type AttachableAlias = {
  alias: string;
  normalizedAlias: string;
};

/** alias の受け入れ上限（register route の MAX_ALIASES と揃える）。 */
export const MAX_ATTACHABLE_ALIASES = 5;

/**
 * ユーザー入力の別名から「安全に保存できるものだけ」を選ぶ。
 *
 * 除外するもの:
 *   - 空 / 空白のみ
 *   - normalize 結果が空
 *   - その企業の normalized_name と同値（表示名そのものを alias にしない）
 *   - **他社が既に占有している token**（★ 奪わない・merge しない・エラーにもしない）
 *   - 自社に既に付いている token（重複保存しない）
 *   - 入力内での重複（先勝ち）
 *
 * ★ 衝突した alias は「黙って落とす」。ここで throw したり、既存企業を書き換えたりしない
 *   （§9 の invariant: 衝突は ambiguous として *読み取り側* が扱う。書き込み側は何もしない）。
 */
export function selectAttachableAliases(params: {
  companyId: string;
  ownNormalizedName: string;
  rawAliases: readonly string[];
  occupancy: AliasOccupancy;
}): AttachableAlias[] {
  const { companyId, ownNormalizedName, rawAliases, occupancy } = params;
  if (!Array.isArray(rawAliases) || rawAliases.length === 0) return [];

  const out: AttachableAlias[] = [];
  const seen = new Set<string>();

  for (const raw of rawAliases) {
    if (out.length >= MAX_ATTACHABLE_ALIASES) break;
    if (typeof raw !== 'string') continue;
    const alias = raw.trim();
    if (alias === '') continue;

    // ★ server 側で必ず再計算する（client 申告の normalized 値を信用しない）。
    const normalizedAlias = normalizeCompanyName(alias);
    if (normalizedAlias === '') continue;
    if (normalizedAlias === ownNormalizedName) continue;
    if (seen.has(normalizedAlias)) continue;

    // 自社が既に持っている / 他社が持っている、どちらも「保存しない」。
    if (occupancy.has(normalizedAlias)) {
      void companyId; // 所有者が誰であれ新規保存はしない（奪わない・重複させない）。
      continue;
    }

    seen.add(normalizedAlias);
    out.push({ alias, normalizedAlias });
  }

  return out;
}
