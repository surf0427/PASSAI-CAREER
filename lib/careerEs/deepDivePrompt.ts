// PASSAI 就活版 — ES「深掘りしながら書く」深掘り質問プロンプト組み立て
//
// 役割: /api/career/es/deep（会話型の深掘り質問生成）が利用する共有モジュール。
//   - 特定の ES 設問に対して、本人の経験・考え・エピソードを「整理する」ための対話。
//     本文は書かせない（ai_policy 厳守）。目的は材料整理であり ES 本文生成ではない。
//   - 質問数は設問種別ごとに変える（ガクチカ 5〜8 / 志望動機 3〜5 / 自己PR 4〜6 / 研究 4〜7 / その他）。
//   - 「1問→回答→次の1問」の自然な壁打ち。面接官ではなく、言語化を助けるコーチのトーン。
// 本ファイルは route ではない（共有モジュール）。

// ES添削・自己分析と同系の Sonnet を使用（課金/usage には接続しない）。
export const CAREER_ES_DEEP_MODEL = 'claude-sonnet-4-6';

// 設問種別。設問文から推定し、質問数レンジを出し分ける。
export type EsQuestionType = 'gakuchika' | 'motivation' | 'selfPr' | 'research' | 'other';

export const ES_QUESTION_TYPE_LABEL: Record<EsQuestionType, string> = {
  gakuchika: 'ガクチカ（学生時代に力を入れたこと）',
  motivation: '志望動機',
  selfPr: '自己PR',
  research: '研究内容',
  other: 'ES設問',
};

// 設問種別ごとの質問数上限（この数に達したら done）。
//   ガクチカ 5〜8 / 志望動機 3〜5 / 自己PR 4〜6 / 研究 4〜7 / その他。
const ES_QUESTION_TURN_CAP: Record<EsQuestionType, number> = {
  gakuchika: 7,
  motivation: 5,
  selfPr: 6,
  research: 7,
  other: 5,
};

// 既知情報があっても、この数までは必ず質問する（削りすぎて材料不足にしない下限）。
export const ES_MIN_TURN_CAP = 3;

/**
 * 質問数上限。
 *
 * `satisfiedAxisCount`（既存 Career Data で既に埋まっている観点の数）を渡すと、
 * その分だけ上限を下げる（＝既に知っていることを聞かない分、対話が短くなる）。
 * 未指定なら従来と同じ値を返す（既存呼び出しは挙動不変）。
 * ★ 質問数削減より「必要情報が揃うこと」を優先するため、下限 ES_MIN_TURN_CAP を割らない。
 */
export function esQuestionTurnCap(type: EsQuestionType, satisfiedAxisCount = 0): number {
  const base = ES_QUESTION_TURN_CAP[type];
  const satisfied = Number.isFinite(satisfiedAxisCount) ? Math.max(0, Math.floor(satisfiedAxisCount)) : 0;
  return Math.max(ES_MIN_TURN_CAP, base - satisfied);
}

// 設問文から種別を推定する（決定論・キーワードマッチ）。
export function classifyEsQuestionType(question: string): EsQuestionType {
  const q = question.trim();
  if (/(志望(動機|理由)|なぜ(当社|弊社|この会社|同社)|入社(後|して)|当社を志望)/.test(q)) {
    return 'motivation';
  }
  if (/(研究|卒論|卒業論文|ゼミ|論文|専攻|学んだこと|学業)/.test(q)) return 'research';
  if (/(自己\s*PR|自己ピーアール|強み|長所|アピール|あなたの魅力)/i.test(q)) return 'selfPr';
  if (/(力を入れ|注力|ガクチカ|学生時代|打ち込ん|力を注|頑張ったこと|取り組んだこと)/.test(q)) {
    return 'gakuchika';
  }
  return 'other';
}

export type EsTurn = { role: 'question' | 'answer'; content: string };

export function esCountAnswers(turns: EsTurn[]): number {
  return turns.filter((t) => t.role === 'answer').length;
}

function buildTranscript(turns: EsTurn[]): string {
  return turns
    .map((t) => (t.role === 'question' ? `深掘り相手: ${t.content}` : `あなた: ${t.content}`))
    .join('\n');
}

