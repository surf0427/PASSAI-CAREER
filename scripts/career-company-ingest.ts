/*
 * scripts/career-company-ingest.ts
 *
 * PASSAI CAREER — Company Data Spine の **operator 用バッチ取り込み**（dev/admin one-shot）。
 *
 * なぜ必要か:
 *   Company Prefetch の取り込み契機は現在「canary allowlist に載ったユーザーが ES / 企業研究 /
 *   面接 / プレゼン / CompanyPicker に企業名を入力したとき」だけで、初回リリース向けに
 *   主要企業を揃えるための入口が存在しない（docs/career/company_prefetch_current_state.md §7）。
 *   本 script はその欠けている operator 手順だけを埋める。
 *
 * ★ 本 script が「しない」こと（設計の中核）:
 *   - 企業一覧を production runtime へ持ち込まない。対象は **CLI 引数 / ファイル**で外から渡す
 *     （app bundle に launch 企業リストを残さない）。
 *   - DB へ手動 INSERT しない。identity / source / fact / status / freshness / provenance は
 *     すべて既存 `runCompanyPrefetch`（＝ intent route と同一の pipeline）が付与する。
 *   - 新しい source を足さない。検索 provider / 公式サイト / 法人 registry の既存 policy のまま。
 *   - 並列実行しない。1 社ずつ逐次（外部 provider へ無駄な負荷をかけない）。
 *   - 何も削除・上書きしない（既存 master / alias / fact は既存 upsert semantics に委ねる）。
 *
 * 事前に必要な env（未設定なら実行を止める。値は表示しない）:
 *   CAREER_COMPANY_PREFETCH_ENABLED=true
 *   CAREER_COMPANY_PREFETCH_EXTERNAL_FETCH_ENABLED=true
 *   CAREER_COMPANY_SEARCH_ENDPOINT / CAREER_COMPANY_SEARCH_API_KEY   … 公式サイト探索
 *   NEXT_PUBLIC_CAREER_SUPABASE_URL / CAREER_SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY                                                 … 抽出（無いと fact が減る）
 *   CAREER_CORPORATE_REGISTRY_APP_ID                                  … 任意（法人番号 identity）
 *
 * ★ --register-without-registry（既定 OFF・operator の明示 opt-in）:
 *   `resolveCompanyIdentity` は「公的 registry で法人が確定した企業だけを共有マスタへ作る」
 *   境界を持つ（free-text だけで全ユーザー共有テーブルに行を作らせないため）。
 *   `CAREER_CORPORATE_REGISTRY_APP_ID` が無い環境では未登録企業がすべて
 *   `identity_blocked(unresolved)` になり 1 社も増やせない。
 *   本オプションはその場合に限り、既存 `registerCompany`（alias 込み dedupe・service role）で
 *   master 行を先に作ってから enrichment を回す。**この経路では法人番号による裏取りが無い**ため、
 *   企業名は operator が責任を持って正式名称で渡すこと。
 *   検索 / ドメイン検証 / 抽出 grounding / provenance / budget は正式 pipeline のまま。
 *
 * 使い方:
 *   # 1) identity だけ先に確認する（外部取得なし・DB 書き込みなし）
 *   npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-company-ingest.ts --dry-run 任天堂株式会社 ソニーグループ株式会社
 *
 *   # 2) 実取り込み（逐次・1 社ずつ）
 *   npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-company-ingest.ts 任天堂株式会社 ソニーグループ株式会社
 *
 *   # 3) ファイルから（1 行 1 社・# 始まりはコメント）
 *   npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-company-ingest.ts --file company-list.txt
 */

// ★ 最初の import。後続 module（lib/ai.ts の Anthropic クライアント等）が評価される前に
//   .env.local を process.env へ流し込む。順序を変えると LLM 抽出が黙って全滅する。
import './loadEnvLocal';

import { readFileSync, existsSync } from 'node:fs';

import { runCompanyPrefetch } from '@/lib/careerCompanyPrefetch/prefetchJobService';
import { buildCompanyPrefetchDeps } from '@/lib/careerCompanyPrefetch/runtime.server';
import {
  isCompanyPrefetchEnabled,
  isCompanyPrefetchExternalFetchEnabled,
} from '@/lib/careerCompanyPrefetch/flags.server';
import { findCompanyCandidates, registerCompany } from '@/lib/careerCompanyIdentity/repository.server';
import { buildCompanyResolveResult } from '@/lib/careerCompanyIdentity/resolution';
import { normalizeCompanyName } from '@/lib/careerCompanyKnowledge/identity';
import { getCareerServiceRoleSupabaseClient } from '@/lib/careerSupabase/serviceRoleClient';
import { CAREER_COMPANY_OFFICIAL_TABLES } from '@/types/careerCompanyOfficial';

