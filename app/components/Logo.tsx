import { BRAND_NAME } from '@/lib/brand';

type LogoVariant = 'default' | 'career';

type Props = {
  className?: string;
  /**
   * 'career' のとき親ブランド PASSAI の右に製品名 CAREER を添える。
   * 既定は 'default'（従来と 1 byte も変わらない出力）。
   */
  variant?: LogoVariant;
};

// PASSAI のテキストロゴ（Notion / Linear / Vercel 系の "文字ベースで洗練されたプロダクト感"）。
//
// 構成：
//   - 左：slate-900 角丸スクエアに白い右矢印 SVG（「pass through」のメタファ、AI ノード感）
//   - 右：font-extrabold + tracking-tight の 2 トーン文字（PASS = slate-900、AI = blue-600）
//
// variant='career'：上記ワードマークはそのままに、右へ小さめの "CAREER" を添える
// （親ブランド PASSAI を残しつつ製品ラインを示す表記。PASSAI 側の字面・色は不変）。
// 就活版の公開 LP と /career 配下でのみ使う。受験版ページ・共通法務ページは 'default'。
//
// プレーン文字列が必要な場所（metadata.title, OG タグ, alt 等）は @/lib/brand の
// BRAND_NAME を直接 import する。ビジュアルの変更はこのファイル内で完結する設計。

export function Logo({ className = '', variant = 'default' }: Props) {
  const isCareer = variant === 'career';
  return (
    <span
      className={`inline-flex items-center gap-2 shrink-0 ${className}`}
      aria-label={isCareer ? `${BRAND_NAME} CAREER` : BRAND_NAME}
    >
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-slate-900 text-white shrink-0">
        <svg
          viewBox="0 0 24 24"
          className="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14" />
          <path d="M13 6l6 6-6 6" />
        </svg>
      </span>
      <span
        className="text-base font-extrabold tracking-tight whitespace-nowrap leading-none"
        aria-hidden="true"
      >
        <span className="text-slate-900">PASS</span>
        <span className="text-blue-600">AI</span>
        {isCareer && (
          <span className="ml-1.5 text-xs font-bold tracking-[0.14em] text-slate-500">
            CAREER
          </span>
        )}
      </span>
    </span>
  );
}
