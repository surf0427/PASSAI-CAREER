// PASSAI CAREER — Consent capture surface API（NEXT-7 / Data Spine Layer 4/5 前提）。
//
// 役割: 集合的知能 / 共有 scope に対する **本人の明示 opt-in / 撤回** を受け付ける唯一の server 入口。
//   GET  : capture surface が有効か + 有効なら本人の consent receipt。
//   POST : scope 単位の grant / withdraw。
//
// ★ 既定は **完全に閉じている**（fail-closed）。次の 3 つが揃うまで `enabled:false` を返し、
//   ledger へ 1 件も書かない:
//     1. CAREER_CONSENT_CAPTURE_ENABLED（運用判断）
//     2. CAREER_CONSENT_POLICY_LEGAL_APPROVED（法務が同意文言を承認）
//     3. CAREER_DATA_SPINE_READY_*（decision register の Layer 別 readiness）
//   さらに production 永続 repository が未実装のため、gate が開いても現状は `unavailable` を返す
//   （H-6 / H-7 決着後に captureService の repository を差し込む）。
//
// 厳守:
//   - subject は **必ず server auth** から取得（request body の userId を信用しない）。RLS が最終権威。
//   - service role を使わない。
//   - IP / User-Agent / free text / 端末情報を **受け取らない・保存しない**（型・parse で拒否）。
//   - Layer 4 / Layer 5 の production consumer をここから起動しない。
//   - 同意文言をここで確定しない（manifest 参照のみ）。

import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import { loadConsentCaptureGate } from '@/lib/careerConsent/captureGate.server';
import { isScopeCapturable } from '@/lib/careerConsent/captureGate';
import {
  captureConsent,
  readConsentReceipt,
  type ConsentCaptureAction,
  type ConsentCaptureDeps,
} from '@/lib/careerConsent/captureService';

export const dynamic = 'force-dynamic';

// production 永続 repository は未実装（DDL は supabase/prototype/・append は service_role RPC 前提で
//   H-6 / H-7 待ち）。null のまま = service が unavailable を返す＝1 件も書かれない。
const deps: ConsentCaptureDeps = {
  repository: null,
  now: () => Date.now(),
};

// capture surface のラベル（PII を含まない enum 相当）。
const SOURCE_SURFACE = 'career_mypage_consent_card';

async function resolveSubjectUserId(): Promise<string | null> {
  try {
    const client = await getCareerServerSupabaseClient();
    if (!client) return null;
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user || data.user.is_anonymous) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

function disabledResponse(reason: string) {
  // gate が閉じている間は scope 一覧も出さない（何が来るかを示唆しない）。
  return Response.json({ enabled: false, reason }, { status: 200 });
}

export async function GET() {
  const gate = loadConsentCaptureGate();
  if (!gate.enabled) return disabledResponse(gate.reason);

  const subjectUserId = await resolveSubjectUserId();
  if (!subjectUserId) return Response.json({ enabled: true, authenticated: false }, { status: 200 });

  const outcome = await readConsentReceipt(subjectUserId, deps);
  if (outcome.status !== 'ok') {
    return Response.json(
      { enabled: true, authenticated: true, available: false, reason: outcome.reason },
      { status: 200 },
    );
  }
  return Response.json(
    { enabled: true, authenticated: true, available: true, scopes: gate.scopes, receipt: outcome.receipt },
    { status: 200 },
  );
}

export async function POST(req: Request) {
  const gate = loadConsentCaptureGate();
  if (!gate.enabled) return disabledResponse(gate.reason);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'リクエストボディが不正です。' }, { status: 400 });
  }
  // ★ 受け取るのは scope と action の 2 つだけ（evidence field は構造的に受け取らない）。
  const b = (body && typeof body === 'object' ? body : {}) as {
    scope?: unknown;
    action?: unknown;
  };

  if (!isScopeCapturable(gate, b.scope)) {
    return Response.json({ error: '対象外の同意範囲です。' }, { status: 400 });
  }
  const action = b.action;
  if (action !== 'grant' && action !== 'withdraw') {
    return Response.json({ error: '不正な操作です。' }, { status: 400 });
  }

  const subjectUserId = await resolveSubjectUserId();
  if (!subjectUserId) {
    return Response.json({ error: 'ログインが必要です。' }, { status: 401 });
  }

  const outcome = await captureConsent(
    subjectUserId,
    { scope: b.scope, action: action as ConsentCaptureAction, sourceSurface: SOURCE_SURFACE },
    deps,
  );
  if (outcome.status === 'unavailable') {
    return Response.json({ available: false, reason: outcome.reason }, { status: 503 });
  }
  if (outcome.status === 'rejected') {
    return Response.json({ error: '同意の記録に失敗しました。', reason: outcome.reason }, { status: 409 });
  }
  return Response.json({ available: true, receipt: outcome.receipt }, { status: 200 });
}
