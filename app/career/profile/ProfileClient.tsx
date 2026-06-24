'use client';

import { useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import type { BasicInfo, SchoolPreference, SubjectGrades } from '@/types/basicInfo';
import { saveBasicInfo, loadBasicInfo } from './profileStorage';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { PageHeader } from '@/components/ui/PageHeader';
import { Accordion } from '@/components/ui/Accordion';

type FormErrors = {
  name?: string;
  grade?: string;
  track?: string;
  examTypes?: string;
  firstPreferenceUniversity?: string;
  firstPreferenceFaculty?: string;
};

const PREFERENCE_LABELS = ['第一志望', '第二志望', '第三志望', '第四志望', '第五志望'];

const EXAM_TYPE_OPTIONS = [
  '総合型選抜（AO入試）',
  '学校推薦型選抜（公募・指定校）',
  '一般選抜',
  '共通テスト利用',
  '海外大学受験',
  'まだ決まっていない',
] as const;

// 科目別評定・欠席日数の field 定義。
// 評定 5 科目は overallGpa と同じ思想で decimal、欠席日数のみ整数想定で numeric。
// label の順序は UI 表示順を兼ねる。
const SUBJECT_GRADE_FIELDS: ReadonlyArray<{
  key: keyof SubjectGrades;
  label: string;
  inputMode: 'decimal' | 'numeric';
  placeholder: string;
}> = [
  { key: 'english', label: '英語評定', inputMode: 'decimal', placeholder: '例：4.5' },
  { key: 'japanese', label: '国語評定', inputMode: 'decimal', placeholder: '例：4.2' },
  { key: 'math', label: '数学評定', inputMode: 'decimal', placeholder: '例：3.8' },
  { key: 'science', label: '理科評定', inputMode: 'decimal', placeholder: '例：4.0' },
  { key: 'social', label: '社会評定', inputMode: 'decimal', placeholder: '例：4.3' },
  { key: 'absenceDays', label: '欠席日数', inputMode: 'numeric', placeholder: '例：3' },
];

const emptyPreference: SchoolPreference = { university: '', faculty: '', department: '' };

// マウント前 false / マウント後 true を返す flag（SSR/hydration セーフ）。
// useSyncExternalStore は server snapshot / client snapshot を React のハイドレーション
// フェーズと協調させるため、setState を使わずに「マウント済み」フラグを表現できる。
// app/self-analysis/page.tsx / app/statement/edit/page.tsx と同形パターン。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

// 保存直前に呼ぶ。subjectGrades を field 単位で prune する：
//   - 各 key を trim し、空文字になった key は落とす
//   - 残る key が 1 つでもあれば subjectGrades に非空 key だけ残す
//   - 全部空なら subjectGrades キーごと削除する
// 空の {} や空文字フィールドが localStorage に残るのを防ぎ、
// AI input hash（lib/aiInputHash.ts）が無駄に変動するのを防ぐ。
function pruneSubjectGrades(data: BasicInfo): BasicInfo {
  const grades = data.subjectGrades;
  if (!grades) return data;
  const nextGrades: SubjectGrades = {};
  for (const [key, value] of Object.entries(grades) as Array<
    [keyof SubjectGrades, string | undefined]
  >) {
    const trimmed = (value ?? '').trim();
    if (trimmed !== '') {
      nextGrades[key] = trimmed;
    }
  }
  if (Object.keys(nextGrades).length === 0) {
    const next = { ...data };
    delete next.subjectGrades;
    return next;
  }
  return { ...data, subjectGrades: nextGrades };
}

const initialFormData: BasicInfo = {
  name: '',
  grade: '',
  track: '',
  overallGpa: '',
  examTypes: [],
  preferences: [
    { ...emptyPreference },
    { ...emptyPreference },
    { ...emptyPreference },
    { ...emptyPreference },
    { ...emptyPreference },
  ],
};

export default function ProfileClient() {
  const router = useRouter();
  // STEP5.15: mount フラグを useSyncExternalStore に置換し、formData は lazy initializer で
  // localStorage から直接復元する。
  //   - SSR / client first render: isMounted = false → 下方の `if (!isMounted) return null` で
  //     どちらも DOM を空に保つため、formData の lazy init が server '' / client '実値' で
  //     異なる状態を持っても **DOM レベルの hydration mismatch は発生しない**。
  //   - hydration commit 後: isMounted = true に切り替わり、formData は既に loadBasicInfo() の
  //     値を保持しているため、追加の setState なしでフォームが復元状態で表示される。
  // これにより従来の `useEffect → setFormData(saved); setIsMounted(true)` 副作用が不要となり、
  // react-hooks/set-state-in-effect 違反は eslint-disable なしで解消される。
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );
  const [formData, setFormData] = useState<BasicInfo>(
    () => loadBasicInfo() ?? initialFormData,
  );
  const [errors, setErrors] = useState<FormErrors>({});

  function handleChange(
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) {
    const { name, value } = event.target;
    setFormData((prev) => ({ ...prev, [name]: value } as BasicInfo));
    setErrors((prev) => ({ ...prev, [name]: undefined } as FormErrors));
  }

  function toggleExamType(option: string) {
    setFormData((prev) => {
      const current = prev.examTypes ?? [];
      const next = current.includes(option)
        ? current.filter((v) => v !== option)
        : [...current, option];
      return { ...prev, examTypes: next };
    });
    setErrors((prev) => ({ ...prev, examTypes: undefined }));
  }

  // subjectGrades はネストオブジェクトかつ optional のため、generic な handleChange に
  // 混ぜず専用ハンドラを置く。未入力フィールドは undefined のまま温存することで、
  // 保存時 prune と AI input hash の不変性を維持する。
  function handleSubjectGradeChange(key: keyof SubjectGrades, value: string) {
    setFormData((prev) => ({
      ...prev,
      subjectGrades: {
        ...(prev.subjectGrades ?? {}),
        [key]: value,
      },
    }));
  }

  function handlePreferenceChange(
    index: number,
    field: keyof SchoolPreference,
    value: string
  ) {
    const newPreferences = formData.preferences.map((pref, i) =>
      i === index ? { ...pref, [field]: value } : pref
    );
    setFormData((prev) => ({ ...prev, preferences: newPreferences }));
    if (index === 0 && field === 'university') {
      setErrors((prev) => ({ ...prev, firstPreferenceUniversity: undefined }));
    }
    if (index === 0 && field === 'faculty') {
      setErrors((prev) => ({ ...prev, firstPreferenceFaculty: undefined }));
    }
  }

  function validateForm(): FormErrors {
    const newErrors: FormErrors = {};
    if (!formData.name.trim()) {
      newErrors.name = 'ユーザー名を入力してください';
    }
    if (!formData.grade) {
      newErrors.grade = '学年を選択してください';
    }
    if (!formData.track) {
      newErrors.track = '文系/理系/未定を選択してください';
    }
    if (!formData.examTypes || formData.examTypes.length === 0) {
      newErrors.examTypes = '受験予定の方式を1つ以上選択してください';
    }
    if (!formData.preferences[0]?.university.trim()) {
      newErrors.firstPreferenceUniversity = '第一志望の大学名を入力してください';
    }
    if (!formData.preferences[0]?.faculty.trim()) {
      newErrors.firstPreferenceFaculty = '第一志望の学部名を入力してください';
    }
    return newErrors;
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const newErrors = validateForm();
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    const pruned = pruneSubjectGrades(formData);
    saveBasicInfo(pruned);

    router.push('/career/home');
  }

  if (!isMounted) return null;

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <PageHeader title="基本情報入力" className="mb-8" />
      <form onSubmit={handleSubmit} noValidate>

        {/* 基本情報 */}
        <section className="mb-10">
          <h2 className="text-base font-semibold text-gray-700 mb-4 pb-2 border-b border-gray-200">
            基本情報
          </h2>
          <div className="space-y-5">

            {/* ユーザー名 */}
            <FormField
              label="ユーザー名"
              required
              hint="ニックネームでも大丈夫です。あとから変更できます。"
              error={errors.name}
            >
              <Input
                type="text"
                name="name"
                value={formData.name}
                onChange={handleChange}
                placeholder="例：たろう"
              />
            </FormField>

            {/* 学年
                Select primitive 未整備のため <select> は raw 維持。
                FormField で label / 必須印 / error 構造だけ統一しておく。 */}
            <FormField
              label="学年"
              required
              error={errors.grade}
            >
              <select
                name="grade"
                value={formData.grade}
                onChange={handleChange}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">選択してください</option>
                <option value="高1">高1</option>
                <option value="高2">高2</option>
                <option value="高3">高3</option>
                <option value="既卒">既卒</option>
                <option value="その他">その他</option>
              </select>
            </FormField>

            {/* 文系・理系・未定 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                文系 / 理系 / 未定 <span className="text-red-500">*</span>
              </label>
              <div className="flex gap-6">
                {(['文系', '理系', '未定'] as const).map((value) => (
                  <label key={value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="track"
                      value={value}
                      checked={formData.track === value}
                      onChange={handleChange}
                      className="w-4 h-4"
                    />
                    <span className="text-sm text-gray-700">{value}</span>
                  </label>
                ))}
              </div>
              {errors.track && (
                <p className="text-red-500 text-xs mt-1">{errors.track}</p>
              )}
            </div>

            {/* 評定平均 */}
            <FormField
              label="評定平均"
              hint="通知表の「全体の学習成績の状況」を入力。まだ確認できていなければ空欄でも大丈夫です。"
            >
              <Input
                type="text"
                name="overallGpa"
                inputMode="decimal"
                value={formData.overallGpa ?? ''}
                onChange={handleChange}
                placeholder="例：4.3"
              />
            </FormField>

            {/* 科目別評定・欠席日数（任意）
                推薦・AO の科目条件マッチング精度を上げるための optional 入力。
                初回離脱を増やさないよう defaultOpen=false。
                値は subjectGrades オブジェクトにネストして保存し、未入力なら
                handleSubmit 時の pruneSubjectGrades で key ごと落とす。 */}
            <Accordion title="＋ 科目別評定・欠席日数を入力する（任意）">
              <p className="text-xs text-gray-500 mb-4">
                詳しく入力すると、推薦可能校や科目条件をより正確に判定できます。あとからでも入力できます。
              </p>
              <div className="space-y-3">
                {SUBJECT_GRADE_FIELDS.map((field) => (
                  <FormField key={field.key} label={field.label}>
                    <Input
                      type="text"
                      inputMode={field.inputMode}
                      value={formData.subjectGrades?.[field.key] ?? ''}
                      onChange={(e) => handleSubjectGradeChange(field.key, e.target.value)}
                      placeholder={field.placeholder}
                    />
                  </FormField>
                ))}
              </div>
            </Accordion>

          </div>
        </section>

        {/* 受験予定の方式 */}
        <section className="mb-10">
          <h2 className="text-base font-semibold text-gray-700 mb-2 pb-2 border-b border-gray-200">
            受験予定の方式 <span className="text-red-500">*</span>
          </h2>
          <p className="text-xs text-gray-500 mb-4">複数選択可</p>
          <div className="space-y-2">
            {EXAM_TYPE_OPTIONS.map((option) => {
              const checked = (formData.examTypes ?? []).includes(option);
              return (
                <label
                  key={option}
                  className="flex items-center gap-3 px-4 py-3 rounded-md border border-slate-200 bg-white cursor-pointer hover:bg-slate-50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleExamType(option)}
                    className="w-4 h-4 shrink-0"
                  />
                  <span className="text-sm text-gray-700">{option}</span>
                </label>
              );
            })}
          </div>
          {errors.examTypes && (
            <p className="text-red-500 text-xs mt-2">{errors.examTypes}</p>
          )}
        </section>

        {/* 志望校 */}
        <section className="mb-10">
          <h2 className="text-base font-semibold text-gray-700 mb-4 pb-2 border-b border-gray-200">
            志望校
          </h2>
          {/* 略称入力を防ぐためのガイダンス。
              DB 照合や submit ブロックは行わず、表示のみで誘導する（[[university_database_usage_guide]] 参照）。 */}
          <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700 mb-4 leading-relaxed">
            <p className="mb-1">
              大学・学部・学科は、できるだけ<span className="font-medium">正式名称で最後まで</span>入力してください。
            </p>
            <p>
              「法政」ではなく「法政大学」、「経営」ではなく「経営学部」、「国際文化」ではなく「国際文化学科」のように入力すると、AI の分析精度が上がります。省略されていると、志望理由書や面接練習で正しく反映されない場合があります。
            </p>
          </div>
          <div className="space-y-4">
            {formData.preferences.map((pref, index) => {
              const isRequired = index === 0;
              const label = PREFERENCE_LABELS[index];
              return (
                <div
                  key={index}
                  className={`p-4 rounded-lg border ${
                    isRequired
                      ? 'border-blue-200 bg-blue-50'
                      : 'border-gray-200 bg-gray-50'
                  }`}
                >
                  <p className="text-sm font-medium text-gray-700 mb-3">
                    {label}
                    {isRequired ? (
                      <span className="text-red-500 ml-1 text-xs">（必須）</span>
                    ) : (
                      <span className="text-gray-400 ml-1 text-xs">（任意）</span>
                    )}
                  </p>
                  <div className="space-y-3">
                    <FormField
                      label="大学名"
                      hint={isRequired ? undefined : 'まだ決まっていなければ空欄でも大丈夫です。'}
                      error={
                        index === 0 ? errors.firstPreferenceUniversity : undefined
                      }
                    >
                      <Input
                        type="text"
                        value={pref.university}
                        onChange={(e) =>
                          handlePreferenceChange(index, 'university', e.target.value)
                        }
                        placeholder="例：〇〇大学"
                      />
                    </FormField>
                    <FormField
                      label="学部名"
                      error={index === 0 ? errors.firstPreferenceFaculty : undefined}
                    >
                      <Input
                        type="text"
                        value={pref.faculty}
                        onChange={(e) =>
                          handlePreferenceChange(index, 'faculty', e.target.value)
                        }
                        placeholder="例：〇〇学部"
                      />
                    </FormField>
                    <FormField
                      label="学科名（任意）"
                      hint="まだ決まっていない場合は空欄でも大丈夫です。"
                    >
                      <Input
                        type="text"
                        value={pref.department ?? ''}
                        onChange={(e) =>
                          handlePreferenceChange(index, 'department', e.target.value)
                        }
                        placeholder="例：〇〇学科"
                      />
                    </FormField>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
        >
          保存してHomeへ進む
        </Button>

      </form>
    </div>
  );
}
