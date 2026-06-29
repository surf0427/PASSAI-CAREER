'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import type { CareerProfile } from '@/types/careerProfile';
import { saveBasicInfo, loadBasicInfo } from './profileStorage';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import {
  loadCareerProfileFromSupabase,
  saveCareerProfileToSupabase,
} from '@/lib/supabase/careerProfile';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { PageHeader } from '@/components/ui/PageHeader';

// 就活版「基本情報」はプロフィールのみを扱う。
// 活動内容→活動整理 / 希望条件・価値観→就活軸整理 / 強み弱み→自己分析 と責務を分離する。
// 入力項目: ニックネーム / 性別(任意) / 大学 / 学部 / 学科(任意) / 学年 / 卒業予定年。

type FormErrors = {
  nickname?: string;
  university?: string;
  faculty?: string;
  grade?: string;
  graduationYear?: string;
};

// フォーム内部状態はフラットに持ち、保存時に CareerProfile（preferences[0] へ大学情報を
// 格納する受験版互換 shape）へ組み立てる。
type ProfileForm = {
  nickname: string;
  gender: string;
  university: string;
  faculty: string;
  department: string;
  grade: string;
  graduationYear: string;
};

const GRADE_OPTIONS = [
  '1年',
  '2年',
  '3年',
  '4年',
  '修士1年',
  '修士2年',
  '博士',
  '既卒',
] as const;

const GRADUATION_YEAR_OPTIONS = [
  '2026年卒',
  '2027年卒',
  '2028年卒',
  '2029年卒',
  '2030年卒',
  '2031年卒',
] as const;

const GENDER_OPTIONS = ['男性', '女性', 'その他', '回答しない'] as const;

// raw <select> のスタイル（受験版と統一）。Select primitive 未整備のため className を共有する。
const SELECT_CLASS =
  'w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-400';

const emptyForm: ProfileForm = {
  nickname: '',
  gender: '',
  university: '',
  faculty: '',
  department: '',
  grade: '',
  graduationYear: '',
};

// 保存済み CareerProfile → フォーム状態。大学/学部/学科は preferences[0] から引く。
function toForm(profile: CareerProfile | null): ProfileForm {
  if (!profile) return emptyForm;
  const pref = profile.preferences?.[0];
  return {
    nickname: profile.name ?? '',
    gender: profile.gender ?? '',
    university: pref?.university ?? '',
    faculty: pref?.faculty ?? '',
    department: pref?.department ?? '',
    grade: profile.grade ?? '',
    graduationYear: profile.graduationYear ?? '',
  };
}

// フォーム状態 → 保存用 CareerProfile。受験版固有項目は就活版では扱わないため既定値で埋める。
function toProfile(form: ProfileForm): CareerProfile {
  const profile: CareerProfile = {
    name: form.nickname.trim(),
    grade: form.grade,
    track: '', // 就活版では文理を扱わない
    examTypes: [], // 就活版では受験方式を扱わない
    overallGpa: '',
    graduationYear: form.graduationYear,
    preferences: [
      {
        university: form.university.trim(),
        faculty: form.faculty.trim(),
        department: form.department.trim(),
      },
    ],
  };
  // 性別は任意。未選択ならキー自体を持たせない。
  const gender = form.gender.trim();
  if (gender) profile.gender = gender;
  return profile;
}

