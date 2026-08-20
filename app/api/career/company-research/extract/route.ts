// PASSAI 就活版 — 企業研究 ファイルテキスト抽出（OCR）API
//
// 役割: /career/company-research/do のアップロードから multipart/form-data でファイル 1 件を受け取り、
//       「資料に書かれている文字を抽出する」だけを行う。企業情報の生成・補完・要約・分析はしない。
//   - PDF: まず埋め込みテキストを抽出（pdfjs-dist）。テキストがほぼ無い画像PDFは Claude の
//          document ブロックで OCR にフォールバック。
//   - 画像（png/jpeg/webp）: Claude Vision（image ブロック）で原文抽出。
//   - text/plain: そのまま読む。
//   - 抽出結果は添削に直接使わない。返した extractedText をユーザーが確認・修正して
//     verifiedResearchText に反映する前提（本 API は添削しない）。
//
// 安全性 / 非接続方針:
//   - ANTHROPIC_API_KEY 未設定でも build / 実行を落とさない。未設定なら自動 OCR をスキップし
//     manual_required を返す（手入力・貼り付けフローは不変）。
//   - サーバ側でもサイズ・MIME を検証する。ファイル本体・base64 は一切保存しない（抽出して破棄）。
//   - 課金 / quota・usage 記録・DB / Supabase には接続しない。

import Anthropic from '@anthropic-ai/sdk';
import { anthropic } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import type { CareerCompanyResearchExtractionStatus } from '@/types/careerCompanyResearch';

// P0（HARDENING）: 認証 identity / rate limit / 入力サイズ上限の共通ガード。
import { guardCareerAiUpload } from '@/lib/careerApi/requestGuard';
import { CAREER_AI_RATE_LIMITS } from '@/lib/rateLimit';

// pdfjs / 画像 OCR は Node ランタイムが必要（Edge では動かさない）。
export const runtime = 'nodejs';
export const maxDuration = 80;

