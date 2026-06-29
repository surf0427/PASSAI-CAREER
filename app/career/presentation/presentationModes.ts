// PASSAI 就活版 — プレゼン対策AI モード定義（種類別の狙い・評価重心）。
//
// 受験版プレゼン機能（志望校プレゼン入試）の「テーマ設定＋AI評価」思想を踏襲しつつ、
// 概念を新卒就活へ全面的に置き換える（大学受験・AO/推薦・志望校評価軸は持ち込まない）。
//
// ブラウザ API を使わない純粋データ／純粋関数のみ。サーバ（route / presentationPrompt）と
// クライアント（setup / session / result UI）の双方から import する。

import type { CareerPresentationType } from '@/types/careerPresentation';

export type CareerPresentationModeConfig = {
  type: CareerPresentationType;
  label: string;
  emoji: string;
  description: string;
  // この種類で「特に活きる」入力データ（UI の補足ヒント用）。
  recommendedData: string;
  // 発表テーマ入力欄のプレースホルダ例。
  themePlaceholder: string;
  // AI即興テーマ生成の狙い（presentationPrompt が使う）。
  themeFocus: string;
  // system prompt 用: この発表の狙い・評価の重心（モード固有）。
  guidance: string;
  // 評価で特に重視する観点（モード固有）。
  evaluationEmphasis: string;
};

const MODES: Record<CareerPresentationType, CareerPresentationModeConfig> = {
  self_pr: {
    type: 'self_pr',
    label: '自己PRプレゼン',
    emoji: '💪',
    description: '自分の強みを、根拠と再現性が伝わるようにプレゼンします。',
    recommendedData: '自己分析・活動整理・ES（自己PR）',
    themePlaceholder: '例: 私の強み「巻き込み力」を1分で伝える',
    themeFocus: '学生の強みと、それを裏づける具体的な経験を軸にした自己PRプレゼンのテーマ。',
    guidance: [
      '自己PRプレゼンとして、強みの主張→具体的な経験（場面・役割・行動）→成果→再現性（仕事でどう活きるか）の流れで伝わるかを見る。',
      '抽象的な強みの羅列ではなく、数字・役割・成果に裏づけられているか、採用担当に「採用したい」と思わせる説得力があるかを重視する。',
    ].join('\n'),
    evaluationEmphasis: '強みの根拠の具体性、再現性（入社後に活きるか）、結論ファースト、採用担当への説得力。',
  },
  gakuchika: {
    type: 'gakuchika',
    label: 'ガクチカプレゼン',
    emoji: '🔥',
    description: '学生時代に力を入れたことを、STAR・成果・学びで発表します。',
    recommendedData: '活動整理・ES（ガクチカ）',
    themePlaceholder: '例: サークルの新歓改革で入会者を1.5倍にした取り組み',
    themeFocus: '学生が最も力を入れた経験を題材にした、STARで語れるガクチカプレゼンのテーマ。',
    guidance: [
      'ガクチカプレゼンとして、状況→課題→自分の行動→結果→学び（STAR）が構造的に伝わるかを見る。',
      '行動の主体性・判断理由、定量的な成果（数字/Before・After）、強みの再現性が示せているかを重視する。',
    ].join('\n'),
    evaluationEmphasis: 'STAR構造の明確さ、成果の定量性、行動の主体性、再現性。',
  },
  motivation: {
    type: 'motivation',
    label: '志望動機プレゼン',
    emoji: '🎯',
    description: '志望動機を、経験・価値観・キャリア軸と接続して発表します。',
    recommendedData: '就活軸・自己分析・ES（志望動機）・企業/業界研究',
    themePlaceholder: '例: なぜ私が御社の〇〇職を志望するのか',
    themeFocus: '学生の経験・価値観と、興味のある業界/職種を結びつけた志望動機プレゼンのテーマ。',
    guidance: [
      '志望動機プレゼンとして、なぜその業界・企業・職種か、自分の経験/価値観/就活軸とどう接続するか、入社後にやりたいことが筋道立てて伝わるかを見る。',
      '「他社・他業界ではなくなぜここか」が自分の言葉で語れているか、企業/業界理解の解像度を重視する。事実確認が必要な企業情報は断定しない。',
    ].join('\n'),
    evaluationEmphasis: '志望理由の一貫性（経験・価値観・就活軸との接続）、企業/業界理解、入社後の像の具体性。',
  },
  company_research: {
    type: 'company_research',
    label: '企業/業界研究プレゼン',
    emoji: '🏢',
    description: '企業・業界の理解を、構造的に整理して発表します。',
    recommendedData: '就活軸・基本情報（志望業界/職種）',
    themePlaceholder: '例: IT業界のビジネスモデルと今後の成長領域',
    themeFocus: '学生の志望業界・企業についての理解を問う、企業/業界研究プレゼンのテーマ。',
    guidance: [
      '企業/業界研究プレゼンとして、事業/ビジネスモデル/市場/競合/求める人物像などを構造的に整理できているかを見る。',
      '事実の断定ではなく、論点整理の妥当性・自分なりの視点・志望との接続を重視する。具体的な事実は公式情報での確認を促す前提で扱う。',
    ].join('\n'),
    evaluationEmphasis: '論点整理の構造、ビジネス視点、事実と推測の切り分け、志望との接続。',
  },
  case: {
    type: 'case',
    label: 'ケース課題プレゼン',
    emoji: '🧩',
    description: 'ケース課題・新規事業提案を、ビジネス視点で発表します。',
    recommendedData: '基本情報・活動整理',
    themePlaceholder: '例: 若者の〇〇離れを解決する新規事業を提案する',
    themeFocus: 'ビジネスの課題解決力を問う、ケース課題・新規事業提案プレゼンのテーマ。',
    guidance: [
      'ケース課題プレゼンとして、課題設定の妥当性→現状分析→打ち手→実行可能性→効果の見立て が論理的に組み立てられているかを見る。',
      'ビジネス妥当性・実行可能性・顧客視点・数字での裏づけを重視する。きれいなフレームより、筋の通った結論と根拠を評価する。',
    ].join('\n'),
    evaluationEmphasis: '課題設定の妥当性、論理構成、ビジネス妥当性・実行可能性、顧客視点、定量的根拠。',
  },
  real: {
    type: 'real',
    label: '本番選考プレゼン',
    emoji: '🎤',
    description: '本番のインターン/最終選考を想定し、総合的に発表します。',
    recommendedData: '基本情報・活動整理・自己分析・ES・面接結果',
    themePlaceholder: '例: 5分間で自分を採用すべき理由をプレゼンする',
    themeFocus: '本番のインターン選考・最終選考プレゼンを想定した、総合的なプレゼンのテーマ。',
    guidance: [
      '本番選考プレゼンとして、結論ファースト・論理構成・根拠の具体性・時間配分・聞き手への伝わりやすさを総合的に見る。',
      '採用担当の目線で「採用したい理由」が伝わるか、突っ込まれても耐える具体性と一貫性があるかを重視する。',
    ].join('\n'),
    evaluationEmphasis: '総合力（結論ファースト・論理・具体性・時間配分・伝わりやすさ・採用担当への説得力）。',
  },
};

