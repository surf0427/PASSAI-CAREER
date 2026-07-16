/*
 * scripts/career-es-cross-feature-closeout-qa.ts
 *
 * PASSAI CAREER — ES Final Closeout: interview / consultation の「本人本文（body）伝播」決定論 QA。
 *
 * 背景（ES Final Closeout 監査で確定した 2 欠陥の回帰ガード）:
 *   ESトレーニングシステム化以降、新ログは AI 代筆の 4 field を持たず、ユーザー本人が書いた本文
 *   （`result.answer = body` 投影）だけを持つ。matching / presentation は body 投影済みだったが、
 *     - Defect #1 interview: renderEs が旧 4 field のみ描画し、body-only ログで ES ブロックが空。
 *     - Defect #2 consultation: normalizeEsHistory が body を落とし、hasContent / formatter も body 非対応で、
 *       body-only ログが相談 AI へ届かない。
 *   本 QA は「body-only ログが interview / consultation のどこでも消えない」ことを固定する。
 *
 * 厳守:
 *   - production code は import して呼ぶだけ（route / prompt / AI / DB / Supabase / env / secret 非接続）。
 *   - 外部 AI・network・localStorage を使わない純粋 fixture のみ。
 *   - 旧生成ログの byte 互換（body を持たないログの出力）を壊さないことも併せて検証する。
 *
 * 使い方: npx tsx scripts/career-es-cross-feature-closeout-qa.ts
 * 終了コード: 全 assertion PASS → 0 / いずれか FAIL → 1。
 */

import type { CareerEsLog, CareerEsResult } from '@/types/careerEs';
import { renderEs, buildInterviewCrossFeatureContext } from '@/lib/careerMemory/renderers/interviewCrossFeature';
import { buildInterviewSnapshot, type CareerMemorySnapshotInput } from '@/lib/careerMemory/snapshot';
import {
  buildEsHistory,
  normalizeEsHistory,
  formatEsHistoryForPrompt,
} from '@/lib/careerConsultation/historySnapshots';
import { buildMatchingEsSummary } from '@/lib/careerMemory/matchingEs';
import { buildPresentationEsSummary } from '@/lib/careerMemory/presentationEs';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`);
  if (!ok) failures++;
};
const section = (t: string) => console.log(`\n# ${t}`);

// ── fixtures ──────────────────────────────────────────────────────
// 空の CareerEsResult 土台（esStorage.emptyEsResult と同形。id/日付生成に依存しないため inline）。
const emptyResult = (): CareerEsResult => ({
  gakuchika: '',
  selfPr: '',
  motivation: '',
  headline: '',
  appealPoints: [],
  interviewQuestions: [],
  improvements: [],
});

// 本人が書いた ES（ESトレーニングシステムの canonical ログ。result.answer に body を投影）。
const authoredLog = (
  body: string,
  question = '学生時代に力を入れたことを教えてください',
  companyName = '株式会社サンプル',
  createdAt = '2026-07-10T00:00:00.000Z',
): CareerEsLog => ({
  id: `authored-${createdAt}`,
  createdAt,
  userInput: '',
  result: { ...emptyResult(), answer: body },
  body,
  question,
  companyName,
  mode: 'write',
  version: 1,
});

// 旧生成ログ（AI 代筆時代・4 field 中心。body / answer なし）。
const legacyLog = (createdAt = '2026-05-01T00:00:00.000Z'): CareerEsLog => ({
  id: `legacy-${createdAt}`,
  createdAt,
  userInput: '',
  result: {
    ...emptyResult(),
    headline: '挑戦を続ける人間',
    gakuchika: '長期インターンで新規事業に挑戦した',
    selfPr: '課題を構造化し周囲を巻き込む力',
    motivation: '事業の社会的意義に共感している',
  },
  question: '自己PRを教えてください',
  companyName: 'レガシー株式会社',
});

