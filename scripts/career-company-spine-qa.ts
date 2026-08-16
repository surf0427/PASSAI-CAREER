/*
 * scripts/career-company-spine-qa.ts
 *
 * PASSAI CAREER — Company Data Spine Phase A（R1〜R6）の QA。
 *
 * 何を守るか:
 *   A. Resolver 不変条件
 *      A-1 normalize / resolved / ambiguous / unresolved
 *      A-2 ambiguous を自動確定しない
 *      A-3 部分一致 suggestion を resolved 扱いしない
 *   B. 表示名の後方互換
 *      B-1 companyId 無しでも companyName で表示できる
 *      B-2 directory があれば server 名（displayName）を優先
 *   C. 既存ログの後方互換（companyId 欠損）
 *      C-1 企業研究 / C-2 ES draft / C-3 ES log / C-4 面接 target / C-5 プレゼン target
 *   D. 面接の不変条件（companyId あり + companyName 空 は保存されない）
 *   E. Application Context（既存 field を置換せず初期値だけを供給する形）
 *   F. Community 境界（静的 guard）
 *      F-1 Private Evidence 型に共有系 field が無い
 *      F-2 Private Evidence → Community 変換関数が存在しない
 *      F-3 Community renderer / contribution module を Company Spine が import しない
 *      F-4 Layer 5 の disabled loader が disabled のまま
 *   G. Scope guard（R7〜R9 を実装していないこと）
 *
 * 使い方: npx tsx scripts/career-company-spine-qa.ts
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeCompanyName } from '../lib/careerCompanyKnowledge/identity';
import { buildCompanyResolveResult } from '../lib/careerCompanyIdentity/resolution';
import {
  decideRegistration,
  selectAttachableAliases,
} from '../lib/careerCompanyIdentity/registration';
import {
  hasLinkedCompanyId,
  resolveCompanyDisplayName,
} from '../lib/careerCompanyIdentity/display';
import { loadCompanyKnowledgeContext } from '../lib/careerContextLoaders/companyKnowledge';
import { validateEsSettings } from '../lib/careerEs/esSettings';
import { normalizeInterviewTarget } from '../app/career/interview/interviewModes';
import { normalizePresentationTarget } from '../app/career/presentation/presentationModes';
import type { CompanyMasterRecord } from '../types/careerCompanyKnowledge';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

// ── fixtures ────────────────────────────────────────────────────────
function master(
  companyId: string,
  displayName: string,
  aliases: string[] = [],
): CompanyMasterRecord {
  return {
    companyId,
    displayName,
    normalizedName: normalizeCompanyName(displayName),
    aliases,
    corporateGroupId: null,
  };
}

const TOYOTA = master('cmp_1', 'トヨタ自動車株式会社', ['トヨタ自動車']);
const TOYOTA_FINANCE = master('cmp_2', 'トヨタファイナンス株式会社');
const TOYOTA_SYSTEMS = master('cmp_3', 'トヨタシステムズ株式会社');
const ALIAS_COLLIDER = master('cmp_4', '別トヨタ株式会社', ['トヨタ自動車']);

// ════════════════════════════════════════════════════════════════════
console.log('[A] Resolver 不変条件');

check(
  'A-1a normalizeCompanyName が法人格表記を落とす',
  normalizeCompanyName('トヨタ自動車株式会社') === normalizeCompanyName('トヨタ自動車'),
);

{
  const r = buildCompanyResolveResult('トヨタ自動車株式会社', [
    TOYOTA,
    TOYOTA_FINANCE,
    TOYOTA_SYSTEMS,
  ]);
  check(
    'A-1b 完全一致は resolved',
    r.status === 'resolved' && r.companyId === 'cmp_1',
    `got ${r.status}`,
  );
}

{
  // 同一 alias が 2 社を指す → ambiguous（自動確定しない）。
  const r = buildCompanyResolveResult('トヨタ自動車', [TOYOTA, ALIAS_COLLIDER]);
  check('A-2a alias 衝突は ambiguous', r.status === 'ambiguous', `got ${r.status}`);
  check(
    'A-2b ambiguous は候補を 2 件返す（勝手に 1 件へ確定しない）',
    r.status === 'ambiguous' && r.candidates.length === 2,
  );
  check(
    'A-2c ambiguous の結果に companyId 単独フィールドが無い（resolved へ昇格していない）',
    r.status === 'ambiguous' && !('companyId' in r),
  );
}

{
  // 「トヨタ」は完全一致しない → unresolved。候補は suggestions として運ぶ。
  const r = buildCompanyResolveResult('トヨタ', [TOYOTA, TOYOTA_FINANCE, TOYOTA_SYSTEMS]);
  check('A-3a 部分一致のみは unresolved', r.status === 'unresolved', `got ${r.status}`);
  check(
    'A-3b unresolved の候補は suggestions として返る（resolved ではない）',
    r.status === 'unresolved' && r.suggestions.length === 3,
  );
  // 順序の「具体値」ではなく **決定論であること** を固定する（locale 依存の照合順に縛られない）。
  const again = buildCompanyResolveResult('トヨタ', [TOYOTA, TOYOTA_FINANCE, TOYOTA_SYSTEMS]);
  const shuffled = buildCompanyResolveResult('トヨタ', [TOYOTA_SYSTEMS, TOYOTA, TOYOTA_FINANCE]);
  check(
    'A-3c suggestions は決定論（同入力→同順序 / 入力順に依存しない）',
    r.status === 'unresolved' &&
      again.status === 'unresolved' &&
      shuffled.status === 'unresolved' &&
      JSON.stringify(r.suggestions) === JSON.stringify(again.suggestions) &&
      JSON.stringify(r.suggestions) === JSON.stringify(shuffled.suggestions),
  );
}

check(
  'A-4 候補ゼロは unresolved（空 suggestions）',
  (() => {
    const r = buildCompanyResolveResult('存在しない企業', []);
    return r.status === 'unresolved' && r.suggestions.length === 0;
  })(),
);

// ════════════════════════════════════════════════════════════════════
console.log('[B] 表示名の後方互換');

check(
  'B-1a companyId 無し（旧ログ）は companyName で表示できる',
  resolveCompanyDisplayName({ companyName: '株式会社レガシー' }) === '株式会社レガシー',
);
check(
  'B-1b directory が無くても companyName へ倒れる',
  resolveCompanyDisplayName({ companyId: 'cmp_1', companyName: '保存時の名前' }) ===
    '保存時の名前',
);
check(
  'B-2 directory があれば server 側の displayName を優先',
  resolveCompanyDisplayName({ companyId: 'cmp_1', companyName: '古い社名' }, [
    { companyId: 'cmp_1', displayName: '新しい社名', lastUsedAt: '' },
  ]) === '新しい社名',
);
check(
  'B-3 空参照でも throw せず空文字',
  resolveCompanyDisplayName(null) === '' && resolveCompanyDisplayName(undefined) === '',
);
check(
  'B-4 hasLinkedCompanyId は欠損 / 空文字を false',
  !hasLinkedCompanyId({ companyName: 'x' }) &&
    !hasLinkedCompanyId({ companyId: '  ', companyName: 'x' }) &&
    hasLinkedCompanyId({ companyId: 'cmp_1', companyName: 'x' }),
);

// ════════════════════════════════════════════════════════════════════
console.log('[C] 既存ログの後方互換（companyId 欠損）');

{
  // 面接: 旧 target（companyId なし）が読める。
  const legacy = normalizeInterviewTarget({ companyName: '株式会社レガシー', industry: 'IT' });
  check(
    'C-4a 旧 interview target（companyId 欠損）が読める',
    !!legacy && legacy.companyName === '株式会社レガシー' && legacy.companyId === undefined,
  );
  const linked = normalizeInterviewTarget({
    companyName: 'トヨタ自動車株式会社',
    companyId: 'cmp_1',
  });
  check(
    'C-4b companyId 付き target は両方保持',
    !!linked && linked.companyId === 'cmp_1' && linked.companyName === 'トヨタ自動車株式会社',
  );
}

{
  const legacy = normalizePresentationTarget({ companyName: '株式会社レガシー' });
  check(
    'C-5a 旧 presentation target（companyId 欠損）が読める',
    !!legacy && legacy.companyName === '株式会社レガシー' && legacy.companyId === undefined,
  );
  const linked = normalizePresentationTarget({
    companyName: 'トヨタ自動車株式会社',
    companyId: 'cmp_1',
  });
  check('C-5b companyId 付き target は両方保持', !!linked && linked.companyId === 'cmp_1');
}

// storage の normalize は localStorage 依存のため、ここでは型・分岐の静的確認で代替する。
{
  const researchStorage = read(
    join(ROOT, 'app/career/company-research/companyResearchStorage.ts'),
  );
  check(
    'C-1 企業研究 storage が companyId を defensive に読む',
    researchStorage.includes("str(r.companyId)") && researchStorage.includes('if (companyId)'),
  );
  const esDraft = read(join(ROOT, 'app/career/es/esDraftStorage.ts'));
  check(
    'C-2 ES draft storage が companyId を defensive に読む',
    esDraft.includes("typeof r.companyId === 'string'"),
  );
  check(
    'C-2b ES draft の schemaVersion を上げていない（旧 draft を破棄しない）',
    esDraft.includes('ES_DRAFT_SCHEMA_VERSION') &&
      !/ES_DRAFT_SCHEMA_VERSION\s*=\s*[2-9]/.test(read(join(ROOT, 'types/careerEs.ts'))),
  );
  const esStorage = read(join(ROOT, 'app/career/es/esStorage.ts'));
  check(
    'C-3 ES log storage が companyId を defensive に読む',
    esStorage.includes("typeof r.companyId === 'string'"),
  );
}

// ════════════════════════════════════════════════════════════════════
console.log('[D] 面接の不変条件');

check(
  'D-1 companyId あり + companyName 空 は target にならない（null）',
  normalizeInterviewTarget({ companyName: '', companyId: 'cmp_1' }) === null,
);
check(
  'D-2 companyId あり + companyName 空白のみ も null',
  normalizeInterviewTarget({ companyName: '   ', companyId: 'cmp_1' }) === null,
);
check(
  'D-3 presentation も companyName 無しでは companyId を残さない',
  (() => {
    const t = normalizePresentationTarget({ companyId: 'cmp_1', industry: 'IT' });
    return !!t && t.companyId === undefined;
  })(),
);

// ════════════════════════════════════════════════════════════════════
console.log('[E] Application Context');

{
  const appType = read(join(ROOT, 'types/careerCompanyApplication.ts'));
  check('E-1 Application Context の型が存在する', appType.includes('CareerCompanyApplication'));
  check(
    'E-2 既存語彙を再利用している（新しい似た enum を増やしていない）',
    appType.includes('CareerCompanyInterestLevel') &&
      appType.includes('CareerInterviewPhase') &&
      appType.includes('CareerInterviewSelectionType'),
  );
  const forbidden = [
    'deadline',
    'interviewDate',
    'outcome',
    'statusHistory',
    'todo',
    'reminder',
    'companyMemo',
  ];
  // ★ field 宣言だけを見る（型ファイル内の説明コメントを誤検知しないため）。
  const found = forbidden.filter((f) => new RegExp(`^\\s*${f}\\??:`, 'm').test(appType));
  check(
    'E-3 Application Tracking へ膨らんでいない（締切/日程/合否/履歴/TODO/メモ が無い）',
    found.length === 0,
    found.join(', '),
  );
  const storage = read(join(ROOT, 'app/career/company/applicationStorage.ts'));
  check(
    'E-4 canonical は localStorage（house rule 準拠）',
    storage.includes('safeGetStorage') && storage.includes("'careerCompanyApplications'"),
  );
  check(
    'E-5 各機能へは「初期値供給」として使われている（既存 field を置換していない）',
    read(join(ROOT, 'app/career/interview/target/page.tsx')).includes(
      'loadCompanyApplicationDefaults',
    ) &&
      read(join(ROOT, 'app/career/presentation/target/page.tsx')).includes(
        'loadCompanyApplicationDefaults',
      ),
  );
}

// ════════════════════════════════════════════════════════════════════
// Phase 1 — Identity duplicate hardening。
//   `任天堂` / `Nintendo` / `ニンテンドー` は normalize が script を跨がないため別 token に
//   なる。これを同一企業へ寄せる唯一の手段が **ユーザーが明示した alias** であり、
//   本 section はその挙動と「誤 merge しない」不変条件を固定する。
//   ★ transliteration（漢字→ローマ字等）は実装しない＝ alias 無しで同一化してはいけない。
console.log('[J] 重複企業の防止（cross-script / alias）');

{
  const NINTENDO_NO_ALIAS = master('cmp_n1', '任天堂');
  const NINTENDO_WITH_ALIAS = master('cmp_n1', '任天堂', ['Nintendo', 'ニンテンドー']);

  /** master 群に対して入力名を解決し、確定した companyId（未確定は status）を返す。 */
  function resolveTo(name: string, list: CompanyMasterRecord[]): string {
    const r = buildCompanyResolveResult(name, list);
    return r.status === 'resolved' ? r.companyId : r.status;
  }

  // ── Case A: 法人格 suffix ──────────────────────────────────────
  check(
    'J-A 任天堂 / 任天堂株式会社 は alias 無しでも同一（法人格語の除去）',
    normalizeCompanyName('任天堂') === normalizeCompanyName('任天堂株式会社') &&
      resolveTo('任天堂株式会社', [NINTENDO_NO_ALIAS]) === 'cmp_n1',
  );

  // ── Case B: ラテン文字の大小 / suffix ──────────────────────────
  check(
    'J-B Nintendo / Nintendo Co., Ltd. / NINTENDO は同一 token',
    normalizeCompanyName('Nintendo') === normalizeCompanyName('Nintendo Co., Ltd.') &&
      normalizeCompanyName('Nintendo') === normalizeCompanyName('NINTENDO'),
  );

  // ── Case C: alias 無しの cross-script は同一化しない ────────────
  check(
    'J-C alias 無しの 任天堂 と Nintendo を自動で同一化しない（transliteration しない）',
    normalizeCompanyName('任天堂') !== normalizeCompanyName('Nintendo') &&
      resolveTo('Nintendo', [NINTENDO_NO_ALIAS]) === 'unresolved' &&
      resolveTo('ニンテンドー', [NINTENDO_NO_ALIAS]) === 'unresolved',
  );

  // ── Case D / E: alias があれば全表記が 1 社へ寄る ──────────────
  check(
    'J-D alias 経由で Nintendo が既存 任天堂 に解決する',
    resolveTo('Nintendo', [NINTENDO_WITH_ALIAS]) === 'cmp_n1',
  );
  check(
    'J-E 6 表記すべてが同一 companyId へ解決する（alias 登録済み）',
    ['任天堂', '任天堂株式会社', 'Nintendo', 'Nintendo Co., Ltd.', 'NINTENDO', 'ニンテンドー'].every(
      (n) => resolveTo(n, [NINTENDO_WITH_ALIAS]) === 'cmp_n1',
    ),
  );

  // ── Case F: 略称 alias ────────────────────────────────────────
  check(
    'J-F 略称 alias（トヨタ）で正式名の企業へ解決する',
    normalizeCompanyName('トヨタ') !== normalizeCompanyName('トヨタ自動車株式会社') &&
      resolveTo('トヨタ', [master('cmp_t1', 'トヨタ自動車株式会社', ['トヨタ'])]) === 'cmp_t1',
  );

  // ── Case G / H: alias 衝突は ambiguous・自動 merge しない ───────
  {
    const A = master('cmp_a', 'エービーシー株式会社', ['ABC']);
    const B = master('cmp_b', 'ABC ホールディングス株式会社', ['ABC']);
    const r = buildCompanyResolveResult('ABC', [A, B]);
    check('J-G 同一 alias が複数社に付く場合は ambiguous', r.status === 'ambiguous');
    check(
      'J-G2 ambiguous は resolved へ昇格しない（companyId を返さない）',
      !('companyId' in r),
    );
    check(
      'J-H 衝突しても company を統合しない（候補は 2 社のまま提示される）',
      r.status === 'ambiguous' && r.candidates.length === 2,
    );
  }

  // ── decideRegistration（登録側の判定・pure）─────────────────────
  check(
    'J-K1 一致 0 件 → 新規作成',
    decideRegistration([]).kind === 'create',
  );
  check(
    'J-K2 一致 1 件 → 既存へ寄せる（新規作成しない）',
    (() => {
      const d = decideRegistration([{ companyId: 'cmp_n1', displayName: '任天堂' }]);
      return d.kind === 'existing' && d.companyId === 'cmp_n1';
    })(),
  );
  check(
    'J-K3 master 経由と alias 経由で同じ企業が来ても 1 社として扱う',
    decideRegistration([
      { companyId: 'cmp_n1', displayName: '任天堂' },
      { companyId: 'cmp_n1', displayName: '任天堂' },
    ]).kind === 'existing',
  );
  check(
    'J-K4 一致 2 件 → ambiguous（★ 自動 merge / 自動選択しない）',
    (() => {
      const d = decideRegistration([
        { companyId: 'cmp_a', displayName: 'A社' },
        { companyId: 'cmp_b', displayName: 'B社' },
      ]);
      return d.kind === 'ambiguous' && d.candidates.length === 2;
    })(),
  );

  // ── selectAttachableAliases（alias 保存の安全性・pure）──────────
  {
    const occupancy = new Map<string, string>([['nintendo', 'cmp_other']]);
    check(
      'J-L1 他社が占有している alias は保存しない（奪わない）',
      selectAttachableAliases({
        companyId: 'cmp_me',
        ownNormalizedName: normalizeCompanyName('任天堂'),
        rawAliases: ['Nintendo'],
        occupancy,
      }).length === 0,
    );
    check(
      'J-L2 未占有の alias は保存対象になり normalized 値を server が付ける',
      (() => {
        const got = selectAttachableAliases({
          companyId: 'cmp_me',
          ownNormalizedName: normalizeCompanyName('任天堂'),
          rawAliases: ['ニンテンドー'],
          occupancy,
        });
        return (
          got.length === 1 &&
          got[0].alias === 'ニンテンドー' &&
          got[0].normalizedAlias === normalizeCompanyName('ニンテンドー')
        );
      })(),
    );
    check(
      'J-L3 自社の表示名と同値の alias / 空文字 / 入力内重複は保存しない',
      selectAttachableAliases({
        companyId: 'cmp_me',
        ownNormalizedName: normalizeCompanyName('任天堂'),
        rawAliases: ['任天堂株式会社', '  ', 'ニンテンドー', 'ニンテンドー'],
        occupancy: new Map(),
      }).length === 1,
    );
  }

  // ── Case I / J: 既存契約の維持（静的固定）──────────────────────
  {
    const repo = read(join(ROOT, 'lib/careerCompanyIdentity/repository.server.ts'));
    check(
      'J-I alias は optional（未指定でも登録できる既定値が残っている）',
      /aliases:\s*readonly string\[\]\s*=\s*\[\]/.test(repo),
    );
    check(
      'J-J UNIQUE 競合時は既存を引き直す（新規 duplicate を作る方向へ倒さない）',
      repo.includes('findMatchesByNormalizedToken(admin, normalizedName)') &&
        repo.includes('created: false'),
    );
    check(
      'J-M 登録の既存判定が alias table も見る（master.normalized_name だけにしない）',
      repo.includes(".eq('normalized_alias', token)"),
    );
    check(
      'J-N transliteration / 外部辞書 / LLM による alias 自動生成を実装していない',
      !repo.includes('romaji') &&
        !repo.includes('transliterate') &&
        !read(join(ROOT, 'lib/careerCompanyIdentity/registration.ts')).includes('transliterate'),
    );
  }
}

