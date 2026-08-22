// PASSAI CAREER — 就活相談（司令塔）: Company Data Spine A 層（公式情報）の解決。
//
// 役割:
//   相談内容が **企業を論点にしている turn だけ**、既に Data Spine に存在する
//   Company Official Facts を読み、prompt 用の 1 本の block 文字列にして route へ返す。
//
// ★ 本モジュールが「しない」こと（Scope の中核）:
//   - 新しい企業検索・crawler・fetcher・enrichment を起動しない。
//     取得（prefetch / refresh / TTL）は lib/careerCompanyPrefetch の別 pipeline の責務。
//     ここは **既に存在する readable snapshot を読むだけ**（面接 / ES / GD と同じ契約）。
//   - 独自の企業名 resolver を作らない。identity 解決は既存の
//     findCompanyCandidates + buildCompanyResolveResult（loadCompanyOfficialContext 内部）に委ねる。
//     ambiguous / unresolved は「公式情報なし」に倒す（誤った企業の事実を prompt へ載せない）。
//   - 自由文から企業名を抽出（NER）しない。候補は **本人が既に構造化データとして持っている
//     企業名**（志望企業 / 企業研究メモ / ES 履歴）に限る。推測で企業を特定しない。
//
// A 層（企業の一次情報）と B 層（ユーザー本人の企業研究メモ）は別経路・別 block。
// B 層は従来どおり resolveContextInputs.ts / consultationCrossFeature が扱う。ここでは触らない。

import 'server-only';

import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
import { loadCompanyOfficialContext } from '@/lib/careerCompanyOfficial/readRepository.server';
import { renderCompanyOfficialForPurpose } from '@/lib/careerContextRenderers/companyOfficialContext';

/** 相談で企業文脈の対象になりうる企業（本人の構造化データ由来）。 */
export type ConsultationCompanyCandidate = {
  companyName: string;
  /** 企業研究メモ等が canonical company id を持っていれば最優先で使う。 */
  companyId: string | null;
};

/**
 * 1 turn で載せる企業数の上限。
 *
 * 相談の主戦場は「1 社の深掘り」と「2 社比較（併願 / 内定比較）」。3 社目までは実務上ありうるが、
 * それ以上は budget を食い潰すだけで判断の質は上がらない（軸の比較は 2〜3 社が限界）。
 */
export const CONSULTATION_COMPANY_MAX = 3;

/**
 * 企業 block 全体の byte 上限（社数 × 1 社あたり budget の上に被せる総枠）。
 *
 * 1 社あたりは renderer の purpose budget（consultation: 2600B）で抑えているが、
 * 3 社載ると合計が User Data Spine / Personal Memory / 出力形式を押し出しうる。
 * 2 社（比較・内定比較）までは全量、3 社目は総枠に収まるときだけ載る。
 * 総枠を超える社は **載せない**（要約せず落とす。renderer と同じ思想）。
 */
export const CONSULTATION_COMPANY_TOTAL_MAX_BYTES = 5600;

/**
 * 企業文脈が「判断の質を変える」相談かを判定するキーワード。
 *
 * ★ 企業名が会話に出ただけでは resolve しない（req: 毎回 fetch しない）。
 *   企業を **論点にしている**（比較 / 志望動機 / 選考対策 / 入社判断 / 適性）ことを要求する。
 */
const COMPANY_CONTEXT_KEYWORDS: readonly string[] = [
  // 比較・意思決定
  'どっち', 'どちら', '比較', '迷', '選ぶ', '選択', '決め', '優先',
  '内定', '承諾', '辞退', '入社',
  // 志望・適性
  '志望', '動機', '向いて', '合って', '合う', '相性', 'フィット', '受ける', '受けよう', 'エントリー',
  // 選考
  '面接', '選考', 'ES', 'エントリーシート', 'GD', 'グループディスカッション', '逆質問', '対策',
  // 企業理解
  '企業', '会社', '事業', '社風', 'カルチャー', '働き方', '将来性', '強み', 'リスク',
];

