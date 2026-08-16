import { notFound } from 'next/navigation';

import { isCareerCompanyMatchingEnabled } from '@/lib/careerMatchingGate/flags.server';

// 企業マッチング segment の公開ゲート（server component）。
//
// なぜ layout なのか:
//   配下の page（page.tsx / result/page.tsx）は両方とも 'use client' で、
//   server-only flag も notFound() も client component からは呼べない。
//   layout は segment の最上位に位置する server component なので、ここで 1 回だけ判定すれば
//   `/career/matching` と `/career/matching/result` の **両方**を同時に塞げる
//   （notFound() は throw した route segment の描画を打ち切るため、children は評価されない）。
//   client 側 redirect と違い、page が一瞬でも描画されることがない。
//   matching UI 本体には一切手を入れないため、再開は flag を ON にするだけで済む。
//
// flag OFF（既定）: 404。ON: 従来どおり children をそのまま描画する（wrapper 以外の副作用なし）。
export default function CareerMatchingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isCareerCompanyMatchingEnabled()) notFound();
  return <>{children}</>;
}
