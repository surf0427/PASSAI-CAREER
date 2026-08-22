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
//   - 自由文から企業名を「推測」しない。今回の発話から企業を拾う経路
//     （resolveConsultationCompanyMentions）はあるが、照合できるのは **既に Company Master /
//     Alias に存在する名前だけ**で、identity の確定は既存 resolver（buildCompanyResolveResult）が
//     行う。NER / LLM / 類似度 / 外部検索は一切使わない。辞書に無い企業は作らないし使わない。
//
// A 層（企業の一次情報）と B 層（ユーザー本人の企業研究メモ）は別経路・別 block。
// B 層は従来どおり resolveContextInputs.ts / consultationCrossFeature が扱う。ここでは触らない。

import 'server-only';

import type { CompanyOfficialReadResult } from '@/types/careerCompanyOfficial';
import { loadCompanyOfficialContext } from '@/lib/careerCompanyOfficial/readRepository.server';
import { loadCompanyMentionDictionary } from '@/lib/careerCompanyIdentity/mentionDictionary.server';
import { detectCompanyMentions, foldMessageForMention } from '@/lib/careerCompanyIdentity/mentionMatch';
import type { CompanyMentionDictionary } from '@/lib/careerCompanyIdentity/mentionDictionary.server';
import { buildCompanyResolveResult } from '@/lib/careerCompanyIdentity/resolution';
import { normalizeCompanyName } from '@/lib/careerCompanyKnowledge/identity';
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
 * 1 社あたりは renderer の purpose budget（consultation: 3400B）で抑えているが、
 * 3 社載ると合計が User Data Spine / Personal Memory / 出力形式を押し出しうる。
 * 2 社（比較・内定比較）までは全量、3 社目は総枠に収まるときだけ載る。
 * 総枠を超える社は **載せない**（要約せず落とす。renderer と同じ思想）。
 */
export const CONSULTATION_COMPANY_TOTAL_MAX_BYTES = 6800;

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

/**
 * 「今回の発話で企業そのものを相談している」ことを示す最小マーカー。
 *
 * ★ COMPANY_CONTEXT_KEYWORDS を広げるのではなく **別集合**にしている理由:
 *   これらは単体では一般語すぎる（「どう」「教えて」「？」）。**今回の発話に辞書一致した企業名がある**
 *   ときにだけ併用することで、「任天堂ってどう？」「味の素について教えて」を拾いつつ、
 *   企業名を含まない一般相談には一切影響させない。
 *
 * ★ 疑問符を含めている理由（grounding 上とても重要）:
 *   企業名を挙げた質問（「A 社って転勤多い？」）で Company block を **注入しない**と、
 *   grounding 規約（USAGE_NOTE_CONSULTATION）ごと prompt から消えるため、
 *   モデルが一般知識で企業固有の事実を語り出す（実 AI probe で再現）。
 *   多少の空振り（「A 社のゲーム面白い？」で block が載る）を許容してでも、
 *   **企業名を挙げた質問には必ず出典と扱い規約を添える**方が安全側に倒れる。
 */
const COMPANY_MENTION_INTENT_MARKERS: readonly string[] = [
  'どう', 'どんな', 'どれ', '教えて', 'おしえて', 'について', 'ってあり', '合いそう', '合うかな',
  '？', '?',
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

/** 今回の発話から既存 identity resolver で確定した企業言及。 */
export type ConsultationCompanyMention = {
  companyId: string;
  displayName: string;
  /** 文中で一致した正規化 token（必要判定の除去にも使う）。 */
  matchedToken: string;
  /** 折りたたみ後本文での出現位置（発話順を決める）。 */
  at: number;
};

/** 判定用に、与えられた名前群を本文から取り除く（社名の字面で誤発火させないため）。 */
function stripNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of names) {
    if (typeof name === 'string' && name !== '') out = out.split(name).join('');
    const folded = foldMessageForMention(typeof name === 'string' ? name : '');
    if (folded !== '') out = out.split(folded).join('');
  }
  return out;
}

/** 候補のうち haystack に現れたものを出現順で最大 max 件返す（純関数）。 */
function pickFromMessage(
  candidates: readonly ConsultationCompanyCandidate[],
  haystack: string,
  max: number,
): ConsultationCompanyCandidate[] {
  const hits: Array<{ at: number; candidate: ConsultationCompanyCandidate }> = [];
  for (const candidate of candidates) {
    const at = haystack.indexOf(candidate.companyName);
    if (at >= 0) hits.push({ at, candidate });
  }
  hits.sort((a, b) => a.at - b.at);
  return hits.slice(0, max).map((h) => h.candidate);
}

/**
 * 今回の発話から、**既に Company Master / Alias に存在する企業**の言及を解決する
 * （server・never-throw / fail-open）。
 *
 * 流れ:
 *   message → 辞書照合（detectCompanyMentions・longest match / 曖昧 span は捨てる）
 *           → 既存 identity resolver（buildCompanyResolveResult）で **resolved のみ**採用
 *           → 出現順・最大 max 社
 *
 * ★ 辞書に無い企業名は候補にならない（新規登録も外部検索もしない）。
 * ★ resolver が ambiguous / unresolved を返したものは採用しない（曖昧なら使わない）。
 * ★ 「Master にいる = Company Data Spine がある」ではない。公式情報の可否は
 *   後段の loadCompanyOfficialContext + renderer が判定する（facts 0 なら prompt 非注入）。
 *
 * @param loadDictionary DI（QA から差し替えるための seam。既定は実 loader）。
 */