function normalize(text: string): string {
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * 相談 turn が企業文脈を必要とするか（純関数・DB に触れない）。
 *
 * ★ 企業名そのものは判定から除く。「株式会社」「〇〇会社」のような社名は
 *   キーワード（会社 / 企業 / 事業 …）と字面が重なるため、社名が入っているだけで
 *   常に true になってしまう（＝「企業名が出ただけで fetch しない」という要件が壊れる）。
 *   呼び出し側は、今回マッチした企業名を除いた文字列を渡すこと。
 */
export function consultationNeedsCompanyContext(message: string, companyNames: readonly string[] = []): boolean {
  let m = normalize(message);
  if (m === '') return false;
  for (const name of companyNames) {
    if (name) m = m.split(name).join('');
  }
  return COMPANY_CONTEXT_KEYWORDS.some((kw) => m.includes(kw));
}

/**
 * 本人の構造化データから「相談対象になりうる企業名」を集める（純関数）。
 *
 * ★ 自由文からの企業名抽出はしない。ここに挙がるのは、本人が
 *   志望企業として登録した / 企業研究メモを書いた / ES を書いた 企業だけ。
 *   Data Spine に存在しても本人と無関係な企業は候補にならない（無関係な企業の注入を防ぐ）。
 */
export function collectConsultationCompanyCandidates(input: {
  targetCompanies?: readonly string[] | null;
  companyResearch?: readonly { companyName?: unknown; companyId?: unknown }[] | null;
  esHistory?: readonly { companyName?: unknown }[] | null;
}): ConsultationCompanyCandidate[] {
  const out: ConsultationCompanyCandidate[] = [];
  const seen = new Set<string>();

  const push = (rawName: unknown, rawId: unknown) => {
    const companyName = normalize(typeof rawName === 'string' ? rawName : '');
    if (companyName === '') return;
    const key = companyName.toLowerCase();
    const companyId = normalize(typeof rawId === 'string' ? rawId : '') || null;
    const existing = out.find((c) => c.companyName.toLowerCase() === key);
    if (existing) {
      // 同名候補に後から companyId が付いたら昇格させる（identity が確実な方を優先）。
      if (!existing.companyId && companyId) existing.companyId = companyId;
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ companyName, companyId });
  };

  // 企業研究メモを最優先（companyId を持ちうる＝identity が確実）。
  for (const r of input.companyResearch ?? []) push(r?.companyName, r?.companyId);
  for (const name of input.targetCompanies ?? []) push(name, null);
  for (const e of input.esHistory ?? []) push(e?.companyName, null);

  return out;
}

/**
 * 今回の turn で公式情報を読む企業を選ぶ（純関数・決定論）。
 *
 * 判定:
 *   1. 相談自体が企業文脈を要するか（社名を除いた本文で consultationNeedsCompanyContext）。要さないなら 0 社。
 *   2. 候補企業名のうち **今回のメッセージに現れたもの**を優先して採用。
 *   3. 今回のメッセージに無ければ、直近のユーザー発話（最大 2 turn）に現れたものを採用
 *      （「A社について〜」→「じゃあ志望動機は？」のような follow-up を拾う）。
 *   4. どこにも現れなければ 0 社（＝ DB を叩かない）。
 *
 * 出現順は「メッセージ中の登場順」で決定的に並べる（A社とB社 → [A社, B社]）。
 */
