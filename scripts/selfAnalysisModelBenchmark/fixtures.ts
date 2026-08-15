/*
 * Self-Analysis latency audit — representative evaluation fixtures.
 *
 * Synthetic personas only. No real user data.
 * Shapes follow the real localStorage canonical types
 * (@/types/basicInfo, @/types/careerActivity, @/types/careerValues)
 * so the built prompt matches what a real request produces.
 */

import type { SelfAnalysisSummaryInput } from '@/lib/careerSelfAnalysis/summaryPrompt';
import type { CareerActivityInput, CareerValuesInput, CareerProfileInput } from '@/lib/careerAi';

type Case = { id: string; label: string; input: SelfAnalysisSummaryInput };

const period = (from: string, to: string) => ({ from, to });

const emptySelections = () => ({
  priorities: [] as string[],
  avoidances: [] as string[],
  industries: [] as string[],
  jobTypes: [] as string[],
  workStyles: [] as string[],
  companyTypes: [] as string[],
  careerGoals: [] as string[],
  culturePreferences: [] as string[],
});
const emptyNotes = () => ({
  priorities: '', avoidances: '', industries: '', jobTypes: '',
  workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '',
});

// ── LIGHT: sparse user — 1 part-time job only, no dialogue, no values ──
const LIGHT_PROFILE = {
  name: '', grade: '3年', track: '文系',
  preferences: [{ university: '国立A大学', faculty: '経済学部' }],
  examTypes: [],
  graduationYear: '2027',
} as unknown as CareerProfileInput;

const LIGHT_ACTIVITY = {
  partTimeJobs: [
    {
      id: 'p1', workplace: '個人経営カフェ', jobContent: 'ホール接客・レジ',
      period: period('2024年4月', '現在'), role: 'スタッフ', scale: '店舗スタッフ8名',
      ingenuity: 'ピーク時間に注文が滞留していたので、席番号とドリンク種別を先に伝える口頭フォーマットを決めた。',
      quantitativeResult: 'ピーク時の提供待ち時間が体感で半分程度に短縮',
      learning: '段取りを先に共有すると全体が速くなること',
    },
  ],
} as unknown as CareerActivityInput;

const LIGHT: SelfAnalysisSummaryInput = {
  profile: LIGHT_PROFILE,
  activity: LIGHT_ACTIVITY,
  values: null,
  userInput: '',
  conversation: [],
  pastSummaries: [],
};

// ── NORMAL: typical user — 3 experiences + values + 6-turn dialogue ──
const NORMAL_PROFILE = {
  name: '', grade: '3年', track: '文系',
  preferences: [{ university: '私立B大学', faculty: '商学部' }],
  examTypes: [],
  graduationYear: '2027',
} as unknown as CareerProfileInput;

const NORMAL_ACTIVITY = {
  personality: {
    mbti: 'ENFJ',
    selfView: '人の間に入って調整するのが苦にならない',
    othersView: '落ち着いている、聞き役',
    strengths: '相手の前提を確認してから話を進められる',
    weaknesses: '自分の意見を通しきる前に譲ってしまう',
    values: '納得して動ける状態をつくること',
    motivationUp: '自分の裁量で試せるとき',
    motivationDown: '理由の説明がないまま作業だけ降ってくるとき',
  },
  clubActivities: [
    {
      id: 'c1', organizationName: 'テニスサークル', activityContent: '週2回の練習運営',
      period: period('2023年4月', '現在'), role: '副代表', scale: '部員60名',
      ingenuity:
        '参加率が4割まで落ちていたため、練習メニューを級別に3分割し、初心者が来やすい枠を新設した。上級者からの反対には、上級者専用枠を週1で確保する条件で合意を取った。',
      quantitativeResult: '半年で参加率が40%→70%に回復',
      learning: '来ない人の問題ではなく場の設計の問題だと捉え直すこと',
    },
  ],
  internships: [
    {
      id: 'i1', companyName: 'Web広告代理店', jobContent: '広告運用アシスタント',
      period: period('2024年4月', '2025年3月'), role: 'インターン', scale: 'チーム5名',
      ingenuity: 'レポート作成が属人化していたのでスプレッドシートのテンプレを作成した。',
      quantitativeResult: 'チーム全体の作業時間を週6時間削減',
      learning: '数字を見るのは好きだが、提案の場で意見を通しきれない課題が見えた',
    },
  ],
  partTimeJobs: [
    {
      id: 'p1', workplace: '個別指導塾', jobContent: '中高生への学習指導',
      period: period('2023年5月', '現在'), role: '講師', scale: '担当生徒12名',
      ingenuity: '生徒ごとに理解の詰まり方が違うので、単元ごとの確認テストを自作して弱点を特定してから教える形に変えた。',
      quantitativeResult: '担当生徒の定期テスト平均が約15点上昇',
      learning: '相手の状態を測ってから手を打つと再現性が出る',
    },
  ],
} as unknown as CareerActivityInput;

