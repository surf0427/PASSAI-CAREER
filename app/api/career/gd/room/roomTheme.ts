// PASSAI 就活版 — GD Phase2 マルチGD テーマの決定的生成（server-side helper）。
//
// STEP-GD-14: host の start（waiting→active）時にテーマを確定させる。
//   - マルチは複数クライアントが同じ room を見るため「同じ room＝同じテーマ」である必要がある。
//   - AI 生成は latency / 失敗のリスクがあり、start の堅牢性を損なう。よって MVP では
//     形式ごとの少数キュレーション済みプールから roomId を seed に **決定的**に 1 つ選ぶ。
//   - 将来 AI 生成テーマに差し替える場合も、この interface（roomId, format → GdTheme）を保つ。
//
// 純粋ロジック（DOM / localStorage / Supabase / Math.random 非依存）。

import type { GdFormat, GdTheme } from '@/types/careerGd';

type ThemeSeed = { title: string; description: string; constraints?: string[] };

const THEME_POOL: Record<GdFormat, ThemeSeed[]> = {
  free: [
    {
      title: 'リモートワークと出社、これからの働き方',
      description: '新卒として入社する会社に望ましい働き方（リモート/出社/ハイブリッド）について、メリット・デメリットを踏まえてチームの結論をまとめてください。',
    },
    {
      title: '学生に一番おすすめしたい「学び直し」の方法',
      description: '社会人になる前に身につけておくと良いスキルや学びを1つ選び、その理由と身につけ方をチームで議論して提案してください。',
    },
    {
      title: '若者の「車離れ」は問題か',
      description: '若者の車離れが進んでいると言われます。これは社会にとって問題なのか、そうでないのか、立場を決めて根拠を整理してください。',
    },
  ],
  case: [
    {
      title: '売上が伸び悩むカフェチェーンの立て直し',
      description: '来店客数が減少している全国展開のカフェチェーンについて、3か月で客数を回復させる施策をチームで1つに絞って提案してください。',
      constraints: [
        '主要顧客は20〜40代の会社員',
        '価格の大幅値下げは不可（利益率を守る）',
        '新規出店・大規模投資はできない',
      ],
    },
    {
      title: '地方の観光地の来訪者を増やす',
      description: '知名度の低い地方の観光地について、来訪者数を1年で増やすための施策を検討し、優先順位をつけて提案してください。',
      constraints: [
        '大都市圏からのアクセスは車で3時間',
        '自治体の予算は限られている',
        '自然環境を大きく損なう開発は不可',
      ],
    },
    {
      title: '社員食堂の利用率を上げる',
      description: '利用率が下がっている社内食堂について、コストを大きくかけずに利用率を上げる施策をチームで1つ選び、根拠とともに提案してください。',
      constraints: [
        '従業員は約500名',
        'メニュー原価の大幅増は不可',
        '営業時間の延長は難しい',
      ],
    },
  ],
  abstract: [
    {
      title: '「良いチーム」とは何か',
      description: '仕事における「良いチーム」とはどんなチームかを、チームで定義し直してください。正解はありません。',
    },
    {
      title: '「成長」とはどういう状態か',
      description: '社会人にとっての「成長」とは何かを定義し、成長を実感できる状態を言語化してください。',
    },
    {
      title: '「信頼される人」に共通するものは何か',
      description: '職場で信頼される人に共通する要素を挙げ、最も重要だと思うものをチームで1つ選んでください。',
    },
  ],
};

// 文字列 → 32bit の決定的ハッシュ（aiMembers の seedFromString と同系。プール選択のみに使う）。
function hash32(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

// roomId + format から決定的にテーマを 1 つ選ぶ（同じ room は毎回同じテーマ）。
export function buildRoomTheme(roomId: string, format: GdFormat): GdTheme {
  const pool = THEME_POOL[format] ?? THEME_POOL.free;
  const pick = pool[hash32(`${roomId}:${format}`) % pool.length];
  return {
    title: pick.title,
    description: pick.description,
    format,
    ...(pick.constraints && pick.constraints.length > 0 ? { constraints: pick.constraints } : {}),
  };
}
