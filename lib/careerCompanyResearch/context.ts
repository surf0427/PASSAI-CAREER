// PASSAI 就活版 — 企業研究ログを他機能へ渡すための共通整形ヘルパー（純粋関数）
//
// 役割: 企業研究ログ（CareerCompanyResearchLog）を、ES・相談AI・将来の面接機能で使い回せる
//       軽量スナップショット（CompanyResearchSnapshot）に整形し、さらにプロンプト用テキストへ整える。
//   - verifiedResearchText の長すぎる部分は抜粋に短縮する。
//   - review / fitAnalysis / interviewContextSummary をプロンプト用に要約する。
//   - null / 旧ログ（フィールド欠損）にも耐える。
//   - 企業研究ログ全文を無制限に API へ送らない（件数・文字数を制限）。
//
// 本ファイルは DOM / localStorage / Supabase に触れない純粋関数のみ（client / server 双方から使う）。

import {
  CAREER_COMPANY_INTEREST_LABELS,
  type CareerCompanyResearchLog,
  type CompanyResearchSnapshot,
} from '@/types/careerCompanyResearch';
// P4-B: str を共通 util へ集約（truncate は suffix '…（以下略）' が異なるため未統合・local 維持）。
import { str } from '@/lib/careerMemory/summaryUtils';

