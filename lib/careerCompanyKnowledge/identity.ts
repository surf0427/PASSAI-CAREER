/**
 * Company Knowledge (Layer 5) — company canonical identity / alias（P17-A §6.1）。
 *
 * free-text 企業名を即座に確定 ID へ変換しない。ambiguous / unresolved を型で表現し、
 * alias collision（同一 alias が複数 company を指す）を検出する。
 * synthetic fixture のみ使用。外部企業 DB / API を使わない。pure・決定論。
 */

import type {
  AliasCollision,
  CompanyCanonicalId,
  CompanyIdentityAdjustment,
  CompanyIdentityResolution,
  CompanyMasterRecord,
} from '@/types/careerCompanyKnowledge';

// ── 法人格の正規化（P0 修復・2026-08-16）─────────────────────────────
//
// 旧実装は `s.split(token).join('')` の **substring 除去**だったため、法人格語が
// 名称の一部に現れる企業名を破壊していた:
//   - `Lincoln`   → `loln`   （'inc' が語中に出現）
//   - `Principal` → `pripal` （同上）
// さらに `株式会社ABC` と `有限会社ABC` が両方 `abc` に潰れ、**別法人が同一 normalized
// token になる**（誤 merge。career_company_master は append-only で in-app 訂正手段が無い）。
//
// 修復方針:
//   1. 法人格は **語頭 / 語末の token boundary でのみ**除去する（語中は絶対に触らない）。
//   2. 法人格を 2 種に分ける。
//      - DEFAULT   : 省略しても同一法人を指すのが慣行のもの（株式会社 / Inc. / Ltd. / Corp. …）
//                    → 落とす。`ソニー` == `ソニー株式会社` を成立させる本体。
//      - DISTINCT  : 省略すると **別法人と区別できなくなる**もの（有限会社 / 合同会社 / LLC …）
//                    → 落とさず、ASCII の form tag として保持する。
//   3. form tag は `<core>#<tag>` 形式（tag は ASCII のみ）。tag 自体は法人格 token に
//      一致しないため、正規化は **冪等**（normalize(normalize(x)) === normalize(x)）。
//      既存コードは `normalizeCompanyName(m.normalizedName)` のように正規化済み文字列を
//      再度通す（identity.ts / repository.server.ts）ため、この冪等性は不変条件。
//   4. transliteration（漢字→ローマ字等）は **実装しない**。`任天堂` != `Nintendo` は
//      仕様どおりで、両者を結ぶ唯一の手段は alias（registration.ts の設計）。

/** form tag の区切り。ASCII のみで構成し、法人格 token と衝突させない。 */
const FORM_TAG_SEPARATOR = '#';

/** 落としてよい日本語法人格（省略しても同一法人を指すのが慣行）。長い順に並べる。 */
const JP_DEFAULT_FORMS: readonly string[] = ['株式会社', '(株)'];

/**
 * 落とすと別法人と区別できなくなる日本語法人格 → ASCII form tag。
 * ★ ここから要素を削ると誤 merge が発生する。追加は安全・削除は危険。
 */
const JP_DISTINCT_FORMS: readonly (readonly [string, string])[] = [
  ['特定非営利活動法人', 'npo'],
  ['一般社団法人', 'ippanshadan'],
  ['一般財団法人', 'ippanzaidan'],
  ['公益社団法人', 'koekishadan'],
  ['公益財団法人', 'koekizaidan'],
  ['独立行政法人', 'dokugyo'],
  ['社会福祉法人', 'shakaifukushi'],
  ['農業協同組合', 'nokyo'],
  ['生活協同組合', 'seikyo'],
  ['学校法人', 'gakko'],
  ['医療法人', 'iryo'],
  ['宗教法人', 'shukyo'],
  ['有限会社', 'yugen'],
  ['合同会社', 'godo'],
  ['合資会社', 'goshi'],
  ['合名会社', 'gomei'],
  ['(有)', 'yugen'],
];

/** 落としてよい英語法人格 token（token 単位で完全一致した場合のみ）。 */
const EN_DEFAULT_FORMS: ReadonlySet<string> = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'ltd',
  'limited',
  'co',
  'company',
  'coltd',
  'kk',
]);

/** 落とすと別法人と区別できなくなる英語法人格 token → form tag。 */
const EN_DISTINCT_FORMS: ReadonlyMap<string, string> = new Map([
  ['llc', 'llc'],
  ['llp', 'llp'],
  ['lp', 'lp'],
  ['plc', 'plc'],
  ['gmbh', 'gmbh'],
  ['ag', 'ag'],
  ['nv', 'nv'],
  ['bv', 'bv'],
  ['pty', 'pty'],
  ['oyj', 'oyj'],
  ['sarl', 'sarl'],
  ['srl', 'srl'],
  ['sas', 'sas'],
]);

