'use client';

// 就活版（CAREER）メール OTP フォームの **唯一の実装**。
//
// 新規登録（/career/register）と 既存ログイン（/career/login）は、UX としては
// 明確に分けるが **認証方式は 1 つ**である。パスワード認証や別 auth system は作らない
// （既存 Supabase Auth / email OTP をそのまま再利用する）。
// 差分は文言だけなので mode で出し分け、送信・検証・遷移のロジックは共有する。
//
// フロー（受験版 app/login/page.tsx と同型）:
//   1. メール入力 → OTP 送信（sendCareerEmailOtp）。
//   2. メールに届いたコードを入力 → verifyCareerEmailOtp で検証しセッション確立。
//   3. 成功後は redirect クエリ（相対パスのみ）or 既定先（/career/start = 状態解決
//      dispatcher）へ window.location で **フル遷移**し、CareerAuthProvider を
//      再マウントさせて新セッションを読み直す。
//      表示ID（display_user_id）の有無で遷移先を分岐しない（受験版と整合）。
//
// 原則: identity は auth.users.id。display_user_id は表示用で認証・遷移判定に使わない。
//   - career_accounts 行は CareerAuthProvider.load() が member 確定時に lazy 作成する
//     （受験版 AuthProvider の ensureProfile と同型）。本フォームは行作成をしない。
//   - 表示ID未設定を理由に /career/onboarding/profile へ強制遷移しない（旧フロー廃止）。

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { AlertBox } from '@/components/ui/AlertBox';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { isValidEmailFormat } from '@/lib/supabase/email';
import {
  sendCareerEmailOtp,
  verifyCareerEmailOtp,
} from '@/lib/careerSupabase/auth';
import { useCareerAuth } from '@/app/career/components/CareerAuthProvider';
import { sanitizeCareerRedirect } from '@/app/career/login/careerLoginRedirect';
import { CAREER_ROUTES } from '@/lib/careerRouting/destination';

type Step = { kind: 'email' } | { kind: 'code'; email: string };

/** 新規登録（register）と既存ログイン（login）の文言差分だけを持つ表。 */
export type CareerEmailOtpMode = 'login' | 'register';

const COPY: Record<
  CareerEmailOtpMode,
  {
    title: string;
    description: string;
    sendLabel: string;
    sendingLabel: string;
    verifyLabel: string;
    verifyingLabel: string;
    switchPrompt: string;
    switchLabel: string;
    switchHref: string;
  }
> = {
  login: {
    title: 'ログイン',
    description:
      '登録したメールアドレスにコードを送ります。同じメールでログインすれば、別の端末でも同じアカウント（履歴・クラウド同期）に戻れます。',
    sendLabel: 'ログインコードを送る',
    sendingLabel: '送信中…',
    verifyLabel: 'ログイン',
    verifyingLabel: '確認中…',
    switchPrompt: 'はじめての方は',
    switchLabel: 'プランを見て登録する →',
    switchHref: CAREER_ROUTES.start,
  },
  register: {
    title: 'メールアドレスを登録',
    description:
      'パスワードは不要です。入力したメールアドレスに確認コードを送ります。次回からは同じメールアドレスでログインできます。',
    sendLabel: '確認コードを送る',
    sendingLabel: '送信中…',
    verifyLabel: '登録して進む',
    verifyingLabel: '確認中…',
    switchPrompt: 'すでにアカウントをお持ちの方は',
    switchLabel: 'ログイン →',
    switchHref: CAREER_ROUTES.login,
  },
};

