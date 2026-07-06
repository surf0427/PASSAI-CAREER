// PASSAI 就活版 — プレゼン対策AI モード定義（種類別の狙い・評価重心）。
//
// 受験版プレゼン機能（志望校プレゼン入試）の「テーマ設定＋AI評価」思想を踏襲しつつ、
// 概念を新卒就活へ全面的に置き換える（大学受験・AO/推薦・志望校評価軸は持ち込まない）。
//
// ブラウザ API を使わない純粋データ／純粋関数のみ。サーバ（route / presentationPrompt）と
// クライアント（setup / session / result UI）の双方から import する。

import type {
  CareerPresentationType,
  CareerPresentationScenario,
  CareerPresentationFormat,
  CareerPresentationSelectionType,
  CareerPresentationTarget,
  CareerPresentationConfig,
} from '@/types/careerPresentation';

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

// 制限時間の選択肢（秒）。1/3/5/10 分＋指定なし（0）。
export const CAREER_PRESENTATION_TIME_LIMITS: Array<{ label: string; sec: number }> = [
  { label: '1分', sec: 60 },
  { label: '3分', sec: 180 },
  { label: '5分', sec: 300 },
  { label: '10分', sec: 600 },
  { label: '指定なし', sec: 0 },
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

// ════════════════════════════════════════════════════════════════════
// お題ベース（プロンプト型）プレゼン — 想定シーン / 発表形式 / 評価観点 / 難易度
//
// 受験版プレゼン機能と同じ「お題に対して発表する」形式へ寄せるための定義。
// 旧「PASSAI 機能別プレゼン種別（MODES）」は履歴表示の後方互換のために残す。
// 新規セッションは scenario（想定シーン）を主軸にし、presentationType は
// legacyType でマッピングして埋める（Supabase mirror 列・旧ラベル表示のため）。
// ════════════════════════════════════════════════════════════════════

export type CareerPresentationScenarioConfig = {
  scenario: CareerPresentationScenario;
  label: string;
  emoji: string;
  // 旧 presentationType へのマッピング（後方互換のためセッションに埋める）。
  legacyType: CareerPresentationType;
  // AIお題生成の狙い。
  themeFocus: string;
  // 評価者（採用担当）としての姿勢・見どころ。
  guidance: string;
  // このシーンで特に重視する観点。
  evaluationEmphasis: string;
};

const SCENARIOS: Record<CareerPresentationScenario, CareerPresentationScenarioConfig> = {
  main_selection: {
    scenario: 'main_selection',
    label: '本選考',
    emoji: '🎯',
    legacyType: 'real',
    themeFocus: '本選考のプレゼン選考を想定した、入社後の貢献・志望度・自分の経験との接続を語れるお題。',
    guidance:
      '本選考のプレゼンとして、入社後にどう貢献するか・志望度の高さ・企業理解・自分の具体的な経験との接続が伝わるかを見る。採用担当として「採用したい理由」が伝わるかを重視する。',
    evaluationEmphasis: '入社後の貢献、志望度、企業理解、具体的な経験との接続、採用する理由が伝わるか。',
  },
  internship: {
    scenario: 'internship',
    label: 'インターン選考',
    emoji: '🌱',
    legacyType: 'real',
    themeFocus: 'インターン選考を想定した、参加目的・学びたいこと・活かしたい強みを語れるお題。',
    guidance:
      'インターン選考のプレゼンとして、参加目的・学習意欲・業界/企業への関心・主体性・成長ポテンシャルが伝わるかを見る。完成度より伸びしろと熱量を重視する。',
    evaluationEmphasis: '参加目的、学習意欲、業界・企業への関心、主体性、成長ポテンシャル。',
  },
  gd_followup: {
    scenario: 'gd_followup',
    label: 'GD後の発表',
    emoji: '🤝',
    legacyType: 'real',
    themeFocus: 'グループディスカッション後の代表発表を想定した、チームの結論を簡潔に伝えるお題。',
    guidance:
      'グループディスカッション後の代表発表として、チームの議論を整理できているか・結論ファーストか・論点と根拠が簡潔か・代表発表として分かりやすいかを見る。',
    evaluationEmphasis: 'チーム議論の整理、結論ファースト、論点と根拠の簡潔さ、代表発表としての分かりやすさ。',
  },
  case: {
    scenario: 'case',
    label: 'ケース面接',
    emoji: '🧩',
    legacyType: 'case',
    themeFocus: 'ケース面接・ケース課題を想定した、課題設定→分析→解決策を筋道立てて提案するお題。',
    guidance:
      'ケース面接のプレゼンとして、課題設定→仮説→分析→解決策→実行可能性→施策の優先順位が論理的に組み立てられているかを見る。きれいなフレームより筋の通った結論と根拠を評価する。',
    evaluationEmphasis: '課題設定、仮説、分析、解決策、実行可能性、施策の優先順位。',
  },
  self_pr: {
    scenario: 'self_pr',
    label: '自己PRプレゼン',
    emoji: '💪',
    legacyType: 'self_pr',
    themeFocus: '自己PRプレゼンを想定した、自分の強みと裏づけとなる経験を語れるお題。',
    guidance:
      '自己PRプレゼンとして、強みの明確さ・エピソードの具体性・再現性（企業でどう活きるか）が伝わるかを見る。抽象的な強みの羅列ではなく具体に裏づけられているかを重視する。',
    evaluationEmphasis: '強みの明確さ、エピソードの具体性、再現性、企業でどう活きるか。',
  },
  company_proposal: {
    scenario: 'company_proposal',
    label: '企業課題提案',
    emoji: '🏢',
    legacyType: 'case',
    themeFocus:
      '企業課題提案を想定した、企業/業界が抱えそうな課題を1つ挙げ解決策を提案するお題（企業の事実は断定しない）。',
    guidance:
      '企業課題提案のプレゼンとして、課題の捉え方・解決策の説得力・企業理解・実現可能性・リスク認識が伝わるかを見る。企業名だけを根拠に事業課題を捏造せず、情報が不足する場合は一般的な業界課題・仮説として扱えているかも見る。',
    evaluationEmphasis: '課題の捉え方、解決策の説得力、企業理解、実現可能性、リスク認識。',
  },
  unspecified: {
    scenario: 'unspecified',
    label: '指定なし',
    emoji: '🎤',
    legacyType: 'real',
    themeFocus: '就活・選考で出されそうな、汎用的なプレゼンのお題。',
    guidance:
      '就活・選考プレゼンとして、結論ファースト・論理構成・根拠の具体性・説得力・聞き手への伝わりやすさ・時間配分を総合的に見る。',
    evaluationEmphasis: '構成の分かりやすさ、主張の明確さ、根拠の具体性、説得力、聞き手意識、時間配分。',
  },
};

// setup 画面のシーン選択の並び順。
export const CAREER_PRESENTATION_SCENARIO_ORDER: CareerPresentationScenario[] = [
  'main_selection',
  'internship',
  'gd_followup',
  'case',
  'self_pr',
  'company_proposal',
  'unspecified',
];

export const CAREER_PRESENTATION_SCENARIOS: CareerPresentationScenarioConfig[] =
  CAREER_PRESENTATION_SCENARIO_ORDER.map((s) => SCENARIOS[s]);

export const DEFAULT_CAREER_PRESENTATION_SCENARIO: CareerPresentationScenario = 'unspecified';

export function isCareerPresentationScenario(v: unknown): v is CareerPresentationScenario {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SCENARIOS, v);
}

