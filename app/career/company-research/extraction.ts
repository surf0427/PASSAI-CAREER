// PASSAI 就活版 — 企業研究 ファイルテキスト抽出（クライアント境界）
//
// 役割:
//   - ファイルの検証（形式・サイズ・件数）。
//   - text/plain はその場で読む（API 不要）。
//   - PDF / 画像（png/jpeg/webp）はサーバ API（/api/career/company-research/extract）へ送り、
//     埋め込みテキスト抽出 or Claude OCR の結果を受け取る。
//   - 抽出結果（extractedText / extractionStatus / extractionError）を CareerCompanyResearchFile に
//     まとめる。ファイル本体は保存しない（メタ + 抽出テキストのみ）。
//
// 抽出結果は AI添削に直接使わない。呼び出し側（do ページ）でユーザーが確認・修正し、
// verifiedResearchText に反映してから添削する流れを必ず通す。

import type {
  CareerCompanyResearchExtractionStatus,
  CareerCompanyResearchFile,
} from '@/types/careerCompanyResearch';

// 受け入れるファイル種別（PDF / 画像 / プレーンテキスト）。
export const ACCEPTED_FILE_ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.webp,.txt,application/pdf,image/png,image/jpeg,image/webp,text/plain';

// 1 ファイルあたりの上限・合計件数（server と一致させる）。
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_FILES = 8;

// 受け入れる MIME（拡張子のみのスクショ等にも耐えるよう、判定は isAcceptedFile で拡張子も見る）。
const ACCEPTED_MIME = new Set([
  'text/plain',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const ACCEPTED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt'];

export type ExtractionResult = {
  status: CareerCompanyResearchExtractionStatus;
  text: string;
  error?: string;
};

// SSR / 旧 runtime fallback 付き UUID。
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `crf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function ext(file: File): string {
  return file.name.split('.').pop()?.toLowerCase() ?? '';
}

// 拡張子 or MIME で受け入れ可否を判定する。
export function isAcceptedFile(file: File): boolean {
  if (ACCEPTED_EXTENSIONS.includes(ext(file))) return true;
  return ACCEPTED_MIME.has(file.type);
}

// 抽出前のメタ（pending）を作る。do ページが先に一覧へ出して「抽出中」を見せるために使う。
export function createPendingFile(
  file: File,
  uploadedAt: string,
): CareerCompanyResearchFile {
  return {
    id: newId(),
    fileName: file.name,
    fileType: file.type || ext(file) || 'unknown',
    fileSize: file.size,
    uploadedAt,
    extractedText: '',
    extractionStatus: 'pending',
  };
}

// 実抽出。text/* はローカル読取、それ以外はサーバ API（PDF 埋め込み or Claude OCR）。
// 将来の OCR 方式変更はサーバ側だけで完結する（本関数の呼び出し側は不変）。
export async function extractTextFromFile(file: File): Promise<ExtractionResult> {
  const isText = file.type.startsWith('text/') || ext(file) === 'txt';
  if (isText) {
    try {
      const text = (await file.text()).trim();
      return { status: text ? 'success' : 'manual_required', text };
    } catch {
      return { status: 'failed', text: '', error: 'テキストの読み取りに失敗しました。' };
    }
  }

  // PDF / 画像はサーバ API へ。
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/career/company-research/extract', {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      return {
        status: 'failed',
        text: '',
        error: data?.error ?? '自動抽出に失敗しました。内容を手動で貼り付けてください。',
      };
    }
    const data = (await res.json()) as {
      extractedText?: string;
      extractionStatus?: CareerCompanyResearchExtractionStatus;
      extractionError?: string;
    };
    const status: CareerCompanyResearchExtractionStatus =
      data.extractionStatus === 'success' ||
      data.extractionStatus === 'failed' ||
      data.extractionStatus === 'manual_required'
        ? data.extractionStatus
        : 'manual_required';
    return {
      status,
      text: typeof data.extractedText === 'string' ? data.extractedText : '',
      error: typeof data.extractionError === 'string' ? data.extractionError : undefined,
    };
  } catch {
    return {
      status: 'failed',
      text: '',
      error: '通信に失敗しました。内容を手動で貼り付けてください。',
    };
  }
}

// pending ファイルに抽出結果を適用した新しい CareerCompanyResearchFile を返す。
export function applyExtraction(
  file: CareerCompanyResearchFile,
  result: ExtractionResult,
): CareerCompanyResearchFile {
  return {
    ...file,
    extractedText: result.text,
    extractionStatus: result.status,
    extractionError: result.error,
  };
}
