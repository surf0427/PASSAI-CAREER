'use client';

// 就活版（CAREER）メール OTP ログインページ。
//
// フロー:
//   1. メール入力 → OTP 送信（sendCareerEmailOtp）。
//   2. メールに届いたコードを入力 → verifyCareerEmailOtp で検証しセッション確立。
//   3. 成功後の遷移先:
//      - display_user_id 未設定 → /career/onboarding/profile（redirect を引き継ぐ）
//      - 設定済み             → redirect クエリ（相対パスのみ）or /career/home
//      いずれも window.location で **フル遷移** し、CareerAuthProvider を再マウントさせて
//      新セッションを読み直す。
//
// 原則: identity は auth.users.id。display_user_id は表示用で認証に使わない。

import { Suspense, useEffect, useMemo, useState } from 'react';
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
import { ensureCareerAccount } from '@/lib/careerSupabase/account';
import { useCareerAuth } from '@/app/career/components/CareerAuthProvider';

const DEFAULT_REDIRECT = '/career/home';
const ONBOARDING_PATH = '/career/onboarding/profile';

/**
 * open-redirect 防止: redirect は **同一オリジンの相対パス** のみ許可する。
 * 先頭が "/" で、"//" / "/\" のような protocol-relative を弾く。
 */
function sanitizeRedirect(raw: string | null): string {
  if (!raw) return DEFAULT_REDIRECT;
  if (!raw.startsWith('/')) return DEFAULT_REDIRECT;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return DEFAULT_REDIRECT;
  return raw;
}

type Step = { kind: 'email' } | { kind: 'code'; email: string };

function CareerLoginForm() {
  const searchParams = useSearchParams();
  const safeRedirect = useMemo(
    () => sanitizeRedirect(searchParams.get('redirect')),
    [searchParams],
  );

  const router = useRouter();
  const { status, account } = useCareerAuth();

  // 既にログイン済み（member）なら OTP を要求せず遷移する。
  // display_user_id 未設定なら onboarding、設定済みなら redirect 先へ。
  const alreadyLoggedIn = status === 'member';
  useEffect(() => {
    if (!alreadyLoggedIn) return;
    // 行が無い（account=null）/ display_user_id 未設定なら onboarding、設定済みなら redirect 先へ。
    if (!account || !account.displayUserId) {
      router.replace(
        `${ONBOARDING_PATH}?redirect=${encodeURIComponent(safeRedirect)}`,
      );
    } else {
      router.replace(safeRedirect);
    }
  }, [alreadyLoggedIn, account, router, safeRedirect]);

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
      setSendError('ストレージに接続できません。少し時間をおいて再度お試しください。');
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
      setVerifyError('ストレージに接続できません。少し時間をおいて再度お試しください。');
      return;
    }
    if (result.kind === 'error') {
      setVerifying(false);
      setVerifyError('コードが正しくないか、有効期限が切れています。再度お試しください。');
      return;
    }

    // セッション確立済み。career_accounts 行を確保（初回ログインは display_user_id=null で
    // 作成）してから、display_user_id の有無で遷移先を分岐する。
    const ensured = await ensureCareerAccount(result.userId, result.email);
    const needsOnboarding =
      ensured.kind !== 'ok' || !ensured.account.displayUserId;

    // フル遷移で CareerAuthProvider を再マウントし、新セッションを読み直す。
    if (needsOnboarding) {
      window.location.assign(
        `${ONBOARDING_PATH}?redirect=${encodeURIComponent(safeRedirect)}`,
      );
    } else {
      window.location.assign(safeRedirect);
    }
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
      <PageHeader
        title="メールでログイン"
        description="登録したメールアドレスにコードを送ります。同じメールでログインすれば、別の端末でも同じアカウント（履歴・クラウド同期）に戻れます。"
      />

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
              {sending ? '送信中…' : 'ログインコードを送る'}
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
              {verifying ? '確認中…' : 'ログイン'}
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
    </div>
  );
}

export default function CareerLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-md mx-auto px-4 py-10 text-sm text-slate-500">
          読み込み中…
        </div>
      }
    >
      <CareerLoginForm />
    </Suspense>
  );
}
