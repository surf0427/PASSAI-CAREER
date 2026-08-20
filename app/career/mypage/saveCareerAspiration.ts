'use client';

// PASSAI CAREER — マイページ「志望条件」の canonical write path。
//
// 責務: マイページの編集を **既存の Layer 1 canonical 保存経路にそのまま乗せる**。
//   マイページ専用の store / key / table は作らない（作ると第 2 の真実になる）。
//
// 経路（app/career/profile/ProfileClient.tsx のプロフィール保存と同一の 3 段）:
//
//   MyPage UI
//     ↓ applyCareerAspiration（純関数マージ。空項目はキーごと削除）
//   saveBasicInfo                    … Layer 1 canonical（localStorage 'careerBasicFormData'）
//     ↓
//   saveCareerProfileToSupabase      … Layer 1 durable mirror（career_profiles / member のみ / best-effort）
//     ↓
//   shadowWriteBaseMemory            … Layer 2 base section を同じ決定的 builder で再構築
//     ↓
//   各 Career AI route が renderProfile（Layer 1）/ renderBase（Layer 2）で prompt へ載せる
//
// 厳守:
//   - 既存 profile を **上書きせずマージ**する（氏名 / 大学 / 学年など既存 field を壊さない）。
//   - never-throw。mirror / shadow write の失敗で UI を壊さない（canonical 保存は成立させる）。
//   - guest でも localStorage canonical へは保存する（guest/member 境界を変えない）。
//   - service role を使わない・Event Log を触らない・prompt を生成しない。

import type { CareerProfile } from '@/types/careerProfile';
import { loadBasicInfo, saveBasicInfo } from '@/app/career/profile/profileStorage';
import { saveCareerProfileToSupabase } from '@/lib/supabase/careerProfile';
import { shadowWriteBaseMemory } from '@/app/career/personalMemoryShadowWrite';
import { applyCareerAspiration, type CareerAspiration } from './mypageDataSpineView';

/**
 * profile が未作成のユーザーでも志望条件だけ先に保存できるようにするための最小 shape。
 * ★ 表示上「基本情報 入力済み」に化けないよう、内容は空のまま（判定は
 *   mypageSummary.hasBasicProfileContent が内容ベースで行う）。
 */
function emptyProfileSkeleton(): CareerProfile {
  return {
    name: '',
    grade: '',
    track: '',
    examTypes: [],
    overallGpa: '',
    graduationYear: '',
    preferences: [],
  };
}

export type SaveAspirationOutcome = {
  /** localStorage canonical への保存が成功したか（false なら何も反映されていない）。 */
  canonical: boolean;
  /** durable mirror（career_profiles）へ書いたか。guest / env 未設定なら false。 */
  mirrored: boolean;
  /** 保存後の canonical profile（呼び出し側の再描画用）。失敗時は null。 */
  profile: CareerProfile | null;
};

/**
 * 志望条件を canonical path へ保存する（never-throw）。
 *
 * @param next    マイページで編集された志望条件
 * @param userId  ログイン中の user id（guest は null）
 */
export async function saveCareerAspiration(
  next: CareerAspiration,
  userId: string | null,
): Promise<SaveAspirationOutcome> {
  let profile: CareerProfile | null = null;
  try {
    const base = loadBasicInfo() ?? emptyProfileSkeleton();
    profile = applyCareerAspiration(base, next);
    saveBasicInfo(profile);
  } catch {
    return { canonical: false, mirrored: false, profile: null };
  }

  // Layer 1 durable mirror（member のみ / best-effort）。失敗しても canonical は成立済み。
  let mirrored = false;
  if (userId && profile) {
    try {
      await saveCareerProfileToSupabase(userId, profile);
      mirrored = true;
    } catch {
      mirrored = false;
    }
  }

  // Layer 2 base section を再構築（flag OFF 既定＝no-op / best-effort / prompt 非利用）。
  // ★ canonical + mirror の **後**に呼ぶ（Data Spine の write ordering 契約）。
  void shadowWriteBaseMemory();

  return { canonical: true, mirrored, profile };
}
