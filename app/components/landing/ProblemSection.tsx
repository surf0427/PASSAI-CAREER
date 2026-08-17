import { Card } from '@/components/ui/Card';

// 就活生が「自分のことだ」と思える共感セクション。
// 3 ブロック構成：
//   1) 悩みリスト（白カード内のチェックリスト）
//   2) このまま進めるとどうなるか（淡いオレンジの注意喚起）
//   3) 解決メッセージ（青アクセントのカード）
// ネガティブで煽りすぎず、最終的に PASSAI CAREER への自然な動機づけに着地させる。
//
// PainItem        … 共感したいときに「自分も」と思える悩み行（チェックリスト風）
// ConsequenceItem … 注意喚起ブロック内の「このまま進めると…」の各帰結行

function PainItem({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-3">
      {/* 空のチェックボックス：読者が脳内で「これ自分だ」とチェックする想定 */}
      <span
        aria-hidden="true"
        className="mt-1 w-5 h-5 rounded-md ring-1 ring-slate-300 bg-white shrink-0"
      />
      <span className="text-sm sm:text-base text-slate-800 leading-relaxed">
        {text}
      </span>
    </li>
  );
}

function ConsequenceItem({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2 leading-relaxed">
      <span aria-hidden="true" className="text-orange-600 font-bold shrink-0 mt-0.5">
        ×
      </span>
      <span>{text}</span>
    </li>
  );
}

export function ProblemSection() {
  return (
    <section id="recommend" className="bg-slate-50 border-y border-slate-200">
      <div className="mx-auto max-w-3xl px-6 sm:px-8 py-14 sm:py-20">
        <div className="text-center mb-10 sm:mb-12">
          <h2 className="text-xl sm:text-3xl font-extrabold tracking-tight leading-snug mb-3">
            こんな悩みがある人に
            <br className="sm:hidden" />
            おすすめです
          </h2>
          <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
            就活は、特別な経験がある人だけが有利になるものではありません。
            <br className="hidden sm:inline" />
            必要なのは、自分の経験を整理して、伝わる形にすることです。
          </p>
        </div>

        {/* 悩みリスト（白カード内に 8 項目） */}
        <Card padding="none" className="p-5 sm:p-7 mb-6 sm:mb-8">
          <ul className="grid gap-3 sm:grid-cols-2 sm:gap-x-6 sm:gap-y-3">
            <PainItem text="何から始めればいいか分からない" />
            <PainItem text="自己分析のやり方が分からない" />
            <PainItem text="ガクチカ・自己PRに書くことがない気がする" />
            <PainItem text="書いたESが「浅い」と言われた" />
            <PainItem text="志望動機を企業ごとに書き分けられない" />
            <PainItem text="面接で深掘りされると言葉に詰まる" />
            <PainItem text="GDやプレゼンの練習相手がいない" />
            <PainItem text="学業やアルバイトと並行して短時間で進めたい" />
          </ul>
        </Card>

        {/* このまま進めるとどうなるか（淡いオレンジの注意喚起） */}
        <div className="bg-orange-50 ring-1 ring-orange-200 rounded-2xl p-5 sm:p-7 mb-6 sm:mb-8">
          <p className="text-sm sm:text-base font-bold text-orange-900 mb-3">
            このまま進めると、
          </p>
          <ul className="space-y-2 text-sm sm:text-base text-orange-900">
            <ConsequenceItem text="中身が固まらないままESを提出してしまう" />
            <ConsequenceItem text="面接で深掘りされて答えに詰まる" />
            <ConsequenceItem text="毎回その場しのぎで、準備が積み上がらない" />
          </ul>
        </div>

        {/* 解決メッセージ（青アクセントカード） */}
        <div className="bg-white rounded-2xl ring-1 ring-brand-200 shadow-sm p-6 sm:p-8 text-center">
          <p className="text-base sm:text-xl font-extrabold leading-relaxed mb-4">
            でも、これは
            <span className="text-brand-600">センスの問題ではありません。</span>
            <br />
            やり方を知らないだけです。
          </p>
          <p className="text-sm sm:text-base text-slate-700 leading-relaxed">
            PASSAI CAREERは、質問に答えながら活動整理・自己分析・就活軸整理・企業研究・ES・面接練習まで進められるように作られています。
          </p>
        </div>
      </div>
    </section>
  );
}
