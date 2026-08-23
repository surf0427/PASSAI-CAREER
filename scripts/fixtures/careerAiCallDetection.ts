/*
 * scripts/fixtures/careerAiCallDetection.ts
 *
 * QA 用の共有ヘルパ — **Anthropic の実 network call を呼び出し形に依存せず検出する**。
 *
 * ── なぜ必要か ────────────────────────────────────────────────────────
 *   複数の QA が「auth / paid / quota の guard が AI 到達より前にあるか」「AI call は
 *   意図した本数か」を検証している。以前はその検出を
 *     src.indexOf('anthropic.messages.create')
 *   という **呼び出し形の literal** で行っていた。
 *
 *   その後、長い出力での HTTP timeout を避けるため一部 route が streaming へ移行し
 *     await anthropic.messages
 *       .stream({...}, { signal })
 *       .finalMessage()
 *   という形になった。literal は当然マッチせず、QA は
 *     「AI call が存在しない」→ 順序比較が -1 で常に false
 *   と **誤って落ちる**（＝ security が壊れたのではなく検出器が古い）。
 *
 *   逆に、これを「guard が存在すればよい」まで緩めると、AI call の**前**に guard が
 *   あることを検証できなくなり false negative だらけになる。
 *   そこで「呼び出し形は問わないが、実 network call の位置は正確に取る」検出器を
 *   1 箇所に置き、各 QA はそれを使って **順序**と**本数**を検証する。
 *
 * ★ ここは検出器であって仕様ではない。新しい呼び出し形（例: batches）が増えたら
 *   ANTHROPIC_CALL_PATTERN に足す。足し忘れると QA が「call が無い」と誤検出するため、
 *   assertAnthropicCallDetected() で「1 件も見つからない」を明示的な失敗にできる。
 */

/**
 * Anthropic SDK の実呼び出し。
 *
 *   anthropic.messages.create( ... )
 *   anthropic.messages
 *     .stream( ... )
 *
 * `messages` と `.create/.stream` の間の改行・インデントを許容する。
 * `client.messages.create(` のような別名 receiver も拾えるよう receiver は緩めに取り、
 * `.messages` に続くことを必須にして誤検出を防ぐ。
 */
export const ANTHROPIC_CALL_PATTERN =
  /(?:anthropic|client|ai)\s*\.\s*messages\s*\.\s*(create|stream)\s*\(/g;

/** 行コメント・ブロックコメントを落とす（説明文中の旧 literal を拾わないため）。 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      // 文字列中の '//'（URL 等）を消さないよう、行頭〜// までに引用符が無い場合のみ落とす。
      if (i < 0) return l;
      const before = l.slice(0, i);
      const quotes = (before.match(/['"`]/g) ?? []).length;
      return quotes % 2 === 0 ? before : l;
    })
    .join('\n');
}

/** 実 AI call の呼び出し形を出現順に返す（コメントは除外）。 */
export function listAnthropicCallForms(src: string): ('create' | 'stream')[] {
  const code = stripComments(src);
  const out: ('create' | 'stream')[] = [];
  for (const m of code.matchAll(ANTHROPIC_CALL_PATTERN)) {
    out.push(m[1] as 'create' | 'stream');
  }
  return out;
}

/** 実 AI call の本数（コメントは除外）。 */
export function countAnthropicCalls(src: string): number {
  return listAnthropicCallForms(src).length;
}

/**
 * **最初の** 実 AI call の位置（コメント除去後の index）。無ければ -1。
 *
 * ★ 順序比較に使うときは、比較相手も必ず同じ `stripComments()` 後の文字列から
 *   index を取ること（index 空間を揃えないと比較が壊れる）。
 *   そのため通常は findAnthropicCallIndexIn(codeOf(src)) の形で使う。
 */
export function findAnthropicCallIndex(code: string): number {
  const re = new RegExp(ANTHROPIC_CALL_PATTERN.source, '');
  const m = re.exec(code);
  return m ? m.index : -1;
}

/**
 * 順序検証のための共通形。
 *
 * `code` は **stripComments 済み**を渡すこと。返り値は各 marker の index と AI call の index。
 * marker が見つからない場合は -1 を返すので、呼び出し側で「存在すること」も併せて検証する。
 */
export function locateGuardOrder(
  code: string,
  markers: readonly string[],
): { markerIndexes: number[]; aiIndex: number } {
  return {
    markerIndexes: markers.map((m) => code.indexOf(m)),
    aiIndex: findAnthropicCallIndex(code),
  };
}
