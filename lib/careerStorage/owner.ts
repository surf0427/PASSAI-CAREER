// PASSAI CAREER — canonical storage の所有者名前空間（account switch 隔離）。
//
// 解決した defect:
//   career の canonical は端末 localStorage だが、キーが全アカウント共通だった。
//   そのため A → logout → B login の端末で、A のデータが B の画面に見え、さらに
//   backfillCareerOnce が **A のデータを B の userId で Supabase へ upload** し得た。
//   RLS は user_id=B の書き込みを正当なものとして許可するため、RLS では防げない
//   （＝ client 側の所有者境界が無いことが原因）。
//
// 方式（Model A: namespaced key）:
//   guest : 従来キーそのまま        …… 'careerEsLogs'
//   member: 従来キー + 所有者 suffix …… 'careerEsLogs::u:<auth user.id>'
//
//   guest を従来キーのままにしている理由:
//     1. guest 利用の挙動が現行と byte 一致で変わらない（移行ゼロ）。
//     2. 既存の localStorage 直書き QA harness（auth が存在しない node 環境 ＝ guest）が
//        そのまま通る。
//     3. 未ログイン端末に残る legacy データを「所有者不明＝guest 相当」として安全側に置ける。
//        member へ勝手に帰属させない（lib/careerStorage/legacyClaim.ts）。
//
//   member suffix は '::u:' 固定。guest は suffix を持たないため、UUID との衝突は構造上起きない。
//
// 所有者 identity:
//   **必ず auth user.id 由来**（CareerAuthProvider が resolveCareerSession の結果で設定する）。
//   email / 表示名 / URL / query param は使わない。
//
// ★ pointer key について:
//   リロード直後は auth が非同期で未解決なのに、storage 読み出しは同期で起きる。
//   そこで「最後に確定した所有者」を pointer key に持ち、初回同期読み出しの名前空間を決める。
//   これは **端末内の名前空間セレクタ**であって認可には一切使わない
//   （server は常に auth session + RLS で判定する。pointer を書き換えても他人の行は読めないし、
//     その端末に無いデータが現れることもない）。auth 解決時に必ず上書き・不一致は即補正される。

import {
  safeGetStorage,
  safeRemoveStorage,
  safeSetStorage,
} from '@/lib/storage/safeStorage';

export type CareerStorageOwner =
  | { kind: 'guest' }
  | { kind: 'member'; userId: string };

export const CAREER_GUEST_OWNER: CareerStorageOwner = { kind: 'guest' };

/** 所有者 suffix。guest は付けない（＝従来キー）。 */
const OWNER_SUFFIX = '::u:';

/** 最後に確定した所有者の pointer（認可には使わない・名前空間の選択のみ）。 */
const OWNER_POINTER_KEY = 'careerStorageOwner';

type OwnerPointer = { userId: string } | null;

// module 内の現在値。null = 未初期化（初回アクセス時に pointer から復元する）。
let current: CareerStorageOwner | null = null;

const listeners = new Set<() => void>();

function readPointer(): CareerStorageOwner {
  const pointer = safeGetStorage<OwnerPointer>(OWNER_POINTER_KEY, null);
  if (pointer && typeof pointer.userId === 'string' && pointer.userId !== '') {
    return { kind: 'member', userId: pointer.userId };
  }
  return CAREER_GUEST_OWNER;
}

/**
 * 現在の所有者。SSR / 未初期化では pointer（無ければ guest）を返す。
 * ★ 同期関数であること自体が要件（storage 読み出しは同期で起きるため）。
 */
export function getCareerStorageOwner(): CareerStorageOwner {
  if (current) return current;
  if (typeof window === 'undefined') return CAREER_GUEST_OWNER;
  current = readPointer();
  return current;
}

function sameOwner(a: CareerStorageOwner, b: CareerStorageOwner): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'member' || b.kind !== 'member' || a.userId === b.userId;
}

/**
 * 所有者を設定する（CareerAuthProvider だけが呼ぶ）。
 * @param userId auth user.id。null / 空文字は guest（ログアウト・未ログイン）。
 * @returns 実際に変化したか（変化時のみ購読者へ通知済み）。
 */
export function setCareerStorageOwner(userId: string | null | undefined): boolean {
  const next: CareerStorageOwner =
    typeof userId === 'string' && userId !== ''
      ? { kind: 'member', userId }
      : CAREER_GUEST_OWNER;

  const prev = getCareerStorageOwner();
  if (sameOwner(prev, next)) return false;

  current = next;
  if (next.kind === 'member') {
    safeSetStorage<OwnerPointer>(OWNER_POINTER_KEY, { userId: next.userId });
  } else {
    // ログアウトでは **消すだけ**。どのアカウントの canonical も削除しない
    //   （同じユーザーが再ログインしたら自分の名前空間がそのまま戻る）。
    safeRemoveStorage(OWNER_POINTER_KEY);
  }
  for (const listener of listeners) listener();
  return true;
}

/** 所有者が切り替わったときに再読込したい view 用（in-memory の持ち越しを防ぐ）。 */
export function subscribeCareerStorageOwner(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** 指定所有者での実キー。guest は従来キーそのまま。 */
export function careerStorageKeyFor(owner: CareerStorageOwner, baseKey: string): string {
  return owner.kind === 'member' ? `${baseKey}${OWNER_SUFFIX}${owner.userId}` : baseKey;
}

/**
 * 現在の所有者での実キー。各 feature の storage module は
 * `const KEY = 'careerEsLogs'` を **読み出しのたびに** 本関数へ通す
 * （module 読み込み時に確定させると、後からログインしても古い名前空間を掴み続けるため）。
 */
export function careerStorageKey(baseKey: string): string {
  return careerStorageKeyFor(getCareerStorageOwner(), baseKey);
}

/** テスト用: module 内キャッシュを捨てて pointer から読み直す。 */
export function resetCareerStorageOwnerCacheForTest(): void {
  current = null;
}