// snapshot input の最小土台（ES 以外は空でよい）。
const baseInput = (esLogs: CareerEsLog[]): CareerMemorySnapshotInput => ({
  profile: null,
  activity: null,
  values: null,
  selfAnalysisLogs: [],
  esLogs,
  interviewResults: [],
  presentationResults: [],
  companyResearchLogs: [],
  matchingLogs: [],
  gdResults: [],
  gdRoomLogs: [],
  consultationThreads: [],
});

// ══════════════════════════════════════════════════════════════════
// Defect #1 — Interview
// ══════════════════════════════════════════════════════════════════
section('Interview: renderEs body propagation');

const bodyText = '私はゼミ活動で仮説検証プロセスの改善を主導し、離脱率を20%改善しました。';

// 1) body-only ログで本文が render される（空にならない）。
const rBodyOnly = renderEs(authoredLog(bodyText).result);
check(rBodyOnly === `- 本文: ${bodyText}`, 'body-only ログで本文が render される（空でない）');
check(rBodyOnly.trim() !== '', 'body-only render 結果が非空（必須 assert）');

// 2) 旧生成ログは従来どおり 4 field（本文行を足さない＝byte 互換）。
const rLegacy = renderEs(legacyLog().result);
check(rLegacy.includes('- キャッチコピー:') && rLegacy.includes('- ガクチカ:'), '旧生成ログは 4 field が出る');
check(!rLegacy.includes('- 本文:'), '旧生成ログに本文行を足さない（byte 互換）');

// 3) body + 旧 4 field 併存（防御）→ 旧 field 優先で本文行を出さない。
const rBoth = renderEs({ ...legacyLog().result, answer: bodyText });
check(!rBoth.includes('- 本文:'), 'body+旧4field 併存では本文行を出さない（旧 byte 互換維持）');

// 4) 設問モード legacy（answer のみ・4 field 空）→ 本文 fallback で出る。
const rAnswerOnly = renderEs({ ...emptyResult(), answer: '設問モードの回答本文です' });
check(rAnswerOnly === '- 本文: 設問モードの回答本文です', 'legacy answer-only は本文 fallback で出る');

// 5) 完全空（4 field も answer も空）→ 空文字（block ごと落ちる現状）。
check(renderEs({ ...emptyResult(), answer: '' }) === '', '4 field も本文も空 → 空文字');
check(renderEs(null) === '', 'null → 空文字');
check(renderEs(undefined) === '', 'undefined → 空文字');

// 6) 空白のみ body → content 扱いしない（空文字）。
check(renderEs({ ...emptyResult(), answer: '   \n  ' }) === '', '空白のみ body は content 扱いしない');

// 7) 長文 body は cap / truncate されない（面接は cap なし現状を維持）。
const longBody = 'あ'.repeat(1200);
const rLong = renderEs({ ...emptyResult(), answer: longBody });
check(rLong.includes(longBody) && !rLong.includes('…'), '長文 body は truncate されない');

// 8) 改行を含む body は内部改行を保持（外側 trim のみ）。
const rNl = renderEs({ ...emptyResult(), answer: '  1行目\n2行目  ' });
check(rNl === '- 本文: 1行目\n2行目', '改行を含む body は内部改行を保持し外側のみ trim');

// 9) 決定論（同入力で同出力・純関数）。
check(renderEs(authoredLog(bodyText).result) === rBodyOnly, 'renderEs は決定論（同入力→同出力）');

// 10) orchestrator context block に本文が届く（見出し + 本文）。
const ivBlock = buildInterviewCrossFeatureContext({ es: authoredLog(bodyText).result });
check(ivBlock.includes('# 直近の ES ドラフト'), 'body-only でも ES 見出しブロックが出る');
check(ivBlock.includes(bodyText), 'context block に本文が含まれる');

// 11) es=null のときはブロックごと落ちる（従来どおり）。
check(!buildInterviewCrossFeatureContext({ es: null }).includes('# 直近の ES ドラフト'), 'es=null は ES ブロックを出さない');

