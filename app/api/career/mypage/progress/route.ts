// PASSAI CAREER — マイページ「練習・作成の進度 / 成長進度」の read 専用 API。
//
// GET のみ。副作用なし・AI 呼び出しなし・書き込みなし。
//   → quota / billing gate の対象にしない（AI route ではないため。既存の課金・quota は非改変）。
//
// 厳守:
//   - subject は **必ず server auth**（loadCareerSourceData が auth.getUser から取る）。
//     query / body / header の userId を受け取らない（そもそも引数が無い）。
//   - 返すのは compact な進度のみ（id / score / 軸 / 時刻）。本文・transcript・AI 全文は返さない。
//   - never-throw。失敗は available:false に写像し、client は端末 canonical へ倒す。

import { getCareerMyPageProgress } from '@/lib/careerMyPageProgress/progress.server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const outcome = await getCareerMyPageProgress();
    // 未ログイン・利用不可のどちらも「異常」ではない（端末 canonical で描ける）ため 200 で返す。
    return Response.json(outcome, { status: 200 });
  } catch {
    return Response.json({ available: false, reason: 'unavailable' }, { status: 200 });
  }
}
