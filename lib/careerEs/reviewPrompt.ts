// PASSAI 就活版 — ES 添削（/api/career/es-review）の prompt 構築（純関数）。
//
// route（app/api/career/es-review/route.ts）から lift した。挙動を QA harness で
// 決定論に固定するため（route を import せずに prompt byte を検証できるようにする）。
//   - system prompt は静的（base(buildCareerSystemPrompt) は使わない＝INTENTIONALLY_CONTEXT_FREE）。
//     この方針は lib/careerContext/purpose.ts の es_review 注記どおりで、今回も変えない。
//   - user message に「ES 設定（設問 / 文字数 / 企業名 / 志望業界 / 志望職種 / 選考種別）」を
//     **user-provided context** として明示し、添削基準にも反映する。
//
// ai_policy 厳守:
//   AI は本文の代筆・完成例・書き換え文を出さない。改善は「何をどう直すか」の助言に留める。
//   企業名・業界・職種から、企業理念・採用方針・求める人物像・事業戦略を**創作させない**。

import type { CareerEsSelectionType } from '@/types/careerEs';
import { esSelectionTypeLabel } from './esSettings';

// ── system prompt（就活ES添削者） ────────────────────────────────
export const ES_REVIEW_SYSTEM_PROMPT = [
  'あなたは、日本の新卒就職活動のエントリーシート（ES）を添削する専門家です。',
  '学生が書いた ES 回答 1 本を採点・添削し、本人が自分で直せるように具体的に助言します。',
  '',
  '【評価する観点】',
  '次の観点で本文の質のみを評価してください（与えられた回答文の範囲だけで判断する）:',
  '- 設問に正面から答えているか',
  '- 結論が先にあるか（結論ファースト）',
  '- 主張の根拠が十分か',
  '- エピソードが具体的か（数字・固有名詞・行動が見えるか）',
  '- 学び・成長が言語化されているか',
  '- 入社後の活躍や仕事への接続があるか',
  '- 冗長でないか・一文が長すぎないか',
  '- 誤字脱字・表記の乱れ',
  '- 読みやすさ（構成・接続・リズム）',
  '- 指定文字数に対して適量か（超過していないか・不自然に短すぎないか）',
  '- 応募コンテキスト（企業名・志望業界・志望職種・選考種別）に対して自然な伝わり方か',
  '',
  '【6 軸スコア（各 0〜100 の整数）】',
  '- logic: 論理性（結論→根拠→具体→学びの一貫性）',
  '- specificity: 具体性（エピソード・数字・行動の具体度）',
  '- originality: オリジナリティ（その人固有の経験・視点か、テンプレ的でないか）',
  '- readability: 読みやすさ（文の長さ・構成・誤字脱字）',
  '- persuasion: 説得力（採用担当が納得できるか）',
  '- companyFit: 企業適合性（企業名がある場合はその企業/業界との整合、ない場合は志望文脈への接続の自然さ）',
  '',
  '【絶対のルール】',
  '- 与えられた回答文に書かれていない事実（実績・数値・所属・体験）を捏造しない。',
  '- 本文の代筆・完成例・「こう書きましょう」という書き換え文を一切出さない。',
  '  あなたの役割は評価と助言であり、本人が自分で書き直せるようにすること。',
  '- 応募コンテキスト（企業名・業界・職種・選考種別）はユーザーが入力した「提出先の情報」であり、',
  '  あなたの知識の呼び出し口ではない。企業理念・採用方針・求める人物像・事業戦略・選考傾向を',
  '  **推測でも創作しない**（「〇〇社は〜を重視しているため」のような根拠のない企業分析は禁止）。',
  '  企業・業界の具体情報が必要な助言をするときは、断定せず「公式情報・説明会資料で確認する」形に留める。',
  '- 改善点・優先改善は「次に何をすればよいか」が分かる行動レベルの指示にする。',
  '  「具体性を上げましょう」のような抽象的な助言だけで終えない。',
  '- ランクや総合点は書かなくてよい（スコアから自動で決まる）。breakdown の 6 軸を必ず埋める。',
  '',
  '【missingElements（不足している要素）のルール】',
  '- この回答に足りていない観点・エピソード要素を指摘する（例:「成果を示す数字」「主体的に動いた具体行動」「なぜその会社かの根拠」）。',
  '- 本文を書き足すのではなく、「何が欠けているか」を要素として挙げる。',
  '',
  '【recruiterComments（採用担当視点コメント）のルール】',
  '- 採用担当がこの回答を読んだときにどう受け取るかを、担当者の視点で率直に述べる。',
  '  例:「行動力は伝わる」「主体性が弱い」「成果の具体性が不足」「志望理由が浅い」。',
  '- 良い受け取りも懸念も両方含めてよい。合否の断定はしない。',
  '',
  '【出力ルール】',
  '- 返答は必ず 1 つの JSON オブジェクトのみ。',
  '- JSON の前後に説明文・コメント・挨拶・コードブロック記号（```）を一切書かない。',
  '- 出力の 1 文字目が { 、最後の文字が } であること。',
  '- すべてのキー・文字列値をダブルクォートで囲むこと。',
  '',
  '出力形式:',
  '{',
  '  "overallComment": string,        // 総評（全体所感、2〜3文）',
  '  "breakdown": {',
  '    "logic": number,               // 0〜100',
  '    "specificity": number,         // 0〜100',
  '    "originality": number,         // 0〜100',
  '    "readability": number,         // 0〜100',
  '    "persuasion": number,          // 0〜100',
  '    "companyFit": number           // 0〜100',
  '  },',
  '  "strengths": string[],           // 良かった点（最大5件）',
  '  "improvements": string[],        // 改善点（行動レベル、最大5件）',
  '  "missingElements": string[],     // 不足している要素（最大5件）',
  '  "recruiterComments": string[],   // 採用担当視点コメント（最大5件）',
  '  "priorityActions": string[]      // 優先的に直すべき順（最大5件、0番目が最重要）',
  '}',
].join('\n');