function parseArgs(argv: readonly string[]): { dryRun: boolean; registerWithoutRegistry: boolean; names: string[] } {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const registerWithoutRegistry = args.includes('--register-without-registry');
  const names: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run' || a === '--register-without-registry') continue;
    if (a === '--file') {
      const path = args[i + 1];
      i += 1;
      if (!path || !existsSync(path)) throw new Error(`--file が見つかりません: ${path ?? '(未指定)'}`);
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const t = line.trim();
        if (t !== '' && !t.startsWith('#')) names.push(t);
      }
      continue;
    }
    if (a.startsWith('--')) throw new Error(`未知のオプション: ${a}`);
    names.push(a);
  }
  // 同一企業を 2 度取りに行かない（外部 provider への無駄な負荷を避ける）。
  return {
    dryRun,
    registerWithoutRegistry,
    names: [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))],
  };
}

/** 実行前 env チェック（値は出さず、設定の有無だけを出す）。 */
function checkEnv(dryRun: boolean): string[] {
  const missing: string[] = [];
  const need = (name: string) => {
    const v = process.env[name];
    if (typeof v !== 'string' || v.trim() === '') missing.push(name);
  };
  need('NEXT_PUBLIC_CAREER_SUPABASE_URL');
  need('CAREER_SUPABASE_SERVICE_ROLE_KEY');
  if (dryRun) return missing;
  if (!isCompanyPrefetchEnabled()) missing.push('CAREER_COMPANY_PREFETCH_ENABLED=true');
  if (!isCompanyPrefetchExternalFetchEnabled()) {
    missing.push('CAREER_COMPANY_PREFETCH_EXTERNAL_FETCH_ENABLED=true');
  }
  need('CAREER_COMPANY_SEARCH_ENDPOINT');
  need('CAREER_COMPANY_SEARCH_API_KEY');
  need('ANTHROPIC_API_KEY');
  return missing;
}

type CompanyStats = { sources: number; facts: number; groups: string[] };

/** 取り込み後の実測（read-only）。company_id 単位で source / fact を数える。 */
async function readStats(companyId: string): Promise<CompanyStats> {
  const admin = getCareerServiceRoleSupabaseClient();
  if (!admin) return { sources: 0, facts: 0, groups: [] };
  const [{ count: sources }, { data: facts }] = await Promise.all([
    admin
      .from(CAREER_COMPANY_OFFICIAL_TABLES.sources)
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId),
    admin
      .from(CAREER_COMPANY_OFFICIAL_TABLES.facts)
      .select('fact_group')
      .eq('company_id', companyId),
  ]);
  const rows = (facts ?? []) as Array<{ fact_group: string }>;
  return {
    sources: sources ?? 0,
    facts: rows.length,
    groups: [...new Set(rows.map((r) => r.fact_group))].sort(),
  };
}