// 12) snapshot は esLogs[0].result を渡す（canonical latest）。newest-first の先頭ログの本文が出る。
const snapLatest = buildInterviewSnapshot(
  baseInput([
    authoredLog('最新版の本文です', 'q', 'Co', '2026-07-15T00:00:00.000Z'),
    authoredLog('古い版の本文です', 'q', 'Co', '2026-07-01T00:00:00.000Z'),
  ]),
);
check(renderEs(snapLatest.es).includes('最新版の本文です'), 'snapshot は esLogs[0]（canonical latest）の本文を出す');
check(!renderEs(snapLatest.es).includes('古い版の本文です'), '古い版の本文は出さない');

// 13) review を本人本文として扱わない（authored log に review があっても本文は body のみ）。
const reviewed: CareerEsLog = {
  ...authoredLog(bodyText),
  review: {
    overallScore: 80,
    rank: 'A',
    overallComment: 'AIレビューの総評テキスト',
    breakdown: { logic: 80, specificity: 80, originality: 80, readability: 80, persuasion: 80, companyFit: 80 },
    strengths: ['良い点'],
    improvements: ['改善点'],
    missingElements: ['不足要素'],
    recruiterComments: ['採用担当コメント'],
    priorityActions: ['優先改善'],
  },
};
check(!renderEs(reviewed.result).includes('AIレビュー'), 'interview: review 文面を本人本文として出さない');

// ══════════════════════════════════════════════════════════════════
// Defect #2 — Consultation
// ══════════════════════════════════════════════════════════════════
section('Consultation: body propagation through normalize / gate / format');

// 14) client buildEsHistory が body を捕捉する。
const clientHist = buildEsHistory([authoredLog(bodyText)]);
check(clientHist.length === 1 && clientHist[0].body === bodyText, 'buildEsHistory が body を捕捉する');

// 15) client: body-only ログが drop されない。
check(buildEsHistory([authoredLog(bodyText)]).length === 1, 'buildEsHistory は body-only ログを残す');

// 16) server normalizeEsHistory が body を保持する（round-trip）。
const normed = normalizeEsHistory(clientHist);
check(normed.length === 1 && normed[0].body === bodyText, 'normalizeEsHistory が body を保持する');

// 17) body-only が hasContent を通過する（gate で消えない）。
const normBodyOnly = normalizeEsHistory([{ createdAt: '2026-07-10', question: 'q', body: bodyText }]);
check(normBodyOnly.length === 1, 'body-only snapshot が hasContent を通る（必須 assert）');

// 18) 空白のみ body かつ legacy 無し → drop（content 扱いしない）。
check(normalizeEsHistory([{ createdAt: '2026-07-10', body: '   ' }]).length === 0, '空白のみ body は破棄される');

// 19) malformed body（string 以外）→ 無視。legacy があれば残る。
const normMalformed = normalizeEsHistory([{ createdAt: '2026-07-10', body: 123, gakuchika: 'ガクチカ本文' }]);
check(normMalformed.length === 1 && normMalformed[0].body === undefined, 'malformed body は無視（legacy で残る）');

// 20) formatter が本文を出力する。
const fmtAuthored = formatEsHistoryForPrompt(normed);
check(fmtAuthored.includes(`本文:${bodyText}`), 'formatEsHistoryForPrompt が本文を出力する');
check(fmtAuthored.includes('# ESの推移'), 'formatter が ES 推移見出しを出す');

// 21) body 優先（both 併存でも本文を出し旧 field を出さない）。
const bothSnap = normalizeEsHistory([
  { createdAt: '2026-07-10', question: 'q', body: bodyText, gakuchika: 'ガクチカ本文', selfPr: '自己PR本文', motivation: '志望動機本文' },
]);
const fmtBoth = formatEsHistoryForPrompt(bothSnap);
check(fmtBoth.includes(`本文:${bodyText}`) && !fmtBoth.includes('ガクチカ:'), 'formatter は body 優先（旧 field を出さない）');

