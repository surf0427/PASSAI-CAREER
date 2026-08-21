/**
 * PASSAI CAREER — daily quota の **anchor 表**（どの route を「1 回」として数えるか）。
 *
 * 最重要原則: 「1 回」は AI call 数ではなく **ユーザーから見た top-level operation**。
 *   ES 1 本は内部で materials / deep×N / organize / review と最大 10 AI call 走るが、
 *   利用回数としては 1。したがって quota を消費するのは各機能につき **anchor route だけ**で、
 *   同一ワークフロー内の他 route は一切消費しない。
 *
 * anchor の選び方（共通の基準）:
 *   1. そのワークフローで **必ず 1 回だけ**通る地点であること。
 *   2. その機能の成果物が確定する地点であること（＝ユーザーが「1 回使った」と認識する）。
 *   3. server が request 内容から **その操作を一意に識別できる**こと
 *      （retry を畳みつつ、別の操作を同一視しないため）。
 *
 * ★ 各 anchor は成功パスで `quota.settle()` を呼ぶ。settle して初めてその実行が
 *   「完了」扱いになり、以降の同一入力は **明示的な再実行**として新しく 1 回消費される。
 *   settle 前（実行中）の同一入力は retry / 二重送信とみなして消費しない。
 *
 * 本ファイルは QA（scripts/career-daily-quota-qa.ts）が「anchor だけが消費し、
 * 非 anchor は消費しない」を静的に検査するための正本でもある。
 */

import type { CareerDailyQuotaFeature } from './limits';

export type CareerQuotaAnchor = {
  feature: CareerDailyQuotaFeature;
  /** repo 相対の route ファイル。 */
  route: string;
  /** なぜここが「1 回」なのか。 */
  unit: string;
};

/** quota を消費する route（ここに無い career AI route は消費しない）。 */
export const CAREER_QUOTA_ANCHORS: readonly CareerQuotaAnchor[] = [
  {
    feature: 'self_analysis',
    route: 'app/api/career/self-analysis/route.ts',
    unit:
      '自己分析セッション 1 本（まとめ生成）。深掘りの seed / followup（question route）は消費しない。',
  },
  {
    feature: 'company_research',
    route: 'app/api/career/company-research/route.ts',
    unit:
      '企業分析 1 実行。資料 OCR（extract）・Company Data Spine の prefetch / identity / official facts は消費しない。',
  },
  {
    feature: 'es',
    route: 'app/api/career/es-review/route.ts',
    unit:
      'ES 1 本（添削 1 回）。materials / deep×N / organize は消費しない。ユーザーが明示的に行う再添削は ES bucket の +1。',
  },
  {
    feature: 'interview',
    route: 'app/api/career/interview/start/route.ts',
    unit: '面接セッション 1 本（開始時）。turn×N / complete は消費しない。',
  },
  {
    feature: 'presentation',
    route: 'app/api/career/presentation/evaluate/route.ts',
    unit: 'プレゼン練習 1 セッション（評価）。theme / Q&A は消費しない。',
  },
  {
    feature: 'gd',
    route: 'app/api/career/gd/feedback/route.ts',
    unit: 'ソロ GD 1 セッション（評価）。theme / turn×N は消費しない。',
  },
  {
    feature: 'gd',
    route: 'app/api/career/gd/room/[roomId]/result/route.ts',
    unit:
      'マルチ GD 1 セッション（room 単位の評価）。room 作成 / 参加 / AI 発言 / 発言は消費しない。評価済み room の再取得も消費しない。',
  },
  {
    feature: 'matching',
    route: 'app/api/career/matching/route.ts',
    unit: 'マッチング 1 実行。',
  },
];