const MAX_BYTES = 10 * 1024 * 1024; // 1 ファイル 10MB（client と一致）
const ALLOWED_MIME = new Set([
  'text/plain',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const VISION_MODEL = 'claude-sonnet-4-6';
const VISION_MAX_TOKENS = 4096;
// PDF 埋め込みテキストがこの文字数未満なら「画像PDF」とみなして OCR へフォールバック。
const PDF_EMBEDDED_MIN_CHARS = 40;
// PDF の処理ページ上限（暴走・コスト保護）。
const PDF_MAX_PAGES = 30;

type ExtractResponse = {
  fileName: string;
  fileType: string;
  extractedText: string;
  extractionStatus: CareerCompanyResearchExtractionStatus;
  extractionError?: string;
};

// OCR 共通の system prompt（原文抽出のみ・推測/補完/要約/分析を禁止）。
const EXTRACTION_SYSTEM = [
  'あなたは資料から文字を抽出する OCR エンジンです。',
  '- この資料に含まれる文字を、できるだけ原文のまま抽出してください。',
  '- 企業情報を推測・補完・要約しないでください。',
  '- 読み取れない箇所は [判読不可] としてください。',
  '- 表や箇条書きは可能な範囲で構造を保ってください。',
  '- 資料内に企業名・事業内容・強み・弱み・競合・説明会メモ・志望理由などがあっても、',
  '  内容の正誤判定や分析はしないでください。',
  '- 出力は抽出テキストのみ。解説・アドバイス・前置き・後書きは一切不要です。',
].join('\n');

const EXTRACTION_USER_INSTRUCTION =
  'この資料の文字を、上記ルールに従ってそのまま抽出してください。出力は抽出テキストのみ。';

function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function imageMediaType(mime: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (mime === 'image/png') return 'image/png';
  if (mime === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

// Claude に content ブロック（document=PDF / image=画像）を渡して原文抽出する。
async function ocrWithClaude(
  block: Anthropic.Messages.ContentBlockParam,
): Promise<{ text: string; truncated: boolean }> {
  const message = await anthropic.messages.create(
    {
      model: VISION_MODEL,
      max_tokens: VISION_MAX_TOKENS,
      temperature: 0,
      system: EXTRACTION_SYSTEM,
      messages: [
        { role: 'user', content: [block, { type: 'text', text: EXTRACTION_USER_INSTRUCTION }] },
      ],
    },
    { signal: createTimeoutSignal() },
  );
  const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
  return { text: text.trim(), truncated: message.stop_reason === 'max_tokens' };
}

// PDF の埋め込みテキストを抽出する（pdfjs-dist / dynamic import）。
// 失敗時は例外を投げ、呼び出し側で OCR フォールバックさせる。
async function extractPdfEmbeddedText(data: Uint8Array): Promise<string> {
  // dynamic import で build 時の静的解決を避ける（壊れにくさ優先）。
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;
  try {
    const pages = Math.min(doc.numPages, PDF_MAX_PAGES);
    const parts: string[] = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => (typeof (item as { str?: unknown }).str === 'string'
          ? (item as { str: string }).str
          : ''))
        .join(' ')
        .replace(/\s+\n/g, '\n')
        .trim();
      if (line) parts.push(line);
    }
    return parts.join('\n\n').trim();
  } finally {
    // v6 では型上 destroy が露出しないことがあるため defensive に呼ぶ。
    await (doc as { destroy?: () => Promise<void> }).destroy?.().catch(() => {});
  }
}

function json(body: ExtractResponse, status = 200): Response {
  return Response.json(body, { status });
}

export async function POST(req: Request): Promise<Response> {
  // P0（HARDENING）: 認証 identity / rate limit の共通ガード。
  //   ★ formData() より前に通す。10MB の multipart を parse する前に 429 を返せるので、
  //     濫用時のコストが最小になる（Vision OCR は 1 call あたり最も高価）。
  //   ★ ファイルの MIME / サイズ検証は下の既存実装（ALLOWED_MIME / MAX_BYTES）が正本。
  const guard = await guardCareerAiUpload(req, {
    rules: {
      member: CAREER_AI_RATE_LIMITS.companyExtractMember,
      guest: CAREER_AI_RATE_LIMITS.companyExtractGuest,
    },
    label: 'company-research-extract',
  });
  if (!guard.ok) return guard.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: 'リクエストが不正です。' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File) || !(file instanceof Blob)) {
    return Response.json({ error: 'ファイルが見つかりません。' }, { status: 400 });
  }

  const fileName = typeof (file as File).name === 'string' ? (file as File).name : 'file';
  const fileType = file.type || '';

  // サーバ側でも MIME / サイズを検証する（defense in depth）。
  if (!ALLOWED_MIME.has(fileType)) {
    return Response.json(
      { error: '対応していないファイル形式です。' },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: 'ファイルサイズが大きすぎます。' }, { status: 413 });
  }

  // ── text/plain: その場で読む（OCR 不要） ──────────────────────────
  if (fileType === 'text/plain') {
    try {
      const text = (await file.text()).trim();
      return json({
        fileName,
        fileType,
        extractedText: text,
        extractionStatus: text ? 'success' : 'manual_required',
        extractionError: text ? undefined : 'テキストが空でした。',
      });
    } catch {
      return json({
        fileName,
        fileType,
        extractedText: '',
        extractionStatus: 'failed',
        extractionError: 'テキストの読み取りに失敗しました。',
      });
    }
  }

  const arrayBuffer = await file.arrayBuffer();

  // ── PDF: 埋め込みテキスト優先 → 不足なら Claude OCR ──────────────────
  if (fileType === 'application/pdf') {
    let embedded = '';
    try {
      embedded = await extractPdfEmbeddedText(new Uint8Array(arrayBuffer));
    } catch (err) {
      console.warn('Career company-research PDF embedded extraction failed:', err);
      embedded = '';
    }

    if (embedded.length >= PDF_EMBEDDED_MIN_CHARS) {
      return json({
        fileName,
        fileType,
        extractedText: embedded,
        extractionStatus: 'success',
      });
    }

    // 埋め込みテキストがほぼ無い（画像PDF）。
    if (!hasApiKey()) {
      return json({
        fileName,
        fileType,
        extractedText: embedded,
        extractionStatus: 'manual_required',
        extractionError:
          '画像PDFのようです。自動抽出は未設定のため、内容を手動で貼り付けてください。',
      });
    }
    try {
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const { text } = await ocrWithClaude({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      });
      const merged = [embedded, text].filter((s) => s.trim()).join('\n\n').trim();
      return json({
        fileName,
        fileType,
        extractedText: merged,
        extractionStatus: merged ? 'success' : 'manual_required',
        extractionError: merged
          ? undefined
          : '画像PDFのため自動抽出できませんでした。内容を手動で貼り付けてください。',
      });
    } catch (err) {
      console.error('Career company-research PDF OCR failed:', err);
      return json({
        fileName,
        fileType,
        extractedText: embedded,
        extractionStatus: 'failed',
        extractionError: '自動抽出に失敗しました。時間をおくか、内容を手動で貼り付けてください。',
      });
    }
  }

  // ── 画像（png/jpeg/webp）: Claude Vision で原文抽出 ────────────────
  if (!hasApiKey()) {
    return json({
      fileName,
      fileType,
      extractedText: '',
      extractionStatus: 'manual_required',
      extractionError: '自動抽出は未設定です。内容を手動で貼り付けてください。',
    });
  }
  try {
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const { text } = await ocrWithClaude({
      type: 'image',
      source: { type: 'base64', media_type: imageMediaType(fileType), data: base64 },
    });
    return json({
      fileName,
      fileType,
      extractedText: text,
      extractionStatus: text ? 'success' : 'manual_required',
      extractionError: text
        ? undefined
        : '文字を読み取れませんでした。内容を手動で貼り付けてください。',
    });
  } catch (err) {
    console.error('Career company-research image OCR failed:', err);
    return json({
      fileName,
      fileType,
      extractedText: '',
      extractionStatus: 'failed',
      extractionError: '自動抽出に失敗しました。時間をおくか、内容を手動で貼り付けてください。',
    });
  }
}