// ════════════════════════════════════════════════════════════════════
console.log('[H] ES CompanyPicker 接続（R4）');

{
  const esNew = read(join(ROOT, 'app/career/es/new/page.tsx'));

  check(
    'H-1 ES new page が共通 CompanyPicker を使う（ES 専用 picker を作っていない）',
    esNew.includes("from '@/components/career/CompanyPicker'") &&
      esNew.includes('<CompanyPicker'),
  );
  check(
    'H-2 companyName の free-text state を維持している（置換していない）',
    esNew.includes('const [companyName, setCompanyName] = useState')  &&
      esNew.includes('companyName: settings.companyName'),
  );
  check(
    'H-3 companyId は未紐付けなら draft へ載せない（旧 draft と同じ形）',
    esNew.includes('linkedCompanyId ? { companyId: linkedCompanyId } : {}'),
  );
  check(
    'H-4 CompanyPicker の onChange が companyId と companyName を同時に更新する',
    /setCompanyId\(next\.companyId\)[\s\S]{0,120}setCompanyName\(next\.companyName\)/.test(esNew),
  );

  // Case D: 必須契約は companyName のみ。companyId で突破できない。
  const base = {
    question: '学生時代に力を入れたこと',
    charLimitInput: '400',
    industry: 'IT',
    jobType: 'エンジニア',
    selectionType: 'main' as const,
  };
  const emptyCompany = validateEsSettings({ ...base, companyName: '' });
  check(
    'H-5 companyName 空は validation error（companyId の有無に関係なく進めない）',
    !emptyCompany.ok && !!emptyCompany.errors.companyName && emptyCompany.normalized === null,
  );
  check(
    'H-6 validateEsSettings は companyId を受け取らない（突破経路が型に存在しない）',
    !/companyId/.test(read(join(ROOT, 'lib/careerEs/esSettings.ts'))),
  );
  // Case B: free-text だけでも ES を作成できる。
  const freeText = validateEsSettings({ ...base, companyName: '未登録の会社' });
  check(
    'H-7 free-text の企業名だけで ES 作成へ進める（Company Spine 不要）',
    freeText.ok && freeText.normalized?.companyName === '未登録の会社',
  );
}