const NORMAL_VALUES = {
  selections: {
    ...emptySelections(),
    priorities: ['裁量の大きさ', '成長環境', 'チームワーク'],
    avoidances: ['細かく管理される', '成果が見えにくい'],
    industries: ['IT・通信', '人材'],
    jobTypes: ['営業', '企画・マーケティング'],
    workStyles: ['裁量労働', 'リモート可'],
  },
  notes: { ...emptyNotes(), priorities: '早い段階で任せてもらえる環境が良い。' },
  overallNote: '営業とマーケのどちらが向いているか決めきれていない。',
} as unknown as CareerValuesInput;

const NORMAL: SelfAnalysisSummaryInput = {
  profile: NORMAL_PROFILE,
  activity: NORMAL_ACTIVITY,
  values: NORMAL_VALUES,
  userInput: '営業とマーケどちらが向いているか知りたいです。',
  conversation: [
    { role: 'question', content: 'サークルで参加率を上げようと思ったきっかけは何ですか？' },
    {
      role: 'answer',
      content:
        '同期が「行っても自分のレベルだと打つ機会がない」と言っていて、来ない人が悪いんじゃなくて場の設計が悪いんだと気づいたからです。',
    },
    { role: 'question', content: '級別に分けるとき、反対はありませんでしたか？' },
    {
      role: 'answer',
      content:
        '上級者から「レベルが下がる」と反対されました。上級者専用の枠を週1で確保する条件で合意を取りました。',
    },
    { role: 'question', content: 'インターンで一番苦労したことは？' },
    {
      role: 'answer',
      content:
        '数字を見るのは好きだけど、改善案を提案する場で自分の意見を通しきれず、結局先輩の案に流れることが多かったです。',
    },
  ],
  pastSummaries: [],
};

// ── HEAVY: rich history — 6 experiences, 12-turn dialogue, 3 past summaries ──
const HEAVY_PROFILE = {
  name: '', grade: '3年', track: '理系',
  preferences: [{ university: '国立C大学', faculty: '工学部', department: '情報工学科' }],
  examTypes: [],
  graduationYear: '2027',
} as unknown as CareerProfileInput;

