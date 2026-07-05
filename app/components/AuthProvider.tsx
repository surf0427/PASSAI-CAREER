'use client';

// STEP-AUTH-01 / STEP-AUTH-02 / AUTH DEBUG FIX 01:
//   Anonymous auth + profile context provider with debug-friendly state.
//
// Exposed state（context value）:
//   - currentUserId / profile  既存 API
//   - authReady     anonymous auth が確定（成功 or 失敗）した時点で true
//   - profileReady  profile ensure が確定（成功 or 失敗）した時点で true
//   - authError     anonymous auth が失敗していれば message。成功 / pending は null
//   - profileError  profile ensure が失敗していれば message。成功 / pending は null
//   - setProfile    UI が保存後にコンテキストを同期するための差し替え
//   - retryProfile  /account 側から手動で再試行するための非同期 helper
//
// 既存機能は currentUserId / profile / setProfile のみを使うため、追加 state は
// 後方互換。auth 失敗 / profile 失敗 / 単に処理中 を呼び出し側が切り分けられる。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { resolveSession } from '@/lib/supabase/auth';
import { ensureProfile } from '@/lib/supabase/profile';
import type { Profile } from '@/types/profile';

// STEP-AUTH-REDESIGN: 認証状態の単一定義。
//   - loading: セッション読み取りが未確定。
//   - guest  : 未ログイン（セッション無し / 旧 anonymous は破棄済み）。
//   - member : is_anonymous === false の永続ユーザー。課金導線の対象。
// 会員判定は is_anonymous のみで行い、email の有無では判定しない。
export type AuthStatus = 'loading' | 'guest' | 'member';

type AuthContextValue = {
  status: AuthStatus;
  currentUserId: string | null;
  profile: Profile | null;
  authReady: boolean;
  profileReady: boolean;
  authError: string | null;
  profileError: string | null;
  setProfile: (profile: Profile) => void;
  retryProfile: () => Promise<void>;
  // STEP-AUTH-REDESIGN: member（is_anonymous === false）か。後方互換のため名称は
  //   isPermanentUser のまま残すが、判定は status === 'member' に一本化（email 不問）。
  isPermanentUser: boolean;
  /** 確定済みメール。guest / 未確定は null。表示・誘導用。 */
  userEmail: string | null;
};

