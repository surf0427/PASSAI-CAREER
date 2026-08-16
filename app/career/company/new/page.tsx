'use client';

// PASSAI 就活版 — 企業を追加（/career/company/new）。Company Data Spine Phase A / R2。
//
// UX 方針:
//   - 必須入力は **企業名だけ**（業界・URL 等を必須にしない）。
//   - 完全一致で 1 社に決まったときは **候補一覧を出さずに** そのまま進む（確認を増やさない）。
//   - 候補が複数（ambiguous）のときだけユーザーに選ばせる。**自動確定しない**。
//   - 未登録なら「〇〇として登録する」を出す。
//   - Company Spine が使えないとき（未ログイン / env 未設定 / flag OFF）は
//     その旨だけ示して行き止まりにしない（各機能では free-text で進める）。
//
// Official Sourced Facts の取得はここでは行わない（R7 scope）。

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { registerCompanyByName, resolveCompanyByName } from '../companyClient';
import type { CompanyResolveCandidate } from '@/types/careerCompanyIdentity';

type Phase =
  | { kind: 'input' }
  | { kind: 'searching' }
  | { kind: 'resolved'; companyId: string; displayName: string }
  | { kind: 'ambiguous'; candidates: readonly CompanyResolveCandidate[] }
  | { kind: 'unresolved'; suggestions: readonly CompanyResolveCandidate[]; name: string }
  | { kind: 'unavailable' };

export default function CareerCompanyNewPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [registering, setRegistering] = useState(false);

  const canSearch = name.trim() !== '' && phase.kind !== 'searching';

  async function handleSearch() {
    const trimmed = name.trim();
    if (trimmed === '') return;
    setPhase({ kind: 'searching' });
    const res = await resolveCompanyByName(trimmed);
    if (!res.available) {
      setPhase({ kind: 'unavailable' });
      return;
    }
    const data = res.data;
    if (data.status === 'resolved') {
      setPhase({ kind: 'resolved', companyId: data.companyId, displayName: data.displayName });
      return;
    }
    if (data.status === 'ambiguous') {
      // ★ 自動確定しない。
      setPhase({ kind: 'ambiguous', candidates: data.candidates });
      return;
    }
    setPhase({ kind: 'unresolved', suggestions: data.suggestions, name: trimmed });
  }

  async function handleRegister(displayName: string) {
    if (registering) return;
    setRegistering(true);
    const res = await registerCompanyByName(displayName);
    setRegistering(false);
    if (!res.available) {
      setPhase({ kind: 'unavailable' });
      return;
    }
    router.push(`/career/company/${encodeURIComponent(res.data.companyId)}`);
  }

  function goToCompany(companyId: string) {
    router.push(`/career/company/${encodeURIComponent(companyId)}`);
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="企業を追加"
        description="企業名を入力してください。登録しておくと、ES・面接・プレゼン・企業研究から選ぶだけで使えます。"
      />

      <Card variant="soft" padding="md" className="mb-5">
        <label className="block text-sm font-bold text-slate-800 mb-2">
          企業名 <span className="text-rose-500">*</span>
        </label>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setPhase({ kind: 'input' });
          }}
          placeholder="例: トヨタ自動車株式会社"
          autoFocus
        />
        <p className="mt-2 text-xs text-slate-500 leading-relaxed">
          登録に必要なのは企業名だけです。業界や URL は後から追加できます。
        </p>

        <div className="mt-4">
          <Button variant="primary" size="md" onClick={handleSearch} disabled={!canSearch}>
            {phase.kind === 'searching' ? '確認中…' : '次へ'}
          </Button>
        </div>
      </Card>

      {/* 完全一致で 1 社に決まった → 候補一覧を出さずそのまま進める */}
      {phase.kind === 'resolved' && (
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">
            登録済みの企業が見つかりました
          </p>
          <p className="text-base font-semibold text-slate-800 mb-3 break-words">
            {phase.displayName}
          </p>
          <Button variant="primary" size="md" onClick={() => goToCompany(phase.companyId)}>
            この企業で進む →
          </Button>
        </Card>
      )}

      {phase.kind === 'ambiguous' && (
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm font-bold text-slate-800 mb-1">候補が複数あります</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-3">
            どの企業か選んでください（自動では決めません）。
          </p>
          <div className="flex flex-col gap-2">
            {phase.candidates.map((c) => (
              <button
                key={c.companyId}
                type="button"
                onClick={() => goToCompany(c.companyId)}
                className="text-left text-sm text-slate-800 rounded-xl bg-white ring-1 ring-slate-200 px-4 py-2.5 hover:bg-slate-50 transition-colors"
              >
                {c.displayName}
              </button>
            ))}
            <button
              type="button"
              onClick={() => handleRegister(name.trim())}
              disabled={registering}
              className="text-left text-sm text-slate-500 rounded-xl ring-1 ring-dashed ring-slate-300 px-4 py-2.5 hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              {registering ? '登録中…' : `どれでもない →「${name.trim()}」として登録する`}
            </button>
          </div>
        </Card>
      )}

      {phase.kind === 'unresolved' && (
        <Card variant="soft" padding="md" className="mb-5">
          {phase.suggestions.length > 0 ? (
            <>
              <p className="text-sm font-bold text-slate-800 mb-1">近い企業が見つかりました</p>
              <p className="text-xs text-slate-500 leading-relaxed mb-3">
                同じ企業であれば選んでください。違う場合は新しく登録できます。
              </p>
              <div className="flex flex-col gap-2 mb-3">
                {phase.suggestions.map((c) => (
                  <button
                    key={c.companyId}
                    type="button"
                    onClick={() => goToCompany(c.companyId)}
                    className="text-left text-sm text-slate-800 rounded-xl bg-white ring-1 ring-slate-200 px-4 py-2.5 hover:bg-slate-50 transition-colors"
                  >
                    {c.displayName}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-600 leading-relaxed mb-3">
              この企業はまだ登録されていません。
            </p>
          )}
          <Button
            variant="primary"
            size="md"
            onClick={() => handleRegister(phase.name)}
            disabled={registering}
          >
            {registering ? '登録中…' : `「${phase.name}」として登録する`}
          </Button>
        </Card>
      )}

      {phase.kind === 'unavailable' && (
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm font-bold text-slate-800 mb-1.5">
            企業の登録機能は現在利用できません
          </p>
          <p className="text-xs text-slate-500 leading-relaxed">
            ログインが必要な場合があります。企業を登録しなくても、ES・面接・プレゼン・企業研究では
            企業名を直接入力してそのまま利用できます。
          </p>
        </Card>
      )}

      <Link
        href="/career/company"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
      >
        ← 企業一覧に戻る
      </Link>
    </div>
  );
}
