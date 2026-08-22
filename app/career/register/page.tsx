'use client';

// 就活版（CAREER）**新規メールアドレス登録**ページ = 新規ユーザー獲得導線の認証ステップ。
//
// 位置づけ:
//   LP「始める」→ /career/start → 料金（/career/billing）→ 「このプランで始める」→ **ここ**
//   → 認証成功 → /career/billing?checkout=1（Checkout 自動再開）→ Stripe → webhook
//   → paid entitlement → 基本情報（/career/profile）→ Home
//
// ★ 新しい認証システムではない。フォーム本体は /career/login と同じ
//   CareerEmailOtpForm（既存 Supabase Auth / email OTP）で、違うのは文言だけ。
//   パスワード認証・独自 session・独自 profile DB のいずれも作らない。
// ★ このページは権利を一切与えない。契約の正本は Stripe → signed webhook →
//   career_subscriptions → entitlement resolver の連鎖のみ。

import { Suspense } from 'react';

import { CareerEmailOtpForm } from '@/app/career/components/CareerEmailOtpForm';

export default function CareerRegisterPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-md mx-auto px-4 py-10 text-sm text-slate-500">
          読み込み中…
        </div>
      }
    >
      <CareerEmailOtpForm mode="register" />
    </Suspense>
  );
}
