// PASSAI 就活版 — 就活相談AI（司令塔）の「初回相談テーマ」をデータ状態に応じて出し分ける層。
//
// 役割: ユーザーが入力済みの各機能データ（有無フラグ）から、今の状況に合った相談スターターを組む。
//   - 追加 API 呼び出し・DB・localStorage には触れない純粋関数（フラグを受け取るだけ）。
//   - AI プロンプト（トークン）には一切影響しない。UI 上の相談例チップの文言生成のみ。
//   - データが乏しい場合は fallback の固定スターターに落とす。

// 各機能データの有無（相談ページが localStorage から算出して渡す）。
export type ConsultationDataFlags = {
  hasProfile: boolean;
  hasActivity: boolean;
  hasValues: boolean;
  hasSelfAnalysis: boolean;
  hasMatching: boolean;
  hasEs: boolean;
  hasInterview: boolean;
  hasGd: boolean;
  hasPresentation: boolean;
  hasCompanyResearch: boolean;
};

// データがほぼ無いユーザー向けの固定スターター（fallback）。
export const DEFAULT_CONSULTATION_STARTERS: string[] = [
  '就活、何から始めればいいですか？',
  'ガクチカに自信がありません。相談したいです。',
  '自己PRの方向性を一緒に整理してください。',
  'ESの志望動機がうまく書けません。',
  '面接が不安です。何を準備すべきですか？',
  '業界・職種の選び方がわかりません。',
  '就活スケジュールを整理したいです。',
];

// ホームの深リンク（?starter=xxx）→ 入力欄へプリフィルする文言のマッピング。
export const CONSULTATION_STARTER_QUERY: Record<string, string> = {
  priority: 'まず就活の現在地を整理して、何から始めるか優先順位を決めたい',
  axis: '就活軸と志望業界・志望企業がズレていないか見てほしい',
  matching: 'マッチング結果をもとに、受ける企業の優先順位を決めたい',
};

const MIN_STARTERS = 4;
const MAX_STARTERS = 7;

// データ状態フラグ → 相談スターター（4〜7件・重要度順・重複除去・fallback 充填）。
export function buildConsultationStarters(flags: ConsultationDataFlags): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };

  const dataCount = Object.values(flags).filter(Boolean).length;

  // 完全にデータが無い（profile も無い）初心者は fallback の固定スターターへ。
  if (dataCount === 0) {
    return DEFAULT_CONSULTATION_STARTERS.slice(0, MAX_STARTERS);
  }

  // A. profile が未入力/薄い → 現在地・優先順位から（最優先で上に出す）。
  if (!flags.hasProfile) {
    push('まず就活の現在地を整理したい');
    push('何から始めればいいか、優先順位を決めたい');
  }

  // 高価値コンボ（複数データがある時ほど具体的な相談を上位に）。
  if (flags.hasMatching && flags.hasValues) {
    push('相性が良い企業と自分の就活軸が本当に合っているか確認したい');
  }
  if (flags.hasEs && flags.hasInterview) {
    push('ESの内容を面接で深掘りされた時の答え方を整理したい');
  }
  if (flags.hasGd && flags.hasInterview) {
    push('GDと面接の結果から、話し方・構造化・対人選考の改善点を整理したい');
  }
  if (flags.hasCompanyResearch && flags.hasEs) {
    push('企業研究メモとESから、志望動機の一貫性を確認したい');
  }

  // 単体データ別（下流＝選考直結のものを上に、上流＝準備系を下に）。
  if (flags.hasMatching) push('マッチング結果をもとに、受ける企業の優先順位を決めたい');
  if (flags.hasInterview) push('面接結果から、次に直すべき課題を整理したい');
  if (flags.hasGd) push('GD結果から、自分の役割や改善点を整理したい');
  if (flags.hasPresentation) push('プレゼン結果から、構成と説得力の改善点を整理したい');
  if (flags.hasEs) push('ガクチカ・自己PR・志望動機の一貫性を整理したい');
  if (flags.hasCompanyResearch) push('企業研究メモをもとに、志望動機の方向性を整理したい');
  if (flags.hasSelfAnalysis) push('自己分析結果をもとに、向いている業界・職種を整理したい');
  if (flags.hasValues) push('就活軸と志望業界がズレていないか見てほしい');
  if (flags.hasActivity) push('活動整理の内容から、ガクチカに使える強みを整理したい');

  // 個別スターターが1件も付かなかった（フラグはあるが未カバー）場合の保険。
  if (out.length === 0) {
    return DEFAULT_CONSULTATION_STARTERS.slice(0, MAX_STARTERS);
  }

  // 最低件数に満たなければ fallback で充填する。
  for (const s of DEFAULT_CONSULTATION_STARTERS) {
    if (out.length >= MIN_STARTERS) break;
    push(s);
  }

  return out.slice(0, MAX_STARTERS);
}
