import type { ExperienceCommon } from '@/types/careerActivity';
import { TextField, TextareaField } from './ActivityField';

// 経験系セクション（アルバイト・インターン・サークル・プロジェクト・リーダー・ボランティア）が
// 共通で持つ「期間・役割・人数規模・工夫・定量的な成果・学び」を描画する共有フィールド群。
//
// 各セクションは固有フィールド（勤務先・企業名・活動内容 等）を先に描画し、最後に本コンポーネントを
// 置くことで、ES・面接で説得力を出すための定量情報を統一フォーマットで集める。
// すべて任意入力。定量成果はプレースホルダで「数字があれば書く」よう自然に誘導する。
type Props<T extends ExperienceCommon> = {
  item: T;
  patch: (patch: Partial<T>) => void;
};

export function ExperienceTail<T extends ExperienceCommon>({ item, patch }: Props<T>) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <TextField
          label="期間（開始）"
          value={item.period.from}
          onChange={(v) => patch({ period: { ...item.period, from: v } } as Partial<T>)}
          placeholder="2023年4月"
        />
        <TextField
          label="期間（終了）"
          value={item.period.to}
          onChange={(v) => patch({ period: { ...item.period, to: v } } as Partial<T>)}
          placeholder="現在 / 2024年3月"
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField
          label="役割"
          value={item.role}
          onChange={(v) => patch({ role: v } as Partial<T>)}
          placeholder="例：リーダー / 会計 / フロント担当"
        />
        <TextField
          label="人数規模"
          value={item.scale}
          onChange={(v) => patch({ scale: v } as Partial<T>)}
          hint="数字があれば書いてください"
          placeholder="例：10人チーム / 部員50名"
        />
      </div>
      <TextareaField
        label="工夫したこと"
        value={item.ingenuity}
        onChange={(v) => patch({ ingenuity: v } as Partial<T>)}
        placeholder="課題に対して、自分なりに工夫・行動したことを書いてください。"
      />
      <TextareaField
        label="定量的な成果"
        value={item.quantitativeResult}
        onChange={(v) => patch({ quantitativeResult: v } as Partial<T>)}
        hint="数字を入れると ES・面接で説得力が増します"
        placeholder="例：売上を15%改善 / 参加者200人のイベントを運営 / 業務時間を30分短縮 / フォロワー1,000人増"
      />
      <TextareaField
        label="学んだこと"
        value={item.learning}
        onChange={(v) => patch({ learning: v } as Partial<T>)}
        placeholder="この経験から得た学び・強みにつながった点を書いてください。"
      />
    </>
  );
}
