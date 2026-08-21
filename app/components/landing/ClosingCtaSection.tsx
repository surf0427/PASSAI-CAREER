import Link from 'next/link';
import { LinkButton } from '@/components/ui/LinkButton';
import { CAREER_LOGIN_PATH, CAREER_START_PATH } from '@/lib/careerLandingRoutes';

// LP の締め。FAQ で不安を解消した直後の「感情に残る最後の一押し」。
// 上から indigo→blue→white にフェードする縦グラデで「光が差す」雰囲気を作り、
// 中央寄せの本文 → メイン CTA（/career/profile）→ サブ導線（ログイン）で締める。
//
// CTA の遷移先は Header 右上の LP CTA と同一（lib/careerLandingRoutes.ts に集約）。
//   - メイン CTA … /career/profile（基本情報入力・ログイン不要）。入力後は
//     /career/home に着地する（app/career/profile/ProfileClient.tsx の push 参照）。
//   - サブ導線   … /career/login（redirect 無し）。既定先 /career/home へ着き、
//     基本情報が未入力なら /career/home 側の既存 guard が /career/profile へ送る。

export function ClosingCtaSection() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-gradient-to-b from-accent-50 via-brand-50 to-white"
      />
      <div className="mx-auto max-w-2xl px-6 sm:px-8 py-16 sm:py-24 text-center">
        <h2 className="text-2xl sm:text-4xl font-extrabold tracking-tight leading-snug mb-8 sm:mb-10 text-slate-900">
          迷っているうちに、
          <br className="sm:hidden" />
          エントリーの時期がくる。
        </h2>

        {/* 本文：指定の改行を <br /> でそのまま再現し、リズムを維持する */}
        <div className="space-y-5 text-sm sm:text-base text-slate-700 leading-relaxed mb-10 sm:mb-12">
          <p>
            就活は、
            <br />
            特別な経験がある人だけのものではありません。
          </p>
          <p>
            自分の経験を整理して、
            <br />
            なぜその会社で働きたいのかを言葉にして、
            <br />
            面接で自分の言葉で伝えられる人が強い選考です。
          </p>
          <p>
            PASSAI CAREERは、
            <br />
            何から始めればいいか分からない人のために、
            <br />
            活動整理・自己分析・就活軸・企業研究・ES・面接練習まで、
            <br />
            1つの流れで進められるように作られています。
          </p>
          <p className="font-semibold text-slate-800">
            まずは基本情報の入力から、
            <br />
            自分の就活準備を始めてください。
          </p>
        </div>

        <div className="flex flex-col gap-3 max-w-md mx-auto">
          <LinkButton
            href={CAREER_START_PATH}
            variant="accent"
            size="cta"
            className="font-bold"
          >
            PASSAI CAREERを始める
            <span aria-hidden="true" className="ml-2">
              →
            </span>
          </LinkButton>
          <Link
            href={CAREER_LOGIN_PATH}
            className="inline-flex justify-center items-center bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 font-semibold text-sm sm:text-base px-6 py-3 rounded-xl transition-colors"
          >
            ログイン
          </Link>
        </div>
      </div>
    </section>
  );
}