// 22) legacy fallback（body 無し → 旧 field を出す・従来 byte 契約）。
const fmtLegacy = formatEsHistoryForPrompt(normalizeEsHistory(buildEsHistory([legacyLog()])));
check(
  fmtLegacy.includes('ガクチカ:') && fmtLegacy.includes('自己PR:') && fmtLegacy.includes('志望動機:') && !fmtLegacy.includes('本文:'),
  'legacy ログは旧 field を出す（本文行なし・byte 互換）',
);

// 23) review を本文として扱わない（EsHistorySnapshot に review は無い。本文は body のみ）。
check(!fmtAuthored.includes('AIレビュー') && !fmtAuthored.includes('採用担当'), 'consultation: review を本人本文として出さない');

// 24) 長文 body は 200 字 + '…' に truncate される。
const longNorm = normalizeEsHistory([{ createdAt: '2026-07-10', body: 'あ'.repeat(500) }]);
check(longNorm.length === 1, '長文 body-only も残る');
check(longNorm[0].body!.length === 201 && longNorm[0].body!.endsWith('…'), '長文 body は 200 字 + … に truncate');

// 25) question / company が保持される（head 行）。
const qcHist = normalizeEsHistory(buildEsHistory([authoredLog(bodyText, '固有の設問文', 'ユニーク商事')]));
const fmtQc = formatEsHistoryForPrompt(qcHist);
check(fmtQc.includes('設問:固有の設問文'), 'question が formatter に出る');
check(fmtQc.includes('ユニーク商事'), 'companyName が head に出る');

// 26) 複数履歴の順序が保たれる（canonical order・入力順）。
const multi = normalizeEsHistory(
  buildEsHistory([
    authoredLog('新しい本文A', 'qA', 'A社', '2026-07-15T00:00:00.000Z'),
    authoredLog('古い本文B', 'qB', 'B社', '2026-07-01T00:00:00.000Z'),
  ]),
);
const fmtMulti = formatEsHistoryForPrompt(multi);
check(fmtMulti.indexOf('新しい本文A') < fmtMulti.indexOf('古い本文B'), '複数履歴の順序（canonical）が保たれる');

// 27) client→server parity: buildEsHistory→normalize→format の end-to-end で本文が最終テキストへ到達。
const e2e = formatEsHistoryForPrompt(normalizeEsHistory(buildEsHistory([authoredLog('エンドツーエンド本文')])));
check(e2e.includes('本文:エンドツーエンド本文'), 'body-only ログが最終 prompt テキストへ到達する（必須 assert）');

// 28) body-only ログが normalize / gate / format のどこでも消えない（統合 assert）。
const survives =
  buildEsHistory([authoredLog(bodyText)]).length === 1 &&
  normalizeEsHistory(buildEsHistory([authoredLog(bodyText)])).length === 1 &&
  formatEsHistoryForPrompt(normalizeEsHistory(buildEsHistory([authoredLog(bodyText)]))).includes(bodyText);
check(survives, 'body-only ログが normalize/gate/format のどこでも消えない（必須 assert）');

// ══════════════════════════════════════════════════════════════════
// Regression — matching / presentation は変更していないが body 投影が維持されていること
// ══════════════════════════════════════════════════════════════════
section('Regression: matching / presentation body projection intact');

const mSum = buildMatchingEsSummary(authoredLog(bodyText).result, { body: bodyText, question: '自己PRを教えてください' });
check(mSum !== null && mSum.selfPr.includes('私はゼミ活動'), 'matching: body が selfPr へ投影される（回帰なし）');

const pSum = buildPresentationEsSummary(authoredLog(bodyText).result, { body: bodyText, question: '自己PRを教えてください' });
check(pSum !== null && pSum.selfPr.includes('私はゼミ活動'), 'presentation: body が selfPr へ投影される（回帰なし）');

check(buildMatchingEsSummary(null) === null && buildPresentationEsSummary(null) === null, 'matching/presentation: result 無しは null（null 安全維持）');

// ── result ────────────────────────────────────────────────────────
console.log('');
console.log(failures === 0 ? '✓ all assertions passed' : `✗ ${failures} assertion(s) failed`);
process.exit(failures === 0 ? 0 : 1);
