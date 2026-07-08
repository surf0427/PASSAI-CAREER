// PASSAI CAREER Context Budget 観測（P3-G で導入）。
//
// 目的: purpose / route ごとに「AI へ渡す context がどれだけ大きいか」を文字数ベースで観測する。
//   P3-H 以降の purpose 別削減判断のためのデータを取る。**削減はしない・観測だけ**。
//
// 厳守:
//   - 純関数のみ（I/O / env / secret / Supabase read なし・client/server 両用）。
//   - 本番 route から自動実行しない（self-check / dev-only 用途）。route 挙動・本番ログを変えない。
//   - token 推定はしない（文字数ベースで十分）。
//   - orchestrator の estimatedChars / policy.maxContextChars と組み合わせて使える。

export type ContextBlock = {
  label: string;
  text: string;
  // 任意: このブロック単体の上限（超過を overBudget で示す）。
  maxChars?: number;
};

export type MeasuredBlock = {
  label: string;
  chars: number;
  overBudget: boolean;
  maxChars?: number;
};

export type ContextBudgetReport = {
  purpose?: string;
  baseChars: number;
  routeSpecificChars: number;
  totalChars: number;
  policyMaxContextChars?: number;
  isBaseOverBudget: boolean;
  isTotalOverBudget: boolean;
  blocks: MeasuredBlock[];
  warnings: string[];
};

/** 1 ブロックの文字数を測る。maxChars 指定時は超過を overBudget で返す。 */
export function measureTextBlock(label: string, text: string, maxChars?: number): MeasuredBlock {
  const chars = typeof text === 'string' ? text.length : 0;
  return {
    label,
    chars,
    overBudget: typeof maxChars === 'number' && chars > maxChars,
    ...(typeof maxChars === 'number' ? { maxChars } : {}),
  };
}

/** 複数ブロックをまとめて測る。 */
export function measureContextBlocks(blocks: ContextBlock[]): MeasuredBlock[] {
  return blocks.map((b) => measureTextBlock(b.label, b.text, b.maxChars));
}

/**
 * base context（orchestrated.systemPrompt など）と route 固有ブロックから budget report を作る。
 * policyMaxContextChars（= orchestrated.policy.maxContextChars）と比較して over budget を判定する。
 */
export function createContextBudgetReport(input: {
  purpose?: string;
  // base の文字数（orchestrated.estimatedChars または base テキストの length）。
  baseChars: number;
  // route が base に足す固有ブロック（任意）。
  routeSpecificBlocks?: ContextBlock[];
  // policy の目安上限（任意）。base / total と比較する。
  policyMaxContextChars?: number;
}): ContextBudgetReport {
  const baseChars = Math.max(0, Math.floor(input.baseChars) || 0);
  const routeBlocks = measureContextBlocks(input.routeSpecificBlocks ?? []);
  const routeSpecificChars = routeBlocks.reduce((sum, b) => sum + b.chars, 0);
  const totalChars = baseChars + routeSpecificChars;
  const max = input.policyMaxContextChars;

  const isBaseOverBudget = typeof max === 'number' && baseChars > max;
  const isTotalOverBudget = typeof max === 'number' && totalChars > max;

  const baseBlock: MeasuredBlock = {
    label: 'base',
    chars: baseChars,
    overBudget: isBaseOverBudget,
    ...(typeof max === 'number' ? { maxChars: max } : {}),
  };

  const warnings: string[] = [];
  if (isBaseOverBudget) warnings.push('base_over_budget');
  if (isTotalOverBudget) warnings.push('total_over_budget');

  return {
    ...(input.purpose ? { purpose: input.purpose } : {}),
    baseChars,
    routeSpecificChars,
    totalChars,
    ...(typeof max === 'number' ? { policyMaxContextChars: max } : {}),
    isBaseOverBudget,
    isTotalOverBudget,
    blocks: [baseBlock, ...routeBlocks],
    warnings,
  };
}

/** budget report を人が読めるテキストに整形する（self-check / dev 用）。 */
export function formatContextBudgetReport(report: ContextBudgetReport): string {
  const head = [
    `purpose: ${report.purpose ?? '(none)'}`,
    `base=${report.baseChars} + route=${report.routeSpecificChars} = total=${report.totalChars}` +
      (typeof report.policyMaxContextChars === 'number'
        ? ` / policyMax=${report.policyMaxContextChars}`
        : ''),
    report.warnings.length ? `warnings: ${report.warnings.join(', ')}` : 'warnings: none',
  ].join(' | ');
  const lines = report.blocks.map(
    (b) => `  - ${b.label}: ${b.chars}${b.overBudget ? ' (OVER)' : ''}`,
  );
  return [head, ...lines].join('\n');
}
