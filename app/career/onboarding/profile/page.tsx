'use client';

// 就活版（CAREER）オンボーディング: 表示用ID（display_user_id）の初回設定。
//
//   - ログイン（member）必須。guest / loading は /career/login へ誘導する。
//   - display_user_id は必須・UNIQUE。career_accounts に upsert（id = auth.uid()）。
//   - email は表示補助として一緒に保存するが、ログイン識別には使わない（identity は id）。
//   - 保存後は redirect クエリ（相対パスのみ）or /career/profile へ進む。

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { AlertBox } from '@/components/ui/AlertBox';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { validateDisplayUserId } from '@/lib/displayUserId';
import { saveCareerDisplayUserId } from '@/lib/careerSupabase/account';
import { useCareerAuth } from '@/app/career/components/CareerAuthProvider';

const DEFAULT_AFTER = '/career/profile';

function sanitizeRedirect(raw: string | null): string {
  if (!raw) return DEFAULT_AFTER;
  if (!raw.startsWith('/')) return DEFAULT_AFTER;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return DEFAULT_AFTER;
  return raw;
}

function OnboardingProfileForm() {
  const searchParams = useSearchParams();
  const afterPath = useMemo(
    () => sanitizeRedirect(searchParams.get('redirect')),
    [searchParams],
  );

  const router = useRouter();
  const { status, user, account, setAccount } = useCareerAuth();

  // 未ログインは onboarding に来られない。login へ誘導（redirect を引き継ぐ）。
  useEffect(() => {
    if (status === 'guest') {
      router.replace(
        `/career/login?redirect=${encodeURIComponent(
          `/career/onboarding/profile?redirect=${encodeURIComponent(afterPath)}`,
        )}`,
      );
    }
  }, [status, router, afterPath]);

  // 既に display_user_id 設定済みなら onboarding をスキップ。
  useEffect(() => {
    if (status === 'member' && account?.displayUserId) {
      router.replace(afterPath);
    }
  }, [status, account, router, afterPath]);

  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const validation = validateDisplayUserId(value);
  const formatError =
    touched && !validation.ok ? validation.error : undefined;
  const canSave = !saving && validation.ok && status === 'member';

  async function handleSave() {
    setTouched(true);
    if (!validation.ok || !user) return;
    setSaving(true);
    setServerError(null);

    const result = await saveCareerDisplayUserId({
      userId: user.id,
      displayUserId: value,
      email: user.email,
    });

    if (result.kind === 'ok') {
      setAccount(result.account);
      router.replace(afterPath);
      return;
    }

    setSaving(false);
    if (result.kind === 'duplicate') {
      setServerError('この表示IDは既に使われています。別のIDを入力してください。');
      return;
    }
    if (result.kind === 'no-env') {
      setServerError('ストレージに接続できません。少し時間をおいて再度お試しください。');
      return;
    }
    setServerError('保存に失敗しました。時間をおいて再度お試しください。');
  }

  if (status !== 'member') {
    return (
      <div className="max-w-md mx-auto px-4 py-10 text-sm text-slate-500">
        読み込み中…
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 py-8 sm:py-10">
      <PageHeader
        title="表示用IDを設定"
        description="他のユーザーに表示される ID です。ログインには使いません（ログインはメールで行います）。あとから変更できます。"
      />

      <Card padding="md">
        <div className="space-y-4">
          <FormField
            label="表示用ID"
            hint="3〜20文字。半角英小文字・数字・アンダースコア（_）が使えます。"
            error={formatError ?? serverError ?? undefined}
          >
            <Input
              type="text"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (serverError) setServerError(null);
              }}
              onBlur={() => setTouched(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave) handleSave();
              }}
              placeholder="例: job_hunter2027"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={saving}
            />
          </FormField>

          {user?.email && (
            <AlertBox variant="info">
              ログイン中: <span className="font-medium">{user.email}</span>
            </AlertBox>
          )}

          <Button variant="primary" size="md" onClick={handleSave} disabled={!canSave}>
            {saving ? '保存中…' : '設定して進む'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function CareerOnboardingProfilePage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-md mx-auto px-4 py-10 text-sm text-slate-500">
          読み込み中…
        </div>
      }
    >
      <OnboardingProfileForm />
    </Suspense>
  );
}
