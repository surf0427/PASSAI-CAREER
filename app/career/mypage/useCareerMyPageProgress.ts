'use client';

// PASSAI CAREER — マイページ進度の取得（端末 canonical 権威・server は欠けている機能だけ補完）。
//
//   端末の Layer 1 canonical（既にページが読んでいる bundle）を **権威**として表示し、
//   member では GET /api/career/mypage/progress（auth session + RLS で本人の行だけ）を併せて読み、
//   **canonical が空の機能だけ** server（＝他端末由来）で埋める。
//
// なぜ canonical が権威か（推測ではなく既存実装の帰結）:
//   この 4 Source は authority class 1 = device_canonical_mirrored
//   （lib/careerSourceData/types.ts の CAREER_SOURCE_AUTHORITY）。各機能は保存時にまず
//   localStorage へ書き、Supabase へは member のときだけ fire-and-forget で upsert する
//   （lib/supabase/career*.ts・失敗は再試行しない）。ログイン時に careerBackfill（上り）→
//   careerRestore（下り・id merge / local 優先）が他端末由来の行を localStorage へ取り込む。
//   ⇒ 定常状態で device ⊇ server。server を優先すると、localStorage を読む ES 履歴 /
//     面接履歴より **少ない件数**をマイページだけが表示することになる。
//
// 判定は lib/careerMyPageProgress/progress.ts の selectCareerMyPageProgress（純関数）に集約し、
// ここには置かない。
//
// ★ どちらの経路でも数値を作るのは同じ純関数（buildCareerMyPageProgress）。
//   経路ごとに数え方が変わらないようにするため、集計をここに書かない。
//
// 安全性:
//   - client は userId を一切送らない。server 側は auth session からしか user を決めない。
//   - 端末経路は自分の端末の localStorage しか読まない（他ユーザーの結果が入る経路が無い）。

import { useEffect, useMemo, useState } from 'react';

import { useCareerAuth } from '@/app/career/components/CareerAuthProvider';
import {
  buildCareerMyPageProgress,
  selectCareerMyPageProgress,
  type CareerMyPageProgressPick,
} from '@/lib/careerMyPageProgress/progress';
import type { CareerMyPageProgress } from '@/lib/careerMyPageProgress/types';
import type { CareerSourceBundle } from '@/lib/careerSourceData/types';

export type CareerMyPageProgressView = {
  progress: CareerMyPageProgress | null;
  source: CareerMyPageProgressPick | null;
  /** server 問い合わせ中（端末 canonical は既にあるが、確定を待っている状態）。 */
  loading: boolean;
};

/**
 * server 応答のキャッシュ。`key` は「誰の応答か」を表す **client 内だけの識別子**で、
 * server へは送らない（server は自分の auth session からしか user を決めない）。
 * key が現在のログインユーザーと一致しないキャッシュは使わない
 * ＝ ログアウト・アカウント切替の直後に前のユーザーの数値が残らない。
 */
type ServerCache = { key: string; progress: CareerMyPageProgress | null };

function isProgressResponse(value: unknown): value is { available: boolean; progress?: unknown } {
  return !!value && typeof value === 'object' && 'available' in (value as Record<string, unknown>);
}

export function useCareerMyPageProgress(bundle: CareerSourceBundle | null): CareerMyPageProgressView {
  const { status, user } = useCareerAuth();
  // member のときだけ非空。guest / loading では空文字（＝server へ問い合わせない）。
  const userKey = status === 'member' ? (user?.id ?? '') : '';
  const [cache, setCache] = useState<ServerCache | null>(null);

  // 端末 canonical 由来の進度（bundle はページが既に読んでいるので追加 I/O ゼロ）。
  const deviceProgress = useMemo(
    () => (bundle ? buildCareerMyPageProgress(bundle) : null),
    [bundle],
  );

  useEffect(() => {
    if (userKey === '') return; // 未ログイン: 端末 canonical だけで描く。
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      let progress: CareerMyPageProgress | null = null;
      try {
        const res = await fetch('/api/career/mypage/progress', {
          method: 'GET',
          signal: controller.signal,
          cache: 'no-store',
        });
        if (res.ok) {
          const json: unknown = await res.json();
          if (isProgressResponse(json) && json.available && json.progress) {
            progress = json.progress as CareerMyPageProgress;
          }
        }
      } catch {
        // abort / network error。端末 canonical で描けるので失敗を表に出さない。
      }
      // setState は必ず await の後（effect body 同期の setState を作らない）。
      if (!cancelled) setCache({ key: userKey, progress });
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [userKey]);

  return useMemo<CareerMyPageProgressView>(() => {
    // 現在のログインユーザーの応答だけを採用する（切替直後の取り違えを構造的に防ぐ）。
    const fresh = cache && cache.key === userKey && userKey !== '';
    // ★ null は「0 件」ではなく **未確定**（未ログイン / 取得失敗 / 応答待ち）。
    //   selectCareerMyPageProgress は null を 0 件として扱わない。
    const serverProgress = fresh ? cache.progress : null;
    const loading = userKey !== '' && !fresh;

    const { progress, source } = selectCareerMyPageProgress(deviceProgress, serverProgress);
    return { progress, source, loading };
  }, [cache, userKey, deviceProgress]);
}