// ── 深掘りで扱う観点（軸）─────────────────────────────────────────────
//
// 従来 `AXES_BY_TYPE`（string[]）だったものを、**同一の文言のまま** key 付き定義へ整理した。
// 目的は「既存 Career Data でどの観点が既に埋まっているか」を決定論で照合できるようにすること。
//   - `label` は従来の文字列と 1 文字も変えない（system prompt は既存と byte 一致のまま）。
//   - `satisfiedBy` は「この観点を埋めうる材料の種別」。空配列 = 既存 Career Data では
//     原則埋まらない観点（企業固有の話・再現性の主張など）＝常に深掘りで聞く。

// 材料が持つ情報の種別。候補生成（materialCandidates.ts）が各候補へ付与する。
export type EsMaterialFactKind =
  | 'motive' // なぜ取り組んだか・目的・きっかけ
  | 'context' // 所属・期間・規模・役割などの前提
  | 'action' // 具体的にやったこと・工夫
  | 'difficulty' // 困難・失敗・挫折
  | 'result' // 成果・数字・変化
  | 'learning' // 学び・強み・成長
  | 'values' // 価値観・志向・モチベーション
  | 'future'; // 将来やりたいこと・キャリア志向

export type EsAxisDef = {
  // 安定 key（prompt へは出さない。内部の照合・保存用）。
  key: string;
  // prompt に出す観点の文言（従来 AXES_BY_TYPE の要素と完全一致）。
  label: string;
  // この観点を「既に分かっている」と見なせる材料種別（空 = 既存データでは埋まらない）。
  satisfiedBy: readonly EsMaterialFactKind[];
};

export const ES_AXIS_DEFS: Record<EsQuestionType, readonly EsAxisDef[]> = {
  gakuchika: [
    { key: 'motive', label: '取り組んだ背景・動機（なぜそれに力を入れたのか）', satisfiedBy: ['motive'] },
    { key: 'difficulty', label: '直面した課題・困難と、そのときの思考プロセス', satisfiedBy: ['difficulty'] },
    { key: 'action', label: '具体的な行動（自分が何をしたか。役割・工夫）', satisfiedBy: ['action'] },
    { key: 'result', label: '定量的な成果・変化（数字／Before・After／周囲への影響）', satisfiedBy: ['result'] },
    { key: 'learning', label: '学び・そこから得たもの（再現性・今後どう活きるか）', satisfiedBy: ['learning'] },
  ],
  motivation: [
    { key: 'origin', label: 'その業界・企業に興味を持ったきっかけ（原体験）', satisfiedBy: ['motive', 'values'] },
    // 企業固有の比較。既存 Career Data には存在しないため必ず深掘りで聞く。
    { key: 'whyCompany', label: 'なぜ他社ではなくこの会社か（惹かれた点・自分の価値観との接続）', satisfiedBy: [] },
    { key: 'afterJoin', label: '入社後にやりたいこと・貢献したいこと', satisfiedBy: ['future'] },
    { key: 'strengthFit', label: '自分の経験・強みがどう活きるか', satisfiedBy: ['learning', 'action'] },
  ],
  selfPr: [
    { key: 'strengthClaim', label: 'アピールしたい強みと、それを一言で言うと何か', satisfiedBy: ['learning'] },
    { key: 'scene', label: 'その強みが最も発揮された具体的な場面・役割', satisfiedBy: ['context', 'action'] },
    { key: 'evidence', label: '強みを裏づける行動・エピソード（数字や事実）', satisfiedBy: ['result'] },
    // 「他の場面でも発揮できるか」は本人の判断。データからは断定できないため必ず聞く。
    { key: 'repeatability', label: '強みの再現性（他の場面でも発揮できるか）', satisfiedBy: [] },
    { key: 'afterJoin', label: '入社後にその強みをどう活かすか', satisfiedBy: ['future'] },
  ],
  research: [
    { key: 'theme', label: '研究テーマと、それを選んだ理由・問い', satisfiedBy: ['motive', 'context'] },
    { key: 'action', label: '具体的に取り組んだこと（手法・自分の役割）', satisfiedBy: ['action'] },
    { key: 'difficulty', label: '直面した難しさと工夫・乗り越え方', satisfiedBy: ['difficulty'] },
    { key: 'result', label: '成果・分かったこと', satisfiedBy: ['result'] },
    { key: 'learning', label: '研究を通じて身についた力（仕事にどう活きるか）', satisfiedBy: ['learning'] },
  ],
  other: [
    // 「何を答えるべきか」は設問ごとに決まるため既存データでは埋まらない。
    { key: 'core', label: '設問が問うている核心（何を答えるべきか）', satisfiedBy: [] },
    { key: 'episode', label: '関連する具体的な経験・エピソード', satisfiedBy: ['context', 'action'] },
    { key: 'action', label: '自分の行動・考えたこと', satisfiedBy: ['action', 'motive'] },
    { key: 'outcome', label: '結果・学び・今後への接続', satisfiedBy: ['result', 'learning'] },
  ],
};

