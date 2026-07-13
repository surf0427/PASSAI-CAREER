// PASSAI CAREER — Personal Memory canary gate（P16-G / pure evaluator + parsers）。
//
// 責務: shadow write の canary 限定に使う「user allowlist / section allowlist」の **純粋な parse と判定**。
//   env / server client / I/O を持たない（server env の読取は canaryConfig.server.ts の責務）。決定的・testable。
//
// ★ 方針:
//   - **default deny / fail-closed**。allowlist が空・invalid・cap 超過は「許可なし」。
//   - config invalid（不正 UUID 混入・unknown section 混入・wildcard/all）は **設定全体を deny** にする。
//   - exact match のみ（substring 一致しない）。UUID を case 変換で壊さない（trim のみ）。
//   - 値（UUID / section）を外部へ露出しない（本 module は log しない・戻り値に生 env を含めない）。

import {
  CAREER_PERSONAL_MEMORY_SECTION_KEYS,
  type CareerPersonalMemorySectionKey,
} from './schema';

// allowlist に載せてよい user 数の上限（防御。運用上 canary は少人数）。
export const CAREER_CANARY_MAX_USER_IDS = 50;

// UUID v1-5 の緩い形（Supabase auth.users.id は UUID）。大文字小文字は許容するが変換しない。
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// parse 結果（valid=false は「設定全体 deny」）。
export type ParsedUserIds =
  | { valid: true; userIds: readonly string[] }
  | { valid: false };
export type ParsedSections =
  | { valid: true; sections: readonly CareerPersonalMemorySectionKey[] }
  | { valid: false };

// comma-separated UUID を parse。trim / 重複除去 / 空要素除去。
//   - 空文字（要素なし）→ valid だが allowlist 空（＝誰も許可されない）。
//   - 不正形式が 1 件でも → **設定全体 invalid（default deny）**。
//   - cap 超過 → invalid。
export function parseCanaryUserIds(raw: unknown): ParsedUserIds {
  if (raw === undefined || raw === null) return { valid: true, userIds: [] };
  if (typeof raw !== 'string') return { valid: false };
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 0) return { valid: true, userIds: [] };
  const seen = new Set<string>();
  for (const p of parts) {
    if (!UUID_RE.test(p)) return { valid: false }; // 不正形式 1 件で全体 deny
    seen.add(p); // 重複除去（exact）
  }
  if (seen.size > CAREER_CANARY_MAX_USER_IDS) return { valid: false };
  return { valid: true, userIds: [...seen] };
}

// comma-separated section を parse。許可値は MVP 4 section のみ。
//   - unknown / wildcard / 'all' → **設定全体 invalid（default deny）**。
//   - 空 → valid だが allowlist 空。
export function parseCanarySections(raw: unknown): ParsedSections {
  if (raw === undefined || raw === null) return { valid: true, sections: [] };
  if (typeof raw !== 'string') return { valid: false };
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 0) return { valid: true, sections: [] };
  const allowed = new Set<string>(CAREER_PERSONAL_MEMORY_SECTION_KEYS as readonly string[]);
  const seen = new Set<CareerPersonalMemorySectionKey>();
  for (const p of parts) {
    // wildcard / all / unknown は明示的に拒否（allowed set に無いものは全部 invalid）。
    if (!allowed.has(p)) return { valid: false };
    seen.add(p as CareerPersonalMemorySectionKey);
  }
  return { valid: true, sections: [...seen] };
}

// parse 済み config（両 allowlist）。どちらか invalid なら valid=false（設定全体 deny）。
export type CanaryConfig = {
  valid: boolean;
  userIds: readonly string[];
  sections: readonly CareerPersonalMemorySectionKey[];
};

export function buildCanaryConfig(userIdsRaw: unknown, sectionsRaw: unknown): CanaryConfig {
  const u = parseCanaryUserIds(userIdsRaw);
  const s = parseCanarySections(sectionsRaw);
  if (!u.valid || !s.valid) return { valid: false, userIds: [], sections: [] };
  return { valid: true, userIds: u.userIds, sections: s.sections };
}

// 純粋判定: allow iff config valid かつ userId が allowlist に exact 一致かつ section が allowlist に exact 一致。
//   userId は server 検証済みの authenticated user id を渡す（client 申告値は渡さない）。
export function evaluateCanaryGate(
  userId: string | null | undefined,
  section: string,
  config: CanaryConfig,
): boolean {
  if (!config.valid) return false;
  if (typeof userId !== 'string' || userId === '') return false;
  if (!config.userIds.includes(userId)) return false; // exact match（substring しない）
  if (!(config.sections as readonly string[]).includes(section)) return false;
  return true;
}
