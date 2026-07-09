# P8-B: matching-only activity compact（orchestrator-policy 通電）

> フェーズ: **P8-B（matching-only activity compact）**。P8-A / P8-A2 監査と P8-A3 persona guard を受けた実装 step。
> matching の base prompt 内 **activity render のみ**を tighter limits で縮める。**BaseMemorySummary は接続しない**。
> matching 以外の purpose・self_analysis / es_generation / interview / consultation は **一切変更しない**。
> DB / SQL / AI schema / Supabase / request body shape は不変。secret / env / token / Supabase URL /
> service_role / API key は非参照・非出力。

実装:
[`lib/careerContext/activity.ts`](../../lib/careerContext/activity.ts)（`MATCHING_ACTIVITY_LIMITS` 追加・型 widen）/
[`lib/careerContext/purpose.ts`](../../lib/careerContext/purpose.ts)（`matching.activity: 'minimal'`）/
[`lib/careerContext/orchestrator.ts`](../../lib/careerContext/orchestrator.ts)（activity:'minimal' 分岐）/
[`lib/careerAi/prompts.ts`](../../lib/careerAi/prompts.ts)（`buildCareerSystemPrompt` に activityLimits option）。
関連: [P4-A 中央メモリ型・マップ](./p4a_memory_types_map.md) / [P8-A3 persona spot-check](./p8a3_persona_spotcheck.md) /
[P7-B matching ES summary](./p7b_matching_es_summary.md) / [P3-H context budget](./p3h_context_budget_report.md)。

---

## 1. 何を削るか / 何を削らないか

**削る**: matching の system prompt 内 `# 活動・経験` section（AI narrative 根拠）の**長い自由記述 field と全体量**。
`MATCHING_ACTIVITY_LIMITS` = `{ maxSections: 12, maxCardsPerSection: 3, maxFieldChars: 50, maxTotalChars: 2800 }`。
既存 `formatCareerActivityForPrompt` を tighter limits で**再利用**する（新しい並立 builder は作らない・AI 再要約なし・決定論 trim のみ）。

**削らない**:
- **section / card 上限は既定と同一**（`maxSections:12` / `maxCardsPerSection:3`）。→ section 見出し・各 section の
  title・役割・**資格 / ITスキル / 語学 card は落とさない**（persona spot-check / matching fit の核を守る）。
- **request body の raw activity は不変**（body-neutral）。selector / snapshot.base / body shape は変更しない。
- profile（P6-C で氏名除去済）/ values / static system指示 は不変。
- **matching 以外の purpose は不変**（`activity:'compact'` のまま）。

## 2. なぜ BaseMemorySummary 直結ではないのか

- base prompt は memory 層ではなく **route/orchestrator 層**で生成される（P6-A 監査結論）。base 削減は
  `BaseMemorySummary`（memory 層の要約型・PII 除外別形状）ではなく **orchestrator-policy** で行うのが P6-A の方針。
- P8-B は P6-C の `profile:minimal → 氏名 strip` と**完全対称**の実装（policy flip 1 箇所 + orchestrator 1 分岐 +
  既存 formatter 再利用）。並立 builder を作らず、memory 層に触れない。
- `BaseMemorySummary` は **P4-A の型資産として温存**（削除も接続もしない）。

## 3. なぜ matching-only か（横展開しない理由）

- **matching の最終スコア / 順位は決定論エンジンが raw activity から算出する**
  （`buildMeasuredReadiness` → `runCareerMatch`。route が `b.activity`＝raw を直読み）。orchestrator の prompt
  activity compact は **AI の signal 根拠 narrative だけ**を縮め、**スコア / 順位を 1 bit も動かさない**。
  → 他 purpose に無い構造的安全性（P8-A2 の決定的発見）。
- **self_analysis / es_generation**: activity が生成の一次材料（分析対象そのもの）。圧縮は入力材料の直接毀損。
- **interview**: P7-D 判定＝C（gakuchika が面接深掘りの一次材料）。flat な圧縮を横展開しない。
- **consultation**: 司令塔・base 描画影響最大・`compressCareerActivityForConsultation` で別圧縮系あり。二重化リスク。

## 4. 実装（P6-C profile:minimal と対称）

1. `activity.ts`: `CareerActivityFormatLimits` を `as const` literal から **number 型へ widen**（formatter 挙動は不変・
   値を差し込めるようにするだけ）。`MATCHING_ACTIVITY_LIMITS` を追加。`CAREER_ACTIVITY_LIMITS`（既定）は値不変。
2. `purpose.ts`: `ActivityInclusion` に `'minimal'` を追加。`CAREER_CONTEXT_REGISTRY.matching.activity` を
   `'compact'` → **`'minimal'`**。他 purpose は `'compact'` のまま。