export function resolveScenario(v: unknown): CareerPresentationScenario {
  return isCareerPresentationScenario(v) ? v : DEFAULT_CAREER_PRESENTATION_SCENARIO;
}

export function getScenarioConfig(v: unknown): CareerPresentationScenarioConfig {
  return SCENARIOS[resolveScenario(v)];
}

// 発表形式の選択肢。
export const CAREER_PRESENTATION_FORMATS: Array<{ key: CareerPresentationFormat; label: string }> = [
  { key: 'individual', label: '個人発表' },
  { key: 'group_rep', label: 'グループ代表発表' },
  { key: 'with_materials', label: '資料あり' },
  { key: 'without_materials', label: '資料なし' },
  { key: 'unspecified', label: '指定なし' },
];

export function getFormatLabel(v: unknown): string | null {
  const found = CAREER_PRESENTATION_FORMATS.find((f) => f.key === v);
  return found && found.key !== 'unspecified' ? found.label : null;
}

// 「評価してほしい観点」の選択肢（任意・複数選択）。
export const CAREER_PRESENTATION_EVAL_FOCUS: Array<{ key: string; label: string }> = [
  { key: 'structure', label: '構成' },
  { key: 'persuasion', label: '説得力' },
  { key: 'logic', label: '論理性' },
  { key: 'delivery', label: '話し方' },
  { key: 'companyUnderstanding', label: '企業理解' },
  { key: 'originality', label: '独自性' },
  { key: 'qaStrength', label: '質疑応答への強さ' },
];