/** 設問種別の観点定義。 */
export function esAxesForType(type: EsQuestionType): readonly EsAxisDef[] {
  return ES_AXIS_DEFS[type] ?? ES_AXIS_DEFS.other;
}

// 従来の観点文言リスト（system prompt 用）。ES_AXIS_DEFS から導出するため文言は不変。
const AXES_BY_TYPE: Record<EsQuestionType, string[]> = {
  gakuchika: ES_AXIS_DEFS.gakuchika.map((a) => a.label),
  motivation: ES_AXIS_DEFS.motivation.map((a) => a.label),
  selfPr: ES_AXIS_DEFS.selfPr.map((a) => a.label),
  research: ES_AXIS_DEFS.research.map((a) => a.label),
  other: ES_AXIS_DEFS.other.map((a) => a.label),
};

export type EsAxisCoverage = {
  // 既存 Career Data で埋まっている観点。
  known: EsAxisDef[];
  // まだ埋まっていない観点（＝深掘りで聞くべきもの）。
  missing: EsAxisDef[];
};

/**
 * 選択材料が持つ情報種別から、設問種別の観点カバレッジを決定論で算出する。
 * 材料が無ければ全観点が missing（＝現行の深掘りと同じ「1 から聞く」状態）。
 */
export function resolveEsAxisCoverage(
  type: EsQuestionType,
  factKinds: readonly string[] | null | undefined,
): EsAxisCoverage {
  const present = new Set((Array.isArray(factKinds) ? factKinds : []).filter((k) => typeof k === 'string'));
  const known: EsAxisDef[] = [];
  const missing: EsAxisDef[] = [];
  for (const axis of esAxesForType(type)) {
    const satisfied = axis.satisfiedBy.length > 0 && axis.satisfiedBy.some((k) => present.has(k));
    (satisfied ? known : missing).push(axis);
  }
  return { known, missing };
}

// ── 選択材料（既知情報）を踏まえた深掘り ─────────────────────────────
//
// V1: 深掘り開始前にユーザーが選んだ既存 Career Data を「すでに分かっていること」として
// 渡し、同じ事実の再質問を禁止する。context 未指定なら **従来と完全に同じ prompt** を返す
// （既存呼び出し・NONE ケースは byte 一致）。

// 「過去の自己分析」由来の事実に付ける接頭辞。自己分析結果は AI との対話から得た整理メモで
// あり、細部（数字・具体的な場面）までは確認できていないため、prompt 側で扱いを分ける。
export const ES_SELF_ANALYSIS_FACT_PREFIX = '［過去の自己分析］';

// 1 request で prompt に載せる既知事実の上限（トークン肥大の防止）。
export const ES_KNOWN_FACTS_MAX_LINES = 40;
export const ES_KNOWN_FACTS_MAX_LINE_CHARS = 160;

export type EsDeepDiveContext = {
  // 選択材料から作った既知事実の行（'ラベル: 値'）。
  knownFacts?: readonly string[] | null;
  // まだ埋まっていない観点の key（ES_AXIS_DEFS の key）。
  missingAxes?: readonly string[] | null;
};

function normalizeKnownFacts(facts: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(facts)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    if (typeof f !== 'string') continue;
    const line = f.trim().slice(0, ES_KNOWN_FACTS_MAX_LINE_CHARS);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= ES_KNOWN_FACTS_MAX_LINES) break;
  }
  return out;
}

