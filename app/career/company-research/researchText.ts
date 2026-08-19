// PASSAI 就活版 — 企業研究 素材 → 企業分析対象テキストの合成（純関数のみ）
//
// 役割: 手入力メモ / 貼り付けテキスト / ファイル抽出テキストを **決定論的に** 1 本へ結合する。
//   - 旧「素材を確認欄にまとめる」ボタンと同一ロジック（挙動を変えずに手動操作だけ廃止した）。
//   - ★ ここに AI call は無い（あってはならない）。純粋な文字列結合のみ。
//     企業分析の AI call は /api/career/company-research の 1 本だけで、
//     その入力本文をここで組み立てる。
//   - React / next / fetch に依存しないので、単体で QA から検証できる。

import type { CareerCompanyResearchFile } from '@/types/careerCompanyResearch';

/** 手入力メモ + 貼り付け + 各ファイル抽出テキストを 1 本にまとめる（順序固定＝決定論）。 */
export function combineSources(
  manualMemo: string,
  pastedText: string,
  files: CareerCompanyResearchFile[],
): string {
  const parts: string[] = [];
  if (manualMemo.trim()) parts.push(manualMemo.trim());
  if (pastedText.trim()) parts.push(pastedText.trim());
  files.forEach((f) => {
    if (f.extractedText.trim()) parts.push(`【${f.fileName}】\n${f.extractedText.trim()}`);
  });
  return parts.join('\n\n');
}

/** ファイル群の抽出テキストだけを連結（input.extractedText = OCR/抽出の生テキスト）。 */
export function combineFileExtracts(files: CareerCompanyResearchFile[]): string {
  return files
    .filter((f) => f.extractedText.trim())
    .map((f) => `【${f.fileName}】\n${f.extractedText.trim()}`)
    .join('\n\n');
}

/**
 * 素材（手入力メモ / 貼り付け / ファイル抽出）が 1 つでもあるか。
 * 旧ログ（確認欄に直接書いただけで素材が空）の後方互換判定に使う。
 */
export function hasAnyMaterial(
  manualMemo: string,
  pastedText: string,
  files: CareerCompanyResearchFile[],
): boolean {
  return (
    manualMemo.trim() !== '' ||
    pastedText.trim() !== '' ||
    files.some((f) => f.extractedText.trim() !== '')
  );
}
