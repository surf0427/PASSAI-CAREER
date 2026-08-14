// PASSAI CAREER — Layer 5 contributor identity strategy（Decision Resolution Batch / `D-R2`）。
//
// 解決した blocker（`D-C8` に記録していたもの）:
//
// > contribution は contributor を **opaque key** で持ち、型に auth user id が無い。
// > owner-scoped RLS を張るには `auth.uid()` と照合できる列が必要だが、
// > opaque key のままでは照合できない。
//
// ── 検討した 3 案 ────────────────────────────────────────────────────
//
// I1: contribution row が直接 `auth.uid()` を owner UUID として保持する
//     ✅ owner RLS が最も単純（`auth.uid() = contributor_user_id`）
//     ✅ withdrawal / account 削除の cascade が自明
//     ❌ **contribution table 自体が「誰が何を投稿したか」の台帳になる**。
//        moderator や将来の read 経路のミスで contributor が漏れる面が広い。
//     ❌ dedupe / provenance の内部処理が user id を触ることになる。
//
// I2: 別テーブルで `auth.uid()` ↔ opaque contributor id を対応させ、
//     contribution は opaque id だけを持つ（**採用**）
//     ✅ owner RLS を張れる（join / subquery で `auth.uid()` から opaque id を解決）
//     ✅ contribution 本体には識別子が入らない（既存の型・projection・dedupe を変えずに済む）
//     ✅ withdrawal は subject table 側で完結（contribution 本体を触らずに全件無効化できる）
//     ✅ 対応表を削除すれば **contribution は再識別不能になる**（強い削除手段が持てる）
//     ❌ join が 1 段増える（性能影響は小。公開 read は published view で別経路）
//
// I3: 完全 anonymous（対応表を持たない）
//     ✅ 最も privacy が強い
//     ❌ **撤回・削除・本人による寄与一覧の確認が原理的に不可能**。
//        「撤回したら以後止まる」すら保証できない（本人の寄与を特定できないため）。
//     ❌ 悪用時の追跡・takedown も不可能。
//     → Human 指示 §18 の「revoked → future contributions blocked を構造的に保証」と両立しない。
//
// ★ 採用: **I2**。privacy（contribution 本体に識別子を置かない）と
//   withdrawal / RLS / provenance の要件を同時に満たせる唯一の案。
//
// ── 本 module の責務 ────────────────────────────────────────────────
// 対応表の **contract と純粋ロジック**だけを定義する。
// 実 DB（table / RLS / RPC）は `supabase/prototype/` の draft のみで、production 適用しない。
//
// pure / deterministic / never-throw。I/O・env 非依存。

import type { CompanyKnowledgeContribution } from '@/types/careerCompanyKnowledge';

/** contribution 本体が持つ匿名 key（`__contributorOpaqueKey`）。 */
export type ContributorOpaqueKey = string;

/**
 * subject table の 1 行（`auth.uid()` ↔ opaque key の対応）。
 *
 * ★ この型は **subject table 内でのみ**扱う。contribution / projection / evidence へ
 *   渡してはいけない（QA `HDR-3` / `HDR-4` が静的に固定する）。
 */
export type ContributorSubject = {
  /** server auth 由来の UUID。**client 申告値を入れてはいけない**。 */
  authUserId: string;
  opaqueKey: ContributorOpaqueKey;
  /** 対応表の作成時刻（ISO）。 */
  linkedAt: string;
  /**
   * 対応表の失効時刻（ISO）。null は有効。
   * ★ 失効させると「その opaque key の寄与を本人へ辿れない」＝再識別不能になる。
   *   これは account 削除時の **強い削除手段**（contribution 本体を消さずに匿名化できる）。
   */
  unlinkedAt: string | null;
};

export type SubjectResolution =
  | { resolved: true; opaqueKey: ContributorOpaqueKey }
  | { resolved: false; reason: 'no_subject' | 'unlinked' | 'invalid_auth_user' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * `auth.uid()` から opaque key を解決する（**fail-closed**）。
 *
 * ★ 引数の `authUserId` は **server auth 由来**でなければならない。
 *   本関数は「渡された値が UUID か」しか検証できないため、
 *   caller-selected UUID を渡さないことは呼び出し側の契約
 *   （QA `HDR-3` が route / lib に client 由来 user id が現れないことを固定する）。
 */
export function resolveContributorOpaqueKey(
  authUserId: string | null | undefined,
  subjects: readonly ContributorSubject[] | null | undefined,
): SubjectResolution {
  if (typeof authUserId !== 'string' || !UUID_RE.test(authUserId)) {
    return { resolved: false, reason: 'invalid_auth_user' };
  }
  const rows = Array.isArray(subjects) ? subjects : [];
  const match = rows.find((s) => s?.authUserId === authUserId);
  if (!match) return { resolved: false, reason: 'no_subject' };
  if (match.unlinkedAt !== null) return { resolved: false, reason: 'unlinked' };
  if (typeof match.opaqueKey !== 'string' || match.opaqueKey === '') {
    return { resolved: false, reason: 'no_subject' };
  }
  return { resolved: true, opaqueKey: match.opaqueKey };
}

/**
 * ある contribution が **その user のものか**（owner 判定の pure 版）。
 *
 * RLS 相当のロジックをコードでも持つことで、
 * 「RLS を張る前でも owner 判定は同じ意味論で動く」ことを保証する。
 */
export function isOwnContribution(input: {
  authUserId: string | null | undefined;
  contribution: CompanyKnowledgeContribution;
  subjects: readonly ContributorSubject[] | null | undefined;
}): boolean {
  const r = resolveContributorOpaqueKey(input.authUserId, input.subjects);
  if (!r.resolved) return false;
  const key = input.contribution?.__contributorOpaqueKey;
  return typeof key === 'string' && key !== '' && key === r.opaqueKey;
}

/**
 * ★ 撤回の構造的保証（Human 指示 §18）。
 *
 * subject を unlink すると、その user は **以後 opaque key を解決できない**
 * ＝新規 contribution を自分の key で作れない。
 * 既存 contribution 本体は触らずに「以後の寄与だけ」を止められる。
 */
export function unlinkSubject(
  subject: ContributorSubject,
  unlinkedAt: string,
): ContributorSubject {
  return { ...subject, unlinkedAt };
}

/** unlink 済み subject では新規寄与を作れないこと（純粋判定）。 */
export function canCreateContribution(
  authUserId: string | null | undefined,
  subjects: readonly ContributorSubject[] | null | undefined,
): boolean {
  return resolveContributorOpaqueKey(authUserId, subjects).resolved;
}

/**
 * ★ contribution へ identity を混入させないための防御。
 *
 * subject 由来の field（authUserId 等）が contribution へ紛れ込んでいないことを検査する。
 * repository / mapper の実装ミスを実行時にも検出できるようにする（QA も静的に固定する）。
 */
export function containsIdentityLeak(contribution: unknown): boolean {
  if (!contribution || typeof contribution !== 'object') return false;
  const banned = ['authUserId', 'auth_user_id', 'userId', 'user_id', 'email', 'contributorName'];
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 8 || v === null || typeof v !== 'object') return false;
    if (seen.has(v)) return false;
    seen.add(v);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (banned.includes(k)) return true;
      if (walk(val, depth + 1)) return true;
    }
    return false;
  };
  return walk(contribution, 0);
}

/** 採用した identity strategy（docs / QA が参照する単一の宣言）。 */
export const CONTRIBUTOR_IDENTITY_STRATEGY = 'I2_subject_table' as const;