export function evalFocusLabels(keys: string[] | undefined): string[] {
  if (!keys || keys.length === 0) return [];
  return keys
    .map((k) => CAREER_PRESENTATION_EVAL_FOCUS.find((f) => f.key === k)?.label)
    .filter((l): l is string => !!l);
}

// AIお題生成の難易度。
export type CareerPresentationDifficulty = 'easy' | 'standard' | 'hard';

export const CAREER_PRESENTATION_DIFFICULTIES: Array<{
  key: CareerPresentationDifficulty;
  label: string;
  hint: string;
}> = [
  { key: 'easy', label: 'やさしめ', hint: '基本的なお題（自己PR・志望動機など）で、答えやすいもの' },
  { key: 'standard', label: '標準', hint: '本番の選考でありそうな標準的な難度のお題' },
  { key: 'hard', label: '難しめ', hint: 'ケース課題・企業課題提案など、思考力を問う歯ごたえのあるお題' },
];

export function resolveDifficulty(v: unknown): CareerPresentationDifficulty {
  return v === 'easy' || v === 'standard' || v === 'hard' ? v : 'standard';
}

// 選考種別の選択肢・ラベル。
export const CAREER_PRESENTATION_SELECTION_TYPES: Array<{
  value: CareerPresentationSelectionType | null;
  label: string;
}> = [
  { value: null, label: '指定なし' },
  { value: 'main', label: '本選考' },
  { value: 'internship', label: 'インターン' },
];

export function getSelectionTypeLabel(v: unknown): string | null {
  if (v === 'main') return '本選考';
  if (v === 'internship') return 'インターン';
  return null;
}

// ── お題生成の前段 target（選考文脈）─────────────────────────────────
// 任意入力（unknown / 下書き / 旧ログ）を CareerPresentationTarget に防御的に正規化する。
// 中身が空（有効な文脈が1つも無い）なら null を返す（= 指定なし扱い）。
function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function normalizePresentationTarget(raw: unknown): CareerPresentationTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const target: CareerPresentationTarget = {};

  const companyName = trimStr(r.companyName);
  if (companyName) target.companyName = companyName;
  const industry = trimStr(r.industry);
  if (industry) target.industry = industry;
  const jobType = trimStr(r.jobType);
  if (jobType) target.jobType = jobType;
  if (isCareerPresentationScenario(r.scenario)) target.scenario = r.scenario;
  if (r.selectionType === 'main' || r.selectionType === 'internship') {
    target.selectionType = r.selectionType;
  }
  if (CAREER_PRESENTATION_FORMATS.some((f) => f.key === r.format)) {
    target.format = r.format as CareerPresentationFormat;
  }
  const companyMemo = trimStr(r.companyMemo);
  if (companyMemo) target.companyMemo = companyMemo;
  const focusPoint = trimStr(r.focusPoint);
  if (focusPoint) target.focusPoint = focusPoint;
  if (r.difficulty === 'easy' || r.difficulty === 'standard' || r.difficulty === 'hard') {
    target.difficulty = r.difficulty;
  }

  // 意味のある文脈が1つも無ければ null（指定なしの汎用練習）。
  const hasContent =
    !!target.companyName ||
    !!target.industry ||
    !!target.jobType ||
    !!target.scenario ||
    !!target.selectionType ||
    !!target.format ||
    !!target.companyMemo ||
    !!target.focusPoint;
  return hasContent ? target : null;
}

// target（選考文脈）を config（セッション設定）の初期値へ写す。
// お題・発表時間・評価観点は setup で決めるため含めない。
export function presentationConfigFromTarget(
  target: CareerPresentationTarget | null | undefined,
): CareerPresentationConfig {
  const cfg: CareerPresentationConfig = {};
  if (!target) return cfg;
  if (target.scenario) cfg.scenario = target.scenario;
  if (target.companyName) cfg.companyName = target.companyName;
  if (target.industry) cfg.industry = target.industry;
  if (target.jobType) cfg.jobType = target.jobType;
  if (target.format) cfg.format = target.format;
  if (target.selectionType) cfg.selectionType = target.selectionType;
  if (target.companyMemo) cfg.companyMemo = target.companyMemo;
  if (target.focusPoint) cfg.focusPoint = target.focusPoint;
  return cfg;
}
