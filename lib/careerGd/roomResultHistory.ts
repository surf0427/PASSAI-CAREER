// PASSAI 就活版 — GD 結果履歴の DB hydrate（client fetch・STEP-GD-20-L）。
//
//   - GET /api/career/gd/room/results（server route・session 必須・自分の結果のみ）を叩く。
//   - 返却 item を localStorage 互換の CareerGdRoomLog に正規化して返す（merge は呼び出し側）。
//   - never throw。失敗（未ログイン 401 / ネットワーク / DB 未適用 503 等）は { ok:false, logs:[] }。
//   - localStorage canonical は消さない。DB は durable mirror（別デバイス/再ログイン/LS 消失時の復元）。

import { normalizeGdRoomLog } from '@/app/career/gd/gdRoomLogStorage';
import type { CareerGdRoomLog, CareerGdRoomResultHistoryItem } from '@/types/careerGd';

function itemToLog(item: CareerGdRoomResultHistoryItem): CareerGdRoomLog | null {
  return normalizeGdRoomLog({
    id: item.roomId,
    roomId: item.roomId,
    participantId: item.participantId,
    createdAt: item.createdAt,
    theme: { title: item.theme ?? '' },
    format: item.format,
    participantCount: item.participantCount,
    humanCount: item.humanParticipantCount,
    durationSec: item.durationSec,
    evaluation: item.evaluation,
    ranking: item.ranking,
    matchingHints: item.matchingHints,
    consultationSummary: item.consultationSummary,
  });
}

export type HydrateResult = { ok: boolean; logs: CareerGdRoomLog[] };

// 自分のマルチGD結果を server route から取得して CareerGdRoomLog[] に正規化（never throw）。
export async function fetchCareerGdRoomResultHistory(): Promise<HydrateResult> {
  try {
    const res = await fetch('/api/career/gd/room/results', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, logs: [] };
    const data = (await res.json().catch(() => null)) as
      | { results?: CareerGdRoomResultHistoryItem[] }
      | null;
    const items = Array.isArray(data?.results) ? data.results : [];
    const logs = items
      .map(itemToLog)
      .filter((l): l is CareerGdRoomLog => l !== null);
    return { ok: true, logs };
  } catch {
    return { ok: false, logs: [] };
  }
}