const HEAVY_ACTIVITY = {
  personality: {
    mbti: 'INTJ',
    selfView: '仕組みで解決したくなる',
    othersView: '理屈っぽい、頼れる',
    strengths: '課題を構造化して原因を切り分けられる',
    weaknesses: '技術的な正しさで押し切ろうとしてしまう',
    values: '再現性のある形で人の役に立つこと',
    motivationUp: '裁量を持って設計から関われるとき',
    motivationDown: '決まらない議論が長引くとき',
  },
  academics: {
    focusedEffort: '',
    seminar: '自然言語処理研究室。日本語テキストの意味類似度推定がテーマ。',
    thesis: '対話ログからの意図分類に関する研究',
    memorableClass: 'アルゴリズムとデータ構造',
    gpa: '3.4',
    academicAwards: '学内発表会 優秀賞',
  },
  focusedActivities: [
    {
      id: 'f1', title: '学生団体の運営改善', category: '学生団体',
      period: period('2024年4月', '現在'), role: '代表', scale: 'メンバー40名',
      ingenuity:
        '講師の定着率が低く半年で3割が辞めていた。辞めた人へのヒアリングでフィードバック不在が原因と特定し、初回2回の先輩同席と終了後15分の振り返り（良かった点2つ・次に試すこと1つ）を制度化した。',
      quantitativeResult: '講師定着率 70%→80%超に改善',
      learning: '熱意の差ではなく仕組みの欠落を疑うこと',
    },
  ],
  internships: [
    {
      id: 'i1', companyName: 'BtoB SaaS スタートアップ', jobContent: 'API開発・DB設計',
      period: period('2024年10月', '現在'), role: 'バックエンドエンジニア', scale: '開発6名',
      ingenuity: '障害対応が特定の人に偏っていたので当番制を提案・導入した。設計レビューで先輩と衝突することもあった。',
      quantitativeResult: '一次対応の平均着手時間を短縮',
      learning: '運用コストを誰が持つかの観点が自分に抜けていた',
    },
  ],
  projects: [
    {
      id: 'pr1', name: 'ハッカソン参加（3回）', content: '短期開発でのプロトタイプ制作',
      period: period('2023年8月', '2025年3月'), role: 'バックエンド担当', scale: 'チーム4名',
      ingenuity: '初日の1時間で役割分担とスコープを固定してから着手する進め方を定着させた。',
      quantitativeResult: '3回中1回で企業賞を受賞',
      learning: '短期間で形にするにはスコープ固定が効く',
    },
  ],
  partTimeJobs: [
    {
      id: 'p1', workplace: '飲食店', jobContent: 'ホール接客',
      period: period('2022年5月', '2023年4月'), role: 'スタッフ', scale: '店舗10名',
      ingenuity: 'クレーム対応で、まず事実確認を先に行う手順を自分の中で固定した。',
      quantitativeResult: '',
      learning: '感情と事実を分けて扱うこと',
    },
  ],
  certifications: [
    { id: 'ce1', name: '基本情報技術者', score: '合格', acquiredDate: '2024年10月' },
    { id: 'ce2', name: 'TOEIC', score: '820点', acquiredDate: '2025年6月' },
  ],
  itSkills: [
    { id: 's1', name: 'Python', level: '上級' },
    { id: 's2', name: 'TypeScript', level: '中級' },
    { id: 's3', name: 'PostgreSQL', level: '中級' },
  ],
  languages: [{ id: 'l1', language: '英語', level: 'B2' }],
} as unknown as CareerActivityInput;

const HEAVY_VALUES = {
  selections: {
    ...emptySelections(),
    priorities: ['技術的挑戦', '成長環境', '一緒に働く人', '裁量の大きさ'],
    avoidances: ['意思決定が遅い', '数字だけを追う文化', '学びが止まる環境'],
    industries: ['IT・通信', 'Webサービス', 'コンサルティング'],
    jobTypes: ['エンジニア', 'プロダクトマネージャー', 'コンサルタント'],
    workStyles: ['リモート可', 'フレックス'],
    companyTypes: ['ベンチャー', 'メガベンチャー'],
    careerGoals: ['専門性を深めたい', '事業をつくりたい'],
    culturePreferences: ['議論しやすい', 'フィードバック文化'],
  },
  notes: {
    ...emptyNotes(),
    careerGoals: '専門性を深めるか、広く見る方向に行くか決めきれていない。',
    culturePreferences: 'レビューでちゃんと指摘し合える環境が良い。',
  },
  overallNote:
    '技術は好きだが、学生団体で仕組みを変えたときの手応えも大きかった。技術が分からないまま仕組みだけ語る人にはなりたくない。',
} as unknown as CareerValuesInput;

