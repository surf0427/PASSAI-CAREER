import { notFound } from 'next/navigation';

import { isCareerGdEnabled } from '@/lib/careerGdGate/flags.server';

// GD segment の公開ゲート（server component）— STEP-CAREER-PUBLIC-SPEC / P2-2。
//
// なぜ layout なのか（既存 app/career/matching/layout.tsx と同一の設計思想）:
//   配下の page（hub / run / session / setup / view / result / rooms / room/* /
//   lobby / friends …）は全て 'use client' で、server-only flag も notFound() も
//   client component からは呼べない。layout は segment の最上位に位置する server
//   component なので、ここで 1 回だけ判定すれば `/career/gd` と `/career/gd/**`
//   （動的 route の /career/gd/room/[roomId] を含む）を **まとめて**塞げる。
//   notFound() は throw した route segment の描画を打ち切るため children は評価されない。
//
// なぜ必要だったか:
//   GD の API は 21 route すべてが CAREER_GD_ENABLED で 404 になるのに、page 側には
//   同等の gate が無かった。その結果 flag OFF でも
//     /career/gd が 200 → ユーザーが UI を操作 → 送信して初めて API が 404
//   という「表示上は使えるのに実際は存在しない」状態が残っていた。
//   client 側で hide する / API 失敗で初めて止める形にはしない。**page boundary 自体を
//   server-side で閉じる**のが唯一の正しい閉じ方（描画が一瞬でも出ない）。
//
// ★ 判定は server flag（CAREER_GD_ENABLED）のみ。NEXT_PUBLIC_* は読まない。
//   UI flag が誤って ON でもここが OFF なら 404 のまま（fail-closed）。
// ★ 個々の page に同じ判定を複製しない（gate はこの 1 箇所だけ）。
// ★ GD のコード・API・DB・localStorage 履歴は何も消さない。到達不能にするだけで、
//   再開は flag を ON にするだけで元に戻る。
//
// flag OFF（既定）: 404。ON: 従来どおり children をそのまま描画する（wrapper 以外の副作用なし）。
export default function CareerGdLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isCareerGdEnabled()) notFound();
  return <>{children}</>;
}