export function selectConsultationCompanyTargets(input: {
  message: string;
  history?: readonly { role?: unknown; content?: unknown }[] | null;
  candidates: readonly ConsultationCompanyCandidate[];
  max?: number;
}): ConsultationCompanyCandidate[] {
  const max = input.max ?? CONSULTATION_COMPANY_MAX;
  const message = normalize(input.message);
  if (message === '' || input.candidates.length === 0) return [];
  // 社名を除いた本文で「企業を論点にしているか」を判定する（社名の字面で誤発火させない）。
  if (!consultationNeedsCompanyContext(message, input.candidates.map((c) => c.companyName))) return [];

  const pick = (haystack: string): ConsultationCompanyCandidate[] => {
    const hits: Array<{ at: number; candidate: ConsultationCompanyCandidate }> = [];
    for (const candidate of input.candidates) {
      const at = haystack.indexOf(candidate.companyName);
      if (at >= 0) hits.push({ at, candidate });
    }
    hits.sort((a, b) => a.at - b.at);
    return hits.slice(0, max).map((h) => h.candidate);
  };

  const inMessage = pick(message);
  if (inMessage.length > 0) return inMessage;

  // 直近のユーザー発話（新しい順に最大 2 件）を follow-up の文脈として見る。
  const recentUserTurns = (input.history ?? [])
    .filter((m) => m?.role === 'user' && typeof m?.content === 'string')
    .slice(-2)
    .map((m) => m.content as string)
    .reverse();
  for (const turn of recentUserTurns) {
    const hit = pick(turn);
    if (hit.length > 0) return hit;
  }
  return [];
}

export type ConsultationCompanyOfficialResult = {
  /** prompt へ載せる block（複数社を結合済み。載せるものが無ければ ''）。 */
  block: string;
  /** 観測用: 実際に block へ載った企業名。 */
  rendered: string[];
  /** 観測用: 読みに行ったが block へ載らなかった企業名（未登録 / 事実なし / budget 超過）。 */
  skipped: string[];
};

const EMPTY_RESULT: ConsultationCompanyOfficialResult = { block: '', rendered: [], skipped: [] };

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 対象企業の公式情報を読み、prompt block を組み立てる（never-throw / fail-open）。
 *
 * 返り値 block が '' なら「公式情報を prompt へ載せない」。
 * 未解決 / 未登録 / fact 0 件 / flag OFF / read 失敗はすべて '' に倒れ、相談は常に成立する
 * （A 層なし → B 層（企業研究メモ）→ 会話内の情報、の順で従来どおり回答できる）。
 *
 * @param loadContext DI（QA から差し替えるための seam。既定は実 read repository）。
 */
export async function resolveConsultationCompanyOfficial(
  targets: readonly ConsultationCompanyCandidate[],
  nowIso: string,
  loadContext: (q: {
    companyId?: string | null;
    companyName?: string | null;
    nowIso: string;
  }) => Promise<CompanyOfficialReadResult> = loadCompanyOfficialContext,
): Promise<ConsultationCompanyOfficialResult> {
  if (targets.length === 0) return EMPTY_RESULT;

  const blocks: string[] = [];
  const rendered: string[] = [];
  const skipped: string[] = [];
  let usedBytes = 0;

  for (const target of targets.slice(0, CONSULTATION_COMPANY_MAX)) {
    let result: CompanyOfficialReadResult;
    try {
      result = await loadContext({
        companyId: target.companyId,
        companyName: target.companyName,
        nowIso,
      });
    } catch {
      // read repository 自体が never-throw だが、import / 初期化の失敗でも相談を止めない。
      skipped.push(target.companyName);
      continue;
    }

    // moderation / provenance / freshness / allowlist / budget はすべて renderer が強制する。
    //   unavailable / disabled は必ず '' になる（「情報が無い」を負の事実として書かない）。
    const block = renderCompanyOfficialForPurpose('consultation', result);
    if (!block.used || block.text === '') {
      skipped.push(target.companyName);
      continue;
    }

    const next = usedBytes + byteLength(block.text);
    if (next > CONSULTATION_COMPANY_TOTAL_MAX_BYTES) {
      // 総枠超過 → **要約せずに落とす**（先に採用した企業の情報は削らない）。
      skipped.push(target.companyName);
      continue;
    }

    blocks.push(block.text);
    rendered.push(target.companyName);
    usedBytes = next;
  }

  // 1 社も載らなくても skipped は落とさない（観測のため。block は '' で相談は継続）。
  if (blocks.length === 0) return { block: '', rendered: [], skipped };
  return { block: blocks.join('\n\n'), rendered, skipped };
}