// 既定の制限値。
const DEFAULT_LIMIT = 5; // 相談AI など複数渡しの最大件数
const DEFAULT_VERIFIED_PREVIEW = 280; // 一覧コンテキストの抜粋文字数
// 個別選択（ES など 1 件を深く使う）ときの抜粋文字数。
export const SINGLE_VERIFIED_PREVIEW = 1200;

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).trim()}…（以下略）`;
}

// review を 1 行の要約に整える（断定ではなく「本人メモへの添削」結果）。
function summarizeReview(log: CareerCompanyResearchLog): string | undefined {
  const r = log.review;
  if (!r) return undefined;
  const parts: string[] = [];
  if (typeof r.overallScore === 'number' && r.rank) {
    parts.push(`理解度スコア ${r.overallScore}点（${r.rank}）`);
  }
  if (str(r.overallComment)) parts.push(str(r.overallComment));
  if (r.missingInfo?.length) parts.push(`不足: ${r.missingInfo.slice(0, 3).join('、')}`);
  if (r.weakAssumptions?.length) {
    parts.push(`根拠不足の指摘: ${r.weakAssumptions.slice(0, 2).join('、')}`);
  }
  const text = parts.join(' / ');
  return text ? text : undefined;
}

// fitAnalysis を 1 行の要約に整える。
function summarizeFit(log: CareerCompanyResearchLog): string | undefined {
  const f = log.fitAnalysis;
  if (!f) return undefined;
  const parts: string[] = [];
  if (str(f.selfAnalysisFit)) parts.push(`自己分析: ${str(f.selfAnalysisFit)}`);
  if (str(f.valuesFit)) parts.push(`就活軸: ${str(f.valuesFit)}`);
  if (str(f.activityFit)) parts.push(`活動: ${str(f.activityFit)}`);
  if (str(f.matchingFit)) parts.push(`マッチング: ${str(f.matchingFit)}`);
  if (f.gaps?.length) parts.push(`ギャップ: ${f.gaps.slice(0, 3).join('、')}`);
  if (f.strengthsToUse?.length) {
    parts.push(`活かせる強み: ${f.strengthsToUse.slice(0, 3).join('、')}`);
  }
  const text = parts.join(' / ');
  return text ? text : undefined;
}

// verifiedResearchText（無ければ手入力・抽出・貼り付け）を抜粋する。
function verifiedPreview(
  log: CareerCompanyResearchLog,
  maxChars: number,
): string | undefined {
  const input = log.input;
  const source =
    str(input?.verifiedResearchText) ||
    str(input?.manualMemo) ||
    str(input?.extractedText) ||
    str(input?.pastedText);
  if (!source) return undefined;
  return truncate(source, maxChars);
}

export type BuildSnapshotOptions = {
  // 抜粋の最大文字数（既定 280）。ES で 1 件を深く使うときは SINGLE_VERIFIED_PREVIEW。
  verifiedTextMaxChars?: number;
};

// 1 件のログ → 軽量スナップショット。
export function buildCompanyResearchSnapshot(
  log: CareerCompanyResearchLog,
  options: BuildSnapshotOptions = {},
): CompanyResearchSnapshot {
  const maxChars = options.verifiedTextMaxChars ?? DEFAULT_VERIFIED_PREVIEW;
  const snapshot: CompanyResearchSnapshot = {
    logId: log.id,
    companyName: str(log.companyName) || str(log.input?.companyName),
    updatedAt: str(log.updatedAt) || str(log.createdAt),
  };
  // Company Identity（Phase A / R3）: 紐付いていれば運ぶ。欠損が正常（旧ログ・未登録企業）。
  // ★ prompt 整形（format*ForPrompt）には出さない。突き合わせ用の識別子であり文脈ではない。
  const companyId = str(log.companyId) || str(log.input?.companyId);
  if (companyId) snapshot.companyId = companyId;
  const industry = str(log.industry) || str(log.input?.industry);
  if (industry) snapshot.industry = industry;
  const interestLevel = log.interestLevel ?? log.input?.interestLevel ?? null;
  if (interestLevel) snapshot.interestLevel = interestLevel;

  const preview = verifiedPreview(log, maxChars);
  if (preview) snapshot.verifiedResearchTextPreview = preview;
  const reviewSummary = summarizeReview(log);
  if (reviewSummary) snapshot.reviewSummary = reviewSummary;
  const fitSummary = summarizeFit(log);
  if (fitSummary) snapshot.fitSummary = fitSummary;
  const ics = str(log.interviewContextSummary);
  if (ics) snapshot.interviewContextSummary = ics;

  return snapshot;
}

export type BuildContextOptions = BuildSnapshotOptions & {
  // 最大件数（既定 5）。最新更新順に詰める。
  limit?: number;
  // 個別に選ばれたログ。先頭へ優先配置する。
  selectedLogId?: string;
};

// 複数ログ → スナップショット配列（最新更新順・件数制限・選択優先）。
export function buildCompanyResearchContext(
  logs: CareerCompanyResearchLog[] | null | undefined,
  options: BuildContextOptions = {},
): CompanyResearchSnapshot[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const valid = (logs ?? []).filter(
    (l): l is CareerCompanyResearchLog =>
      !!l && typeof l.id === 'string' && !!(str(l.companyName) || str(l.input?.companyName)),
  );
  const sorted = [...valid].sort((a, b) =>
    (str(b.updatedAt) || str(b.createdAt)).localeCompare(str(a.updatedAt) || str(a.createdAt)),
  );
  let ordered = sorted;
  if (options.selectedLogId) {
    const sel = sorted.filter((l) => l.id === options.selectedLogId);
    const rest = sorted.filter((l) => l.id !== options.selectedLogId);
    ordered = [...sel, ...rest];
  }
  return ordered
    .slice(0, limit)
    .map((l) => buildCompanyResearchSnapshot(l, { verifiedTextMaxChars: options.verifiedTextMaxChars }));
}

// API 側で受け取った snapshot（unknown）を防御的に正規化する。
export function normalizeCompanyResearchSnapshot(raw: unknown): CompanyResearchSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const companyName = str(r.companyName);
  if (!companyName) return null;
  const snapshot: CompanyResearchSnapshot = {
    logId: str(r.logId),
    companyName,
    updatedAt: str(r.updatedAt),
  };
  if (str(r.companyId)) snapshot.companyId = str(r.companyId);
  if (str(r.industry)) snapshot.industry = str(r.industry);
  if (
    r.interestLevel === 'high' ||
    r.interestLevel === 'mid' ||
    r.interestLevel === 'low' ||
    r.interestLevel === 'watch'
  ) {
    snapshot.interestLevel = r.interestLevel;
  }
  if (str(r.verifiedResearchTextPreview)) {
    snapshot.verifiedResearchTextPreview = str(r.verifiedResearchTextPreview);
  }
  if (str(r.reviewSummary)) snapshot.reviewSummary = str(r.reviewSummary);
  if (str(r.fitSummary)) snapshot.fitSummary = str(r.fitSummary);
  if (str(r.interviewContextSummary)) {
    snapshot.interviewContextSummary = str(r.interviewContextSummary);
  }
  return snapshot;
}

// ── 面接AI 連携 ───────────────────────────────────────────────────
// 面接では verifiedResearchText 全文を渡さず、要約（interviewContextSummary / fitSummary /
// reviewSummary）を優先する。抜粋は短く（トークン節約）。
const INTERVIEW_PREVIEW_CHARS = 200;

export type InterviewCompanyResearchContext = {
  logId: string;
  companyName: string;
  industry?: string;
  interestLevel?: CareerCompanyResearchLog['interestLevel'];
  // 面接連携用要約を最優先で使う。
  interviewContextSummary?: string;
  fitSummary?: string;
  reviewSummary?: string;
  // 必要最小限の短い抜粋（任意）。
  verifiedResearchTextPreview?: string;
};

// CompanyResearchSnapshot を面接用コンテキストへ写す（updatedAt 等は落とす）。
function snapshotToInterviewContext(
  snapshot: CompanyResearchSnapshot,
): InterviewCompanyResearchContext {
  const ctx: InterviewCompanyResearchContext = {
    logId: snapshot.logId,
    companyName: snapshot.companyName,
  };
  if (snapshot.industry) ctx.industry = snapshot.industry;
  if (snapshot.interestLevel) ctx.interestLevel = snapshot.interestLevel;
  if (snapshot.interviewContextSummary) ctx.interviewContextSummary = snapshot.interviewContextSummary;
  if (snapshot.fitSummary) ctx.fitSummary = snapshot.fitSummary;
  if (snapshot.reviewSummary) ctx.reviewSummary = snapshot.reviewSummary;
  if (snapshot.verifiedResearchTextPreview) {
    ctx.verifiedResearchTextPreview = snapshot.verifiedResearchTextPreview;
  }
  return ctx;
}

// 企業研究ログ 1 件 → 面接用コンテキスト（要約優先・短い抜粋）。
export function buildInterviewCompanyResearchContext(
  log: CareerCompanyResearchLog,
): InterviewCompanyResearchContext {
  const snapshot = buildCompanyResearchSnapshot(log, {
    verifiedTextMaxChars: INTERVIEW_PREVIEW_CHARS,
  });
  return snapshotToInterviewContext(snapshot);
}

// API 受信側の防御正規化（面接用コンテキスト）。
export function normalizeInterviewCompanyResearchContext(
  raw: unknown,
): InterviewCompanyResearchContext | null {
  const snapshot = normalizeCompanyResearchSnapshot(raw);
  if (!snapshot) return null;
  return snapshotToInterviewContext(snapshot);
}

// 面接用コンテキストをプロンプトブロックへ整形する（空なら空文字）。
// 面接官が「ユーザー本人の企業研究を前提に深掘りする」ための文脈 + 行動指針を含める。
export function formatInterviewCompanyResearchForPrompt(
  ctx: InterviewCompanyResearchContext | null | undefined,
): string {
  if (!ctx || !ctx.companyName) return '';
  const metas: string[] = [];
  if (ctx.industry) metas.push(`業界: ${ctx.industry}`);
  if (ctx.interestLevel) metas.push(`志望度: ${CAREER_COMPANY_INTEREST_LABELS[ctx.interestLevel]}`);
  const lines = [
    '【企業研究コンテキスト（ユーザー本人が作成・保存したもの）】',
    `企業名: ${ctx.companyName}${metas.length ? `（${metas.join('・')}）` : ''}`,
  ];
  if (ctx.interviewContextSummary) {
    lines.push(`企業研究の要約（面接連携メモ）: ${ctx.interviewContextSummary}`);
  }
  if (ctx.fitSummary) lines.push(`本人との適合分析: ${ctx.fitSummary}`);
  if (ctx.reviewSummary) lines.push(`AI添削サマリ: ${ctx.reviewSummary}`);
  if (ctx.verifiedResearchTextPreview) {
    lines.push(`本人記述の抜粋: ${ctx.verifiedResearchTextPreview}`);
  }
  lines.push(
    '',
    'この面接では以下を意識してください:',
    '- ユーザー自身が行った企業研究を前提にし、その内容理解を深掘りする（企業研究の代行はしない）。',
    '- 「なぜその企業／その点に興味を持ったのか」「企業研究で注目した点は何か」を掘る。',
    '- その注目点が本人の経験・自己分析とどうつながるかを掘る。',
    '- 競合と比較してどう考えているか、入社後にどう活かしたいかを確認する。',
    '- 志望理由の具体性を確認する。',
    '- 企業情報を断定しない。売上・IR数字の暗記確認や企業クイズ（事業セグメントを全部言わせる等）はしない。',
    '- 「あなたの企業研究を見る限り」「保存済みメモでは」「追加確認が必要ですが」という文体を使い、保存済み企業研究を根拠に質問する。',
  );
  return lines.join('\n');
}

// スナップショット配列をプロンプト用テキストへ整形する。空なら空文字。
export function formatCompanyResearchContextForPrompt(
  snapshots: CompanyResearchSnapshot[] | null | undefined,
): string {
  if (!snapshots || snapshots.length === 0) return '';
  return snapshots
    .map((s) => {
      const metas: string[] = [];
      if (s.industry) metas.push(`業界: ${s.industry}`);
      if (s.interestLevel) metas.push(`志望度: ${CAREER_COMPANY_INTEREST_LABELS[s.interestLevel]}`);
      if (s.updatedAt) metas.push(`更新: ${s.updatedAt.slice(0, 10)}`);
      const head = `■ ${s.companyName || '（企業名なし）'}${metas.length ? `（${metas.join('・')}）` : ''}`;
      const lines = [head];
      if (s.verifiedResearchTextPreview) {
        lines.push(`- 企業研究メモ（本人記述の抜粋）: ${s.verifiedResearchTextPreview}`);
      }
      if (s.reviewSummary) lines.push(`- AI添削サマリ: ${s.reviewSummary}`);
      if (s.fitSummary) lines.push(`- 本人情報とのすり合わせ: ${s.fitSummary}`);
      if (s.interviewContextSummary) lines.push(`- 面接連携メモ: ${s.interviewContextSummary}`);
      return lines.join('\n');
    })
    .join('\n\n');
}