export function CareerEmailOtpForm({ mode }: { mode: CareerEmailOtpMode }) {
  const copy = COPY[mode];
  const searchParams = useSearchParams();
  const safeRedirect = useMemo(
    () => sanitizeCareerRedirect(searchParams.get('redirect')),
    [searchParams],
  );

  const router = useRouter();
  const { status } = useCareerAuth();

  // 既にログイン済み（member）なら OTP を要求せず redirect 先へ（受験版と同型）。
  // display_user_id の有無では分岐しない（表示ID未設定でも member として利用可能）。
  const alreadyLoggedIn = status === 'member';
  useEffect(() => {
    if (alreadyLoggedIn) {
      router.replace(safeRedirect);
    }
  }, [alreadyLoggedIn, router, safeRedirect]);

  const [step, setStep] = useState<Step>({ kind: 'email' });

  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  const emailFormatError = (() => {
    if (!emailTouched) return undefined;
    if (email === '') return 'メールアドレスを入力してください。';
    if (!isValidEmailFormat(email)) return 'メールアドレスの形式が正しくありません。';
    return undefined;
  })();

  const canSend = !sending && email !== '' && isValidEmailFormat(email);
  const canVerify = !verifying && code.trim().length >= 6;

  async function handleSend() {
    setEmailTouched(true);
    if (!canSend) return;
    setSending(true);
    setSendError(null);
    const result = await sendCareerEmailOtp(email);
    setSending(false);
    if (result.kind === 'ok') {
      setStep({ kind: 'code', email });
      setCode('');
      setVerifyError(null);
      setResent(false);
      return;
    }
    if (result.kind === 'no-env') {
      // CAREER 専用 env が build に inline されていない（production では shared fallback 禁止）。
      // 設定不備であり時間経過では解消しないため、retry を促す文言にしない。
      setSendError(
        'ただいまご利用いただけません（サーバー設定の問題）。時間をおいても解消しないため、恐れ入りますが運営までお問い合わせください。',
      );
      return;
    }
    setSendError('コードを送信できませんでした。メールアドレスを確認して再度お試しください。');
  }

  async function handleVerify() {
    if (step.kind !== 'code' || !canVerify) return;
    setVerifying(true);
    setVerifyError(null);
    const result = await verifyCareerEmailOtp(step.email, code);
    if (result.kind === 'no-env') {
      setVerifying(false);
      // 設定不備。retry 案内をしない（handleSend と同一方針）。
      setVerifyError(
        'ただいまご利用いただけません（サーバー設定の問題）。時間をおいても解消しないため、恐れ入りますが運営までお問い合わせください。',
      );
      return;
    }
    if (result.kind === 'error') {
      setVerifying(false);
      setVerifyError('コードが正しくないか、有効期限が切れています。再度お試しください。');
      return;
    }

    // セッション確立済み（result.kind === 'ok'）。受験版 app/login と同型で、表示IDの
    // 有無に関わらず safeRedirect へフル遷移する。career_accounts 行の lazy 作成は
    // 遷移先で再マウントされる CareerAuthProvider.load()（ensureCareerAccount）に委ねる。
    // フル遷移により provider が再マウントし、新セッション（永続ユーザー）を読み直す。
    //
    // ★ redirect 未指定なら safeRedirect は /career/start（状態解決 dispatcher）になり、
    //   server が「未契約 → 料金 / 基本情報未完 → 基本情報 / 完了 → Home」を決める。
    //   このページ自身は権利を判定しない（entitlement の正本は常に server）。
    window.location.assign(safeRedirect);
  }

  async function handleResend() {
    if (step.kind !== 'code') return;
    setVerifying(false);
    setVerifyError(null);
    const result = await sendCareerEmailOtp(step.email);
    if (result.kind === 'ok') {
      setResent(true);
      return;
    }
    setVerifyError('コードを再送できませんでした。少し待って再度お試しください。');
  }

  if (alreadyLoggedIn) {
    return (
      <div className="max-w-md mx-auto px-4 py-10 text-sm text-slate-500">
        ログイン済みです。移動しています…
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 py-8 sm:py-10">
      <PageHeader title={copy.title} description={copy.description} />

      {step.kind === 'email' ? (
        <Card padding="md">
          <div className="space-y-4">
            <FormField
              label="メールアドレス"
              hint="例: yourname@example.com"
              error={emailFormatError ?? sendError ?? undefined}
            >
              <Input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (sendError) setSendError(null);
                }}
                onBlur={() => setEmailTouched(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSend) handleSend();
                }}
                placeholder="yourname@example.com"
                autoComplete="email"
                autoCapitalize="off"
                spellCheck={false}
                inputMode="email"
                disabled={sending}
              />
            </FormField>

            <Button variant="primary" size="md" onClick={handleSend} disabled={!canSend}>
              {sending ? copy.sendingLabel : copy.sendLabel}
            </Button>
          </div>
        </Card>
      ) : (
        <Card padding="md">
          <div className="space-y-4">
            <AlertBox variant="info">
              <span className="font-medium">{step.email}</span>{' '}
              宛にコードを送りました。メールに記載のコードを入力してください。
            </AlertBox>

            {resent && (
              <AlertBox variant="success">
                コードを再送しました。最新のメールをご確認ください。
              </AlertBox>
            )}

            <FormField
              label="認証コード"
              hint="メールが届かない場合は迷惑メールフォルダもご確認ください。"
              error={verifyError ?? undefined}
            >
              <Input
                type="text"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D/g, '').slice(0, 10));
                  if (verifyError) setVerifyError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canVerify) handleVerify();
                }}
                placeholder="認証コードを入力"
                autoComplete="one-time-code"
                inputMode="numeric"
                disabled={verifying}
              />
            </FormField>

            <Button variant="primary" size="md" onClick={handleVerify} disabled={!canVerify}>
              {verifying ? copy.verifyingLabel : copy.verifyLabel}
            </Button>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={handleResend}
                disabled={verifying}
                className="text-sm font-medium text-brand-600 underline-offset-2 hover:underline disabled:opacity-60"
              >
                コードを再送する
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep({ kind: 'email' });
                  setCode('');
                  setVerifyError(null);
                  setResent(false);
                }}
                className="text-sm font-medium text-slate-600 underline-offset-2 hover:underline"
              >
                メールアドレスを変更する
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* 新規 / 既存の入口を取り違えた人のための相互リンク（導線を混ぜないための明示）。 */}
      <p className="mt-6 text-center text-sm text-slate-600">
        {copy.switchPrompt}{' '}
        <Link
          href={copy.switchHref}
          className="font-medium text-brand-600 underline-offset-2 hover:underline"
        >
          {copy.switchLabel}
        </Link>
      </p>
    </div>
  );
}