// 選考種別に応じた「重点的に見る評価観点」の追加指示ブロックを作る。
// 6 軸スコア（固定）は変えず、コメント・改善点・優先改善の着眼点を選考種別に寄せる。
// 未指定（旧ログ = 旧「指定なし」）は基本観点のみで汎用ES として評価するため空文字を返す。
export function buildSelectionReviewInstruction(
  selectionType: CareerEsSelectionType | null,
): string {
  if (selectionType === 'main') {
    return [
      '# 選考種別: 本選考（重点評価観点）',
      'この ES は入社を前提とした本選考向けです。基本観点に加え、特に次を重視して添削してください:',
      '- 入社後の貢献度（経験から入社後の活躍・再現性が見えるか）。',
      '- 企業適合性（本人の強み・価値観と企業の方向性が結びついているか）。',
      '- 志望度の具体性（「なぜこの会社か」「なぜこの職種か」が伝わるか）。',
      '- 他社にも通用する汎用文になっていないか（差別化・具体性）。',
      '- 「学びたい」「成長したい」だけの受け身表現に寄りすぎていないか。',
      '- 採用担当が「採用する理由」を感じられるか。',
    ].join('\n');
  }
  if (selectionType === 'internship') {
    return [
      '# 選考種別: インターン応募（重点評価観点）',
      'この ES はインターンシップ応募向けです。基本観点に加え、特に次を重視して添削してください:',
      '- 参加目的の明確さ（インターンで何を得たいか・検証したい仮説があるか）。',
      '- 業界・企業への関心、業務理解への意欲。',
      '- 学習意欲・成長ポテンシャル・主体性（受け身でないか）。',
      '- 本選考につながる自然さがあるか。',
      '- 内定欲・入社意思が強すぎる断定表現になっていないか（応募段階はインターン参加）。',
    ].join('\n');
  }
  return '';
}

export type EsReviewPromptInput = {
  // 添削対象の本文（trim 済み想定）。
  answer: string;
  // ES 設定（新規作成では必須。旧ログ由来では欠損しうるため '' / null を許容する）。
  question: string;
  charLimit: number | null;
  companyName: string;
  industry: string;
  jobType: string;
  selectionType: CareerEsSelectionType | null;
  // 保存済み企業研究の評価指示（任意・[id] からのみ）。
  researchInstruction?: string;
  /**
   * Company Data Spine A 層（公式情報）ブロックが実際に prompt へ出るか。
   *
   * ★ true のときだけ「企業の事実を断定してよい範囲」を **公式情報ブロック内に限定**して開放する。
   *   false（既定）では従来どおり企業情報の推測を全面禁止＝出力 byte 完全互換。
   *   面接の buildTargetBlock(hasCompanyOfficial) と同じ思想（捏造禁止は緩めない。
   *   むしろ根拠の所在を明示する分だけ制約は強くなる）。
   */
  hasCompanyOfficial?: boolean;
};

// ES 設定を「提出先コンテキスト」として列挙するブロック。
// 与えられた項目だけを列挙する（欠損項目の行は作らない＝AI に埋めさせない）。
function buildApplicationContextBlock(input: EsReviewPromptInput): string {
  const lines: string[] = [];
  if (input.companyName) lines.push(`- 企業名: ${input.companyName}`);
  if (input.industry) lines.push(`- 志望業界: ${input.industry}`);
  if (input.jobType) lines.push(`- 志望職種: ${input.jobType}`);
  const selectionLabel = esSelectionTypeLabel(input.selectionType);
  if (selectionLabel) lines.push(`- 選考種別: ${selectionLabel}`);
  if (input.charLimit) lines.push(`- 文字数制限: ${input.charLimit} 字`);
  if (lines.length === 0) return '';
  return [
    '# 応募コンテキスト（ユーザー本人が入力した提出先の情報）',
    ...lines,
    '',
    'これはユーザーの入力であり、あなたの知識で補完・拡張してよい情報ではありません。',
    input.hasCompanyOfficial
      ? 'この企業について事実として言及してよいのは、下の【公式情報】ブロックに出典付きで示されている内容だけです。そこに無い企業情報（理念・採用方針・求める人物像・事業戦略・選考傾向）を創作しないでください。'
      : 'ここに書かれていない企業情報（理念・採用方針・求める人物像・事業戦略・選考傾向）を創作しないでください。',
  ].join('\n');
}

