// PASSAI CAREER — Canary diagnostics（operator inspection path / Canary activation）。
//
// 役割: canary 運用者が「動いているか / どこで fallback しているか」を確認するための
//   **集計値のみ** の read-only エンドポイント。外部 metrics 基盤の代替として最小構成で置く。
//
// ★ 三重 gate（すべて必要。既定は完全に閉じている）:
//   1. `CAREER_DATA_SPINE_CANARY_DIAGNOSTICS_ENABLED=true`（運用者の明示有効化）
//   2. authenticated member（server auth。anonymous 不可）
//   3. その user が Server Context canary allowlist に居る
//      → canary 運用者本人だけが自分の process の集計を見られる
//
// ★★ 返すのは enum 別カウンタと率のみ ★★
//   userId / UUID / 本文 / prompt / AI response / email / name を一切返さない
//   （counters.server.ts が構造的に保持しない）。
//
// 厳守: service role を使わない / never-throw / gate 閉時は内部情報を示唆しない。

import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import { snapshotCanaryCounters } from '@/lib/careerDataSpineCanary/counters.server';
import { loadServerContextCanaryConfigFromEnv } from '@/lib/careerServerContext/canaryGate.server';
import { isServerContextCanaryUser } from '@/lib/careerServerContext/canaryGate';

export const dynamic = 'force-dynamic';

export const CAREER_CANARY_DIAGNOSTICS_ENABLED_ENV =
  'CAREER_DATA_SPINE_CANARY_DIAGNOSTICS_ENABLED';

const TRUE_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes']);

function isDiagnosticsEnabled(): boolean {
  const raw = process.env[CAREER_CANARY_DIAGNOSTICS_ENABLED_ENV];
  return typeof raw === 'string' && TRUE_VALUES.has(raw.trim().toLowerCase());
}

async function resolveUserId(): Promise<string | null> {
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

export async function GET() {
  // 1) 運用者の明示有効化。既定は閉じている（内部状態を示唆しない一律応答）。
  if (!isDiagnosticsEnabled()) {
    return Response.json({ enabled: false }, { status: 200 });
  }
  // 2) authenticated member のみ。
  const userId = await resolveUserId();
  if (!userId) return Response.json({ enabled: false }, { status: 200 });

  // 3) canary allowlist の user のみ（他人には常に閉じている）。
  if (!isServerContextCanaryUser(userId, loadServerContextCanaryConfigFromEnv())) {
    return Response.json({ enabled: false }, { status: 200 });
  }

  return Response.json({ enabled: true, counters: snapshotCanaryCounters() }, { status: 200 });
}
