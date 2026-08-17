// PASSAI CAREER — ES 深掘り / 材料整理 route 共有: User Data Spine の **背景 context** 接続。
//
// 背景（AI call 単位監査の指摘 P1-2 / P2-1）:
//   旧実装は「選択材料（knownFacts）が 1 つでもあれば背景 context を一切出さない」という
//   **排他的択一**だった。その結果、材料を選んだユーザーほど prompt が薄くなり、
//   就活軸・志望業界/職種・自己分析が深掘り質問 AI に一切届いていなかった
//   （probe: profile=no activity=no values=no selfA=no）。
//
// 本 module の責務:
//   選択材料の有無に **関わらず** compact な背景 context を返す。ただし
//   「選択材料あり」と「選択材料なし」で **見出しと取り扱いルールを変える**。
//
// ★ 選択材料の意味を弱めない（ここが設計の中核）:
//     - 選択材料（knownFacts）= 本人が「今回これを使う」と宣言した **主要材料**。
//       同じ事実の再質問は禁止（deepDivePrompt の既存ルール。本 module は触らない）。
//     - 背景 context = 本人が選んでいない参考情報。
//       「質問の方向性・矛盾チェック・不足の発見・本人の軸との整合」にのみ使う。
//       ★ 本文材料へ勝手に昇格させない／既に回答済みと決めつけない、を明文で禁じる。
//
// 厳守: never-throw / fail-open / 新しい normalizer を作らない（buildCareerAiContext が canonical）。

import 'server-only';

import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import { buildCareerAiContext } from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';
import { loadPurposeServerContext } from '@/lib/careerServerContext/purposeContext.server';
import type { CareerSourceKind } from '@/lib/careerSourceData/types';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
// 「最新 log の result」規則 / render は canonical 実装を再利用する（ES 専用実装を作らない）。
import { latestEsSelfAnalysisResult } from '@/lib/careerEs/reviewContext';
import { renderSelfAnalysis } from '@/lib/careerMemory/renderers/interviewCrossFeature';

/**
 * 背景 context が必要とする Source kind。
 *
 * ★ P2-1: `self_analysis` を追加。材料候補の列挙（materialCandidates）は
 *   selfAnalysisLogs も候補源にしているのに、背景 context 側だけ落ちていて非対称だった。
 */
export const ES_FALLBACK_SOURCE_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
  'self_analysis',
];

export type EsFallbackBridgeInputs = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  /** 最新の自己分析（client bridge。server 由来が verified ならそちらを優先）。 */
  selfAnalysis?: CareerSelfAnalysisResult | null;
};

/**
 * 見出し + 取り扱いルール。
 *
 * ★ 「選択材料あり」版は、背景情報を主要材料へ昇格させない制約を **最優先**で書く。
 *   「選択材料なし」版は、背景を前提に会話してよいが具体は掘ってよい、と書く。
 *   どちらも「既知＝再質問禁止」ブロック（knownFacts）とは別物であることを明示する。
 */
function backgroundHeader(hasKnownFacts: boolean): string {
  if (hasKnownFacts) {
    return [
      '# 参考: 選択材料以外の背景情報（本人が過去に入力した基本情報・活動整理・就活軸・自己分析）',
      '★ 今回の **主要材料は上の「すでに分かっていること」（本人が選んだ材料）** です。',
      '  この背景情報は、質問の方向性を決める・矛盾に気づく・不足している観点を見つける・',
      '  本人の就活軸との整合を確認する、ためだけに使ってください。',
      '★ 禁止: ここに書かれた活動・経験を「本人が今回選んだ材料」として扱うこと。',
      '  ES 本文の材料として勝手に昇格させないでください（本人は今回それを選んでいません）。',
      '★ 禁止: ここに書かれている内容を「既に本人が回答済み」と決めつけること。',
      '  背景として把握しているだけなので、必要なら通常どおり質問してかまいません。',
    ].join('\n');
  }
  return [
    '# 参考: 本人が過去に入力した基本情報・活動整理・就活軸・自己分析（背景情報）',
    '★ これは本人が「今回の材料」として選んだものではなく、あくまで背景情報です。',
    '  ここに書かれている内容を前提に、より的確な質問を選んでください。',
    '  ただし具体的なエピソード・行動・数字・そのときの考えは確認できていないため、',
    '  そこは遠慮なく深掘りしてかまいません（項目名そのものの再確認だけは避ける）。',
  ].join('\n');
}

/**
 * 背景 context ブロックを返す（never-throw・fail-open）。
 *
 * @param hasKnownFacts 選択材料があるか。**出すか出さないかではなく、見出し/ルールの出し分けに使う**。
 * @returns prompt へ追記するブロック。読めない / 全部空のときは ''。
 */
export async function resolveEsFallbackContextBlock(
  hasKnownFacts: boolean,
  bridge: EsFallbackBridgeInputs,
  req?: Request,
  loadContext = loadPurposeServerContext,
): Promise<string> {
  try {
    // server context canary が無効な環境では I/O ゼロで bridge をそのまま使う。
    let profile = bridge.profile ?? null;
    let activity = bridge.activity ?? null;
    let values = bridge.values ?? null;
    let selfAnalysis = bridge.selfAnalysis ?? null;
    try {
      const ctx = await loadContext('es_review', ES_FALLBACK_SOURCE_KINDS, req);
      if (ctx.base) {
        profile = ctx.base.profile;
        activity = ctx.base.activity;
        values = ctx.base.values;
      }
      // 「context を減らさない」: server が空で bridge に中身があるなら bridge を残す。
      if (ctx.origin.self_analysis === 'server') {
        const serverSelf = latestEsSelfAnalysisResult(ctx.sources.selfAnalysisLogs);
        if (serverSelf || !selfAnalysis) selfAnalysis = serverSelf;
      }
    } catch {
      // server read の失敗は bridge へ倒す（context を減らさない）。
    }

    if (!profile && !activity && !values && !selfAnalysis) return '';

    // ★ ES 独自 normalizer を作らない。canonical boundary は buildCareerAiContext。
    //   policy（profile:minimal で氏名除外 / activity:compact）は es_review registry を再利用する。
    const context = buildCareerAiContext({
      featureKey: 'career-es',
      profile,
      activity,
      values,
      userInput: '',
    });
    const base = buildCareerContextForPurpose('es_review', context).systemPrompt.trim();
    // 自己分析は canonical renderer を再利用（ES 専用 renderer を作らない）。
    const selfBlock = renderSelfAnalysis(selfAnalysis);
    const body = [base, selfBlock ? `## 直近の自己分析結果\n${selfBlock}` : '']
      .filter((s) => s !== '')
      .join('\n\n');
    if (body === '') return '';

    return `${backgroundHeader(hasKnownFacts)}\n\n${body}`;
  } catch {
    // 背景情報の不調で深掘りを止めない（従来どおり材料のみで進む）。
    return '';
  }
}
