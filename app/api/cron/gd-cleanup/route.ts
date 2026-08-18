/**
 * GD room timeout / abandon cleanup cron（STEP-GD-22）。
 *
 * 目的:
 *   ランダムマッチ・公開ロビー・合言葉(invite) room で、放置された
 *   room / match_queue / member / message が本番で残り続けないようにする定期 cleanup。
 *   **user-facing な履歴（career_gd_room_results）と finished room・result 済み room は消さない。**
 *
 * 実行内容（DB 側 RPC に委譲。service_role・SECURITY DEFINER）:
 *   1. waiting match_queue の期限切れ → expired（career_gd_match_expire_stale）
 *   2. 未開始で古い waiting room（結果なし）を削除／開始後放置の active room（結果なし）を cancelled に
 *      soft-close／古い cancelled room（結果なし）を削除（career_gd_cleanup_abandoned_rooms）
 *   3. 終端状態の古い match_queue 行を削除（career_gd_cleanup_stale_queue）
 *
 * 認証:
 *   - `Authorization: Bearer ${CRON_SECRET}` のみ許可。それ以外・未設定は fail-closed で 401。
 *   - Vercel Cron は CRON_SECRET 設定時に自動でこの header を付与する（他 cron と同方式）。
 *   - public client からは叩けない。secret / PII は一切出力しない（件数のみ返す）。
 *
 * dry-run:
 *   - `?dryRun=true`（`?dry=1`）で一切 mutate せず対象件数のみ返す。
 * TTL 上書き（QA / 運用調整用・省略時は既定値）:
 *   - `?waitingTtlMin=`（既定 60）/ `?activeTtlMin=`（既定 180）/ `?queueTtlDays=`（既定 7）。負値は 0 に丸め。
 *
 * 必要 env: CRON_SECRET / CAREER_SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_CAREER_SUPABASE_URL
 * （career_gd_* は CAREER 専用 Supabase = Project B に存在する。受験版 Project A は参照しない）
 * env 未設定でも build は落ちない（実行時に 401/500 で安全に失敗）。
 */

import 'server-only';

import { NextResponse } from 'next/server';

import { devWarn } from '@/lib/devLog';
import { captureRouteException } from '@/lib/sentry/capture';
import { getCareerServiceRoleSupabaseClient } from '@/lib/careerSupabase/serviceRoleClient';
import { GD_DISCONNECT_AFTER_SEC, GD_STALE_AFTER_SEC } from '@/lib/careerGd/presence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// 既定 TTL。
const DEFAULT_WAITING_TTL_MIN = 60; // 未開始 waiting room（作成から）
const DEFAULT_ACTIVE_TTL_MIN = 180; // 開始後放置 active room（開始から）
const DEFAULT_QUEUE_TTL_DAYS = 7; // 終端状態の match_queue 行

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail-closed
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

function intParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n);
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryParam = url.searchParams.get('dryRun') ?? url.searchParams.get('dry');
  const dryRun = dryParam === 'true' || dryParam === '1';
  const waitingTtlMin = intParam(url, 'waitingTtlMin', DEFAULT_WAITING_TTL_MIN);
  const activeTtlMin = intParam(url, 'activeTtlMin', DEFAULT_ACTIVE_TTL_MIN);
  const queueTtlDays = intParam(url, 'queueTtlDays', DEFAULT_QUEUE_TTL_DAYS);

  const startedAt = new Date().toISOString();

  try {
    const admin = getCareerServiceRoleSupabaseClient();

    // 1) waiting match_queue の期限切れ → expired。
    let expiredQueueCount = 0;
    if (dryRun) {
      const { count, error } = await admin
        .from('career_gd_match_queue')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'waiting')
        .lte('expires_at', new Date().toISOString());
      if (error) throw new Error(`expire-stale-count: ${error.message}`);
      expiredQueueCount = count ?? 0;
    } else {
      const { data, error } = await admin.rpc('career_gd_match_expire_stale');
      if (error) throw new Error(`expire-stale: ${error.message}`);
      expiredQueueCount = typeof data === 'number' ? data : 0;
    }

    // 2) room の abandon/stale cleanup。
    const { data: rooms, error: roomsErr } = await admin.rpc('career_gd_cleanup_abandoned_rooms', {
      p_waiting_ttl_min: waitingTtlMin,
      p_active_ttl_min: activeTtlMin,
      p_dry_run: dryRun,
    });
    if (roomsErr) throw new Error(`cleanup-rooms: ${roomsErr.message}`);

    // 3) 終端 match_queue 行の削除。
    const { data: queue, error: queueErr } = await admin.rpc('career_gd_cleanup_stale_queue', {
      p_ttl_days: queueTtlDays,
      p_dry_run: dryRun,
    });
    if (queueErr) throw new Error(`cleanup-queue: ${queueErr.message}`);

    // ── 4) STEP-GD-31: 期限切れ room の finish（host 不在でも必ず終わる保険）──
    //    通常はリクエスト経路（room GET / heartbeat / 発言）で finish されるが、
    //    「誰も見ていない部屋」だけはここで回収する。
    //    ★ 既存 TTL cleanup（activeTtlMin=180分）とは目的が違う:
    //      こちらは time_limit_sec 到達で **正常終了** させる（結果を出せる状態にする）。
    //      既存 cleanup は放置部屋を cancelled にする最終手段。順序上こちらが先に効くため、
    //      「時間切れ → finished（結果あり）」が「放置 → cancelled（結果なし）」に化けない。
    let expiredRoomCount = 0;
    if (!dryRun) {
      const { data, error } = await admin.rpc('career_gd_finish_expired_all');
      // RPC 未適用（career_gd_realtime_apply.sql 未適用）でも cleanup 全体は止めない。
      if (error) devWarn('[cron/gd-cleanup] finish-expired skipped', error.message ?? 'rpc unavailable');
      else expiredRoomCount = typeof data === 'number' ? data : 0;
    }

    // ── 5) STEP-GD-31: presence sweep（全 room 横断）──
    //    切断検知の閾値は lib/careerGd/presence.ts と共有する（cron 側で別値を持たない）。
    let presenceSwept = { disconnected: 0, stale: 0 };
    if (!dryRun) {
      const { data, error } = await admin.rpc('career_gd_sweep_presence_all', {
        p_disconnect_sec: GD_DISCONNECT_AFTER_SEC,
        p_stale_sec: GD_STALE_AFTER_SEC,
      });
      if (error) devWarn('[cron/gd-cleanup] presence-sweep skipped', error.message ?? 'rpc unavailable');
      else {
        const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
        presenceSwept = {
          disconnected: Number(row?.disconnected_count ?? 0) || 0,
          stale: Number(row?.stale_count ?? 0) || 0,
        };
      }
    }

    return NextResponse.json(
      {
        ok: true,
        dryRun,
        startedAt,
        finishedAt: new Date().toISOString(),
        ttl: { waitingTtlMin, activeTtlMin, queueTtlDays },
        expiredQueueCount,
        rooms: rooms ?? {},
        queue: queue ?? {},
        // STEP-GD-31: 件数のみ（PII / 識別子は含めない）。
        expiredRoomCount,
        presenceSwept,
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'gd-cleanup failed';
    devWarn('[cron/gd-cleanup] fatal', message);
    captureRouteException(
      err,
      { route: 'cron/gd-cleanup', feature: 'career-gd', status: 500 },
      { status: 500, code: 'gd-cleanup-fatal' },
    );
    return NextResponse.json({ ok: false, error: message, startedAt }, { status: 500 });
  }
}

// Vercel Cron は GET。手動運用のため POST も許可。
export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
