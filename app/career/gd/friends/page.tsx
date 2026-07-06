'use client';

// PASSAI 就活版 — 友達とプレイ（合言葉GD）ハブ画面（STEP-GD-30）。
//
// 合言葉（6桁コード）で友達とマルチGDを行う導線を独立させる：
//   ① 部屋を作る → /career/gd/room/create（6桁コードを発行して共有）
//   ② 部屋に入る → /career/gd/room/join（共有された6桁コードで参加）
// いずれも既存ページ（合言葉 room 系）をそのまま流用する（機能変更なし）。
// 認証（member ログイン）は各遷移先ページ側で判定する。

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';

export default function CareerGdFriendsPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="友達とプレイ"
        description="合言葉（6桁コード）を使って、友達・知人とグループディスカッションを練習します（ログインが必要）。"
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <ActionCard
          emoji="🔑"
          title="部屋を作る"
          description="合言葉を発行して友達に共有します。友達がその合言葉で参加すると一緒にGDを始められます。"
          href="/career/gd/room/create"
          cta="合言葉を作成する →"
        />
        <ActionCard
          emoji="🚪"
          title="部屋に入る"
          description="友達から共有された合言葉を入力して、その部屋に参加します。"
          href="/career/gd/room/join"
          cta="合言葉で参加する →"
        />
      </div>

      <Card variant="soft" padding="md" className="mt-5">
        <p className="text-xs text-slate-500 leading-relaxed">
          合言葉は作成から30分間有効です。参加人数が足りない場合は、開始時にAIメンバーが自動で補完します。
        </p>
      </Card>

      <div className="mt-8">
        <Link
          href="/career/gd"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← GD練習トップに戻る
        </Link>
      </div>
    </div>
  );
}

function ActionCard({
  emoji,
  title,
  description,
  href,
  cta,
}: {
  emoji: string;
  title: string;
  description: string;
  href: string;
  cta: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col rounded-2xl bg-white ring-1 ring-slate-200 shadow-card transition-all p-5 hover:shadow-md active:bg-slate-50"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xl leading-none" aria-hidden>
          {emoji}
        </span>
        <h2 className="text-sm sm:text-base font-bold leading-snug text-violet-700">{title}</h2>
      </div>
      <p className="text-xs leading-relaxed text-slate-500 flex-1">{description}</p>
      <p className="mt-3 text-sm font-bold text-violet-700">{cta}</p>
    </Link>
  );
}
