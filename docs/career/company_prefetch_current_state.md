# Company Prefetch / Company Data Spine — current state

志望企業名の入力を起点に、企業研究を開くより **前** に企業情報を先回りして集め、
Company Data Spine を ES / 面接 / 志望動機 / Career AI の共通基盤にするための機能。

**状態: code-complete / flag OFF。** Production は通電していない。

**DDL 適用状態（2026-08-17 に Project B へ live probe で実測）:**

| 対象 | 状態 |
|---|---|
| `career_company_identity_apply.sql`（master / aliases） | **適用済み** |
| `career_company_official_facts_apply.sql` の **v1 部分** | **適用済み**（sources / facts / derived / enrichment_jobs / claim RPC 10 引数版） |
| v2 差分（`facts.schema_revision` 列 / `fact_group` の `developments`） | **適用済み**（operator が SQL Editor で実行） |

v2 差分の実測結果:

- `facts.schema_revision` = `text` / **nullable**（既存 11 行は NULL のまま生存 → backfill 不要）
- `fact_group` CHECK は code の 7 group（`identity` / `profile` / `navigation` / `ir` /
  `recruiting` / `developments` / `news`）を全て受け、未知 group は `23514` で拒否する
- 適用による既存データの欠損なし（company 1 / sources 6 / facts 11 / enrichment_jobs 1 が保全）

実 DB での v1 → v2 refresh・v2 persistence は実測済み（→ §3-1 の「実測（live）」）。

**fact schema: v2**（2026-08-17。企業分析向けに fact key を 25 → 62 へ拡張。→ §3-1）

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
| DDL | `supabase/career_company_official_facts_apply.sql`（**適用済み**・v1 + v2 差分とも） |

### 3-1. fact schema v2（企業分析向け項目拡張・2026-08-17）

`COMPANY_FACT_SCHEMA_REVISION = 'company-facts-v2'`。fact key を **25 → 62** へ拡張し、
企業研究 / ES / 面接が「会社概要」だけでなく **事業構造・理念・戦略・財務・市場・採用・
最近の動向**を出典付きで参照できるようにした。EAV なので **列追加は不要**
（追加したのは `facts.schema_revision` 1 本のみ / nullable）。

#### fact_group の 2 階層（コスト設計の中核）

| 区分 | group | 役割 |
|---|---|---|
| `PREFETCH_FACT_GROUPS` | identity / profile / navigation | **refresh cycle を駆動する**。claim / cooldown / `completed` 判定の対象 |
| `OPPORTUNISTIC_FACT_GROUPS` | ir / recruiting / developments | job が走ったときに **便乗して取る**だけ。取れなくても status に影響しない |
| 契約のみ | news | volatile すぎるため **保存しない**（都度取得が正しい） |

★ ir / recruiting を `PREFETCH_FACT_GROUPS` に入れてはいけない。
入れると (a) `refreshCooldownIsConsistent()` が cooldown の短縮を要求し全企業の再取得間隔が縮む、
(b) IR を公開していない企業が **恒常 partial** となり failure cooldown（1 日）で毎日再取得が走る。
この不変条件は `types/careerCompanyOfficial.ts` の doc と
`scripts/career-company-spine-expansion-qa.ts` の `X-8d` / `X-8s` が固定する。

#### ページ別抽出（1 ページ = 1 抽出 = 1 出典）

| ページ | 埋まる group | 主な key |
|---|---|---|
| トップ | navigation / profile | 入口 URL・`officialDomain` |
| 会社概要 | profile | 規模・事業・代表者・ビジネスモデル・顧客・強み |
| 理念（無ければ会社概要本文） | profile | `missionStatement` / `visionStatement` / `corporateValues` |
| 決算 or IR | ir | 売上・利益・セグメント・中期計画・成長戦略・課題・リスク・市場環境 |
| 採用 | recruiting | 求める人物像・職種・社風・働き方・研修・キャリア |
| ニュース一覧 | developments | 最近の動向（最大 6 件）・新製品・提携・M&A |

