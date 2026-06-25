import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';

// 複数登録できるセクション（アルバイト・インターン・プロジェクト・資格・IT スキル・語学）の
// 共通レイアウト。各行を枠で囲み、右上に削除ボタン、末尾に追加ボタンを置く。
//
// 行のフィールド描画は呼び出し側が renderItem で担う（行ごとに項目が異なるため）。
type Props<T extends { id: string }> = {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  onAdd: () => void;
  onRemove: (id: string) => void;
  addLabel: string;
  emptyHint?: string;
  itemLabel: (index: number) => string;
};

export function RepeatableList<T extends { id: string }>({
  items,
  renderItem,
  onAdd,
  onRemove,
  addLabel,
  emptyHint,
  itemLabel,
}: Props<T>) {
  return (
    <div className="space-y-4">
      {items.length === 0 && emptyHint && (
        <p className="text-sm text-gray-400">{emptyHint}</p>
      )}

      {items.map((item, index) => (
        <div
          key={item.id}
          className="rounded-xl border border-gray-200 bg-gray-50/60 p-4"
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-500">
              {itemLabel(index)}
            </span>
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              className="text-xs text-red-500 hover:text-red-700 transition-colors"
            >
              削除
            </button>
          </div>
          <div className="space-y-3">{renderItem(item, index)}</div>
        </div>
      ))}

      <Button variant="secondary" size="sm" onClick={onAdd}>
        ＋ {addLabel}
      </Button>
    </div>
  );
}
