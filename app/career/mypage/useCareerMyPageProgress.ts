'use client';

// PASSAI CAREER — マイページ進度の取得（server 優先・端末 canonical フォールバック）。
//
//   member          → GET /api/career/mypage/progress（auth session + RLS で本人の行だけ）
//   guest / 取得不可 → この端末の Layer 1 canonical（既にページが読んでいる bundle）
//
// なぜ 2 経路あるか:
//   就活版の solo 機能は **端末 localStorage が canonical**、Supabase は member の durable mirror
//   という既存構造（Data Spine Layer 1）。server だけを見ると guest は常に空、mirror 同期前の
//   member も一時的に空になり「実績が消えた」ように見える。逆に端末だけを見ると別端末の履歴が
//   出ない。そこで **server を優先し、確定できない/空のときだけ端末 canonical へ倒す**。
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
  isCareerMyPageProgressEmpty,
} from '@/lib/careerMyPageProgress/progress';
import type {
  CareerMyPageProgress,
  CareerMyPageProgressSource,
} from '@/lib/careerMyPageProgress/types';
import type { CareerSourceBundle } from '@/lib/careerSourceData/types';

export type CareerMyPageProgressView = {
  progress: CareerMyPageProgress | null;
  source: CareerMyPageProgressSource | null;
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
    const serverProgress = fresh ? cache.progress : null;
    const loading = userKey !== '' && !fresh;

    // server が本人の実績を返せたならそれを正とする（別端末の履歴も含まれる）。
    // server が「空」を返した場合だけ端末 canonical に倒す（mirror 未同期の取りこぼし対策）。
    if (serverProgress && !isCareerMyPageProgressEmpty(serverProgress)) {
      return { progress: serverProgress, source: 'server', loading: false };
    }
    if (deviceProgress && !isCareerMyPageProgressEmpty(deviceProgress)) {
      return { progress: deviceProgress, source: 'device', loading };
    }
    // どちらも空。server 応答があればそれを、無ければ端末側を「0 件」として表示する。
    return {
      progress: serverProgress ?? deviceProgress,
      source: serverProgress ? 'server' : deviceProgress ? 'device' : null,
      loading,
    };
  }, [cache, userKey, deviceProgress]);
}