// missingAxes（key 配列）を、その設問種別の観点定義へ解決する。
// 未知 key は捨て、解決結果が空なら「材料なし」と同じ扱いに倒す（fail-safe）。
function resolveMissingAxes(type: EsQuestionType, keys: readonly string[] | null | undefined): EsAxisDef[] {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const wanted = new Set(keys.filter((k): k is string => typeof k === 'string'));
  return esAxesForType(type).filter((a) => wanted.has(a.key));
}

// system prompt の土台（人格・ai_policy・話し方・今回の設問）。
// context あり / なしの両分岐が共有する（片方だけ書き換わって prompt が分裂しないように）。
function esDeepSystemHeader(question: string, type: EsQuestionType): string[] {
  return [
    'あなたは、日本の新卒就活のエントリーシート（ES）作成を支援する「深掘りの壁打ちパートナー」です。',
    '面接官ではありません。学生本人が、ある ES 設問に答えるための「材料（経験・考え・エピソード）」を',
    '自分の言葉で整理できるよう、対話でやさしく深掘りします。',
    '',
    '【最重要ルール（ai_policy）】',
    '- あなたは ES 本文を書きません。本文の代筆・完成文・例文・「こう書きましょう」を一切出しません。',
    '- あなたの役割は、良い質問を1つずつ投げて、本人の中にある具体を引き出すことだけです。',
    '',
    '【話し方・進め方】',
    '- 質問は必ず1つだけ。毎回言い回しを変え、定型文にしない。',
    '- 詰問・尋問にしない。答えやすく開かれた問いにする（Yes/Noで終わらせない）。',
    '- 学生の実体験・具体に即して掘る（一般論で埋めない）。抽象的すぎる質問は避ける。',
    '- 事実確認が必要な情報（企業の事業内容・待遇・選考等）は断定しない。',
    '',
    `【今回の ES 設問（種別: ${ES_QUESTION_TYPE_LABEL[type]}）】`,
    question,
  ];
}

// 深掘りの土台 system prompt（全ターン共通）。設問と種別に特化させる。
export function buildEsDeepSystem(
  question: string,
  type: EsQuestionType,
  context?: EsDeepDiveContext,
): string {
  const knownFacts = normalizeKnownFacts(context?.knownFacts);
  const missing = resolveMissingAxes(type, context?.missingAxes);
  const hasContext = knownFacts.length > 0 || missing.length > 0;

  if (hasContext) {
    const known = missing.length > 0
      ? esAxesForType(type).filter((a) => !missing.some((m) => m.key === a.key))
      : [];
    const axisLines = missing.length > 0 ? missing : esAxesForType(type).slice();
    return [
      // ★ 土台（人格・ルール・設問）は context 無しの分岐と **同一の配列**を使う。
      //   片方だけ書き換わって prompt が分裂するのを防ぐ（byte parity は QA が固定）。
      ...esDeepSystemHeader(question, type),
      ...(knownFacts.length > 0
        ? [
            '',
            '【すでに分かっていること（本人が過去に入力・整理した情報。今回の材料として本人が選んだもの）】',
            ...knownFacts.map((f) => `- ${f}`),
            '',
            '★ 上記はすでに把握している情報です。同じ事実を確認する質問は禁止します。',
            '  （言い換え・「〜で合っていますか？」といった確認も禁止。既知の内容は前提として会話してよい）',
            '★ 不足している情報だけを質問してください。',
            // 事実行は材料名の見出し（【…】）付きで渡ってくるため startsWith では判定しない。
            ...(knownFacts.some((f) => f.includes(ES_SELF_ANALYSIS_FACT_PREFIX))
              ? [
                  `★ ${ES_SELF_ANALYSIS_FACT_PREFIX}が付いた項目は本人の整理メモです。具体的なエピソード・数字までは`,
                  '  確認できていないため、そこは深掘りしてかまいません（項目そのものの再確認はしない）。',
                ]
              : []),
          ]
        : []),
      ...(known.length > 0
        ? ['', '【すでに材料が揃っている観点（掘り直さない）】', ...known.map((a) => `- ${a.label}`)]
        : []),
      '',
      '【まだ聞けていない観点（この中から、最重要の1点を選んで掘る）】',
      ...axisLines.map((a) => `- ${a.label}`),
    ].join('\n');
  }

  return [
    ...esDeepSystemHeader(question, type),
    '',
    '【この設問で引き出したい観点（この中から、まだ十分聞けていない最重要の1点を選んで掘る）】',
    ...AXES_BY_TYPE[type].map((a) => `- ${a}`),
  ].join('\n');
}

