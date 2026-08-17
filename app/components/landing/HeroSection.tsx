import Image from 'next/image';
import Link from 'next/link';
import { LinkButton } from '@/components/ui/LinkButton';

// First View（ヒーロー）— PASSAI CAREER（新卒就活向け AI 就活準備サービス）。
// PC: 左右 2 カラム（左=テキスト / 右=画像）、スマホ: テキストの下に画像。
// 淡い青→白のグラデ背景。右の画像は角丸＋軽いシャドウ。
//
// 主 CTA は /career/profile（基本情報入力）。ログイン不要で開始でき、入力後に
// /career/home へ着地する導線に合わせている（app/career/home/page.tsx 参照）。
// 副導線としてログイン（/career/login）を控えめに置く。
//
// 画像は public/hero-passai-interview.png（AI面接練習の利用シーン）。
// 元画像の下部には机上の書籍が写り込んでいるため、aspect-[21/10] + object-cover +
// object-top で上側だけを見せる（PC / スマホとも同じ切り出しになる）。
// CLS 対策として width/height を明示し、コンテナ側で縦横比を固定する。

export function HeroSection() {
  return (
    <section className="relative overflow-hidden">
      {/* 淡い青→白のグラデ背景 */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-gradient-to-b from-brand-50 via-white to-white"
      />
      <div className="mx-auto max-w-6xl px-6 sm:px-8 pt-10 sm:pt-16 pb-14 sm:pb-20">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          {/* 左：テキスト（スマホは中央寄せ / PC は左寄せ） */}
          <div className="text-center lg:text-left">
            <p className="inline-block text-xs sm:text-sm font-semibold text-brand-700 bg-brand-100 rounded-full px-3 py-1 mb-6">
              新卒就活のためのAI就活サポート
            </p>
            <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight leading-tight mb-5">
              自己分析から、
              <br className="sm:hidden" />
              ES・面接まで。
            </h1>
            <p className="text-base sm:text-lg text-slate-700 leading-relaxed mb-4">
              活動整理・自己分析・就活軸・企業研究・ES・面接・GD・プレゼン練習まで、
              就活準備を1つのサービスで進められます。
            </p>
            <p className="text-sm text-slate-500 leading-relaxed">
              入力した内容は次の対策にも引き継がれるので、
              毎回いちから自分の説明をやり直す必要がありません。
            </p>

            <div className="mt-8 sm:mt-10 flex flex-col items-center gap-3 lg:items-start">
              <LinkButton
                href="/career/profile"
                variant="primary"
                size="hero"
                className="w-full sm:w-auto font-bold"
              >
                PASSAI CAREERを始める
                <span aria-hidden="true" className="ml-2">
                  →
                </span>
              </LinkButton>
              <p className="text-xs text-slate-500">
                基本情報の入力から始められます／
                <Link
                  href="/career/login?redirect=%2Fcareer%2Fprofile"
                  className="font-semibold text-brand-600 hover:text-brand-700 underline underline-offset-2"
                >
                  ログインはこちら
                </Link>
              </p>
            </div>
          </div>

          {/* 右：ヒーロー画像（角丸＋軽いシャドウ。画像上に文字は重ねない） */}
          <div className="lg:justify-self-end lg:w-[88%]">
            <div className="relative aspect-[21/10] w-full overflow-hidden rounded-2xl shadow-lg ring-1 ring-black/5">
              <Image
                src="/hero-passai-interview.png"
                alt="PASSAI CAREERのAI面接練習を自宅で利用する就活生"
                width={1536}
                height={1024}
                preload
                sizes="(min-width: 1024px) 45vw, 100vw"
                className="h-full w-full object-cover object-top"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