{
  // Case E: ES 材料選択 V1 / CONTEXT_FREE を触っていないこと。
  const untouched = [
    'lib/careerEs/materialCandidates.ts',
    'lib/careerEs/materialPrompt.ts',
    'lib/careerEs/deepDivePrompt.ts',
    'lib/careerEs/organizePrompt.ts',
    'app/api/career/es/deep/route.ts',
    'app/api/career/es/organize/route.ts',
    'app/api/career/es/materials/route.ts',
  ];
  const leaked = untouched.filter((p) => /companyId|CompanyPicker/.test(read(join(ROOT, p))));
  check(
    'H-8 材料選択 V1 / ES route に companyId が漏れていない（CONTEXT_FREE 維持）',
    leaked.length === 0,
    leaked.join(', '),
  );
  const draftEditor = read(join(ROOT, 'app/career/es/draft/[draftId]/page.tsx'));
  check(
    'H-9 深掘り/整理へ渡す契約（knownFacts / missingAxes）が維持されている',
    draftEditor.includes('buildEsKnownFacts') && draftEditor.includes('buildEsMissingAxisKeys'),
  );
}

// ════════════════════════════════════════════════════════════════════
console.log('[F] Community 境界（LOCKED）');

{
  const researchTypes = read(join(ROOT, 'types/careerCompanyResearch.ts'));
  const sharingFields = [
    'visibility',
    'shareConsent',
    'communityRequested',
    'moderationStatus',
    'publishedAt',
  ];
  const leaked = sharingFields.filter((f) => new RegExp(`^\\s*${f}\\??:`, 'm').test(researchTypes));
  check(
    'F-1 Private Evidence 型に共有系 field が無い（100% PRIVATE）',
    leaked.length === 0,
    leaked.join(', '),
  );
}