抽出値は **そのページの本文**に対して grounding 検証する（別ページの本文で検証しない）。
1 job の予算は `MAX_FETCHES_PER_JOB=10` と `ENRICHMENT_DEADLINE_MS` で、
`prefetchJobService` が各ページの前に確認して打ち切る（打ち切っても既取得分は保存する）。

#### deploy 順序の吸収（コード先行 / DDL 後追い）

本 repo の運用は「コードは Vercel で先に出る / DDL は operator が SQL Editor で後から適用」で、
**順序が保証されない**。v2 のコードが v1 の DB に当たると
`select(... schema_revision)` は 42703、insert は PGRST204 で失敗する。
握らないと DDL 適用までの間 **enrichment が丸ごと停止**する（freshness read が
DB_ERROR → job が skipped に倒れる）。

そこで `repository.server.ts` が両方を検出して縮退する:

| 経路 | 縮退 |
|---|---|
| freshness read | 列を外して読み直す（`schemaRevision = null` ＝ 世代不明 → TTL のみで判定） |
| facts insert | `schema_revision` を外して書き直す（v2 適用後に世代ズレとして 1 回だけ再取得される） |

実 DB（v1 適用済み・facts 11 件）で fallback が効くことを確認済み。
`qa:careerCompanySpineExpansion` の `X-4k` / `X-4l` が固定する。

#### schema 世代（新 key を既存企業へ行き渡らせる仕組み）

key を増やしただけでは、TTL 内の企業は freshness short-circuit で `fresh` と判定され
**新 key が最長 90 日入らない**。そこで `facts.schema_revision` を持ち、
「最新 fact が旧世代」の group を stale とする（`isSchemaRevisionStale`）。
1 企業あたり **1 世代につき 1 回だけ**余分な取得サイクルが走り、その後は通常の TTL 判定へ戻る。
`schema_revision` が NULL（v1 以前の行）は stale にしない（旧行を一斉に stale にして storm を作らない）。

#### 主観の扱い（raw fact と分析の分離）

競争優位・課題・市場ポジションは **企業自身が述べている記述**としてのみ保存する
（`selfDescribedStrengths` / `statedChallenges` / `businessRisks` / `marketPositionClaims` /
`namedCompetitors`）。我々の分析・競合比較・将来予測は fact ではないため保存経路を持たない
（`career_company_derived` の責務であり、Phase 3 でも生成しない）。

#### prompt への渡し方

renderer が **企業分析の観点**で section 化する（会社概要 / 事業 / 理念・戦略 / 業績・財務 /
市場・競合 / 採用・組織 / 最近の動向 / 参照ページ）。空 section の見出しは出さない。
budget は purpose 別:

| purpose | maxBytes | maxFacts |
|---|---|---|
| `company_research_review` | 4600 | 48 |
| `interview_practice` | 1600（従来据え置き） | 18 |

#### 実測（live・2026-08-17 / Project B / 任天堂株式会社）

DDL 適用後、実 DB に対して production path（`runCompanyPrefetch`）を通した結果:

| 観測点 | 結果 |
|---|---|
| v1 世代（`schema_revision='company-facts-v1'`）の検出 | identity / profile / navigation の 3 group が `stale`（age 約 2.6h ≪ TTL 90 日） |
| claim | `CLAIMED_NEW`（世代が idempotency key の材料なので v1 の terminal 行の cooldown に縛られない） |
| 取得 | 実 HTTP 4 ページ / 実 Anthropic 抽出 5 回 / grounding 検証あり |
| 永続化 | **14 facts**（identity 3 / profile 7 / navigation 3 / recruiting 1）すべて `schema_revision='company-facts-v2'` |
| job terminal | `completed`（attempt 1 / cycle 1 / error_code NULL） |
| 直後の再判定 | 3 group とも `fresh` → `kind:'fresh'`（外部 I/O ゼロ。**refresh storm なし**） |
| provenance | 14/14 で `source_id` 解決・出典ドメインが同一企業・`llm_extraction` は rawExcerpt が原文に逐語一致・URL fact は実 href |
| 欠損の扱い | 48 key が **行として存在しない**（`不明` / 推測での埋めは 0 件） |
| renderer | `company_research_review` 2055B / 14 facts、`interview_practice` 1579B（budget 内）、allowlist 外 purpose は空 |