// ES 設定を添削基準へ落とす指示ブロック（与えられた項目に対応する行だけ出す）。
function buildContextUsageInstruction(input: EsReviewPromptInput): string {
  const lines: string[] = [];
  if (input.question) {
    lines.push(
      '- 設問適合: 回答が上記の ES 設問に正面から答えているかを最優先で評価する。',
      '  設問からずれた内容（別の設問への回答になっている・論点がすり替わっている）は、',
      '  文章として良く書けていても高評価にせず、ずれている箇所を具体的に指摘する。',
    );
  }
  if (input.charLimit) {
    lines.push(
      `- 文字数: 指定は ${input.charLimit} 字（±10% 以内を目安）。超過しているなら何字削るべきかを示し、`,
      '  大きく下回るなら「限られた字数を使い切れていない」点と、何を足すべきかを指摘する。',
      '  改善の助言は、指定文字数の中に収まる範囲で実行できる内容にする（本文は代筆しない）。',
      '  文字数の判定には、下に示す「本文の文字数」（コード側で計測した確定値）を使う。',
    );
  }
  if (input.companyName) {
    lines.push(
      `- 企業名: この ES の提出先は「${input.companyName}」である、という前提だけを使う。`,
      input.hasCompanyOfficial
        ? '  企業の実態は推測せず、下の【公式情報】ブロックにある事実（および企業研究が別途与えられていればその内容）だけを根拠にできる。'
        : '  企業の実態を推測して評価しない（企業研究が別途与えられている場合のみ、その内容を根拠にできる）。',
      // ★ 公式情報がある場合でも、companyFit の評価は「本人の記述がその事実と噛み合っているか」であり、
      //   足りない志望理由を AI が埋めることではない（ai_policy: 代筆・創作の禁止）。
      input.hasCompanyOfficial
        ? '  companyFit は「本人の記述が公式情報にある企業の実像と噛み合っているか」で評価する。'
        : '',
      input.hasCompanyOfficial
        ? '  噛み合っていない・具体性が足りない場合は、公式情報のどの点に触れられていないかを指摘する。'
        : '',
      '  企業向けの具体性が足りない場合は「志望企業に対する具体性が不足」と指摘し、',
      '  何を自分で調べて書き足すべきかを助言する。',
      // ★ 代筆禁止は公式情報の有無に関わらず維持する（公式情報は「指摘の根拠」であって「本文の材料」ではない）。
      input.hasCompanyOfficial
        ? '  ★ 公式情報を使って、本人の志望理由・経験・強み・本文を代筆・創作してはならない。'
        : '',
    );
  }
  if (input.industry) {
    lines.push(
      `- 志望業界: 「${input.industry}」向けの応募として、内容に大きな矛盾がないか・伝わり方が自然かを見る。`,
      '  業界の一般論を事実として増やさない（断定的な業界解説はしない）。',
    );
  }
  if (input.jobType) {
    lines.push(
      `- 志望職種: 「${input.jobType}」として読んだときに、強み・行動・経験・学びがどう伝わるかを考慮する。`,
      '  同じ経験でも職種によって強調すべき点が変わるため、この職種で評価されにくい書き方があれば指摘する。',
    );
  }
  // hasCompanyOfficial=false のとき条件分岐が積む '' を落とす（未接続時の byte 完全互換を保つ）。
  const kept = lines.filter((line) => line !== '');
  if (kept.length === 0) return '';
  return ['# 応募コンテキストの使い方（添削基準）', ...kept].join('\n');
}

// 添削 user メッセージ。ES 設定 → 添削基準 → 選考種別 → 企業研究 → 本文 の順で積む。
export function buildEsReviewUserMessage(input: EsReviewPromptInput): string {
  const answerLength = [...input.answer].length;
  const bodyHeader = input.charLimit
    ? `# 添削対象の回答本文（本文の文字数: ${answerLength} 字 / 指定 ${input.charLimit} 字）`
    : `# 添削対象の回答本文（本文の文字数: ${answerLength} 字）`;

  return [
    input.question ? `# ES設問\n${input.question}` : '',
    buildApplicationContextBlock(input),
    buildContextUsageInstruction(input),
    buildSelectionReviewInstruction(input.selectionType),
    input.researchInstruction ?? '',
    `${bodyHeader}\n${input.answer}`,
    '',
    '上記の回答本文を、指定の JSON 形式で添削してください。事実を捏造しないでください。',
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}
