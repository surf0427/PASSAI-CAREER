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

export function esQuestionTurnCap(type: EsQuestionType): number {
  return ES_QUESTION_TURN_CAP[type];
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

// 深掘りで扱う観点（種別ごとに重視するものを変える）。
const AXES_BY_TYPE: Record<EsQuestionType, string[]> = {
  gakuchika: [
    '取り組んだ背景・動機（なぜそれに力を入れたのか）',
    '直面した課題・困難と、そのときの思考プロセス',
    '具体的な行動（自分が何をしたか。役割・工夫）',
    '定量的な成果・変化（数字／Before・After／周囲への影響）',
    '学び・そこから得たもの（再現性・今後どう活きるか）',
  ],
  motivation: [
    'その業界・企業に興味を持ったきっかけ（原体験）',
    'なぜ他社ではなくこの会社か（惹かれた点・自分の価値観との接続）',
    '入社後にやりたいこと・貢献したいこと',
    '自分の経験・強みがどう活きるか',
  ],
  selfPr: [
    'アピールしたい強みと、それを一言で言うと何か',
    'その強みが最も発揮された具体的な場面・役割',
    '強みを裏づける行動・エピソード（数字や事実）',
    '強みの再現性（他の場面でも発揮できるか）',
    '入社後にその強みをどう活かすか',
  ],
  research: [
    '研究テーマと、それを選んだ理由・問い',
    '具体的に取り組んだこと（手法・自分の役割）',
    '直面した難しさと工夫・乗り越え方',
    '成果・分かったこと',
    '研究を通じて身についた力（仕事にどう活きるか）',
  ],
  other: [
    '設問が問うている核心（何を答えるべきか）',
    '関連する具体的な経験・エピソード',
    '自分の行動・考えたこと',
    '結果・学び・今後への接続',
  ],
};

// 深掘りの土台 system prompt（全ターン共通）。設問と種別に特化させる。
export function buildEsDeepSystem(question: string, type: EsQuestionType): string {
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
    '',
    '【この設問で引き出したい観点（この中から、まだ十分聞けていない最重要の1点を選んで掘る）】',
    ...AXES_BY_TYPE[type].map((a) => `- ${a}`),
  ].join('\n');
}

// seed（1問目）の user プロンプト。質問文そのものだけを返させる。
export function buildEsSeedUserPrompt(type: EsQuestionType): string {
  const cap = ES_QUESTION_TURN_CAP[type];
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
): string {
  const cap = ES_QUESTION_TURN_CAP[type];
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
    '- 上の「引き出したい観点」から、まだ十分に聞けていない最重要の1点を選んで掘る。',
    '- 直前の回答だけに引っ張られすぎず、設問の答えに必要な材料が揃うよう観点を進める。',
    '- 既に聞いた論点は繰り返さない。答えやすく具体的な問いにする。',
    '- 本文の書き方の指示・例文は出さない（材料を引き出す質問のみ）。',
    '',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '{ "reaction": string, "question": string }',
  ].join('\n');
}
