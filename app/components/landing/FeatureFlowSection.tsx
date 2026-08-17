// 番号付きカードで「就活準備の流れ」を提示。
// スマホ：1列／タブレット：2列／PC：3列のグリッド。
// 番号バッジ自体が「流れ」の可読性を担保するため、矢印類は省略。
//
// カード構成は「アイコン → 機能名 → 1〜2行の説明 → 特徴(最大5) → キャッチコピー」で統一。
// flex-col + 説明 flex-1 の構造で、グリッド内の同じ行のカードどうしで
// 「特徴・キャッチコピーの位置」が揃う。
//
// 掲載しているのは /career 配下に実ページがある機能だけ（app/career/home/page.tsx の
// FEATURES / RECOMMENDED_STEPS と一致）。企業マッチング（/career/matching）は
// NEXT_PUBLIC_CAREER_COMPANY_MATCHING_ENABLED が既定 OFF で公開対象外のため載せない。
//
// 流れのステップとは別に、それらを横断して支える機能（就活相談AI / マイページ / 企業登録）を
// 「流れ全体を支える機能」として番号なしの別ブロックで提示する。
// num を省略すると番号バッジが消える以外は、流れカードと同一デザインを共有する。

type StepCardProps = {
  num?: string;
  icon: string;
  title: string;
  desc: string;
  tags: string[];
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

export function FeatureFlowSection() {
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
            活動整理から自己分析、就活軸、企業研究、ES、面接・GD・プレゼン練習まで。
            <br className="hidden sm:inline" />
            バラバラに対策するのではなく、入力した内容を次の対策に活かしながら進められます。
            <br className="hidden sm:inline" />
            さらに、就活相談AIとマイページが相談と振り返りで全体を支えます。
          </p>
        </div>

        <ol className="grid gap-5 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <StepCard
            num="01"
            icon="🗂️"
            title="活動整理"
            desc="サークル・アルバイト・インターン・資格などの経験を、質問に答えるだけで整理。ESや面接で使える形にまとまります。"
            tags={['#経験整理', '#AIヒント', '#ESにつながる']}
            catchphrase="「経験を、話せる材料に変える。」"
          />
          <StepCard
            num="02"
            icon="🔍"
            title="自己分析"
            desc="「なぜその行動をしたのか」をAIが深掘り。自分でも気づかなかった強みや価値観を言葉にできます。"
            tags={['#AI深掘り', '#強み分析', '#価値観の言語化']}
            catchphrase="「自分の強みを、言葉にする。」"
          />
          <StepCard
            num="03"
            icon="🧭"
            title="就活軸整理"
            desc="重視する条件・避けたい条件・興味のある業界や職種・働き方・社風を、チェック形式で整理して就活の軸を言語化します。"
            tags={['#チェック形式', '#業界職種', '#働き方']}
            catchphrase="「選ぶ基準を、自分で決める。」"
          />
          <StepCard
            num="04"
            icon="🏢"
            title="企業研究"
            desc="自分で調べた企業研究メモをAIが添削。不足している視点や思い込みを指摘し、あなたの情報とのすり合わせまで行います。"
            tags={['#メモ添削', '#不足の指摘', '#自分との接続']}
            catchphrase="「調べた内容を、使える理解に。」"
          />
          <StepCard
            num="05"
            icon="✍️"
            title="ES作成"
            desc="ガクチカ・自己PR・志望動機などを、AIの深掘り質問と添削で仕上げます。AIが代筆するのではなく、自分で書く力を鍛える設計です。"
            tags={['#深掘り質問', '#材料整理', '#AI添削', '#改善支援']}
            catchphrase="「自分の言葉で、書き切る。」"
          />
          <StepCard
            num="06"
            icon="🤖"
            title="面接練習"
            desc="面接官AIと、質問→回答→深掘りのターン形式で音声練習。自己分析・企業理解・本番・圧迫の4モードから選べます。"
            tags={['#音声回答', '#4モード', '#AIフィードバック', '#履歴が残る']}
            catchphrase="「面接経験を、AIで積み重ねる。」"
          />
          <StepCard
            num="07"
            icon="👥"
            title="GD練習"
            desc="AI参加者とグループディスカッションを実施し、論理性・協調性・議論推進力などを選考目線で評価。ログインすれば公開部屋や友達との実施もできます。"
            tags={['#ソロ練習', '#AI参加者', '#選考目線の評価', '#公開部屋']}
            catchphrase="「議論の場数を、いつでも踏む。」"
          />
          <StepCard
            num="08"
            icon="🎤"
            title="プレゼン対策"
            desc="自己PR・ガクチカ・志望動機・ケース課題などの発表を、構成・説得力・具体性・時間配分の観点でAIが評価。発表後の質疑応答まで練習できます。"
            tags={['#お題設定', '#AI評価', '#発表後Q&A', '#時間配分']}
            catchphrase="「話す力を、可視化して伸ばす。」"
          />
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
              desc="自己分析・ES・面接・GD・プレゼンなどの進捗と履歴を、ひとつの場所でまとめて確認できます。"
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
