# Company Prefetch / Company Data Spine — current state

志望企業名の入力を起点に、企業研究を開くより **前** に企業情報を先回りして集め、
Company Data Spine を ES / 面接 / 志望動機 / Career AI の共通基盤にするための機能。

**状態: code-complete / flag OFF / DDL 未適用。** Production は通電していない。

---

## 1. 設計思想（最重要）

`docs/principles/ai_policy.md`（入力にない事実の創作を禁止）と
`docs/company_research/company_research_current_state.md`（AI は企業情報の生成者ではなく添削者）を
壊さないことが最上位の制約。よって:

- prefetch が保存するのは **出典 URL に遡れる事実だけ**。`career_company_official_facts.source_id` は NOT NULL。
- LLM は **抽出器としてのみ**使う。生成・推測・要約は prompt で禁止し、
  さらに保存前に「抽出値が原文に実在するか」を決定論で検証して落とす（`extraction.ts`）。
- AI 派生要約は `career_company_derived` に分離し、**facts へ昇格させない**。
- prompt では 3 つを別ブロックにする: `[公式情報]` / `[ユーザー自身の企業研究]` / `[AI による参考情報]`。

## 2. データフロー

```
CompanyPicker（free-text のまま・UI 変更なし）
  └ onBlur → notifyCompanyIntent()  ── fire & forget（T2）
POST /api/career/company/intent            AI route（企業研究など・T1）
  └ evaluateCompanyPrefetchGate            └ triggerCompanyPrefetch()
        │ flag → env/auth → canary → rate limit
        ▼ after()（response を待たせない）
  runCompanyPrefetch()
    1a 内部 registry 照合（DB のみ・outbound ゼロ）
    1b freshness short-circuit ← fresh なら **ここで終了・cost 0**
    1c 外部 registry（法人番号）→ registerCompany（既存 Identity を再利用）
       ambiguous / unresolved → 停止（facts を取りに行かない・企業を作らない）
    2  freshness 再確認
    3  claim（company-scoped・N 人 → 1 job）
    4  domain discovery（検索 → 実取得 → 法人名照合）→ 会社概要 → LLM 抽出 → 出典検証
    5  sources を先に書き、source_id を持つ fact だけ書く
    6  completed / partial / failed（attempt fencing）
                    │
                    ▼
      Company Data Spine（global・非個人データ）
                    │
  loadCompanyOfficialContext() → renderCompanyOfficialForPurpose()
                    │
  Orchestrator extras.company → companyOfficialContext（別 field）
                    │
              企業研究 route（Phase 2 の唯一の consumer）
```

## 3. 主要ファイル

| 層 | パス |
|---|---|
| 型契約 | `types/careerCompanyOfficial.ts` |
| freshness（fact_group 別 TTL） | `lib/careerCompanyOfficial/freshness.ts` |
| projection / 読み出し | `lib/careerCompanyOfficial/projection.ts` / `readRepository.server.ts` |
| renderer | `lib/careerContextRenderers/companyOfficialContext.ts` |
| flag / gate | `lib/careerCompanyPrefetch/flags.server.ts` / `gate.server.ts` |
| SSRF guard | `lib/careerCompanyFetch/urlGuard.ts` / `safeFetch.server.ts` |
| providers | `lib/careerCompanyPrefetch/providers/*`（registry / search / official site） |
| 抽出と検証 | `lib/careerCompanyPrefetch/extraction.ts` |
| fact 写像 | `lib/careerCompanyPrefetch/factMapping.ts` |
| job orchestration | `lib/careerCompanyPrefetch/prefetchJobService.ts`（pure DI）/ `runtime.server.ts`（配線） |
| 永続化 | `lib/careerCompanyPrefetch/repository.server.ts` |
| API | `app/api/career/company/intent/route.ts` |
| DDL | `supabase/career_company_official_facts_apply.sql`（**NOT APPLIED**） |

## 4. Feature flags（すべて未設定 = OFF）

| flag | 役割 |
|---|---|
| `CAREER_COMPANY_PREFETCH_ENABLED` | 実行権限。OFF なら I/O ゼロ |
| `CAREER_COMPANY_PREFETCH_EXTERNAL_FETCH_ENABLED` | 外部取得の独立 kill switch |
| `CAREER_COMPANY_PREFETCH_CANARY_USER_IDS` | fail-closed allowlist |
| `CAREER_CORPORATE_REGISTRY_APP_ID` / `_BASE_URL` | 公的 registry |
| `CAREER_COMPANY_SEARCH_*` | 検索 provider（provider 非依存） |

**独立性:** `CAREER_COMPANY_MATCHING_ENABLED` と `CAREER_COMPANY_IDENTITY_ENABLED` は
OFF のままで本機能だけ ON にできる（prefetch のコードはどちらの flag も参照しない）。
`/career/company` は 404 のまま、CompanyPicker も free-text のまま。

## 5. Identity の作成規則（重要）

- **公的 registry で裏が取れた企業だけ新規作成する。**
  registry が使えない構成では **既存企業への紐付けのみ**行い、free-text だけで
  全ユーザー共有の企業マスタに行を作らせない（append-only で in-app 訂正手段が無いため）。
- `ambiguous` / `unresolved` は確定させず、profile enrichment へ進めない。
- `normalizeCompanyName` は語頭/語末の token boundary でのみ法人格を除去し、
  `有限会社` などの区別が必要な法人格は `<core>#<tag>` 形式で保持する。

## 6. QA

```
npm run qa:careerCompanyPrefetchAll
```
individual: `qa:careerCompanyNormalize` / `qa:careerCompanyOfficialSql` /
`qa:careerCompanyFetchGuard` / `qa:careerCompanyPrefetch` /
`qa:careerCompanyOfficialContext` / `qa:careerCompanyPrefetchE2E` /
`qa:careerCompanySpine` / `qa:careerCompanyPickerRelease`

`scripts/career-company-spine-qa.ts` の `[G]` は「未実装であること」の absence guard から
「契約どおりであること」の contract guard へ **意図的に反転**済み（削除ではない）。

## 7. 残る運用手順（コードでは終わらないもの）

1. `supabase/career_company_identity_apply.sql` を Project B へ適用（現在 NOT APPLIED）
2. `supabase/career_company_official_facts_apply.sql` を Project B へ適用（現在 NOT APPLIED）
   - 事前に registry CSV の列同定が実 API 応答で通ることを 1 件確認する
     （parser は列順非依存だが、実応答での動作確認は取得前に済ませたい）
3. provider secret を Preview env に設定（`CAREER_CORPORATE_REGISTRY_APP_ID` / `CAREER_COMPANY_SEARCH_*`）
4. `CAREER_COMPANY_PREFETCH_CANARY_USER_IDS` に自分の UUID のみ設定
5. `CAREER_COMPANY_PREFETCH_ENABLED=true`（この時点では外部 I/O ゼロ・identity のみ）
6. Preview で挙動確認 → `CAREER_COMPANY_PREFETCH_EXTERNAL_FETCH_ENABLED=true`
7. Production 有効化は canary 結果を見てから

## 8. 今回の非対象（Deep Research）

IR 全文解析 / 決算 / 最新ニュース収集 / 採用選考情報 / 競合分析 / 企業文化推定 /
ES・面接材料生成 / scheduled cron enrichment。
`fact_group`（`ir` / `recruiting` / `news`）と provider interface は将来足せる形で残してある。
