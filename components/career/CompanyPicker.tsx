'use client';

/**
 * CompanyPicker — 4 機能（企業研究 / ES / 面接 / プレゼン）共通の企業入力（Phase A）。
 *
 * 責務:
 *   - 登録済み企業の選択（companyId + companyName を **必ず両方**セット）
 *   - 企業の検索・新規登録（Resolver / register API 経由）
 *   - **free-text fallback**（Company Spine が使えない状況でも従来どおり入力できる）
 *
 * 絶対に守る不変条件:
 *   1. free-text 入力欄を **消さない**。未ログイン / Supabase 未設定 / flag OFF /
 *      オフラインでも、企業名を手入力して既存機能を完走できる。
 *   2. `ambiguous` / 部分一致 suggestion を **勝手に確定しない**。必ずユーザーが選ぶ。
 *   3. 企業を選んだら companyId と companyName を同時にセットする
 *      （面接の「companyId があるのに companyName 空」を構造的に防ぐ）。
 *   4. free-text を編集したら companyId を **外す**（ID と名前の乖離を作らない）。
 *
 * ★ 企業判定ロジックは持たない（server の Resolver → 既存 identity.ts へ委譲）。
 *
 * ── 初回リリース（Company Identity 延期中）──────────────────────────────
 * server flag `CAREER_COMPANY_IDENTITY_ENABLED` は OFF 固定のため、resolve / register /
 * lookup は常に `available:false` を返す。その状態で「登録済み企業とひも付ける」ボタンを
 * 出しても、押した先で「利用できません」と言うだけの行き止まりになる。
 * そこで本 component は `IDENTITY_UI_ENABLED`（下記）で Identity 系 UI を静的に伏せ、
 * ユーザーには **企業名を入力するだけの普通のフォーム**として見せる。
 * 実装・props・handler は削除せず温存してあり、再開は定数 1 つの切り替えで済む。
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import { Input } from '@/components/ui/Input';
import {
  loadCompanyDirectory,
  touchCompanyInDirectory,
} from '@/app/career/company/companyDirectory';
import {
  notifyCompanyIntent,
  registerCompanyByName,
  resolveCompanyByName,
} from '@/app/career/company/companyClient';
import type {
  CareerCompanyDirectoryEntry,
  CompanyResolveCandidate,
} from '@/types/careerCompanyIdentity';

export type CompanyPickerValue = {
  /** 登録済み企業に紐付いているときだけ入る（欠損が正常）。 */
  companyId?: string;
  /** 既存の free-text。**常に維持される**。 */
  companyName: string;
};

type Props = {
  value: CompanyPickerValue;
  onChange: (next: CompanyPickerValue) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** 入力欄の下に出す補足文（機能ごとの文言）。 */
  hint?: string;
};

/**
 * Company Identity 系 UI（ひも付け CTA / 候補選択 / 企業登録 / 最近使った企業 /
 * 「利用できません」文言）を表示してよいか。
 *
 * ★ 初回リリースは **false 固定**。理由:
 *   - 権限を持つのは server flag `CAREER_COMPANY_IDENTITY_ENABLED`（server-only）であり、
 *     client からは読めない。UI 都合だけで `NEXT_PUBLIC_*` を増やすと flag が二重管理になり、
 *     「UI だけ ON / server は OFF」という行き止まり状態を作れてしまう。
 *   - 初回リリースでは OFF 固定と決まっているため、build 時定数で十分（env を増やさない）。
 *
 * 再開手順: 本定数を true にし、あわせて server の `CAREER_COMPANY_IDENTITY_ENABLED=true` を
 * 設定する。**server 側が最終権限**なので、ここだけ true にしても登録・解決は成立しない
 * （その場合は従来どおり `unavailable` 表示に落ちるだけで、free-text は壊れない）。
 *
 * boolean 注釈は意図的: リテラル型に潰さず、伏せてある分岐も型検査の対象に保つ。
 */
const IDENTITY_UI_ENABLED: boolean = false;

// マウント前 false / マウント後 true（他ページと同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

type SearchState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'ambiguous'; candidates: readonly CompanyResolveCandidate[] }
  | { kind: 'unresolved'; suggestions: readonly CompanyResolveCandidate[]; name: string }
  | { kind: 'unavailable' };

