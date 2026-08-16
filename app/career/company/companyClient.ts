'use client';

/**
 * Company Identity — client 側の API 呼び出し境界（Phase A / R2）。
 *
 * 契約（最重要）:
 *   - **never throw**。ネットワーク断・env 未設定・未ログイン・flag OFF のいずれでも
 *     `{ available:false }` を返し、呼び出し側（CompanyPicker / 企業ページ）は
 *     free-text 入力へ倒す。Company Spine の不調で既存機能を止めない。
 *   - server の envelope（`{available:true,data} | {available:false,reason}`）をそのまま扱う。
 */

import { touchCompanyInDirectory } from './companyDirectory';
import type {
  CompanyIdentityEnvelope,
  CompanyRegisterResult,
  CompanyResolveResult,
} from '@/types/careerCompanyIdentity';

type Envelope<T> = CompanyIdentityEnvelope<T>;

const UNAVAILABLE = { available: false, reason: 'lookup_error' } as const;

async function postJson<T>(url: string, body: unknown): Promise<Envelope<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return UNAVAILABLE;
    const json = (await res.json()) as Envelope<T>;
    if (!json || typeof json !== 'object') return UNAVAILABLE;
    return json;
  } catch {
    return UNAVAILABLE;
  }
}

/** 企業名を解決する。ambiguous / unresolved はそのまま返す（自動確定しない）。 */
export async function resolveCompanyByName(
  name: string,
): Promise<Envelope<CompanyResolveResult>> {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '') {
    return { available: true, data: { status: 'unresolved', suggestions: [] } };
  }
  return postJson<CompanyResolveResult>('/api/career/company/resolve', { name: trimmed });
}

/**
 * 企業を登録する。
 *
 * - 既存企業（**別表記 alias 経由の一致を含む**）があれば `created:false` で既存 ID が返る。
 * - 複数社に一致した場合は `status:'ambiguous'`。★ 呼び出し側は候補を提示すること
 *   （勝手に 1 社目を選んだら invariant 違反）。
 *
 * `aliases` は任意。未指定でも従来どおり動く（free-text fallback を壊さない）。
 */
export async function registerCompanyByName(
  displayName: string,
  aliases: readonly string[] = [],
): Promise<Envelope<CompanyRegisterResult>> {
  const result = await postJson<CompanyRegisterResult>('/api/career/company/register', {
    displayName,
    aliases,
  });
  // 登録直後は必ず表示キャッシュへ反映（詳細ページで名前が出るように）。
  // ★ ambiguous は「まだどの企業か決まっていない」ので**キャッシュへ書かない**。
  if (result.available && result.data?.status === 'registered') {
    touchCompanyInDirectory(result.data.companyId, result.data.displayName);
  }
  return result;
}

/**
 * Company Prefetch — 志望企業 intent を server へ通知する（**fire & forget**）。
 *
 * 目的:
 *   ユーザーが企業名を入力し終えた時点で、server 側に「この企業を調べておいて」と伝える。
 *   ユーザーが企業研究を開くまでの時間差を使って Company Data Spine を先に埋める。
 *
 * 契約（Requirement A: 入力をブロックしない）:
 *   - **await しても意味のある値は返らない**（常に void）。呼び出し側は結果を見ない。
 *   - 失敗・タイムアウト・オフライン・flag OFF のいずれでも **何も起きない**。
 *     企業名の free-text 保存フローは一切影響を受けない。
 *   - spinner を出さない。UI 状態を変えない。
 *
 * ★ `companyId` を client から送らない。canonical company id は server が決める
 *   （client 申告の id を権威情報として扱わない）。
 */
export function notifyCompanyIntent(companyName: string): void {
  const name = typeof companyName === 'string' ? companyName.trim() : '';
  // 1 文字の入力で外部照合を起こさない（IME 確定直後の取りこぼしを拾うための最小長）。
  if (name.length < 2) return;
  try {
    void fetch('/api/career/company/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName: name }),
      // タブを閉じても送信を完了させる（trigger は「入力し終えた瞬間」なので離脱と重なりやすい）。
      keepalive: true,
    }).catch(() => {
      /* prefetch の失敗はユーザーに見せない・何も起きない */
    });
  } catch {
    /* fetch が使えない環境でも保存フローを壊さない */
  }
}

export type CompanyLookupData = { companyId: string; displayName: string } | null;

/** companyId から企業を引く（見つからなければ data:null）。 */
export async function lookupCompanyById(
  companyId: string,
): Promise<Envelope<CompanyLookupData>> {
  const id = typeof companyId === 'string' ? companyId.trim() : '';
  if (id === '') return { available: true, data: null };
  try {
    const res = await fetch(
      `/api/career/company/lookup?companyId=${encodeURIComponent(id)}`,
      { method: 'GET' },
    );
    if (!res.ok) return UNAVAILABLE;
    const json = (await res.json()) as Envelope<CompanyLookupData>;
    if (!json || typeof json !== 'object') return UNAVAILABLE;
    if (json.available && json.data) {
      touchCompanyInDirectory(json.data.companyId, json.data.displayName);
    }
    return json;
  } catch {
    return UNAVAILABLE;
  }
}