{
  // Company Spine の実装群が Layer 5 Community の contribution / moderation / consent を
  // import していないこと（identity.ts のみ再利用が許される）。
  const spineDirs = [
    'lib/careerCompanyIdentity',
    'lib/careerCompanySpine',
    'app/api/career/company',
    'app/career/company',
    'components/career',
  ];
  const forbiddenImports = [
    'careerCompanyKnowledge/contribution',
    'careerCompanyKnowledge/moderation',
    'careerCompanyKnowledge/lifecycle',
    'careerCompanyKnowledge/consentSnapshot',
    'careerCompanyKnowledge/sourceClass',
    'careerCompanyKnowledge/supabaseRepository',
    'careerCollectiveIntelligence',
    'careerContextRenderers/companyKnowledgeResearch',
  ];
  const offenders: string[] = [];
  for (const dir of spineDirs) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8');
      for (const bad of forbiddenImports) {
        if (src.includes(bad)) offenders.push(`${file.replace(ROOT + '/', '')} -> ${bad}`);
      }
    }
  }
  check('F-3 Company Spine が Community module を import しない', offenders.length === 0, offenders.join('; '));
}

{
  // Private Evidence → Community contribution の自動変換関数が存在しないこと（CI-8 の拡張）。
  const conversionPatterns = [
    /CareerCompanyResearchLog\s*\)\s*:\s*CompanyKnowledgeContribution/,
    /toCompanyKnowledgeContribution/,
    /researchLogToContribution/,
  ];
  const offenders: string[] = [];
  for (const dir of ['lib', 'app', 'types']) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8');
      for (const re of conversionPatterns) {
        if (re.test(src)) offenders.push(file.replace(ROOT + '/', ''));
      }
    }
  }
  check(
    'F-2 Private Evidence → Community の自動変換経路が存在しない',
    offenders.length === 0,
    offenders.join(', '),
  );
}