export function CompanyPicker({
  value,
  onChange,
  label = '企業名',
  required = false,
  disabled = false,
  placeholder = '例: 〇〇株式会社',
  hint,
}: Props) {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
  const [registering, setRegistering] = useState(false);
  // 表示キャッシュを読み直すための世代カウンタ（選択・登録のたびに +1）。
  const [directoryVersion, setDirectoryVersion] = useState(0);

  const directory = useMemo<CareerCompanyDirectoryEntry[]>(() => {
    // directoryVersion は「localStorage を読み直す」ためのトリガ（値自体は使わない）。
    void directoryVersion;
    return isMounted ? loadCompanyDirectory() : [];
  }, [isMounted, directoryVersion]);

  const linked = typeof value.companyId === 'string' && value.companyId.trim() !== '';

  // 最近使った企業（現在選択中のものは除く）。
  const recent = useMemo(
    () => directory.filter((e) => e.companyId !== value.companyId).slice(0, 6),
    [directory, value.companyId],
  );

  /** 企業を確定する（companyId と companyName を必ず同時にセット）。 */
  function selectCompany(companyId: string, displayName: string) {
    const name = displayName.trim();
    // 表示名が空の企業は紐付けない（invariant 3 を壊さないための保険）。
    if (name === '') return;
    touchCompanyInDirectory(companyId, name);
    setDirectoryVersion((v) => v + 1);
    setSearch({ kind: 'idle' });
    onChange({ companyId, companyName: name });
  }

  /** free-text 編集 → companyId を外す（ID と名前の乖離を防ぐ）。 */
  function handleFreeTextChange(next: string) {
    setSearch({ kind: 'idle' });
    onChange({ companyName: next });
  }

  /**
   * Company Prefetch の内部 trigger（**UI は何も変わらない**）。
   *
   * なぜ onChange ではなく onBlur か:
   *   - onChange（keystroke）で発火すると IME 変換中の中間文字列（「そに」「ソニ」）が
   *     server の企業照合へ流れ、全ユーザー共有の企業マスタを汚す。
   *   - onBlur は IME 確定後に必ず 1 回だけ来るため、「入力し終えた」最も早い確実な signal。
   *
   * 契約:
   *   - fire & forget（await しない・結果を見ない・state を変えない）。
   *   - 失敗しても何も起きない（free-text 保存フローに影響させない）。
   *   - 同一企業への重複 trigger は server 側の company-scoped idempotency が畳む。
   *     よって「保存時にも送る」経路と二重に走っても外部取得は 1 回に収束する。
   */
  function handleFreeTextBlur() {
    if (disabled) return;
    notifyCompanyIntent(value.companyName);
  }

  async function handleSearch() {
    const name = value.companyName.trim();
    if (name === '' || disabled) return;
    setSearch({ kind: 'searching' });
    const res = await resolveCompanyByName(name);
    if (!res.available) {
      // flag OFF / 未ログイン / env 未設定 / 失敗 → free-text のまま続行できる。
      setSearch({ kind: 'unavailable' });
      return;
    }
    const data = res.data;
    if (data.status === 'resolved') {
      selectCompany(data.companyId, data.displayName);
      return;
    }
    if (data.status === 'ambiguous') {
      // ★ 自動確定しない。
      setSearch({ kind: 'ambiguous', candidates: data.candidates });
      return;
    }
    setSearch({ kind: 'unresolved', suggestions: data.suggestions, name });
  }

  async function handleRegister(name: string) {
    if (disabled || registering) return;
    setRegistering(true);
    const res = await registerCompanyByName(name);
    setRegistering(false);
    if (!res.available) {
      setSearch({ kind: 'unavailable' });
      return;
    }
    // ★ 登録時にも複数社へ一致しうる（別表記 alias の衝突）。自動確定せず候補を出す。
    if (res.data.status === 'ambiguous') {
      setSearch({ kind: 'ambiguous', candidates: res.data.candidates });
      return;
    }
    selectCompany(res.data.companyId, res.data.displayName);
  }

  return (
    <div>
      <label className="block text-sm font-bold text-slate-800 mb-2">
        {label} {required && <span className="text-rose-500">*</span>}
      </label>

      {/* 「登録済み企業」バッジは Identity UX そのものなので初回リリースでは出さない。
          ★ value.companyId は落とさない（過去データはそのまま親 state に残り、ユーザーが
            企業名を編集しない限り従来どおり保存される）。表示だけを free-text に寄せる。 */}
      {linked && IDENTITY_UI_ENABLED ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-blue-50 ring-1 ring-blue-200 px-3 py-2.5">
          <span className="text-sm font-semibold text-blue-900 break-words">
            {value.companyName}
          </span>
          <span className="text-[11px] font-bold text-blue-600 tracking-wide">登録済み企業</span>
          <button
            type="button"
            onClick={() => handleFreeTextChange(value.companyName)}
            disabled={disabled}
            className="ml-auto text-xs text-blue-700 underline underline-offset-2 hover:text-blue-900 disabled:opacity-50"
          >
            変更する
          </button>
        </div>
      ) : (
        <>
          {/* ★ free-text fallback。どんな状況でもここから入力できる。
              初回リリースではこれが唯一の入力手段になる（IME 中に resolve / normalize /
              API request が走る経路は下記が伏せられている間そもそも存在しない）。 */}
          <Input
            value={value.companyName}
            onChange={(e) => handleFreeTextChange(e.target.value)}
            onBlur={handleFreeTextBlur}
            placeholder={placeholder}
            disabled={disabled}
          />

          {/* ── ここから下は Company Identity 専用 UI（初回リリースでは非表示）──────
              ひも付け CTA / 最近使った企業 / 候補選択 / 企業登録 / 利用不可メッセージ。
              削除せず定数で伏せるだけに留める（再開時にそのまま復帰させるため）。 */}
          {IDENTITY_UI_ENABLED && (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleSearch}
                  disabled={disabled || value.companyName.trim() === '' || search.kind === 'searching'}
                  className="text-xs font-semibold text-blue-700 ring-1 ring-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50 disabled:opacity-40 transition-colors"
                >
                  {search.kind === 'searching' ? '検索中…' : '登録済み企業とひも付ける'}
                </button>
                <span className="text-[11px] text-slate-400">
                  ひも付けなくてもこのまま進めます
                </span>
              </div>

              {recent.length > 0 && (
                <div className="mt-2.5">
                  <p className="text-[11px] font-bold text-slate-500 tracking-wide mb-1.5">
                    最近使った企業
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {recent.map((e) => (
                      <button
                        key={e.companyId}
                        type="button"
                        onClick={() => selectCompany(e.companyId, e.displayName)}
                        disabled={disabled || e.displayName.trim() === ''}
                        className="rounded-full bg-white ring-1 ring-slate-200 px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors"
                      >
                        {e.displayName || '（名称不明）'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {search.kind === 'ambiguous' && (
                <div className="mt-2.5 rounded-xl bg-amber-50 ring-1 ring-amber-200 px-3 py-2.5">
                  <p className="text-xs font-bold text-amber-900 mb-2">
                    候補が複数あります。どれか選んでください。
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {search.candidates.map((c) => (
                      <button
                        key={c.companyId}
                        type="button"
                        onClick={() => selectCompany(c.companyId, c.displayName)}
                        className="text-left text-sm text-slate-800 rounded-lg bg-white ring-1 ring-slate-200 px-3 py-1.5 hover:bg-slate-50 transition-colors"
                      >
                        {c.displayName}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {search.kind === 'unresolved' && (
                <div className="mt-2.5 rounded-xl bg-slate-50 ring-1 ring-slate-200 px-3 py-2.5">
                  {search.suggestions.length > 0 && (
                    <>
                      <p className="text-xs font-bold text-slate-700 mb-2">
                        近い企業が見つかりました（違う場合は下から登録できます）
                      </p>
                      <div className="flex flex-col gap-1.5 mb-2.5">
                        {search.suggestions.map((c) => (
                          <button
                            key={c.companyId}
                            type="button"
                            onClick={() => selectCompany(c.companyId, c.displayName)}
                            className="text-left text-sm text-slate-800 rounded-lg bg-white ring-1 ring-slate-200 px-3 py-1.5 hover:bg-slate-50 transition-colors"
                          >
                            {c.displayName}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRegister(search.name)}
                    disabled={registering}
                    className="text-xs font-semibold text-white bg-blue-600 rounded-lg px-3 py-1.5 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {registering ? '登録中…' : `「${search.name}」として登録する`}
                  </button>
                </div>
              )}

              {search.kind === 'unavailable' && (
                <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                  企業の登録機能は現在利用できません（ログインが必要な場合があります）。
                  このまま企業名を入力して進められます。
                </p>
              )}
            </>
          )}
        </>
      )}

      {hint && <p className="mt-2 text-xs text-slate-500 leading-relaxed">{hint}</p>}
    </div>
  );
}