/**
 * context を踏まえた質問数上限。
 * missingAxes が渡されているときだけ「既に埋まっている観点の数」だけ上限を下げる。
 * context 無し（NONE ケース・既存呼び出し）は従来値。
 */
export function esTurnCapForContext(type: EsQuestionType, context?: EsDeepDiveContext): number {
  const missing = resolveMissingAxes(type, context?.missingAxes);
  if (missing.length === 0) return esQuestionTurnCap(type);
  return esQuestionTurnCap(type, esAxesForType(type).length - missing.length);
}

// seed（1問目）の user プロンプト。質問文そのものだけを返させる。
export function buildEsSeedUserPrompt(type: EsQuestionType, context?: EsDeepDiveContext): string {
  const cap = esTurnCapForContext(type, context);
  const knownFacts = normalizeKnownFacts(context?.knownFacts);
  if (knownFacts.length > 0) {
    return [
      'この設問に答えるための深掘りを始めます。',
      `全${cap}問程度で、この設問の材料を一緒に整理していきます。`,
      '本人は今回使いたい材料をすでに選んでおり、その内容は「すでに分かっていること」に示してあります。',
      'そこに書かれている事実は聞き返さず、「まだ聞けていない観点」のうち最も重要な1点について、',
      '答えやすく開かれた質問を1つだけ出してください。いきなり数字や細部を問い詰めないでください。',
      '出力は質問文そのものだけ（前置き・説明・記号・引用符は付けない）。',
    ].join('\n');
  }
  return [
    'この設問に答えるための深掘りを始めます。',
    `全${cap}問程度で、この設問の材料を一緒に整理していきます。`,
    'まずは、答えの核になりそうな「具体的な経験・エピソード」を1つ話してもらえるような、',
    '答えやすく開かれた質問を1つだけ出してください。いきなり数字や細部を問い詰めないでください。',
    '出力は質問文そのものだけ（前置き・説明・記号・引用符は付けない）。',
  ].join('\n');
}

// followup（回答を踏まえた次質問）の user プロンプト。JSON {reaction, question} を要求する。
export function buildEsFollowupUserPrompt(
  type: EsQuestionType,
  turns: EsTurn[],
  context?: EsDeepDiveContext,
): string {
  const cap = esTurnCapForContext(type, context);
  const hasKnownFacts = normalizeKnownFacts(context?.knownFacts).length > 0;
  // system prompt が context 付きの見出し（「まだ聞けていない観点」）になっているか。
  const hasContext = hasKnownFacts || resolveMissingAxes(type, context?.missingAxes).length > 0;
  const questionNumber = Math.min(esCountAnswers(turns) + 1, cap);
  return [
    'これまでのやり取り:',
    buildTranscript(turns),
    '',
    `これは${questionNumber}問目（全${cap}問程度）です。`,
    '学生の直前の回答に、まず一言リアクション（最大1文・共感的に。褒めすぎない）をし、',
    'それを自然に踏まえて、次の質問を1つだけ作ってください。',
    '',
    '質問設計の方針:',
    hasContext
      ? '- 上の「まだ聞けていない観点」から、まだ十分に聞けていない最重要の1点を選んで掘る。'
      : '- 上の「引き出したい観点」から、まだ十分に聞けていない最重要の1点を選んで掘る。',
    '- 直前の回答だけに引っ張られすぎず、設問の答えに必要な材料が揃うよう観点を進める。',
    '- 既に聞いた論点は繰り返さない。答えやすく具体的な問いにする。',
    '- 本文の書き方の指示・例文は出さない（材料を引き出す質問のみ）。',
    ...(hasKnownFacts
      ? [
          '- 「すでに分かっていること」に書かれている事実は、絶対に聞き返さない（言い換えての再確認も禁止）。',
          '- 既知の情報は前提として扱い、そこから一歩踏み込んだ具体（理由・工夫・数字・変化・学び）を引き出す。',
        ]
      : []),
    '',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '{ "reaction": string, "question": string }',
  ].join('\n');
}
