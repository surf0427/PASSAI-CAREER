// 番号付きカードで「就活準備の流れ」を提示。
// スマホ：1列／タブレット：2列／PC：3列のグリッド。
// 番号バッジ自体が「流れ」の可読性を担保するため、矢印類は省略。
//
// カード構成は「アイコン → 機能名 → 1〜2行の説明 → 特徴(最大5) → キャッチコピー」で統一。
// flex-col + 説明 flex-1 の構造で、グリッド内の同じ行のカードどうしで
// 「特徴・キャッチコピーの位置」が揃う。
//
// 掲載しているのは /career 配下に実ページがあり、かつ **今この環境で提供されている**機能だけ。
// カードの実データは app/components/landing/featureAvailability.ts の catalog が持ち、
// 提供可否（GD / 企業マッチング）は app/page.tsx が server flag から解決して渡す。
// ★ 番号（01, 02 …）は **絞り込んだ後の並び**で採番するので、OFF の機能があっても欠番にならない。
// ★ JSX でカードを二重に持たない（catalog を filter して map するだけ）。
//
// 流れのステップとは別に、それらを横断して支える機能（就活相談AI / マイページ / 企業登録）を
// 「流れ全体を支える機能」として番号なしの別ブロックで提示する。
// num を省略すると番号バッジが消える以外は、流れカードと同一デザインを共有する。

import {
  selectAvailableLandingFlowSteps,
  type CareerLandingAvailability,
} from './featureAvailability';

type StepCardProps = {
  num?: string;
  icon: string;
  title: string;
  desc: string;
  tags: readonly string[];
  catchphrase: string;
};

function StepCard({ num, icon, title, desc, tags, catchphrase }: StepCardProps) {
  return (
    <li className="list-none flex flex-col bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm p-6 sm:p-7">
      <div className="flex items-center gap-2.5 mb-3">
        {num && (
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-xl bg-brand-50 text-brand-700 text-sm font-extrabold tracking-tight shrink-0">
            {num}
          </span>
        )}
        <span className="text-2xl leading-none shrink-0" aria-hidden="true">
          {icon}
        </span>
        <p className="text-base sm:text-lg font-bold text-slate-900">{title}</p>
      </div>
      <p className="text-sm text-slate-600 leading-relaxed mb-4 flex-1">{desc}</p>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center bg-brand-50 text-brand-700 ring-1 ring-brand-100 rounded-full px-2.5 py-1 text-xs font-semibold"
          >
            {tag}
          </span>
        ))}
      </div>
      <p className="mt-4 pt-4 border-t border-slate-100 text-sm font-semibold text-brand-700">
        {catchphrase}
      </p>
    </li>
  );
}

export function FeatureFlowSection({
  availability,
}: {
  availability: CareerLandingAvailability;
}) {
  // 提供中のステップだけを、catalog の順序のまま取り出す。
  const steps = selectAvailableLandingFlowSteps(availability);

  return (
    <section id="features" className="bg-white">
      <div className="mx-auto max-w-5xl px-6 sm:px-8 py-14 sm:py-20">
        <div className="text-center mb-10 sm:mb-12">
          <h2 className="text-xl sm:text-3xl font-extrabold tracking-tight leading-snug mb-3">
            PASSAI CAREERは、就活準備が
            <br className="sm:hidden" />
            1つの流れでつながる
          </h2>
          <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
            活動整理から自己分析、就活軸、企業研究、ES、面接・プレゼン練習まで。
            <br className="hidden sm:inline" />
            バラバラに対策するのではなく、入力した内容を次の対策に活かしながら進められます。
            <br className="hidden sm:inline" />
            さらに、就活相談AIとマイページが相談と振り返りで全体を支えます。
          </p>
        </div>

        <ol className="grid gap-5 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((step, i) => (
            <StepCard
              key={step.title}
              num={String(i + 1).padStart(2, '0')}
              icon={step.icon}
              title={step.title}
              desc={step.desc}
              tags={step.tags}
              catchphrase={step.catchphrase}
            />
          ))}
        </ol>

        {/* 流れ全体を支える機能：順序フローには属さない横断機能。
            番号バッジを外し、見出しで「下支え」だと一目で分かるようにする。 */}
        <div className="mt-12 sm:mt-16">
          <div className="text-center mb-6 sm:mb-8">
            <h3 className="text-lg sm:text-2xl font-extrabold tracking-tight leading-snug mb-2">
              流れ全体を支える機能
            </h3>
            <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
              どのステップの途中でも、いつでも相談でき、これまでの取り組みを振り返れます。
            </p>
          </div>

          <ul className="grid gap-5 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <StepCard
              icon="💬"
              title="就活相談AI"
              desc="今の進め方や次にやることの迷いを相談できます。これまでの活動整理・自己分析・ESなどの内容をふまえて答えます。"
              tags={['#いつでも相談', '#あなたの情報をふまえる', '#次アクション']}
              catchphrase="「迷ったときの、相談相手。」"
            />
            <StepCard
              icon="📊"
              title="マイページ"
              desc="自己分析・ES・面接・プレゼンなどの進捗と履歴を、ひとつの場所でまとめて確認できます。"
              tags={['#一元管理', '#進捗確認', '#振り返り']}
              catchphrase="「準備の積み上げを、見える化する。」"
            />
            <StepCard
              icon="📁"
              title="企業の登録"
              desc="一度登録した企業は、ES・面接練習・プレゼン対策・企業研究から選ぶだけで使えます。登録せずに企業名を直接入力して進めることもできます。"
              tags={['#入力の使い回し', '#選ぶだけ', '#任意登録']}
              catchphrase="「企業ごとの準備を、まとめて持つ。」"
            />
          </ul>
        </div>
      </div>
    </section>
  );
}
