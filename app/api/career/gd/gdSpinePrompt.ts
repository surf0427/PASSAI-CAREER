// PASSAI CAREER — GD の Data Spine prompt block 組み立て（STEP-GD-31・server-only）。
//
// 役割: 解決済みの User Data Spine（resolveContextInputs）と Company Data Spine
//   （resolveCompanyOfficial）を、GD の AI 呼び出しへ渡す **1 本の追加 block** にまとめる。
//
// ★ 既存 architecture の踏襲:
//   - base career system prompt と Company 公式情報は Context Orchestrator
//     （buildCareerContextForPurpose）経由で取得する。GD 専用の並行実装を作らない。
//   - 公式事実 / 本人の登録情報 / AI 派生を **別ブロック**として並べる（Spine の中核契約）。
//
// ★ 非破壊の保証:
//   context がすべて空なら本関数は '' を返す。GD の system prompt は
//   `[既存の静的 prompt, spineBlock].filter(Boolean).join('\n\n')` の形で結合されるため、
//   Spine 未通電環境（canary OFF・企業未指定）では **従来と byte 完全一致**の prompt になる。
//
// ★ 採点契約（要件 29）:
//   本 block は AI に「軸スコアと根拠」以外を作らせない既存契約を一切変更しない。
//   総合点 / ランク / 企業コミュ適性グレードは server の決定論算出のままで、
//   Spine はそこへ到達しない（roomFeedback.ts の computeOverallScore 等は入力が axisScores だけ）。

import 'server-only';

import { buildCareerContextForPurpose } from '@/lib/careerContext/orchestrator';
// ★ GD 独自 normalizer は作らない。buildCareerAiContext が canonical boundary
//   （es-review / matching / consultation と同じ入口を使う）。
import { buildCareerAiContext } from '@/lib/careerAi';
import { buildGdCrossFeatureContext } from '@/lib/careerMemory/renderers/gdCrossFeature';
import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
import type { GdContextInputs } from './resolveContextInputs';

export type GdSpinePromptParts = {
  /** GD の静的 system prompt の後ろへ結合する追加 block（空なら ''）。 */
  block: string;
  /** 観測 / QA 用。prompt へ実際に到達したかを route が判定できる。 */
  reached: {
    base: boolean;
    crossFeature: boolean;
    companyOfficial: boolean;
  };
};

const EMPTY_PARTS: GdSpinePromptParts = {
  block: '',
  reached: { base: false, crossFeature: false, companyOfficial: false },
};

/**
 * GD 用の Data Spine block を組む。
 *
 * @param ctx     User Data Spine（resolveGdContextInputs の結果）
 * @param company Company Data Spine A 層（resolveGdCompanyOfficial の結果。null なら載せない）
 */
export function buildGdSpinePrompt(
  ctx: GdContextInputs | null | undefined,
  company: CompanyOfficialReadResult | null | undefined,
): GdSpinePromptParts {
  if (!ctx && !company) return EMPTY_PARTS;

  const hasBaseInput = !!(ctx?.profile || ctx?.activity || ctx?.values);

  // Orchestrator へ渡す base context。空でも buildCareerSystemPrompt 側の fallback で落ちない。
  const context = buildCareerAiContext({
    // 既存 CareerAiFeatureKey に 'career-gd' が既にある（新設しない）。
    featureKey: 'career-gd',
    profile: ctx?.profile ?? null,
    activity: ctx?.activity ?? null,
    values: ctx?.values ?? null,
    userInput: '',
  });
  const orchestrated = buildCareerContextForPurpose(
    'gd_feedback',
    context,
    // Company Data Spine A 層。renderer が purpose allowlist / budget / provenance を強制する。
    //   ★ 面接・ES・プレゼンと **同じ type・同じ renderer・同じ extras key** を使う。
    company ? { company } : undefined,
  );

  // 本人の登録情報（自己分析 / 過去 GD）。injection 境界と採点契約は renderer 側が付ける。
  const crossFeature = buildGdCrossFeatureContext({
    selfAnalysisLogs: ctx?.selfAnalysisLogs,
    gdRoomLogs: ctx?.gdRoomLogs,
  });

  // base は「実データがあったときだけ」載せる。空 profile の定型文で prompt を汚さない。
  const baseBlock = hasBaseInput ? orchestrated.systemPrompt : '';
  const companyBlock = orchestrated.companyOfficialContext;

  const block = [baseBlock, companyBlock, crossFeature].filter((s) => s !== '').join('\n\n');

  return {
    block,
    reached: {
      base: baseBlock !== '',
      crossFeature: crossFeature !== '',
      companyOfficial: companyBlock !== '',
    },
  };
}

/**
 * 静的 system prompt と Spine block を結合する（唯一の結合口）。
 *
 * block が空なら入力をそのまま返す＝ **byte 完全一致**（非破壊の保証点）。
 * QA はこの関数の入出力に対して「空なら byte 一致 / 非空なら別ブロックとして付く」を検証する。
 */
export function appendGdSpineBlock(baseSystem: string, block: string): string {
  return block ? `${baseSystem}\n\n${block}` : baseSystem;
}