取れなかった group と理由（いずれも現行 pipeline の想定内・§8 参照）:

- `ir` — IR ランディングと決算ページが PDF リンク集のため抽出値が 0 件
- `developments` — 会社概要ページに news リンクが無く、同社の news index は
  **別の登録ドメイン**（`nintendo.com`）にあるため `sameSite` 不変条件が正しく拒否する。
  同ページに対する抽出単体では `recentDevelopments` / `productLaunches` が 12/12 grounded で
  取れており、group そのものは DB CHECK も含めて受理される。

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
`qa:careerCompanyPrefetchTtl` / `qa:careerCompanySpineExpansion` /
`qa:careerCompanySpineCoverage` / `qa:careerCompanySpine` / `qa:careerCompanyPickerRelease`

`qa:careerCompanySpineExpansion`（fact schema v2）が固定するもの:
追加 key の group / label / section 割当、幻覚除去、v1 row の後方互換、provenance、
DB 往復での欠落無し、企業分析 prompt への実流入、部分データ耐性、
schema 世代による再取得、opportunistic group が storm を生まないこと。

`qa:careerCompanySpineCoverage` は企業タイプ別（大手上場 / tech ベンチャー / 情報量の少ない中小）の
**項目カバレッジ smoke**。ネットワーク / DB / LLM のみ fake で、grounding 検証・fact 写像・
renderer は本物を通す。満点を目指すものではなく、情報量の差がそのままカバレッジの差になり、
仕込んだ幻覚が落ちることを確認するためのもの。

`scripts/career-company-spine-qa.ts` の `[G]` は「未実装であること」の absence guard から
「契約どおりであること」の contract guard へ **意図的に反転**済み（削除ではない）。

## 7. 残る運用手順（コードでは終わらないもの）

1. ~~`supabase/career_company_identity_apply.sql` を Project B へ適用~~ — **完了**
2. ~~`supabase/career_company_official_facts_apply.sql` を Project B へ適用~~ — **完了**（v2 差分含む）
   - 事前に registry CSV の列同定が実 API 応答で通ることを 1 件確認する
     （parser は列順非依存だが、実応答での動作確認は取得前に済ませたい）— **未実施**
     （`CAREER_CORPORATE_REGISTRY_APP_ID` 未設定のため。identity group は公式サイト側の
     抽出で埋まるので enrichment 自体は止まらない）
   - 再実行は引き続き安全（`ADD COLUMN IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` →
     `ADD CONSTRAINT`）。追加適用が要る差分が出たら同じファイルをもう一度流すだけでよい。
3. provider secret を Preview env に設定（`CAREER_CORPORATE_REGISTRY_APP_ID` / `CAREER_COMPANY_SEARCH_*`）
4. `CAREER_COMPANY_PREFETCH_CANARY_USER_IDS` に自分の UUID のみ設定
5. `CAREER_COMPANY_PREFETCH_ENABLED=true`（この時点では外部 I/O ゼロ・identity のみ）
6. Preview で挙動確認 → `CAREER_COMPANY_PREFETCH_EXTERNAL_FETCH_ENABLED=true`
7. Production 有効化は canary 結果を見てから

## 8. 非対象（fact schema v2 でも取らないもの）

- **IR の PDF / 有価証券報告書の全文解析** — IR ランディングがリンク集だけの企業では
  `ir` group が薄くなる。PDF 解析は provider 追加が必要なため未実装。
- **競合分析・市場シェアの推定** — 公式資料が競合名やシェアを明記していない限り取らない
  （推測は `ai_policy.md` 違反）。`namedCompetitors` / `marketPositionClaims` は
  あくまで **企業自身の記述**の抽出。
- **選考フロー・締切・給与** — 年度で変わるため保存しない（採用 prompt でも扱わない）。
- **個別ニュースの逐次収集**（`news` group）と scheduled cron enrichment。
  `news` の `fact_group` と provider interface は将来足せる形で残してある。
- **AI 派生要約**（`career_company_derived`）— 生成経路は依然として作っていない。