{
  const loader = read(join(ROOT, 'lib/careerContextLoaders/companyKnowledge.ts'));
  check(
    'F-4a Layer 5 disabled loader が disabled 固定のまま',
    loader.includes("status: 'disabled'") && loader.includes("reason: 'not_connected'"),
  );
}

void (async () => {
  const result = await loadCompanyKnowledgeContext({ purpose: 'company_research', companyId: 'cmp_1' });
  check(
    'F-4b Layer 5 loader は実行しても disabled を返す（data を持たない）',
    result.status === 'disabled' && !('data' in result),
  );

  // ══════════════════════════════════════════════════════════════════
  console.log('[G] Scope guard（R7〜R9 未実装）');

  const spineFiles = [
    ...walk(join(ROOT, 'lib/careerCompanyIdentity')),
    ...walk(join(ROOT, 'lib/careerCompanySpine')),
    ...walk(join(ROOT, 'app/api/career/company')),
    ...walk(join(ROOT, 'app/career/company')),
  ];
  const spineSrc = spineFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  check(
    'G-1 Official Sourced Facts の table / 型を実装していない（R7 scope 外）',
    !spineSrc.includes('career_company_official_facts') &&
      !spineSrc.includes('OfficialSourcedFact') &&
      !existsSync(join(ROOT, 'types/careerCompanyOfficial.ts')),
  );
  {
    // R7 の本体リスクは「server が任意の外部 URL を取りに行く」こと。
    // server 側（route handler / *.server.ts）に outbound fetch が無いことを固定する。
    // ★ client の companyClient.ts が自前 API を fetch するのは対象外（外部取得ではない）。
    const serverSide = [
      ...walk(join(ROOT, 'app/api/career/company')),
      ...walk(join(ROOT, 'lib/careerCompanyIdentity')),
    ].filter((f) => f.endsWith('route.ts') || f.endsWith('.server.ts'));
    const fetchers = serverSide.filter((f) => /\bfetch\s*\(/.test(readFileSync(f, 'utf8')));
    check(
      'G-2a server 側に outbound fetch が無い（URL 取得は R7 scope 外）',
      fetchers.length === 0,
      fetchers.map((f) => f.replace(ROOT + '/', '')).join(', '),
    );
    check(
      'G-2b HTML→text 変換を実装していない（R7 scope 外）',
      !spineSrc.includes('htmlToText') && !spineSrc.includes('stripHtml'),
    );
  }
  check(
    'G-3 Company Context の prompt injection を実装していない（R8/R9 scope 外）',
    !existsSync(join(ROOT, 'lib/careerCompanySelector')) &&
      !existsSync(join(ROOT, 'lib/careerContextRenderers/companyOfficialContext.ts')),
  );
  check(
    'G-4 Orchestrator に company extras を足していない（R8/R9 scope 外）',
    !/company\??:/.test(
      read(join(ROOT, 'lib/careerContext/orchestrator.ts')).split('CareerContextExtras')[1]?.slice(0, 900) ??
        '',
    ),
  );
  check(
    'G-5 ES の CONTEXT_FREE 契約を壊していない（company を材料候補へ足していない）',
    !read(join(ROOT, 'lib/careerEs/materialCandidates.ts')).includes('companyId') &&
      !read(join(ROOT, 'lib/careerEs/deepDivePrompt.ts')).includes('companyId'),
  );
  check(
    'G-6 Community DDL（contributions 以降）を identity apply へ持ち込んでいない',
    (() => {
      const sql = read(join(ROOT, 'supabase/career_company_identity_apply.sql'));
      return (
        !sql.includes('career_company_knowledge_contributions') &&
        !sql.includes('career_company_knowledge_moderation') &&
        !sql.includes('career_company_knowledge_consent_snapshots')
      );
    })(),
  );

  console.log(
    failures === 0
      ? '\nAll company spine QA checks passed.'
      : `\n${failures} check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