const AuthContext = createContext<AuthContextValue>({
  status: 'loading',
  currentUserId: null,
  profile: null,
  authReady: false,
  profileReady: false,
  authError: null,
  profileError: null,
  setProfile: () => {},
  retryProfile: async () => {},
  isPermanentUser: false,
  userEmail: null,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // retryProfile が常に最新の userId を参照できるよう ref に保持。
  // ref の更新は commit 後（effect 内）に行う。retryProfile は event/effect から
  // 呼ばれ render 中には参照しないため、同期更新と挙動は等価（react-hooks/refs 準拠）。
  const currentUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // STEP-AUTH-REDESIGN: セッションは「読むだけ」。anonymous は発行しない。
      const session = await resolveSession();
      if (cancelled) return;

      if (session.kind === 'no-env') {
        setStatus('guest');
        setCurrentUserId(null);
        setUserEmail(null);
        setAuthError(
          'Supabase 接続情報が読み込まれていません (NEXT_PUBLIC_SUPABASE_* 未設定)。',
        );
        setAuthReady(true);
        setProfileReady(true);
        return;
      }

      if (session.kind === 'guest') {
        // 未ログイン（セッション無し / 旧 anonymous は resolveSession が破棄済み）。
        setStatus('guest');
        setCurrentUserId(null);
        setUserEmail(null);
        setAuthError(null);
        setAuthReady(true);
        setProfileReady(true); // guest は profile を持たない。
        return;
      }

      // member（is_anonymous === false の永続ユーザー）。
      setStatus('member');
      setCurrentUserId(session.userId);
      setUserEmail(session.email);
      setAuthError(null);
      setAuthReady(true);

      const profileResult = await ensureProfile(session.userId);
      if (cancelled) return;
      if (profileResult.kind === 'ok') {
        setProfileState(profileResult.profile);
        setProfileError(null);
      } else if (profileResult.kind === 'no-env') {
        setProfileError('Supabase 接続情報が読み込まれていません。');
      } else {
        setProfileError(profileResult.message);
      }
      setProfileReady(true);

      // ── STEP-SUPABASE-COMPLETE-03B: tutor 履歴の初回 backfill（fire-and-forget）──
      //
      // profileReady 確定後、userId が確定しているとき（authResult.kind==='ok'）に
      // 1 回だけ起動する。目的: 差分ミラー（mirrorTutorStoreDelta）が初回マウントを
      // skip するため Supabase に上がらない「既存 LS thread」を一括同期し、別端末の
      // 復元対象にする（STEP-SUPABASE-COMPLETE-02 §3 / 03A backfillTutorOnce）。
      //
      // 契約:
      //   - await しない。認証 / profile フローをブロックしない。
      //   - 例外は握りつぶす。backfill 失敗を auth / profile の失敗にしない。
      //   - dynamic import で browser-only な repository / Supabase client を
      //     server bundle に引き込まない（boundary 安全）。
      //   - cancelled guard: アンマウント後は起動しない。
      //   - backfillTutorOnce 自身が flag（supabaseBackfill）で冪等・1 回限り。
      //     再マウント / 再ログインでも二重実行されない（失敗時のみ次回再試行）。
      //
      // 初回 backfill 負荷:
      //   LS の全 thread × message を直列 upsert する（上限 MAX_THREADS=50 ×
      //   MAX_MESSAGES=200, lib/tutorChatStorage.ts）。最悪ケースで一時的に書き込みが
      //   集中し得るが、fire-and-forget のため UI / auth は待たない。
      //   requestIdleCallback 等の遅延起動は本 STEP では導入しない（必要になれば
      //   後続 STEP で計測のうえ判断）。
      if (!cancelled) {
        const backfillUserId = session.userId;
        void import('@/lib/repository/tutorRepository')
          .then((mod) => mod.backfillTutorOnce(backfillUserId))
          .catch(() => {});
      }

      // ── STEP-SUPABASE-COMPLETE-04C / 04E-2: selfAnalysisLogs 履歴の同期 ──
      //
      // tutor backfill と同形・同じ場所で起動する独立した 2 本目の fire-and-forget。
      // 同一 dynamic import の chain 内で「上り → 下り」を順に実行する:
      //   1. backfillSelfAnalysisLogsOnce（04C, 上り）:
      //      dualWrite 配線前に localStorage に蓄積された既存ログを Supabase へ
      //      一括同期し durable replica を作る。
      //   2. restoreSelfAnalysisLogsOnce（04E-2, 下り one-way merge）:
      //      別端末で生まれたログを Supabase から取り込み localStorage に merge する。
      //      backfill の後に走らせることで、自端末分を先に SB へ確定させてから
      //      取り込み、未同期の自端末ログを取りこぼさない（STEP-04E-DESIGN §5）。
      //
      // restore の性質:
      //   - 下り one-way merge。削除は非伝播（remote に無い local log を消さない）。
      //   - merge 時は older/original の id を保持し、UI の selectedLogId
      //     （selection identity）を安定させる（mergeSelfAnalysisLogs）。
      //   - 即時再 render は保証しない。mypage の useMemo は LS 書き戻しを自動検知
      //     しないため、mypage / resume への反映は次回 mount / 再訪時でよい
      //     （mypage に subscribe / 強制再 render は足さない＝read 経路を変えない）。
      //
      // 契約（tutor backfill と同一）:
      //   - await しない。認証 / profile フローをブロックしない。
      //   - 例外は握りつぶす。同期失敗を auth / profile の失敗にしない。
      //   - dynamic import で browser-only な repository / Supabase client を
      //     server bundle に引き込まない（boundary 安全）。
      //   - cancelled guard: アンマウント後は起動しない。
      //   - backfillSelfAnalysisLogsOnce / restoreSelfAnalysisLogsOnce はそれぞれ
      //     別の flag（supabaseBackfill の 'selfAnalysisLogs' / 'selfAnalysisLogsRestore'）
      //     で冪等・1 回限り。再マウント / 再ログインでも二重実行されない。
      //   - tutor backfill とはチェーンしない（独立起動）。
      if (!cancelled) {
        const backfillUserId = session.userId;
        void import('@/lib/repository/selfAnalysisLogRepository')
          .then((mod) =>
            mod
              .backfillSelfAnalysisLogsOnce(backfillUserId)
              .then(() => mod.restoreSelfAnalysisLogsOnce(backfillUserId)),
          )
          .catch(() => {});
      }

      // ── STEP-SUPABASE-COMPLETE-05C: selfPRs 履歴の初回 backfill（上りのみ）──
      //
      // tutor / selfAnalysisLogs backfill と同形・同じ場所で起動する独立した
      // 3 本目の fire-and-forget。dualWrite 配線前に localStorage（key='selfPRs'）に
      // 蓄積された既存カードを Supabase self_prs へ一括同期し durable replica を作る
      // （STEP-05B backfillSelfPRsOnce）。
      //
      // selfAnalysisLogs と異なり restore（下り）はチェーンしない:
      //   selfPR は delete feature であり、down-sync は delete resurrection を招く。
      //   restore / tombstone は別 STEP（schema preview §6 / §8）。本 STEP は上りのみ。
      //
      // 契約（tutor backfill と同一）:
      //   - await しない。認証 / profile フローをブロックしない。
      //   - 例外は握りつぶす。backfill 失敗を auth / profile の失敗にしない。
      //   - dynamic import で browser-only な repository / Supabase client を
      //     server bundle に引き込まない（boundary 安全）。
      //   - cancelled guard: アンマウント後は起動しない。
      //   - backfillSelfPRsOnce 自身が flag（supabaseBackfill の 'selfPRs'）で
      //     冪等・1 回限り。再マウント / 再ログインでも二重実行されない。
      if (!cancelled) {
        const backfillUserId = session.userId;
        void import('@/lib/repository/selfPRRepository')
          .then((mod) => mod.backfillSelfPRsOnce(backfillUserId))
          .catch(() => {});
      }

      // ── STEP-SUPABASE-COMPLETE-06C: statementReviewHistory の初回 backfill（上りのみ）──
      //
      // tutor / selfAnalysisLogs / selfPRs backfill と同形・同じ場所で起動する独立した
      // 4 本目の fire-and-forget。dualWrite 配線（06D）前に localStorage
      // （key='statementReviewHistory'）に蓄積された既存の添削履歴を Supabase
      // statement_review_history へ一括同期し durable replica を作る
      // （STEP-06B/06C backfillStatementReviewHistoryOnce）。
      //
      // selfPRs と同じく restore（下り）はチェーンしない:
      //   添削履歴は delete を伴う feature（id 削除 + 10 件 cap eviction）であり、
      //   down-sync は delete resurrection を招く。restore / tombstone は別 STEP（06E）。
      //   LS の 10 件 cap は DB に反映しない（DB は 10 件超を durable 保持。preview §9）。
      //
      // 契約（tutor backfill と同一）:
      //   - await しない。認証 / profile フローをブロックしない。
      //   - 例外は握りつぶす。backfill 失敗を auth / profile の失敗にしない。
      //   - dynamic import で browser-only な repository / Supabase client を
      //     server bundle に引き込まない（boundary 安全）。
      //   - cancelled guard: アンマウント後は起動しない。
      //   - backfillStatementReviewHistoryOnce 自身が flag（supabaseBackfill の
      //     'statementReviewHistory'）で冪等・1 回限り。再マウント / 再ログインでも
      //     二重実行されない。
      if (!cancelled) {
        const backfillUserId = session.userId;
        void import('@/lib/repository/statementReviewHistoryRepository')
          .then((mod) =>
            mod.backfillStatementReviewHistoryOnce({ userId: backfillUserId }),
          )
          .catch(() => {});
      }

      // ── STEP-INTERVIEW-AI-PR2: interview_practice_records の初回 backfill（上りのみ）──
      //
      // 先行 backfill（tutor / selfAnalysisLogs / selfPRs / statementReviewHistory）と
      // 同形・同じ場所で起動する独立した fire-and-forget。create-site mirror 配線前に
      // localStorage（key='interview_records'）に蓄積された既存の面接練習記録を Supabase
      // interview_practice_records へ一括同期し durable replica を作る
      // （STEP-INTERVIEW-AI-PR2 backfillInterviewPracticeRecordsOnce）。
      //
      // selfPRs / statementReviewHistory と同じく restore（下り）はチェーンしない:
      //   面接練習記録は delete を伴う feature（deleteInterviewRecord）であり、down-sync は
      //   delete resurrection を招く。restore / tombstone は別 STEP（schema preview §8）。
      //
      // 契約（先行 backfill と同一）:
      //   - await しない。認証 / profile フローをブロックしない。
      //   - 例外は握りつぶす。backfill 失敗を auth / profile の失敗にしない。
      //   - dynamic import で browser-only な repository / Supabase client を server bundle に
      //     引き込まない（boundary 安全）。cancelled guard: アンマウント後は起動しない。
      //   - backfillInterviewPracticeRecordsOnce 自身が flag（supabaseBackfill の
      //     'interviewPracticeRecords'）で冪等・1 回限り。再マウント / 再ログインでも
      //     二重実行されない。
      if (!cancelled) {
        const backfillUserId = session.userId;
        void import('@/lib/repository/interviewPracticeRecordRepository')
          .then((mod) =>
            mod.backfillInterviewPracticeRecordsOnce({ userId: backfillUserId }),
          )
          .catch(() => {});
      }

      // ── STEP-TUTOR-CONTEXT-PHASE2-REPOSITORY-01: basic_info / diagnosis / activity の
      //    snapshot 型 durable の同期（各 feature 上り backfill → 下り restore）──
      //
      // 先行 4 feature（tutor / selfAnalysisLogs / selfPRs / statementReviewHistory）と
      // 同形・同じ場所で起動する独立した fire-and-forget。各 feature は backfill（上り）の
      // 後に restore（下り・LS 空のときだけ）をチェーンする（selfAnalysisLogs と同方式）。
      //
      // 契約（先行 backfill と同一）:
      //   - await しない。認証 / profile フローをブロックしない。
      //   - 例外は握りつぶす。同期失敗を auth / profile の失敗にしない。
      //   - dynamic import で browser-only な repository / Supabase client を server bundle に
      //     引き込まない（boundary 安全）。cancelled guard: アンマウント後は起動しない。
      //   - 各 once 関数が flag（supabaseBackfill の 'basicInfoLog'/'basicInfoLogRestore' 等）で
      //     冪等・1 回限り。snapshot 型のため restore は LS 空のときだけ取り込む（上書き事故防止）。
      //   - 既存 anonymous mirror（mirrorBasicInfo / mirrorDiagnosis / mirrorActivityData）には
      //     触らない（別経路）。
      if (!cancelled) {
        const backfillUserId = session.userId;
        void import('@/lib/repository/basicInfoRepository')
          .then((mod) =>
            mod
              .backfillBasicInfoLogOnce(backfillUserId)
              .then(() => mod.restoreBasicInfoLogOnce(backfillUserId)),
          )
          .catch(() => {});
        void import('@/lib/repository/diagnosisRepository')
          .then((mod) =>
            mod
              .backfillDiagnosisLogOnce(backfillUserId)
              .then(() => mod.restoreDiagnosisLogOnce(backfillUserId)),
          )
          .catch(() => {});
        void import('@/lib/repository/activityRepository')
          .then((mod) =>
            mod
              .backfillActivityLogOnce(backfillUserId)
              .then(() => mod.restoreActivityLogOnce(backfillUserId)),
          )
          .catch(() => {});
      }

      // ── 小論文 essayWorkspaces の mirror 配線 + 初回 backfill（上りのみ）──
      //
      // 先行 feature と同形・同じ場所で起動する独立した fire-and-forget。essay は
      // 保存経路が localStorage のみで Supabase 未連携だったため、本配線で durable mirror を
      // 確立する。statement_review_history（志望理由書）とは別 table・別機能。
      //
      //   1. registerEssayWorkspaceMirror: 以降の upsertEssayWorkspace（autosave / 添削結果 /
      //      改善ワーク保存）を debounce で essay_workspaces に mirror する dualWrite を配線。
      //   2. backfillEssayWorkspacesOnce: 配線前に localStorage（key='essayWorkspaces'）へ
      //      蓄積された既存 workspace を一括同期（flag で 1 回限り・冪等）。
      //
      // 契約（先行 backfill と同一）:
      //   - await しない。認証 / profile フローをブロックしない。
      //   - 例外は握りつぶす。同期失敗を auth / profile の失敗にしない。
      //   - dynamic import で browser-only な repository / Supabase client を server bundle に
      //     引き込まない（boundary 安全）。cancelled guard: アンマウント後は起動しない。
      //   - userId が空なら mirror は no-op。RLS（auth.uid() = user_id）で他人の行は触れない。
      if (!cancelled) {
        const essayUserId = session.userId;
        void import('@/lib/repository/essayWorkspaceRepository')
          .then((mod) => {
            mod.registerEssayWorkspaceMirror(essayUserId);
            return mod.backfillEssayWorkspacesOnce({ userId: essayUserId });
          })
          .catch(() => {});
      }

      // ── STEP-CAREER-SUPABASE-01/02: 就活版（career）各機能の初回 backfill（上り）+ restore（下り）──
      //
      // 先行 backfill と同形・同じ場所で起動する独立した fire-and-forget。
      // career 機能は localStorage canonical で、ログイン（member）確定後に:
      //   1. 上り backfill: LS に貯まった career データ（profile / activity / values / 自己分析 /
      //      自己PR / マッチング / ES / 面接 / プレゼン / 相談 / 企業研究）を career_* table
      //      （durable mirror）へ一括 upsert する。
      //   2. 下り restore: durable mirror 由来のログを LS へマージ復元する（別端末ログイン時に
      //      マイページ /career/mypage が空にならないようにする）。単一レコードは LS 空のときだけ、
      //      履歴系は id マージ（local 優先）で local を壊さない。
      // 各 feature は backfillFlag（supabaseBackfill）で冪等・1 端末 1 回限り。受験版データには触れない。
      //
      // 契約（先行 backfill と同一）:
      //   - await しない。認証 / profile フローをブロックしない。例外は握りつぶす。
      //   - dynamic import で browser-only な repository を server bundle に引き込まない。
      //   - cancelled guard: アンマウント後は起動しない。userId 空 / env 未設定なら no-op。
      //   - backfill（上り）→ restore（下り）の順で走らせ、手元データ push 後に他端末由来行を merge する。
      if (!cancelled) {
        const careerUserId = session.userId;
        void import('@/lib/repository/careerBackfill')
          .then((mod) => mod.backfillCareerOnce({ userId: careerUserId }))
          .then(() => import('@/lib/repository/careerRestore'))
          .then((mod) => mod.restoreCareerOnce({ userId: careerUserId }))
          .catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setProfile = useCallback((next: Profile) => {
    setProfileState(next);
    setProfileError(null);
    setProfileReady(true);
  }, []);

  const retryProfile = useCallback(async () => {
    const userId = currentUserIdRef.current;
    if (!userId) return;
    setProfileReady(false);
    const result = await ensureProfile(userId);
    if (result.kind === 'ok') {
      setProfileState(result.profile);
      setProfileError(null);
    } else if (result.kind === 'no-env') {
      setProfileError('Supabase 接続情報が読み込まれていません。');
    } else {
      setProfileError(result.message);
    }
    setProfileReady(true);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        status,
        currentUserId,
        profile,
        authReady,
        profileReady,
        authError,
        profileError,
        setProfile,
        retryProfile,
        isPermanentUser: status === 'member',
        userEmail,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useCurrentUserId(): string | null {
  return useContext(AuthContext).currentUserId;
}

export function useProfile(): Profile | null {
  return useContext(AuthContext).profile;
}

/** STEP-AUTH-REDESIGN: 認証状態（loading / guest / member）。 */
export function useAuthStatus(): AuthStatus {
  return useContext(AuthContext).status;
}

/** STEP-AUTH-REDESIGN: member（is_anonymous === false）か。課金導線のゲートに使う。 */
export function useIsMember(): boolean {
  return useContext(AuthContext).status === 'member';
}

/**
 * STEP-AUTH-REDESIGN: 後方互換エイリアス。判定は member（is_anonymous === false）。
 * 新規コードは useIsMember を使う。
 */
export function useIsPermanentUser(): boolean {
  return useContext(AuthContext).isPermanentUser;
}

/** STEP-AUTH-P0: 確定済みメール（匿名 / 未確定は null）。表示・誘導用。 */
export function useUserEmail(): string | null {
  return useContext(AuthContext).userEmail;
}

export function useSetProfile(): (profile: Profile) => void {
  return useContext(AuthContext).setProfile;
}

/** AUTH DEBUG FIX 01: /account の分岐表示 / debug panel 用。 */
export function useAuthDebug(): {
  authReady: boolean;
  profileReady: boolean;
  authError: string | null;
  profileError: string | null;
  retryProfile: () => Promise<void>;
} {
  const ctx = useContext(AuthContext);
  return {
    authReady: ctx.authReady,
    profileReady: ctx.profileReady,
    authError: ctx.authError,
    profileError: ctx.profileError,
    retryProfile: ctx.retryProfile,
  };
}