/** token 比較用に句読点を落とす（`co.,` → `co` / `l.l.c.` → `llc`）。 */
function toComparableToken(token: string): string {
  return token.replace(/[.,]/g, '');
}

/**
 * 幅・互換文字を揃える（`㈱`/`（株）` → `(株)`、全角英数 → 半角、全角空白 → 半角空白）。
 * NFKC は決定論であり、環境差を持ち込まない。
 */
function foldWidth(value: string): string {
  try {
    return value.normalize('NFKC');
  } catch {
    return value;
  }
}

/**
 * 企業名を正規化する（pure・決定論・never-throw・冪等）。
 *
 * 契約:
 *   - 法人格は **語頭 / 語末でのみ**除去する（`Lincoln` / `Principal` を壊さない）。
 *   - DISTINCT な法人格は `<core>#<tag>` として保持する（`株式会社ABC` != `有限会社ABC`）。
 *   - script は跨がない（`任天堂` != `Nintendo`）。結合は alias の責務。
 *   - core が空になる除去は行わない（`株式会社` 単体は '' のまま）。
 */
export function normalizeCompanyName(raw: string): string {
  if (typeof raw !== 'string') return '';

  let s = foldWidth(raw).toLowerCase().replace(/\s+/g, ' ').trim();
  if (s === '') return '';

  const formTags = new Set<string>();

  // ── 日本語法人格（空白なしで密着するため文字列の前後で判定する）──────────
  // 前後どちらか 1 箇所を落とすたびに再走査する（`株式会社ABC株式会社` のような重複表記に耐える）。
  for (let guard = 0; guard < 8; guard += 1) {
    let changed = false;

    for (const [form, tag] of JP_DISTINCT_FORMS) {
      if (s.startsWith(form) && s.length > form.length) {
        s = s.slice(form.length).trim();
        formTags.add(tag);
        changed = true;
        break;
      }
      if (s.endsWith(form) && s.length > form.length) {
        s = s.slice(0, s.length - form.length).trim();
        formTags.add(tag);
        changed = true;
        break;
      }
    }
    if (changed) continue;

    for (const form of JP_DEFAULT_FORMS) {
      if (s.startsWith(form) && s.length > form.length) {
        s = s.slice(form.length).trim();
        changed = true;
        break;
      }
      if (s.endsWith(form) && s.length > form.length) {
        s = s.slice(0, s.length - form.length).trim();
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  // ── 英語法人格（空白区切りの token 単位でのみ判定する）────────────────
  let tokens = s.split(' ').filter((t) => t !== '');
  for (let guard = 0; guard < 8 && tokens.length > 1; guard += 1) {
    const lastRaw = tokens[tokens.length - 1];
    const last = toComparableToken(lastRaw);
    const firstRaw = tokens[0];
    const first = toComparableToken(firstRaw);

    if (EN_DISTINCT_FORMS.has(last)) {
      formTags.add(EN_DISTINCT_FORMS.get(last) as string);
      tokens = tokens.slice(0, -1);
      continue;
    }
    if (EN_DEFAULT_FORMS.has(last)) {
      tokens = tokens.slice(0, -1);
      continue;
    }
    if (EN_DISTINCT_FORMS.has(first)) {
      formTags.add(EN_DISTINCT_FORMS.get(first) as string);
      tokens = tokens.slice(1);
      continue;
    }
    if (EN_DEFAULT_FORMS.has(first)) {
      tokens = tokens.slice(1);
      continue;
    }
    break;
  }

  const core = tokens.join(' ').replace(/\s+/g, ' ').trim();
  if (core === '') return '';
  if (formTags.size === 0) return core;

  // 決定論順（tag は ASCII なので localeCompare 不要）。
  const tag = Array.from(formTags).sort().join('+');
  return `${core}${FORM_TAG_SEPARATOR}${tag}`;
}

/**
 * master 群から alias collision を検出する（同一 normalized alias が複数 company を指す）。
 * displayName / normalizedName / aliases すべてを alias 候補として扱う。決定論順。
 */
export function detectAliasCollisions(
  master: readonly CompanyMasterRecord[],
): AliasCollision[] {
  const aliasToCompanies = new Map<string, Set<CompanyCanonicalId>>();
  const add = (aliasRaw: string, companyId: CompanyCanonicalId) => {
    const alias = normalizeCompanyName(aliasRaw);
    if (alias === '') return;
    let set = aliasToCompanies.get(alias);
    if (!set) {
      set = new Set<CompanyCanonicalId>();
      aliasToCompanies.set(alias, set);
    }
    set.add(companyId);
  };
  for (const m of master) {
    add(m.displayName, m.companyId);
    add(m.normalizedName, m.companyId);
    for (const a of m.aliases) add(a, m.companyId);
  }
  const collisions: AliasCollision[] = [];
  for (const [alias, ids] of aliasToCompanies) {
    if (ids.size > 1) {
      collisions.push({ alias, companyIds: Array.from(ids).sort() });
    }
  }
  collisions.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
  return collisions;
}

/**
 * free-text 企業名を master に対して解決する（pure・決定論）。
 *
 * - 一意一致 → resolved（matchedAlias を保持）。
 * - 複数一致（alias collision 等）→ ambiguous（自動確定しない）。
 * - 不一致 → unresolved。
 */
export function resolveCompany(
  rawName: string,
  master: readonly CompanyMasterRecord[],
): CompanyIdentityResolution {
  const norm = normalizeCompanyName(rawName);
  if (norm === '') return { status: 'unresolved' };

  const matches: Array<{ id: CompanyCanonicalId; displayName: string; matchedAlias: string | null }> = [];
  for (const m of master) {
    const candidates = new Set<string>([
      normalizeCompanyName(m.displayName),
      normalizeCompanyName(m.normalizedName),
      ...m.aliases.map(normalizeCompanyName),
    ]);
    if (candidates.has(norm)) {
      const matchedAlias =
        normalizeCompanyName(m.displayName) === norm ? null : rawName.trim();
      matches.push({ id: m.companyId, displayName: m.displayName, matchedAlias });
    }
  }

  if (matches.length === 0) return { status: 'unresolved' };
  if (matches.length === 1) {
    return {
      status: 'resolved',
      companyId: matches[0].id,
      displayName: matches[0].displayName,
      matchedAlias: matches[0].matchedAlias,
    };
  }
  // 複数一致は黙って解決しない（ambiguous）。候補は決定論順。
  const uniqueIds = Array.from(new Set(matches.map((x) => x.id))).sort();
  if (uniqueIds.length === 1) {
    const only = matches[0];
    return { status: 'resolved', companyId: only.id, displayName: only.displayName, matchedAlias: only.matchedAlias };
  }
  return { status: 'ambiguous', candidates: uniqueIds };
}

/** resolution が確定 id を持つか（projection / dedup の前提判定）。 */
export function isResolvedIdentity(
  r: CompanyIdentityResolution,
): r is Extract<CompanyIdentityResolution, { status: 'resolved' }> {
  return r.status === 'resolved';
}

// ── P17-B 追加: master versioning / group / merge ──────────────────────

/**
 * 過去社名で master を引く（現在名で上書きしない・履歴照合のみ）。
 * 現在名一致は resolveCompany が担当。ここは historicalNames のみを見る。
 */
export function matchHistoricalName(
  rawName: string,
  master: readonly CompanyMasterRecord[],
): CompanyMasterRecord | null {
  const norm = normalizeCompanyName(rawName);
  if (norm === '') return null;
  for (const m of master) {
    const hist = (m.historicalNames ?? []).map(normalizeCompanyName);
    if (hist.includes(norm)) return m;
  }
  return null;
}

/** corporate group 参照か（子法人を持つ / 親として参照される）。単一法人と混同しない。 */
export function isCorporateGroupReference(
  companyId: CompanyCanonicalId,
  master: readonly CompanyMasterRecord[],
): boolean {
  const rec = master.find((m) => m.companyId === companyId);
  if (!rec) return false;
  if ((rec.subsidiaryIds ?? []).length > 0) return true;
  return master.some((m) => (m.parentId ?? null) === companyId);
}

/** 現在の identity version（未設定は 1）。 */
export function currentIdentityVersion(record: CompanyMasterRecord): number {
  return typeof record.identityVersion === 'number' ? record.identityVersion : 1;
}

/**
 * merge 候補を検出する（同一 normalizedName・別 companyId）。自動確定しない。
 * 決定論順で返す。
 */
export function detectMergeCandidates(
  master: readonly CompanyMasterRecord[],
): CompanyIdentityAdjustment[] {
  const byNorm = new Map<string, CompanyCanonicalId[]>();
  for (const m of master) {
    const norm = normalizeCompanyName(m.normalizedName || m.displayName);
    const arr = byNorm.get(norm);
    if (arr) arr.push(m.companyId);
    else byNorm.set(norm, [m.companyId]);
  }
  const out: CompanyIdentityAdjustment[] = [];
  for (const [norm, ids] of byNorm) {
    const uniq = Array.from(new Set(ids)).sort();
    if (uniq.length > 1) {
      out.push({ kind: 'merge_candidate', companyIds: uniq, reason: `same normalized name: ${norm}` });
    }
  }
  out.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return out;
}
