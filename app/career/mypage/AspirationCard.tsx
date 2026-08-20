'use client';

// PASSAI CAREER — マイページ「志望条件」カード（User Data Spine の編集面）。
//
// 位置づけ:
//   ここが User Data Spine Layer 1 の canonical profile を **マイページから直接編集する唯一の面**。
//   保存は app/career/mypage/saveCareerAspiration.ts の canonical path のみを通る
//   （localStorage canonical → career_profiles mirror → Layer 2 base 再構築）。
//   マイページ専用の store / key / table は持たない。
//
// 編集ポリシー（要件 6）:
//   - user-authored canonical data のみを編集させる（志望業界 / 志望職種 / 志望企業 /
//     希望勤務地 / 就活状況）。
//   - AI 由来の derived data（自己分析の強み・価値観など）はここでは編集させない。
//     更新は「元データを更新 → Data Spine 再構築」の経路に限る。
//
// UI 方針: 既存 design system（Card / Button / Input / FormField）だけを使い、
//   新しい独自 design system を作らない。

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FormField } from '@/components/ui/FormField';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
import type { CareerProfile } from '@/types/careerProfile';
import { saveCareerAspiration } from './saveCareerAspiration';
import {
  isCareerAspirationEmpty,
  type CareerAspiration,
} from './mypageDataSpineView';

// 就活状況の選択肢（自由入力ではなく固定語彙にして prompt の揺れを抑える）。
const JOB_HUNTING_STATUS_OPTIONS = [
  '情報収集を始めたところ',
  '自己分析・業界研究中',
  'インターン選考に参加中',
  '本選考にエントリー中',
  '面接が進行中',
  '内定あり・就活継続中',
  '就活を終えた',
] as const;

const SELECT_CLASS =
  'w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-400';

// 「、」「,」「改行」区切りのテキスト → 正規化済み配列（決定的・重複除去は保存側と同じ挙動）。
function parseList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,、\n]/)) {
    const t = part.trim();
    if (t !== '' && !out.includes(t)) out.push(t);
  }
  return out;
}

function toText(values: string[]): string {
  return values.join('、');
}

type FormState = {
  targetIndustries: string;
  targetJobs: string;
  targetCompanies: string;
  preferredLocations: string;
  jobHuntingStatus: string;
};

function toForm(a: CareerAspiration): FormState {
  return {
    targetIndustries: toText(a.targetIndustries),
    targetJobs: toText(a.targetJobs),
    targetCompanies: toText(a.targetCompanies),
    preferredLocations: toText(a.preferredLocations),
    jobHuntingStatus: a.jobHuntingStatus,
  };
}

function fromForm(f: FormState): CareerAspiration {
  return {
    targetIndustries: parseList(f.targetIndustries),
    targetJobs: parseList(f.targetJobs),
    targetCompanies: parseList(f.targetCompanies),
    preferredLocations: parseList(f.preferredLocations),
    jobHuntingStatus: f.jobHuntingStatus.trim(),
  };
}

type Props = {
  aspiration: CareerAspiration;
  /** 保存が canonical へ通ったあとに呼ばれる（呼び出し側が Spine view を読み直す）。 */
  onSaved: (profile: CareerProfile) => void;
};

export default function AspirationCard({ aspiration, onSaved }: Props) {
  const userId = useCurrentUserId();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState>(() => toForm(aspiration));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>('');

  const empty = isCareerAspirationEmpty(aspiration);

  function startEdit() {
    setForm(toForm(aspiration));
    setNotice('');
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    setNotice('');
    const outcome = await saveCareerAspiration(fromForm(form), userId);
    setSaving(false);
    if (!outcome.canonical || !outcome.profile) {
      setNotice('保存できませんでした。時間をおいて もう一度お試しください。');
      return;
    }
    onSaved(outcome.profile);
    setEditing(false);
    // 事実だけを伝える（mirror 失敗を「同期済み」と偽らない）。
    setNotice(
      outcome.mirrored
        ? '保存しました。この内容はAI機能にも反映されます。'
        : 'この端末に保存しました。ログインするとクラウドにも保存されます。',
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-lg font-bold text-slate-900">志望条件</h2>
        {!editing && (
          <Button variant="outline" size="sm" onClick={startEdit}>
            {empty ? '入力する' : '編集する'}
          </Button>
        )}
      </div>

      <Card variant="default" padding="md">
        {editing ? (
          <div className="space-y-4">
            <FormField
              label="志望業界"
              hint="「、」または改行で区切って入力してください（例：コンサル、IT・通信）"
            >
              <Input
                type="text"
                value={form.targetIndustries}
                onChange={(e) => setForm({ ...form, targetIndustries: e.target.value })}
                placeholder="例：コンサル、IT・通信"
              />
            </FormField>
            <FormField label="志望職種" hint="例：営業、エンジニア、企画">
              <Input
                type="text"
                value={form.targetJobs}
                onChange={(e) => setForm({ ...form, targetJobs: e.target.value })}
                placeholder="例：営業、エンジニア"
              />
            </FormField>
            <FormField label="気になっている企業" hint="社名を「、」で区切って入力できます">
              <Input
                type="text"
                value={form.targetCompanies}
                onChange={(e) => setForm({ ...form, targetCompanies: e.target.value })}
                placeholder="例：○○商事、△△システム"
              />
            </FormField>
            <FormField label="希望勤務地" hint="例：東京、大阪、リモート可">
              <Input
                type="text"
                value={form.preferredLocations}
                onChange={(e) => setForm({ ...form, preferredLocations: e.target.value })}
                placeholder="例：東京、リモート可"
              />
            </FormField>
            <FormField label="就活の状況">
              <select
                className={SELECT_CLASS}
                value={form.jobHuntingStatus}
                onChange={(e) => setForm({ ...form, jobHuntingStatus: e.target.value })}
              >
                <option value="">未選択</option>
                {JOB_HUNTING_STATUS_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </FormField>

            <div className="flex items-center gap-3 pt-1">
              <Button variant="primary" size="md" onClick={handleSave} disabled={saving}>
                {saving ? '保存中…' : '保存する'}
              </Button>
              <Button
                variant="ghost"
                size="md"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                キャンセル
              </Button>
            </div>
          </div>
        ) : empty ? (
          <p className="text-sm text-gray-600 leading-relaxed">
            志望業界・職種・勤務地などを登録すると、ES・面接・企業分析など
            すべてのAI機能があなたの志望に合わせた内容を返すようになります。
          </p>
        ) : (
          <dl className="space-y-3">
            <AspirationRow label="志望業界" values={aspiration.targetIndustries} />
            <AspirationRow label="志望職種" values={aspiration.targetJobs} />
            <AspirationRow label="気になっている企業" values={aspiration.targetCompanies} />
            <AspirationRow label="希望勤務地" values={aspiration.preferredLocations} />
            <AspirationRow
              label="就活の状況"
              values={aspiration.jobHuntingStatus ? [aspiration.jobHuntingStatus] : []}
            />
          </dl>
        )}

        {notice && <p className="mt-3 text-xs text-gray-500">{notice}</p>}
      </Card>
    </section>
  );
}

function AspirationRow({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="flex flex-col sm:flex-row sm:gap-4">
      <dt className="shrink-0 sm:w-36 text-xs font-medium text-gray-400 pt-1">{label}</dt>
      <dd className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-sm text-slate-700"
          >
            {v}
          </span>
        ))}
      </dd>
    </div>
  );
}
