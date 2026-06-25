import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';

// 活動整理の 1 セクションを表すカード。絵文字 + タイトル + 任意の説明 + 本文。
// 受験版の ActivitySectionShell に相当する就活版の薄いラッパー。
type Props = {
  emoji: string;
  title: string;
  description?: string;
  children: ReactNode;
};

export function SectionCard({ emoji, title, description, children }: Props) {
  return (
    <Card variant="default" padding="md">
      <div className="mb-4">
        <h2 className="text-base font-bold text-gray-800">
          <span className="mr-1.5" aria-hidden>
            {emoji}
          </span>
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-sm text-gray-500 leading-relaxed">{description}</p>
        )}
      </div>
      {children}
    </Card>
  );
}
