'use client';

// STEP-AUTH-P0: メール OTP ログインページ。
//
// 目的:
//   無料プランの無い課金サービスで、課金ユーザーが Mac / スマホ / 別ブラウザでも
//   「同じ auth.users.id」に復帰できる正規ログイン入口。匿名認証では端末ごとに
//   別 user_id が発行され「課金済みなのに別端末で Free 表示」が起きるため、
//   課金前にこのページでメール OTP ログインを通す。
//
// フロー:
//   1. メール入力 → OTP 送信（signInWithEmailOtp({ allowSignup: true })）
//      - 初回購入者（未登録メール）も新規発行、既存ユーザーはログインに使える同一入口。
//   2. メールに届いたコードを入力 → verifyEmailOtp で検証しセッション確立。
//      - テンプレートがリンクのみの構成でも、リンク click → /auth/callback で
//        同じ user_id に着地する（コード経路はその UX 改善版）。
//   3. 成功後、`next`（相対パスのみ許可）へ window.location で **フル遷移**。
//      フル遷移により AuthProvider が再マウントし、新セッション（永続ユーザー）を
//      読み直す（client 内 router.push だと state が匿名のまま古くなるため）。
//
// 原則:
//   - identity は auth.users.id（email は復帰のための鍵）。display_user_id は不使用。
//   - profiles.plan / is_qa_user / planGate / webhook には一切触れない。

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { AlertBox } from '@/components/ui/AlertBox';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { useAuthDebug, useIsMember } from '@/app/components/AuthProvider';
import { FooterSection } from '@/app/components/landing/FooterSection';
import { signInWithEmailOtp, verifyEmailOtp } from '@/lib/supabase/auth';
import { isValidEmailFormat } from '@/lib/supabase/email';

// next 未指定時の既定遷移先。本体ホーム。未課金なら PlanGate が /pricing へ送るため、
// 「課金済み → /home」「未課金 → /pricing」が遷移先の出し分けなしで成立する。
const DEFAULT_NEXT = '/home';

/**
 * open-redirect 防止: `next` は **同一オリジンの相対パス** のみ許可する。
 * - 先頭が "/" で始まり、"//" や "/\" のような protocol-relative を弾く。
 * - 不正なら DEFAULT_NEXT にフォールバック。
 */
function sanitizeNext(raw: string | null): string {
  if (!raw) return DEFAULT_NEXT;
  if (!raw.startsWith('/')) return DEFAULT_NEXT;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return DEFAULT_NEXT;
  return raw;
}

type Step =
  | { kind: 'email' }
  | { kind: 'code'; email: string };

function LoginForm() {
  const searchParams = useSearchParams();
  const safeNext = useMemo(
    () => sanitizeNext(searchParams.get('next')),
    [searchParams],
  );

  // STEP-AUTH-REDESIGN: 既ログイン（member = is_anonymous === false）なら OTP を
  // 要求せず safeNext へ。guest（未ログイン / 旧 anonymous）は OTP フォームを表示する。
  // 認可（課金）判定は遷移先で PlanGate に委ねる（ここでは plan に触れない）。
  const router = useRouter();
  const isMember = useIsMember();
  const { authReady } = useAuthDebug();
  const alreadyLoggedIn = authReady && isMember;

  useEffect(() => {
    if (alreadyLoggedIn) {
      router.replace(safeNext);
    }
  }, [alreadyLoggedIn, router, safeNext]);

  const [step, setStep] = useState<Step>({ kind: 'email' });

  // ── email step ──
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // ── code step ──
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  const emailFormatError = (() => {
    if (!emailTouched) return undefined;
    if (email === '') return 'メールアドレスを入力してください。';
    if (!isValidEmailFormat(email)) {
      return 'メールアドレスの形式が正しくありません。';
    }
    return undefined;
  })();

  const canSend = !sending && email !== '' && isValidEmailFormat(email);
  // 桁数非依存: Supabase の OTP 長（6〜8 桁等の設定差）に追従するため、
  // 下限 6 桁のみ要求し上限は入力側で 10 桁に緩める。
  const canVerify = !verifying && code.trim().length >= 6;

  async function handleSend() {
    setEmailTouched(true);
    if (!canSend) return;
    setSending(true);
    setSendError(null);
    // allowSignup: 初回購入者（未登録メール）も発行し、既存ユーザーはログイン。
    const result = await signInWithEmailOtp(email, {
      allowSignup: true,
      next: safeNext,
    });
    setSending(false);
    if (result.kind === 'ok') {
      setStep({ kind: 'code', email });
      setCode('');
      setVerifyError(null);
      setResent(false);
      return;
    }
    if (result.kind === 'no-env') {
      // 設定不備（公開 env が build に inline されていない）。時間をおいても解消しないため
      // 「再度お試しください」とは案内しない（transient failure と混同させない）。
      setSendError(
        'ただいまログインをご利用いただけません（サーバー設定の問題）。時間をおいても解消しないため、恐れ入りますが運営までお問い合わせください。',
      );
      return;
    }
    setSendError(
      'コードを送信できませんでした。メールアドレスを確認して再度お試しください。',
    );
  }

  async function handleVerify() {
    if (step.kind !== 'code' || !canVerify) return;
    setVerifying(true);
    setVerifyError(null);
    const result = await verifyEmailOtp(step.email, code);
    if (result.kind === 'ok') {
      // フル遷移で AuthProvider を再マウントし、新セッションを読み直す。
      window.location.assign(safeNext);
      return;
    }
    setVerifying(false);
    if (result.kind === 'no-env') {
      // 設定不備。retry 案内をしない（handleSend と同一方針）。
      setVerifyError(
        'ただいまログインをご利用いただけません（サーバー設定の問題）。時間をおいても解消しないため、恐れ入りますが運営までお問い合わせください。',
      );
      return;
    }
    setVerifyError(
      'コードが正しくないか、有効期限が切れています。再度お試しください。',
    );
  }

  async function handleResend() {
    if (step.kind !== 'code') return;
    setVerifying(false);
    setVerifyError(null);
    const result = await signInWithEmailOtp(step.email, {
      allowSignup: true,
      next: safeNext,
    });
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
        description="登録したメールアドレスにコードを送ります。Mac でもスマホでも、同じメールでログインすれば同じアカウント（学習データ・契約状態）に戻れます。"
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

            <Button
              variant="primary"
              size="md"
              onClick={handleSend}
              disabled={!canSend}
            >
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
                  // 数字のみに正規化。桁数は Supabase 設定（6〜8 桁等）に追従するため
                  // 固定せず、暴走防止に上限 10 桁まで許容する。
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

            <Button
              variant="primary"
              size="md"
              onClick={handleVerify}
              disabled={!canVerify}
            >
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

export default function LoginPage() {
  // useSearchParams は Suspense 境界を要求するため wrap する。
  return (
    <>
      <Suspense
        fallback={
          <div className="max-w-md mx-auto px-4 py-10 text-sm text-slate-500">
            読み込み中…
          </div>
        }
      >
        <LoginForm />
      </Suspense>
      <FooterSection />
    </>
  );
}