const HEAVY: SelfAnalysisSummaryInput = {
  profile: HEAVY_PROFILE,
  activity: HEAVY_ACTIVITY,
  values: HEAVY_VALUES,
  userInput:
    'エンジニアとしての専門性を深めるか、PdM的に広く見る方向に行くか迷っています。両方の適性を見てほしいです。',
  conversation: [
    { role: 'question', content: '研究室で前処理の自動化を整備したのはなぜですか？' },
    {
      role: 'answer',
      content:
        '自分の実験を回すたびに同じ前処理を手でやっていて、他の人も同じことをしているのを見て、一度作れば全員分の時間が浮くと思ったからです。',
    },
    { role: 'question', content: '学生団体で講師の定着率が低かった原因は何だと考えましたか？' },
    {
      role: 'answer',
      content:
        '最初は「熱意の差」だと思っていましたが、辞めた人に聞くと「自分の授業が良かったのか分からない」という声が多く、フィードバックが無いことが原因だと分かりました。',
    },
    { role: 'question', content: '研修と振り返り会は具体的にどう設計しましたか？' },
    {
      role: 'answer',
      content:
        '初回2回は先輩が同席して、終了後15分だけ「良かった点2つ・次に試すこと1つ」を必ず言語化する形にしました。長いと続かないので15分に固定したのがポイントです。',
    },
    { role: 'question', content: 'インターンで先輩と衝突したときはどう対処しましたか？' },
    {
      role: 'answer',
      content:
        '自分の設計案の方が拡張性が高いと思っていたので譲れなかったのですが、最終的に「運用コストを誰が持つか」の観点が抜けていると指摘されて納得しました。技術的な正しさだけで押し切ろうとする癖があると思います。',
    },
    { role: 'question', content: 'ストレスを感じるのはどんな場面ですか？' },
    {
      role: 'answer',
      content:
        '決まらない議論が長引くときです。あとは、なぜそうするのかの説明が無いまま作業だけ降ってくるとモチベーションが落ちます。',
    },
    { role: 'question', content: '専門性を深める方向と、広く見る方向、今はどちらに惹かれますか？' },
    {
      role: 'answer',
      content:
        '正直まだ分かりません。技術は好きですが、学生団体で仕組みを変えたときの手応えも大きかったです。ただ、技術が分からない状態で仕組みだけ語る人にはなりたくないです。',
    },
  ],
  pastSummaries: [
    {
      createdAt: '2026-05-02T10:00:00.000Z',
      summary: '技術志向と組織改善志向の両方を持つ。課題を仕組みで解く傾向が強い。',
      careerDirection: '技術を基盤に、開発プロセスや組織の課題を解く方向。',
      strengths: ['課題の構造化', '仕組み化による再現性の担保'],
      weaknesses: ['説明が技術寄りになりがち'],
      valueKeywords: ['裁量', '仕組み化', '成長'],
      strengthKeywords: ['構造化', '自動化'],
      recommendedIndustries: ['Webサービス', 'SIer'],
      recommendedJobs: ['バックエンドエンジニア'],
      companySelectionCriteria: ['技術的裁量', 'レビュー文化'],
      nextActions: ['非エンジニアへの説明機会を意識的に取る'],
    },
    {
      createdAt: '2026-06-14T10:00:00.000Z',
      summary: '前回より、他者を巻き込む力の言語化が進んだ。合意形成の型がある。',
      careerDirection: 'エンジニア起点でプロダクトに関わる方向を仮説として置く。',
      strengths: ['合意形成', '定着まで見る運用設計'],
      weaknesses: ['意思決定が遅い場面での忍耐'],
      valueKeywords: ['仕組み化', '専門性', 'チーム'],
      strengthKeywords: ['合意形成', '運用設計'],
      recommendedIndustries: ['Webサービス'],
      recommendedJobs: ['PdM', 'バックエンドエンジニア'],
      companySelectionCriteria: ['意思決定の速さ'],
      nextActions: ['PdM 的役割の体験を1つ作る'],
    },
    {
      createdAt: '2026-07-20T10:00:00.000Z',
      summary: '技術的正しさで押し切る癖が課題として浮上。運用・コスト観点の補強が次の論点。',
      careerDirection: '専門性と越境のバランスが未決。次回で意思決定基準を精密化する。',
      strengths: ['技術的深さ', '自動化による生産性改善'],
      weaknesses: ['運用コスト観点の抜け', '技術的正しさで押し切る'],
      valueKeywords: ['専門性', '越境', '裁量'],
      strengthKeywords: ['技術的深さ', '生産性改善'],
      recommendedIndustries: ['Webサービス', 'コンサル'],
      recommendedJobs: ['PdM', 'テックリード候補'],
      companySelectionCriteria: ['技術投資への姿勢', '越境しやすさ'],
      nextActions: ['意思決定基準を言語化する', '運用コストを見積もる練習'],
    },
  ] as never,
};

export const CASES: Case[] = [
  { id: 'light', label: 'LIGHT (1 part-time job, no dialogue, no values)', input: LIGHT },
  { id: 'normal', label: 'NORMAL (3 experiences + values, 6-turn dialogue)', input: NORMAL },
  { id: 'heavy', label: 'HEAVY (6 experiences + full values, 12-turn dialogue, 3 past summaries)', input: HEAVY },
];
