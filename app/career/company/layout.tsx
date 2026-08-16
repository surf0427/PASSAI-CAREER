import { notFound } from 'next/navigation';

import { isCompanyIdentityEnabled } from '@/lib/careerCompanySpine/flags.server';

// Company Identity segment の公開ゲート（server component）。
//
// なぜ必要か:
//   初回リリースでは Company Identity を出さない。CompanyPicker 側は `IDENTITY_UI_ENABLED`
//   で Identity 系 UI を伏せてあるが、**企業ページ本体（/career/company 配下）は route として
//   残ったまま**だった。server flag OFF のままここへ直リンク / 直 URL で入ると、
//   「企業の登録機能は現在利用できません」「（名称を取得できませんでした）」しか出ない
//   行き止まりページが公開されてしまう（Home / マイページからは辿れないが、URL は生きている）。
//   到達不能にするのが正しい状態なので、segment 最上位で 1 回だけ塞ぐ。
//
// なぜ layout なのか（app/career/matching/layout.tsx と同じ理由）:
//   配下の page（page.tsx / new/page.tsx / [companyId]/page.tsx）はすべて 'use client' で、
//   server-only flag も notFound() も client component からは呼べない。layout は segment の
//   最上位に位置する server component なので、ここで 1 回判定すれば配下 3 ページを同時に塞げる
//   （notFound() は throw した route segment の描画を打ち切るため children は評価されない）。
//   client 側 redirect と違い、page が一瞬でも描画されることがない。
//
// ★ 重要: 本 layout が塞ぐのは **route だけ**。同ディレクトリに同居する
//   `applicationStorage.ts` / `companyDirectory.ts` / `companyClient.ts` は
//   ES・面接・プレゼン・企業研究から module として import され続ける（routing とは無関係）。
//   したがって Phase 1 の free-text UX には一切影響しない。
//
// flag OFF（既定）: 404。ON: 従来どおり children をそのまま描画する（wrapper 以外の副作用なし）。
// 再開は `CAREER_COMPANY_IDENTITY_ENABLED=true` を設定するだけ（コード変更不要）。
export default function CareerCompanyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isCompanyIdentityEnabled()) notFound();
  return <>{children}</>;
}