export async function resolveConsultationCompanyMentions(
  message: string,
  loadDictionary: (nowMs?: number) => Promise<CompanyMentionDictionary> = loadCompanyMentionDictionary,
  max: number = CONSULTATION_COMPANY_MAX,
): Promise<{ mentions: ConsultationCompanyMention[]; dictionaryQueries: number }> {
  const text = normalize(message);
  if (text === '') return { mentions: [], dictionaryQueries: 0 };

  let dictionary: CompanyMentionDictionary;
  try {
    dictionary = await loadDictionary();
  } catch {
    return { mentions: [], dictionaryQueries: 0 };
  }
  if (dictionary.entries.length === 0) {
    return { mentions: [], dictionaryQueries: dictionary.queries };
  }

  const detected = detectCompanyMentions(text, dictionary.entries);
  const mentions: ConsultationCompanyMention[] = [];

  for (const hit of detected) {
    // ★ 最終権限は既存 resolver。辞書 hit をそのまま企業として採用しない。
    //   照合対象は「その token を持つ企業だけ」ではなく **辞書全体**にする
    //   （別企業が同名 alias を持っていれば ambiguous になり、採用されない）。
    const records = dictionary.entries.map((e) => ({
      companyId: e.companyId,
      displayName: e.displayName,
      normalizedName: e.tokens[0] ?? '',
      aliases: e.tokens,
      corporateGroupId: null,
    }));
    const resolved = buildCompanyResolveResult(hit.matchedToken, records);
    if (resolved.status !== 'resolved') continue;
    if (mentions.some((m) => m.companyId === resolved.companyId)) continue;
    mentions.push({
      companyId: resolved.companyId,
      displayName: resolved.displayName,
      matchedToken: hit.matchedToken,
      at: hit.at,
    });
    if (mentions.length >= max) break;
  }

  return { mentions, dictionaryQueries: dictionary.queries };
}

/**
 * 今回の turn で公式情報を読む企業を選ぶ（純関数・決定論）。
 *
 * 判定:
 *   1. 相談自体が企業文脈を要するか（社名を除いた本文で consultationNeedsCompanyContext）。
 *      ただし今回の発話に **辞書一致した企業言及**があれば、相談マーカー（どう / 教えて / について 等）
 *      でも成立させる（「任天堂ってどう？」を拾うため。企業言及が無い turn には影響しない）。
 *   2. 今回の発話で解決済みの企業言及（mentions）を最優先で採用（出現順）。
 *   3. 次に、本人の構造化データ候補のうち **今回のメッセージに現れたもの**。
 *   4. 今回のメッセージに無ければ、直近のユーザー発話（最大 2 turn）に現れたものを採用
 *      （「A社について〜」→「じゃあ志望動機は？」のような follow-up を拾う）。
 *   5. どこにも現れなければ 0 社（＝ Company Data Spine を読まない）。
 *
 * dedupe は **companyId 単位**（「任天堂」と「任天堂株式会社」を 2 社にしない）。
 * companyId を持たない構造化候補は正規化名で突き合わせる。
 */
export function selectConsultationCompanyTargets(input: {
  message: string;
  history?: readonly { role?: unknown; content?: unknown }[] | null;
  candidates: readonly ConsultationCompanyCandidate[];
  /** 今回の発話から既存 identity resolver で解決済みの企業（resolveConsultationCompanyMentions の出力）。 */
  mentions?: readonly ConsultationCompanyMention[];
  max?: number;
}): ConsultationCompanyCandidate[] {
  const max = input.max ?? CONSULTATION_COMPANY_MAX;
  const message = normalize(input.message);
  const mentions = [...(input.mentions ?? [])].sort((a, b) => a.at - b.at);
  if (message === '' || (input.candidates.length === 0 && mentions.length === 0)) return [];

  // 社名を除いた本文で「企業を論点にしているか」を判定する（社名の字面で誤発火させない）。
  //   ★ 自由文で一致した企業名も除去対象に含める（「株式会社◯◯」の "会社" で誤発火させない）。
  const strippedNames = [
    ...input.candidates.map((c) => c.companyName),
    ...mentions.map((m) => m.matchedToken),
    ...mentions.map((m) => m.displayName),
  ];
  const needsByKeyword = consultationNeedsCompanyContext(message, strippedNames);
  const needsByMention =
    mentions.length > 0 &&
    COMPANY_MENTION_INTENT_MARKERS.some((marker) =>
      stripNames(foldMessageForMention(message), strippedNames).includes(marker),
    );
  if (!needsByKeyword && !needsByMention) return [];

  // 今回の発話で解決済みの企業言及が最優先（保存データに無くても届く経路）。
  if (mentions.length > 0) {
    const fromMentions = mentions.slice(0, max).map((m) => ({
      companyName: m.displayName,
      companyId: m.companyId,
    }));
    const remaining = max - fromMentions.length;
    if (remaining <= 0) return fromMentions;
    // 余枠があれば、同 turn に現れた構造化候補を companyId / 正規化名で dedupe しつつ足す。
    const takenIds = new Set(fromMentions.map((c) => c.companyId).filter((id): id is string => !!id));
    const takenNames = new Set(fromMentions.map((c) => normalizeCompanyName(c.companyName)));
    const extra = pickFromMessage(input.candidates, message, remaining).filter((c) => {
      if (c.companyId && takenIds.has(c.companyId)) return false;
      return !takenNames.has(normalizeCompanyName(c.companyName));
    });
    return [...fromMentions, ...extra];
  }

  const inMessage = pickFromMessage(input.candidates, message, max);
  if (inMessage.length > 0) return inMessage;

  // 直近のユーザー発話（新しい順に最大 2 件）を follow-up の文脈として見る。
  const recentUserTurns = (input.history ?? [])
    .filter((m) => m?.role === 'user' && typeof m?.content === 'string')
    .slice(-2)
    .map((m) => m.content as string)
    .reverse();
  for (const turn of recentUserTurns) {
    const hit = pickFromMessage(input.candidates, turn, max);
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
