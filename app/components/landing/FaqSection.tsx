// FAQ は <details>/<summary> をそのまま使う。JS なしで開閉が動き、
// Tailwind の group-open:rotate-180 だけでシェブロンを反転させる。
// 質問文・回答文は LP からのコピー編集が見やすいよう配列で集中管理。
//
// 回答は必ず実装に一致させること（推測で書かない）。根拠:
//   - 機能一覧            … app/career/home/page.tsx の FEATURES
//   - 開始導線            … /career/profile（基本情報入力・ログイン不要）→ /career/home
//   - ログイン必須の範囲  … GD の公開部屋 / 友達とプレイ（app/career/gd/page.tsx）
//   - 横断コンテキスト    … lib/careerMemory/selector.ts（各機能の入力を他機能の生成に渡す）
//   - ES の設計思想       … app/career/es/page.tsx（AI は代筆せず添削・深掘りを担当）
//   - 保存先              … 各機能の *Storage.ts（localStorage canonical）
//   - 課金                … /career 配下は PlanGate の保護対象外・career 側に決済導線なし

const FAQ_ITEMS: { q: string; a: string }[] = [
  {
    q: 'PASSAI CAREERでは何ができますか？',
    a: '新卒就活の準備を、次の8つの機能で進められます。\n活動整理／自己分析／就活軸整理／企業研究／ES作成／面接練習／GD練習／プレゼン対策。\nあわせて、進め方を相談できる「就活相談AI」と、進捗と履歴を確認できる「マイページ」が使えます。',
  },
  {
    q: 'どんな就活生向けですか？',
    a: '新卒就活の準備をこれから進める大学生・大学院生向けです。\n「何から始めればいいか分からない」「自己分析のやり方が分からない」という状態からスタートする前提で作られています。',
  },
  {
    q: '自己分析だけでも利用できますか？',
    a: 'はい、使いたい機能だけでも利用できます。\nおすすめの進め方（活動整理 → 就活軸整理 → 自己分析 → 企業研究 → ES → 面接 → プレゼン → GD）は表示されますが、この順番どおりに進める必要はありません。',
  },
  {
    q: 'ESや面接対策にも使えますか？',
    a: 'はい。ES作成ではガクチカ・自己PR・志望動機などを深掘り質問と添削で仕上げられます。\n面接練習では面接官AIと、質問→回答→深掘りのターン形式で音声練習ができ、自己分析／企業理解／本番／圧迫の4モードから選べます。\nこのほかGD練習・プレゼン対策も利用できます。',
  },
  {
    q: '保存した情報は他の機能でも使われますか？',
    a: 'はい。活動整理・自己分析・就活軸整理などで入力した内容は、ES・面接練習・プレゼン対策・就活相談AIの回答にも反映されます。\nそのため、機能を移るたびに自分のことをいちから説明し直す必要がありません。',
  },
  {
    q: 'AIが全部書いてくれるのですか？',
    a: 'いいえ、書くのはあなたです。\nESでは、AIが代わりに文章を書くのではなく、深掘り質問・材料整理・添削・改善支援を担当します。\nそのため、面接で聞かれても答えられる「自分の言葉」で仕上げられます。',
  },
  {
    q: 'AIの回答をそのまま企業へ提出してよいですか？',
    a: '提出前に、必ずご自身で内容を確認・修正してください。\nAIの出力には事実の誤りや不正確な表現が含まれることがあります。とくに企業に関する記述は、企業の公式サイトや採用ページなど一次情報でご確認ください。\n企業研究機能も、AIが企業情報を作るのではなく、あなたが調べたメモを添削する設計です。',
  },
  {
    q: 'ログインは必要ですか？',
    a: '基本情報の入力から、ログインなしで始められます。\nメールアドレスによるログインが必要なのは、GD練習の「公開GD部屋」「友達とプレイ」など、他のユーザーと一緒に行う機能です。',
  },
  {
    q: '利用料金はいくらですか？',
    a: '現時点のPASSAI CAREERには、有料プランや決済のご案内はありません。各機能はそのままご利用いただけます。\n料金プランを導入する場合は、事前にサイト上でご案内します。',
  },
  {
    q: 'スマートフォンでも使えますか？',
    a: 'はい、スマートフォンのブラウザでもご利用いただけます。\nただし面接練習・プレゼン対策は音声で回答するため、ブラウザのマイク利用を許可する必要があります。プレゼン対策は、音声認識がうまく動かない場合に発表内容をテキストで貼り付けて進めることもできます。',
  },
  {
    q: '入力した内容はどこに保存されますか？',
    a: '入力内容や結果は、お使いのブラウザ内に保存されます。\nそのため、別の端末やブラウザに切り替えると、これまでの内容は引き継がれません。ブラウザのデータを削除すると保存内容も消えるためご注意ください。',
  },
];

function FAQItem({ q, a }: { q: string; a: string }) {
  return (
    <details className="group bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm overflow-hidden">
      <summary className="list-none flex items-start gap-3 cursor-pointer p-5 sm:p-6 [&::-webkit-details-marker]:hidden">
        <span className="flex-1 font-bold text-slate-900 text-sm sm:text-base leading-relaxed">
          {q}
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded-full bg-brand-50 text-brand-600 transition-transform duration-200 group-open:rotate-180"
        >
          <svg
            viewBox="0 0 20 20"
            className="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 8l5 5 5-5" />
          </svg>
        </span>
      </summary>
      <div className="px-5 sm:px-6 pb-5 sm:pb-6 pt-4 sm:pt-5 border-t border-slate-100">
        <p className="text-sm sm:text-base text-slate-700 leading-relaxed whitespace-pre-line">
          {a}
        </p>
      </div>
    </details>
  );
}

export function FaqSection() {
  return (
    <section id="faq" className="bg-slate-50 border-y border-slate-200">
      <div className="mx-auto max-w-3xl px-6 sm:px-8 py-14 sm:py-20">
        <div className="text-center mb-10 sm:mb-12">
          <h2 className="text-xl sm:text-3xl font-extrabold tracking-tight mb-3">
            よくある質問
          </h2>
          <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
            使う前に気になる点をまとめました。
          </p>
        </div>

        <div className="space-y-3 sm:space-y-4">
          {FAQ_ITEMS.map((item) => (
            <FAQItem key={item.q} q={item.q} a={item.a} />
          ))}
        </div>
      </div>
    </section>
  );
}
