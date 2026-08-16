'use client';

/**
 * 就活版（CAREER）専用の認証コンテキスト。
 *
 * 受験版 `app/components/AuthProvider.tsx` とは別系統・独立で、career 専用 Supabase
 * client（lib/careerSupabase/*）の上に構築する。ログインは email OTP のみ、匿名は
 * 発行しない。既存セッションが残っていれば自動で member になる（2 回目以降は自動ログイン）。
 *
 * 公開する state:
 *   - status : 'loading' | 'guest' | 'member'
 *   - user   : { id, email } | null（member のとき）
 *   - account: CareerAccount | null（career_accounts 行。display_user_id を含む）
 *   - refresh(): セッション + account を読み直す
 *   - signOut(): ログアウト
 *
 * 未ログイン / env 未設定では account は null のまま。既存の localStorage canonical
 * な保存経路には一切干渉しない（本 provider は identity を持つだけ）。
 *
 * ✅ Project B 完全分離（split-brain 解消済み）:
 *   かつては career 機能 mirror（lib/supabase/career*.ts）と GD roomAuth が受験版
 *   （shared / Project A）client の auth.uid() を使っており、CAREER_* を別プロジェクトへ
 *   向けた瞬間に identity と mirror が割れる split-brain 状態だった。
 *   現在は career runtime の **identity / browser mirror / server / service role すべてが
 *   Project B（lib/careerSupabase/*）に統一**され、auth.uid() 空間は単一になっている。
 *   この不変条件は scripts/career-supabase-project-boundary-qa.ts が静的に守る。
 *   詳細: docs/auth/career_login_design.md
 *
 * 受験版 API 互換 alias:
 *   `useCurrentUserId` / `useAuthStatus` / `useIsMember` は受験版 AuthProvider と
 *   **同名・同シグネチャ**の alias。career 側 callsite の import 差し替えだけで
 *   Project B identity に切り替えられるように用意してある（下の state を読むだけで、
 *   auth logic は一切重複実装しない）。career 専用の名前を使いたい場合は
 *   `useCareerUserId` / `useCareerAuthStatus` / `useCareerAuth` を使う。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  resolveCareerSession,
  signOutCareer,
} from '@/lib/careerSupabase/auth';
import {
  ensureCareerAccount,
  loadCareerAccount,
  type CareerAccount,
} from '@/lib/careerSupabase/account';

export type CareerAuthStatus = 'loading' | 'guest' | 'member';

export type CareerUser = {
  id: string;
  email: string | null;
};

type CareerAuthContextValue = {
  status: CareerAuthStatus;
  user: CareerUser | null;
  account: CareerAccount | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** UI が onboarding 保存後に account を差し替えるための同期 setter。 */
  setAccount: (account: CareerAccount) => void;
};

const CareerAuthContext = createContext<CareerAuthContextValue>({
  status: 'loading',
  user: null,
  account: null,
  refresh: async () => {},
  signOut: async () => {},
  setAccount: () => {},
});

export function CareerAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CareerAuthStatus>('loading');
  const [user, setUser] = useState<CareerUser | null>(null);
  const [account, setAccountState] = useState<CareerAccount | null>(null);

  // StrictMode / 再マウントの二重起動を無害化するためのガード。
  const runningRef = useRef(false);

  const load = useCallback(async () => {
    const session = await resolveCareerSession();

    if (session.kind === 'no-env' || session.kind === 'guest') {
      // env 未設定でも guest として扱い、既存機能（localStorage）は素通しさせる。
      setStatus('guest');
      setUser(null);
      setAccountState(null);
      return;
    }

    // member（is_anonymous !== true の永続ユーザー）。session が残っていれば
    // 自動で member になる（2 回目以降の自動ログイン）。
    setUser({ id: session.userId, email: session.email });

    // account 行を **確定させてから** member に切り替える。ensureCareerAccount で
    // 行が無ければ display_user_id=null で idempotent に作成する。account 解決を
    // status 切替の前に済ませることで「member かつ account=null（読み込み中）」の
    // 過渡状態で誤って onboarding へ飛ばす race を防ぐ。
    //   - 成功 → account 設定（display_user_id 済み or 未設定=onboarding 必要）。
    //   - 失敗（env/RLS/network）→ フォールバックで load を試し、それも不可なら null。
    //     account=null は「表示ID未確定」と同義で UI は onboarding へ誘導する。
    const ensured = await ensureCareerAccount(session.userId, session.email);
    if (ensured.kind === 'ok') {
      setAccountState(ensured.account);
    } else {
      const loaded = await loadCareerAccount(session.userId);
      setAccountState(loaded.kind === 'ok' ? loaded.account : null);
    }
    setStatus('member');
  }, []);

  useEffect(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        await load();
      } finally {
        if (!cancelled) runningRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const signOut = useCallback(async () => {
    await signOutCareer();
    setStatus('guest');
    setUser(null);
    setAccountState(null);
  }, []);

  const setAccount = useCallback((next: CareerAccount) => {
    setAccountState(next);
  }, []);

  return (
    <CareerAuthContext.Provider
      value={{ status, user, account, refresh, signOut, setAccount }}
    >
      {children}
    </CareerAuthContext.Provider>
  );
}

export function useCareerAuth(): CareerAuthContextValue {
  return useContext(CareerAuthContext);
}

/** member（ログイン済み）確定の auth user id。guest / loading は null。 */
export function useCareerUserId(): string | null {
  return useContext(CareerAuthContext).user?.id ?? null;
}

export function useCareerAuthStatus(): CareerAuthStatus {
  return useContext(CareerAuthContext).status;
}

// ── 受験版 AuthProvider 互換 alias（Project B identity を返す）─────────────
//
// 受験版 `app/components/AuthProvider.tsx` と同名・同シグネチャ・同 semantics。
// career 配下の callsite は import 元をこのファイルへ差し替えるだけでよい。
// いずれも上の CareerAuthContext を読むだけで、認証ロジックは重複させない。

/** 受験版互換: member 確定の auth user id。guest / loading は null。 */
export function useCurrentUserId(): string | null {
  return useCareerUserId();
}

/** 受験版互換: 認証状態（'loading' | 'guest' | 'member'）。 */
export function useAuthStatus(): CareerAuthStatus {
  return useCareerAuthStatus();
}

/** 受験版互換: member（ログイン済み永続ユーザー）か。 */
export function useIsMember(): boolean {
  return useContext(CareerAuthContext).status === 'member';
}
