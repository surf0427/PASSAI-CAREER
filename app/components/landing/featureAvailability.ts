/**
 * PASSAI CAREER — LP に載せる機能の **提供可否**（pure / 判定と catalog だけ）。
 *
 * STEP-CAREER-LANDING-AVAILABILITY。
 *
 * ── なぜ必要か ────────────────────────────────────────────────────────
 *   GD / 企業マッチングは server flag（CAREER_GD_ENABLED /
 *   CAREER_COMPANY_MATCHING_ENABLED）で提供可否が切り替わり、既定は OFF。
 *   OFF のとき Home のカードは消え、page は 404、API も 404 になる。
 *   /career/pricing は既に server flag から提供機能を導出しているのに、LP だけが
 *   GD を無条件に「主要機能」として紹介していたため、
 *     LP では使えると書いてある → 契約しても Home に出ない / URL は 404
 *   という矛盾が残っていた。LP も同じ product truth に従わせる。
 *
 * ── 権威 ──────────────────────────────────────────────────────────────
 *   提供可否の正本は **server flag**（lib/careerGdGate/flags.server.ts /
 *   lib/careerMatchingGate/flags.server.ts）。Pricing と同じ関数を同じ意味で使う。
 *   `NEXT_PUBLIC_*`（UI flag）は商品表示の権威にしない — API の実行権限は
 *   server flag が単独で持つため、UI flag を根拠にすると表示と挙動が割れる。
 *
 * ── 境界 ──────────────────────────────────────────────────────────────
 *   - 本 module は **pure**（server-only を持たない・env を読まない）。
 *     flag の解決は app/page.tsx が 1 回だけ行い、結果をここへ渡す。
 *   - Pricing の表示モデル（label / quota / gate）とは別物。LP はカード表現
 *     （icon / tags / catchphrase）を持つので、無理に共有せず catalog を分ける。
 *     **共有しているのは「どの機能が提供されているか」という判定の入力**であり、
 *     そこが同じ server flag である限り LP と Pricing は一致する。
 *   - flag OFF の機能に「準備中」「近日公開」等は付けない。OFF が「未公開」なのか
 *     「一時停止」なのかコードからは確定できないため、**単に載せない**。
 */

/** LP の表示可否に効く feature flag の解決結果。 */
export type CareerLandingAvailability = {
  gd: boolean;
  matching: boolean;
};

/** flag で提供可否が変わる機能の gate 種別。null は常時提供。 */
export type CareerLandingGate = 'gd' | 'matching' | null;

/** その gate を持つ項目を今表示してよいか（純関数）。 */
export function isLandingFeatureVisible(
  gate: CareerLandingGate,
  availability: CareerLandingAvailability,
): boolean {
  if (gate === null) return true;
  return gate === 'gd' ? availability.gd : availability.matching;
}

/** 「就活準備の流れ」カード 1 枚ぶんの表示データ。 */
export type CareerLandingFlowStep = {
  icon: string;
  title: string;
  desc: string;
  tags: readonly string[];
  catchphrase: string;
  gate: CareerLandingGate;
};

/**
 * 流れカードの catalog（**提供しうる全集合**）。
 *
 * ★ 掲載順は app/career/home/page.tsx の RECOMMENDED_STEPS と同じ思想（就活準備の順）。
 * ★ 企業マッチングは元から LP に載せていない（既定 OFF のため）。将来 ON で載せる
 *   ことになった場合はここへ `gate: 'matching'` の entry を足すだけでよい。
 * ★ 番号（01, 02 …）は **絞り込んだ後の順序**で採番する（欠番を作らない）。
 *   採番は描画側が index から導出するので、ここには持たない。
 */
