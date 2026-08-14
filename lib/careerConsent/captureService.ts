// PASSAI CAREER — Consent capture service（NEXT-7 / Data Spine）。
//
// 責務: capture surface（API route / UI）と、永続 repository の間の **repository 非依存な合成層**。
//   既存の pure 部品（policy manifest / ledger builder / reducer / receipt）を再利用し、
//   「同意を取る / 取り消す / 現在状態を返す」を 1 箇所で表現する。
//
// ★ 現状の production 可用性:
//   production 永続 repository は **まだ存在しない**（DDL は supabase/prototype/ にあり production 未適用、
//   append は service_role-gated RPC 前提 = H-6 / H-7 の Human decision 待ち）。
//   そのため既定の repository は null で、service は `unavailable` を返す。
//   repository が用意できれば **本 service を書き換えずに** 差し込める（interface 依存）。
//
// 厳守:
//   - pure な合成のみ（I/O は注入された repository が担う）。never-throw。
//   - client timestamp を権威にしない（serverSequence / recordedAt は repository 側が採番）。
//   - prohibited evidence field（IP / UA / free text 等）を **受け取らない**（型に存在しない）。
//   - 同意文言をコードで確定しない（manifest の version / digest 参照のみ）。
//   - Layer 4 / Layer 5 の production consumer をここから起動しない。

import { DEFAULT_CONSENT_MANIFEST, manifestEntry } from './policy';
import { deriveConsentState } from './reducer';
import { buildConsentReceipt } from './receipt';
import type {
  ConsentLedgerEvent,
  ConsentReceipt,
  ConsentScope,
} from '@/types/careerConsent';

// capture surface が受け付ける操作（default deny の enum）。
export type ConsentCaptureAction = 'grant' | 'withdraw';

// capture 要求（**PII / free text / client timestamp / server sequence を含まない**）。
export type ConsentCaptureRequest = {
  scope: ConsentScope;
  action: ConsentCaptureAction;
  /** UI 上の記録元ラベル（enum 相当・PII なし）。 */
  sourceSurface: string;
};

// service が使う最小 repository 契約（既存 ConsentLedgerRepository の部分集合）。
//   append は **server-authoritative**（seq / recordedAt / idempotency は repository が確定する）。
export type ConsentCaptureRepository = {
  listForSubject(subjectUserId: string): Promise<ConsentLedgerEvent[]>;
  appendCapture(input: {
    subjectUserId: string;
    scope: ConsentScope;
    action: ConsentCaptureAction;
    consentVersion: number | null;
    noticeVersion: string | null;
    policyDigest: string | null;
    sourceSurface: string;
  }): Promise<{ ok: boolean }>;
};

export type ConsentCaptureOutcome =
  | { status: 'unavailable'; reason: 'no_repository' | 'policy_missing' }
  | { status: 'rejected'; reason: 'unknown_scope' | 'append_failed' }
  | { status: 'ok'; receipt: ConsentReceipt };

export type ConsentCaptureDeps = {
  /** 未実装なら null（＝unavailable）。production 実装は H-6 / H-7 決着後に差し込む。 */
  repository: ConsentCaptureRepository | null;
  now: () => number;
};

/** 現在の同意状態（本人向け receipt）を返す（never-throw）。 */
export async function readConsentReceipt(
  subjectUserId: string,
  deps: ConsentCaptureDeps,
): Promise<ConsentCaptureOutcome> {
  try {
    if (!deps.repository) return { status: 'unavailable', reason: 'no_repository' };
    const events = await deps.repository.listForSubject(subjectUserId);
    const state = deriveConsentState({ events, now: deps.now() });
    return { status: 'ok', receipt: buildConsentReceipt({ state }) };
  } catch {
    return { status: 'unavailable', reason: 'no_repository' };
  }
}

/**
 * 同意の付与 / 撤回を記録する（never-throw）。
 * 文言は manifest の version / digest を参照するだけで、本文をコードへ持ち込まない。
 */
export async function captureConsent(
  subjectUserId: string,
  request: ConsentCaptureRequest,
  deps: ConsentCaptureDeps,
): Promise<ConsentCaptureOutcome> {
  try {
    if (!deps.repository) return { status: 'unavailable', reason: 'no_repository' };
    const entry = manifestEntry(request.scope, DEFAULT_CONSENT_MANIFEST);
    if (!entry) return { status: 'unavailable', reason: 'policy_missing' };

    const appended = await deps.repository.appendCapture({
      subjectUserId,
      scope: request.scope,
      action: request.action,
      // withdraw は version を持たない（manifest の grant 版のみ参照する）。
      consentVersion: request.action === 'grant' ? entry.requiredVersion : null,
      noticeVersion: request.action === 'grant' ? entry.noticeVersion : null,
      policyDigest: request.action === 'grant' ? entry.policyDigest : null,
      sourceSurface: request.sourceSurface,
    });
    if (!appended.ok) return { status: 'rejected', reason: 'append_failed' };

    return readConsentReceipt(subjectUserId, deps);
  } catch {
    return { status: 'rejected', reason: 'append_failed' };
  }
}