// マウント前 false / マウント後 true を返す flag（SSR/hydration セーフ）。
// 旧 ProfileClient と同形パターン（useSyncExternalStore で setState なしのマウント判定）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function ProfileClient() {
  const router = useRouter();

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );
  const [form, setForm] = useState<ProfileForm>(() => toForm(loadBasicInfo()));
  const [errors, setErrors] = useState<FormErrors>({});

  const userId = useCurrentUserId();
  // 初期表示時点で localStorage が空だったか（down-sync を 1 回だけ許可する条件）。
  const [localWasEmpty] = useState(() => loadBasicInfo() === null);
  // ユーザーが編集を始めたら true。Supabase からの遅延 down-sync で上書きしない。
  const dirtyRef = useRef(false);

  // localStorage が空 + ログイン済みなら、Supabase の durable mirror から 1 回だけ復元する
  // （別端末で保存したプロフィールの取り込み）。career_values ページと同形。
  useEffect(() => {
    if (!userId || !localWasEmpty) return;
    let cancelled = false;
    (async () => {
      const result = await loadCareerProfileFromSupabase(userId);
      if (cancelled || dirtyRef.current) return;
      if (result.kind === 'ok') {
        saveBasicInfo(result.profile); // LS canonical に揃える（normalize は load 側）
        const reloaded = loadBasicInfo();
        if (reloaded) setForm(toForm(reloaded));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, localWasEmpty]);

  function handleChange(
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) {
    const { name, value } = event.target;
    dirtyRef.current = true;
    setForm((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: undefined }));
  }

  function validateForm(next: ProfileForm): FormErrors {
    const newErrors: FormErrors = {};
    if (!next.nickname.trim()) {
      newErrors.nickname = 'ニックネームを入力してください';
    }
    if (!next.university.trim()) {
      newErrors.university = '大学名を入力してください';
    }
    if (!next.faculty.trim()) {
      newErrors.faculty = '学部を入力してください';
    }
    if (!next.grade) {
      newErrors.grade = '学年を選択してください';
    }
    if (!next.graduationYear) {
      newErrors.graduationYear = '卒業予定年を選択してください';
    }
    return newErrors;
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const newErrors = validateForm(form);
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    const profile = toProfile(form);
    saveBasicInfo(profile);
    // Supabase durable mirror（best-effort / member のみ）。失敗しても遷移は止めない。
    if (userId) void saveCareerProfileToSupabase(userId, profile);
    router.push('/career/home');
  }

  if (!isMounted) return null;

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <PageHeader title="基本情報入力" className="mb-8" />
      <form onSubmit={handleSubmit} noValidate>

        {/* プロフィール */}
        <section className="mb-10">
          <h2 className="text-base font-semibold text-gray-700 mb-4 pb-2 border-b border-gray-200">
            プロフィール
          </h2>
          <div className="space-y-5">

            {/* ニックネーム */}
            <FormField
              label="ニックネーム"
              required
              hint="本名でなくて大丈夫です。あとから変更できます。"
              error={errors.nickname}
            >
              <Input
                type="text"
                name="nickname"
                value={form.nickname}
                onChange={handleChange}
                placeholder="例：たろう"
              />
            </FormField>

            {/* 性別（任意） */}
            <FormField label="性別（任意）">
              <select
                name="gender"
                value={form.gender}
                onChange={handleChange}
                className={SELECT_CLASS}
              >
                <option value="">選択しない</option>
                {GENDER_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </FormField>

            {/* 学年 */}
            <FormField label="学年" required error={errors.grade}>
              <select
                name="grade"
                value={form.grade}
                onChange={handleChange}
                className={SELECT_CLASS}
              >
                <option value="">選択してください</option>
                {GRADE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </FormField>

            {/* 卒業予定年 */}
            <FormField label="卒業予定年" required error={errors.graduationYear}>
              <select
                name="graduationYear"
                value={form.graduationYear}
                onChange={handleChange}
                className={SELECT_CLASS}
              >
                <option value="">選択してください</option>
                {GRADUATION_YEAR_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </FormField>

          </div>
        </section>

        {/* 学校情報 */}
        <section className="mb-10">
          <h2 className="text-base font-semibold text-gray-700 mb-4 pb-2 border-b border-gray-200">
            学校情報
          </h2>
          {/* 略称入力を防ぐためのガイダンス。DB 照合や submit ブロックは行わず表示のみで誘導。 */}
          <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700 mb-4 leading-relaxed">
            大学・学部・学科は、できるだけ
            <span className="font-medium">正式名称で最後まで</span>
            入力してください。省略されていると、AI の分析精度が下がる場合があります。
          </div>
          <div className="space-y-5">

            {/* 大学 */}
            <FormField label="大学" required error={errors.university}>
              <Input
                type="text"
                name="university"
                value={form.university}
                onChange={handleChange}
                placeholder="例：〇〇大学"
              />
            </FormField>

            {/* 学部 */}
            <FormField label="学部" required error={errors.faculty}>
              <Input
                type="text"
                name="faculty"
                value={form.faculty}
                onChange={handleChange}
                placeholder="例：〇〇学部"
              />
            </FormField>

            {/* 学科（任意） */}
            <FormField
              label="学科（任意）"
              hint="まだ決まっていない場合は空欄でも大丈夫です。"
            >
              <Input
                type="text"
                name="department"
                value={form.department}
                onChange={handleChange}
                placeholder="例：〇〇学科"
              />
            </FormField>

          </div>
        </section>

        <Button type="submit" variant="primary" size="lg" className="w-full">
          保存してHomeへ進む
        </Button>

      </form>
    </div>
  );
}
