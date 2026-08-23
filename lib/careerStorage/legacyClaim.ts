// PASSAI CAREER — 所有者名前空間の導入前に書かれた legacy データの帰属判定。
//
// 問題:
//   名前空間の導入以前、career の canonical は全アカウント共通のキーに入っていた。
//   その中身が誰のものかを示す field は **どのログにも無い**（CareerEsLog 等に ownerId は無い）。
//   したがって「いまログイン中だからこの端末の legacy は全部この人のもの」と即断すると、
//   過去に account switch した端末では **他人のデータを現ユーザーへ帰属させて**しまい、
//   さらに backfill でそれが現ユーザーの Supabase 行として書かれる（今回直した defect の再発）。
//
// 唯一使える所有証明:
//   'supabaseBackfill'（lib/repository/backfillFlag.ts）は
//   `{ [userId]: { [feature]: entry } }` 形式で、**この端末で過去に backfill が走った userId** を
//   記録している。backfill はログイン確定直後に必ず起動されるため、
//   「career feature の記録を持つ userId 集合」＝ この端末で過去にログインした career account。
//
// 判定:
//   自分以外の career account の記録が 1 つでもある  → 帰属不明 ⇒ **移行しない**（安全側）
//   自分以外の記録が無い                            → この端末の legacy は自分（または自分が
//                                                     ログイン前に guest として作ったもの）だけ
//                                                     ⇒ 自分の名前空間へ **移動**する
//
//   ★ copy ではなく move にしているのは、
//     「guest data → A が login して取り込む → logout → B が login → 同じ guest data を B も取り込む」
//     という二重帰属を **構造的に**起こさないため（移動後は legacy キーが存在しない）。
//
// 移行しなかった legacy データは削除しない。ログアウト時（guest 名前空間）にはこれまでどおり見える。
// member 側は再 backfill/restore（BACKFILL_VERSION の世代上げ）で自分の mirror から復元される。

import {
  safeGetRawStorage,
  safeGetStorage,
  safeHasStorage,
  safeRemoveStorage,
  safeSetRawStorage,
} from '@/lib/storage/safeStorage';
import { CAREER_LEGACY_CLAIM_EXCLUDED_KEYS, CAREER_OWNED_STORAGE_KEYS } from './keys';
import { CAREER_GUEST_OWNER, careerStorageKeyFor } from './owner';

const BACKFILL_FLAG_KEY = 'supabaseBackfill';

export type CareerLegacyClaimOutcome =
  /** legacy を自分の名前空間へ移動した。 */
  | { kind: 'claimed'; keys: string[] }
  /** 他 account の利用履歴がある端末。帰属不明のため移行しない。 */
  | { kind: 'skipped_ambiguous'; otherUserCount: number }
  /** 移行対象の legacy が無い。 */
  | { kind: 'skipped_no_legacy' }
  /** 自分の名前空間に既にデータがある（上書きしない）。 */
  | { kind: 'skipped_already_owned' }
  /** userId が無い等、判定不能。 */
  | { kind: 'skipped_unknown_owner' };

type BackfillRecord = Record<string, Record<string, unknown> | undefined>;

/**
 * この端末で過去に career を使った **自分以外の** account 数。
 * 受験版 feature（tutor / essayWorkspaces 等）しか記録が無い userId は数えない。
 */
export function countOtherCareerAccountsOnDevice(userId: string): number {
  const record = safeGetStorage<BackfillRecord>(BACKFILL_FLAG_KEY, {});
  let others = 0;
  for (const [id, features] of Object.entries(record)) {
    if (!id || id === userId || !features) continue;
    const hasCareerFeature = Object.keys(features).some((f) => f.startsWith('career'));
    if (hasCareerFeature) others++;
  }
  return others;
}

/**
 * legacy（所有者なし）career データを、証明できる場合だけ userId の名前空間へ移す。
 * never-throw。呼び出しは CareerAuthProvider の **backfill より前**（`setCareerStorageOwner` の直後）。
 */
export function claimLegacyCareerDataOnce(userId: string): CareerLegacyClaimOutcome {
  if (!userId) return { kind: 'skipped_unknown_owner' };
  const owner = { kind: 'member', userId } as const;

  // 自分の名前空間に何かあるなら、この端末では移行済み（または既に自分で使っている）。
  const alreadyOwned = CAREER_OWNED_STORAGE_KEYS.some((key) =>
    safeHasStorage(careerStorageKeyFor(owner, key)),
  );
  if (alreadyOwned) return { kind: 'skipped_already_owned' };

  const legacyKeys = CAREER_OWNED_STORAGE_KEYS.filter(
    (key) =>
      !CAREER_LEGACY_CLAIM_EXCLUDED_KEYS.includes(key) &&
      safeHasStorage(careerStorageKeyFor(CAREER_GUEST_OWNER, key)),
  );
  if (legacyKeys.length === 0) return { kind: 'skipped_no_legacy' };

  const others = countOtherCareerAccountsOnDevice(userId);
  if (others > 0) return { kind: 'skipped_ambiguous', otherUserCount: others };

  const moved: string[] = [];
  for (const key of legacyKeys) {
    const from = careerStorageKeyFor(CAREER_GUEST_OWNER, key);
    // 値は再解釈せず raw のまま移す（normalize 差分でデータが変質しないように）。
    const raw = safeGetRawStorage(from);
    if (raw === null) continue;
    safeSetRawStorage(careerStorageKeyFor(owner, key), raw);
    safeRemoveStorage(from);
    moved.push(key);
  }
  return { kind: 'claimed', keys: moved };
}