3. `prompts.ts`: `buildCareerSystemPrompt(context, options?)` に `options.activityLimits` を追加（未指定なら現行と
   byte 一致）。唯一の実呼び出し元は orchestrator。
4. `orchestrator.ts`: `policy.activity === 'minimal'` のとき `MATCHING_ACTIVITY_LIMITS` を
   `buildCareerSystemPrompt` に渡す。`effectiveContext`（生 activity object）・request body は不変。
   観測用に `omitted` へ `'activity.compacted'` を積む（挙動非依存）。

## 5. before / after 数値（文字数ベース / token 実測ではない）

`scripts/career-context-budget-qa.ts` の P8-B セクションで再現（決定論 mock）。

| scenario | body(raw activity JSON) | render(activity section) | base prompt total |
|---|---|---|---|
| normal | 453 → 453（**−0.0% 不変**） | 206 → 206（**−0.0% 無損失**） | 1134 → 1134 |
| heavy | 9196 → 9196（**−0.0% 不変**） | 3517 → 2817（**−19.9%**） | 5213 → 4513（**−13.4%**） |

- **body は不変**（raw activity を carry ＝ body-neutral・decision engine 入力も不変）。
- **prompt/token が減るのは render**。normal は上限未満で無損失、heavy は tighter limits（field 50 / total 2800）が
  裾を削り base total を 5213→4513（−13.4%）に縮める。
- 「body だけ縮んで token が減らない罠」の**逆**（body 不変・render のみ減）であることが readout で明示される。

## 6. persona spot-check 結果（[P8-A3 harness](./p8a3_persona_spotcheck.md)）

`qa:careerPersonaSpotcheck` の `AFTER_LIMITS` を production の `MATCHING_ACTIVITY_LIMITS` に一致させた。
7 ケース（normal / heavy / activity-multi-section / values-notes / overseas / internship / qualifications-it-languages）
**全 PASS**。normal 等は before ≡ after（no-loss）、heavy は長い自由記述 field（65字の「具体的な行動」）が
50 字 trim されるが **section 見出し / title / 役割 / 成果 / 定量（協賛社数18→27社、金額160%）/ 資格・IT・語学の核は保持**。
`--tighter` demo（card 上限 2）では 3 件目の IT スキル（AWS）が落ちて **FAIL** ＝ harness が実際に核欠落を検知する証跡。

## 7. harness の役割分担

| harness | 面 | P8-B での結果 |
|---|---|---|
| `qa:careerMemoryPromptGolden`（system prompt byte・25 golden） | prompt byte | **matching__heavy のみ**意図更新（`具体的な行動` field が `…` trim・核保持）。他 24 golden 不変。ALL_MATCH |
| `qa:careerMemoryMatching`（request body byte・18） | body byte | **ALL_MATCH**（body raw carry ＝ activity compact は body に出ない） |
| `qa:careerPersonaSpotcheck`（活動核情報・7） | 情報集合 | **7/7 PASS**（圧縮しても核が残る） |
| `qa:careerMemory{Presentation,Interview,Consultation}` | 他 purpose body byte | **16/18/32 ALL_MATCH**（matching-only の裏付け） |
| `qa:careerMatchingEsRender/Body` ほか ES 系 | ES render/body | **ALL_PASS**（P7 保証を壊さない） |
| `career-context-budget-qa`（P8-B readout） | 文字数観測 | body 不変 / render −19.9%(heavy) を可視化・rawTextGuard self-check ALL PASS |

PII（氏名）strict は matching 0/5 を継続（P6-C 維持）。`guardRawText` findings 非増加。

## 8. rollback 方針（rollback surface は小さい）

1. `purpose.ts`: `matching.activity` を `'minimal'` → `'compact'` に戻す（1 行）。
2. `activity.ts`: `MATCHING_ACTIVITY_LIMITS` を戻す / 削除（type widen は残してよい・挙動非依存）。
3. `matching__heavy.txt` golden を revert。
4. persona harness の `AFTER_LIMITS` を `CAREER_ACTIVITY_LIMITS`（before と同一）に戻す。
5. **BaseMemorySummary / snapshot / selector には触れていない**ため rollback は policy + golden + limits 定数のみ。

## 9. cap 妥当性 / 今後

- `maxFieldChars: 50` は matching の narrative 根拠向けの pilot 値（identifier / 役割 / 定量は残り、長い散文の裾のみ削る）。
  aggressive すぎないか（narrative 根拠が薄まらないか）は運用観測で調整する（P7-F と同じく保守的調整方針）。
- 他 purpose への横展開はしない（§3）。activity compact の横展開検討時は purpose 別に品質評価を経てから
  purpose 専用 limits を定義する（matching の値を機械流用しない）。
