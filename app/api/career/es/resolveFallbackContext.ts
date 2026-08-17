// PASSAI CAREER — ES 深掘り / 材料整理 route 共有: User Data Spine の **fallback** 接続。
//
// 背景（cross-feature audit の指摘 U-2）:
//   ES 深掘りは「client の純関数が候補を列挙 → ユーザーが選んだものだけ knownFacts として送る」
//   という UX で、**材料を 1 つも選ばなかったユーザーには User Data Spine が一切届かない**。
//   その結果、活動整理に書いてある内容を AI が知らないまま「ゼロから聞き直す」質問になっていた。
//
// 本モジュールの責務（最小接続）:
//   `knownFacts` が **空のときだけ**、orchestrator の compact base context を
//   「背景情報」ブロックとして返す。
//
// ★ 「すでに分かっていること」ブロックとは **明確に別物**にする（ここが設計の中核）:
//     - 選択材料（knownFacts）は本人が「今回これを使う」と宣言したもの
//       → 同じ事実の再質問は **禁止**（deepDivePrompt の既存ルール）。
//     - 本 fallback は本人が選んでいない背景情報
//       → 「知っている前提で会話してよいが、具体エピソード・数字は掘ってよい」。
//       これを混同して「再質問禁止」に入れると、材料未選択のユーザーから
//       深掘りの機会そのものを奪ってしまう。
//
// ★ 選択材料がある場合は **何もしない**（byte 完全互換）。既存 UX / 既存 QA を変えない。
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

/** fallback が必要とする Source kind（base 3 のみ。横断ログは読まない）。 */
export const ES_FALLBACK_SOURCE_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
];

export type EsFallbackBridgeInputs = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
};

/** 背景情報ブロックの見出し + 取り扱いルール（「既知＝再質問禁止」と混同させない）。 */
const BACKGROUND_HEADER = [
  '# 参考: 本人が過去に入力した基本情報・活動整理・就活軸（背景情報）',
  '★ これは本人が「今回の材料」として選んだものではなく、あくまで背景情報です。',
  '  ここに書かれている内容を前提に、より的確な質問を選んでください。',
  '  ただし具体的なエピソード・行動・数字・そのときの考えは確認できていないため、',
  '  そこは遠慮なく深掘りしてかまいません（項目名そのものの再確認だけは避ける）。',
].join('\n');

/**
 * 材料未選択のときだけ返す背景 context ブロック（never-throw・fail-open）。
 *
 * @param hasKnownFacts 選択材料があるか。true なら **常に ''**（既存挙動と byte 一致）。
 * @returns prompt へ追記するブロック。読めない / 空 / 選択材料ありのときは ''。
 */
export async function resolveEsFallbackContextBlock(
  hasKnownFacts: boolean,
  bridge: EsFallbackBridgeInputs,
  req?: Request,
  loadContext = loadPurposeServerContext,
): Promise<string> {
  // 選択材料があるユーザーの prompt は 1 byte も変えない。
  if (hasKnownFacts) return '';

  try {
    // server context canary が無効な環境では I/O ゼロで bridge をそのまま使う。
    let profile = bridge.profile ?? null;
    let activity = bridge.activity ?? null;
    let values = bridge.values ?? null;
    try {
      const ctx = await loadContext('es_review', ES_FALLBACK_SOURCE_KINDS, req);
      if (ctx.base) {
        profile = ctx.base.profile;
        activity = ctx.base.activity;
        values = ctx.base.values;
      }
    } catch {
      // server read の失敗は bridge へ倒す（context を減らさない）。
    }

    if (!profile && !activity && !values) return '';

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
    if (base === '') return '';

    return `${BACKGROUND_HEADER}\n\n${base}`;
  } catch {
    // 背景情報の不調で深掘りを止めない（従来どおり材料なしで進む）。
    return '';
  }
}
