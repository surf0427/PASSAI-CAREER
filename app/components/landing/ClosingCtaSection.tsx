import Link from 'next/link';
import { isCareerVariantByEnv } from '@/lib/appVariant';
// FREEZE(legacy-diagnosis): 締めの主 CTA（/diagnosis）は凍結中。CTA 非表示に伴い
// LinkButton は未使用となるため import も停止。サブ CTA（/home）は Link のまま残す。
// import { LinkButton } from '@/components/ui/LinkButton';

// LP の締め。FAQ で不安を解消した直後の「感情に残る最後の一押し」。
// 上から indigo→blue→white にフェードする縦グラデで「光が差す」雰囲気を作り、
// 中央寄せの本文 → メイン CTA（凍結中）→ サブ CTA（PASSAIを始める / /login）で締める。
// Free Diagnosis CTA とのカニバリ回避のため、本文を厚めに、CTA は同色だがコンテキストで差別化。

export function ClosingCtaSection() {
  // 就活版（CAREER）では「PASSAIを始める」を受験版課金（/pricing）ではなく
  // CAREER 基本情報（/career/profile・guest 可）へ向ける。受験版は従来どおり /pricing。
  const startHref = isCareerVariantByEnv() ? '/career/profile' : '/pricing';
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
          時間だけが過ぎていく。
        </h2>

        {/* 本文：ユーザー指定の改行を <br /> でそのまま再現し、詩的なリズムを維持 */}
        <div className="space-y-5 text-sm sm:text-base text-slate-700 leading-relaxed mb-10 sm:mb-12">
          <p>
            総合型選抜・学校推薦型選抜は、
            <br />
            特別な才能がある人だけの入試ではありません。
          </p>
          <p>
            自分の経験を整理して、
            <br />
            なぜその大学で学びたいのかを言葉にして、
            <br />
            面接で自分の言葉で伝えられる人が強い入試です。
          </p>
          <p>
            PASSAIは、
            <br />
            何も書けない状態から始める人のために、
            <br />
            活動整理・自己分析・志望理由書・小論文・面接対策まで、
            <br />
            1つの流れで進められるように作られています。
          </p>
          <p className="font-semibold text-slate-800">
            まずは無料診断から、
            <br />
            自分に合う対策の始め方を見つけてください。
          </p>
        </div>

        {/* CTA：メイン（/diagnosis）は凍結中のため非表示。サブ（/home）のみ残す。 */}
        <div className="flex flex-col gap-3 max-w-md mx-auto">
          {/* FREEZE(legacy-diagnosis): メイン CTA は /diagnosis への導線だったため凍結。
          <LinkButton
            href="/diagnosis"
            variant="accent"
            size="cta"
            className="font-bold"
          >
            無料で受験タイプ診断をする
            <span aria-hidden="true" className="ml-2">→</span>
          </LinkButton>
          */}
          {/* サブ CTA：cta size の主役と並ぶ控えめ 1 本。LinkButton size 体系に
              完全一致しないため（text-sm sm:text-base）、ここは Link のまま残し、
              次の PR で「subtle」size を追加するときに揃える。 */}
          <Link
            href={startHref}
            className="inline-flex justify-center items-center bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 font-semibold text-sm sm:text-base px-6 py-3 rounded-xl transition-colors"
          >
            PASSAIを始める
          </Link>
        </div>
      </div>
    </section>
  );
}
