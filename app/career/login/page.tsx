'use client';

// 就活版（CAREER）メール OTP **ログイン**ページ = 既存ユーザーの復帰専用入口。
//
// フォーム本体は app/career/components/CareerEmailOtpForm.tsx（新規登録
// /career/register と共有する唯一の OTP 実装）。ここは mode を指定するだけの薄い page。
//   - 認証方式は変更していない（既存 Supabase Auth / email OTP をそのまま利用）。
//   - 新規登録導線（LP「始める」→ 料金 → /career/register）とは UI を分けるが、
//     裏側の auth infrastructure は 1 つだけ（パスワード認証を作らない）。
//   - 認証成功後は redirect クエリ（相対パスのみ）or 既定先 /career/start
//     （状態解決 dispatcher）へフル遷移する。遷移先の決定は server が行う。

import { Suspense } from 'react';

import { CareerEmailOtpForm } from '@/app/career/components/CareerEmailOtpForm';

export default function CareerLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-md mx-auto px-4 py-10 text-sm text-slate-500">
          読み込み中…
        </div>
      }
    >
      <CareerEmailOtpForm mode="login" />
    </Suspense>
  );
}