async function main(): Promise<void> {
  const { dryRun, registerWithoutRegistry, names } = parseArgs(process.argv);

  if (names.length === 0) {
    console.error('企業名を 1 つ以上指定してください（または --file <path>）。');
    process.exit(2);
  }

  const missing = checkEnv(dryRun);
  if (missing.length > 0) {
    console.error('必要な env が未設定のため中止します（値は表示しません）:');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('docs/career/company_prefetch_current_state.md §7 の運用手順を参照してください。');
    process.exit(1);
  }

  console.log(`mode: ${dryRun ? 'DRY-RUN（identity 照合のみ・DB 書き込みなし・外部取得なし）' : 'INGEST（正式 pipeline・逐次）'}`);
  if (registerWithoutRegistry && !dryRun) {
    console.log('option: --register-without-registry（法人番号による裏取り無しで master 行を作る）');
  }
  console.log(`companies: ${names.length}`);
  console.log('');

  if (dryRun) {
    for (const name of names) {
      const normalized = normalizeCompanyName(name);
      const candidates = await findCompanyCandidates(name, getCareerServiceRoleSupabaseClient());
      const resolved = candidates === null ? null : buildCompanyResolveResult(name, candidates);
      console.log(
        [
          name,
          `normalized=${normalized}`,
          `candidates=${candidates === null ? 'lookup_error' : candidates.length}`,
          `status=${resolved?.status ?? 'n/a'}`,
          `companyId=${resolved && resolved.status === 'resolved' ? resolved.companyId : '-'}`,
        ].join(' | '),
      );
    }
    return;
  }

  // ── 実取り込み（1 社ずつ逐次。1 社の失敗は他社へ波及させない）──────────────
  //   ★ deps は production の buildCompanyPrefetchDeps() をそのまま使う。
  //     唯一 resolveExistingCompany だけ差し替える理由: 既定実装は cookie ベースの
  //     user-scoped client を使うため request 文脈の外（本 script）では動かない。
  //     差し替え後も **同じ findCompanyCandidates + 同じ buildCompanyResolveResult** を通す
  //     （独自 resolver は作らない。client だけを operator 文脈のものに替える）。
  const admin = getCareerServiceRoleSupabaseClient();
  const deps: ReturnType<typeof buildCompanyPrefetchDeps> = {
    ...buildCompanyPrefetchDeps(),
    async resolveExistingCompany(rawName: string) {
      const candidates = await findCompanyCandidates(rawName, admin);
      if (candidates === null || candidates.length === 0) return null;
      const resolved = buildCompanyResolveResult(rawName, candidates);
      // ambiguous / unresolved は確定しない（既存不変条件をそのまま踏襲）。
      if (resolved.status !== 'resolved') return null;
      return { companyId: resolved.companyId, displayName: resolved.displayName };
    },
  };
  const results: Array<{ name: string; kind: string; companyId: string; detail: string; stats: CompanyStats }> = [];

  for (const name of names) {
    let kind = 'error';
    let companyId = '';
    let detail = '';
    try {
      if (registerWithoutRegistry) {
        // ★ 既存 registerCompany（alias 込み dedupe）で master 行だけ先に作る。
        //   既に在る企業は既存行へ寄る（created:false）＝ 重複を作らない。
        const reg = await registerCompany(name, []);
        if (!reg) {
          detail = 'register_failed';
          throw new Error('register_failed');
        }
        if (reg.status === 'ambiguous') {
          // 複数社に一致 → 自動選択しない（既存不変条件）。
          kind = 'identity_blocked';
          detail = 'master_ambiguous';
          results.push({ name, kind, companyId: '', detail, stats: { sources: 0, facts: 0, groups: [] } });
          console.log(`${name} | kind=${kind}(${detail}) | companyId=- | sources=0 | facts=0 | groups=-`);
          continue;
        }
      }
      const outcome = await runCompanyPrefetch(deps, name);
      kind = outcome.kind;
      companyId = 'companyId' in outcome ? outcome.companyId : '';
      if (outcome.kind === 'failed') detail = outcome.errorCode;
      else if (outcome.kind === 'identity_blocked') detail = outcome.reason;
      else if (outcome.kind === 'deduped') detail = outcome.outcome;
      else if (outcome.kind === 'written') detail = outcome.status;
      else if (outcome.kind === 'skipped') detail = outcome.reason;
    } catch (err) {
      // ★ 1 社の例外で batch 全体を止めない（他社の成功データも壊さない）。
      detail = err instanceof Error ? err.name : 'unknown';
    }
    const stats = companyId ? await readStats(companyId) : { sources: 0, facts: 0, groups: [] };
    results.push({ name, kind, companyId, detail, stats });
    console.log(
      `${name} | kind=${kind}${detail ? `(${detail})` : ''} | companyId=${companyId || '-'} | sources=${stats.sources} | facts=${stats.facts} | groups=${stats.groups.join('/') || '-'}`,
    );
  }

  console.log('');
  const usable = results.filter((r) => r.stats.facts > 0 && r.stats.sources > 0);
  console.log(`usable（fact>=1 かつ source>=1）: ${usable.length} / ${results.length}`);
  const failed = results.filter((r) => r.stats.facts === 0);
  if (failed.length > 0) {
    console.log('未取得:');
    for (const f of failed) console.log(`  - ${f.name} | kind=${f.kind}${f.detail ? `(${f.detail})` : ''}`);
  }
  process.exit(usable.length > 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error('ingest aborted:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