export const CAREER_LANDING_FLOW_STEPS: readonly CareerLandingFlowStep[] = [
  {
    icon: '🗂️',
    title: '活動整理',
    desc: 'サークル・アルバイト・インターン・資格などの経験を、質問に答えるだけで整理。ESや面接で使える形にまとまります。',
    tags: ['#経験整理', '#AIヒント', '#ESにつながる'],
    catchphrase: '「経験を、話せる材料に変える。」',
    gate: null,
  },
  {
    icon: '🔍',
    title: '自己分析',
    desc: '「なぜその行動をしたのか」をAIが深掘り。自分でも気づかなかった強みや価値観を言葉にできます。',
    tags: ['#AI深掘り', '#強み分析', '#価値観の言語化'],
    catchphrase: '「自分の強みを、言葉にする。」',
    gate: null,
  },
  {
    icon: '🧭',
    title: '就活軸整理',
    desc: '重視する条件・避けたい条件・興味のある業界や職種・働き方・社風を、チェック形式で整理して就活の軸を言語化します。',
    tags: ['#チェック形式', '#業界職種', '#働き方'],
    catchphrase: '「選ぶ基準を、自分で決める。」',
    gate: null,
  },
  {
    icon: '🏢',
    title: '企業研究',
    desc: '自分で調べた企業研究メモをAIが添削。不足している視点や思い込みを指摘し、あなたの情報とのすり合わせまで行います。',
    tags: ['#メモ添削', '#不足の指摘', '#自分との接続'],
    catchphrase: '「調べた内容を、使える理解に。」',
    gate: null,
  },
  {
    icon: '✍️',
    title: 'ES作成',
    desc: 'ガクチカ・自己PR・志望動機などを、AIの深掘り質問と添削で仕上げます。AIが代筆するのではなく、自分で書く力を鍛える設計です。',
    tags: ['#深掘り質問', '#材料整理', '#AI添削', '#改善支援'],
    catchphrase: '「自分の言葉で、書き切る。」',
    gate: null,
  },
  {
    icon: '🤖',
    title: '面接練習',
    desc: '面接官AIと、質問→回答→深掘りのターン形式で音声練習。自己分析・企業理解・本番・圧迫の4モードから選べます。',
    tags: ['#音声回答', '#4モード', '#AIフィードバック', '#履歴が残る'],
    catchphrase: '「面接経験を、AIで積み重ねる。」',
    gate: null,
  },
  {
    icon: '👥',
    title: 'GD練習',
    // ★ 「ログインすれば公開部屋や友達との実施もできます」という旧文言は、ソロ GD が
    //   ログインなしで使えた頃の名残。現在は GD も含め AI 機能はログイン + 契約が必須。
    desc: 'AI参加者とグループディスカッションを実施し、論理性・協調性・議論推進力などを選考目線で評価。公開部屋や友達との実施も選べます。',
    tags: ['#ソロ練習', '#AI参加者', '#選考目線の評価', '#公開部屋'],
    catchphrase: '「議論の場数を、いつでも踏む。」',
    gate: 'gd',
  },
  {
    icon: '🎤',
    title: 'プレゼン対策',
    desc: '自己PR・ガクチカ・志望動機・ケース課題などの発表を、構成・説得力・具体性・時間配分の観点でAIが評価。発表後の質疑応答まで練習できます。',
    tags: ['#お題設定', '#AI評価', '#発表後Q&A', '#時間配分'],
    catchphrase: '「話す力を、可視化して伸ばす。」',
    gate: null,
  },
];

/** 今 LP に載せてよい流れカードだけを返す（表示順は catalog のまま）。 */
export function selectAvailableLandingFlowSteps(
  availability: CareerLandingAvailability,
): readonly CareerLandingFlowStep[] {
  return CAREER_LANDING_FLOW_STEPS.filter((s) => isLandingFeatureVisible(s.gate, availability));
}

/**
 * FAQ「何ができますか？」用の機能名リスト。
 *
 * ★ カードと同じ catalog から作るので、「カードには無いのに FAQ には書いてある」
 *   というズレが構造的に起きない（件数も同じ配列長から導く）。
 */
export function selectAvailableLandingFeatureNames(
  availability: CareerLandingAvailability,
): readonly string[] {
  return selectAvailableLandingFlowSteps(availability).map((s) => s.title);
}