// UI の並び順（setup 画面のカード順）。
export const CAREER_PRESENTATION_MODE_ORDER: CareerPresentationType[] = [
  'self_pr',
  'gakuchika',
  'motivation',
  'company_research',
  'case',
  'real',
];

export const CAREER_PRESENTATION_MODES: CareerPresentationModeConfig[] =
  CAREER_PRESENTATION_MODE_ORDER.map((t) => MODES[t]);

export const DEFAULT_CAREER_PRESENTATION_TYPE: CareerPresentationType = 'self_pr';

// 制限時間の選択肢（秒）。1/3/5/10 分。
export const CAREER_PRESENTATION_TIME_LIMITS: Array<{ label: string; sec: number }> = [
  { label: '1分', sec: 60 },
  { label: '3分', sec: 180 },
  { label: '5分', sec: 300 },
  { label: '10分', sec: 600 },
];

export function isCareerPresentationType(v: unknown): v is CareerPresentationType {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MODES, v);
}

// 未指定・不正値は自己PR（self_pr）に倒す。後方互換に使う。
export function resolvePresentationType(v: unknown): CareerPresentationType {
  return isCareerPresentationType(v) ? v : DEFAULT_CAREER_PRESENTATION_TYPE;
}

export function getPresentationModeConfig(v: unknown): CareerPresentationModeConfig {
  return MODES[resolvePresentationType(v)];
}
