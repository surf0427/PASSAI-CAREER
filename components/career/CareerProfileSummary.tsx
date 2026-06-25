import type { CareerProfile } from '@/types/careerProfile';

// 就活版（PASSAI CAREER）プロフィールサマリー。
// 受験版の共有 components/shared/BasicInfoSummary（文理・評定・受験方式など受験前提の項目を
// 表示）は流用せず、就活版プロフィールに必要な項目だけを表示する専用コンポーネント。
// 受験版コンポーネントには一切手を入れないため、受験版表示への影響はない。
//
// 表示項目: ニックネーム / 大学 / 学部 / 学科 / 学年 / 卒業予定年 / 性別。
//   - 大学・学部・学科は CareerProfile.preferences[0] から引く（受験版データ構造を流用した
//     就活版の保存形状に合わせる）。
//   - 学科・性別は未入力なら表示しない。
//
// カードUI・余白・配色は受験版 BasicInfoSummary と揃える（新規デザインはしない）。
type Props = {
  profile: CareerProfile | null;
  // 「編集する」リンクを右上に表示するときの遷移先。
  editHref?: string;
};

export default function CareerProfileSummary({ profile, editHref }: Props) {
  if (!profile) return null;

  const pref = profile.preferences?.[0];

  // 表示する項目を「ラベル・値」の組で構築し、空の任意項目（学科・性別）は除外する。
  const items: Array<{ label: string; value: string }> = [
    { label: 'ニックネーム', value: profile.name?.trim() || '未入力' },
    { label: '大学', value: pref?.university?.trim() || '未入力' },
    { label: '学部', value: pref?.faculty?.trim() || '未入力' },
  ];

  const department = (pref?.department ?? '').trim();
  if (department) items.push({ label: '学科', value: department });

  items.push({ label: '学年', value: profile.grade?.trim() || '未入力' });
  items.push({
    label: '卒業予定',
    value: (profile.graduationYear ?? '').trim() || '未入力',
  });

  const gender = (profile.gender ?? '').trim();
  if (gender) items.push({ label: '性別', value: gender });

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 mb-6 text-sm text-gray-700">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wide">
          プロフィール
        </h2>
        {editHref && (
          <a href={editHref} className="text-xs text-blue-600 hover:underline">
            編集する
          </a>
        )}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1.5">
        {items.map((item) => (
          <span key={item.label}>
            <span className="text-gray-400 mr-1">{item.label}</span>
            {item.value}
          </span>
        ))}
      </div>
    </div>
  );
}
