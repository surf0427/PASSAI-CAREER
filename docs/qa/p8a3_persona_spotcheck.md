# P8-A3: activity 圧縮 persona spot-check harness（前提guard 追加）

> フェーズ: **P8-A3（additive harness のみ）**。P8-A / P8-A2 監査の結論を受け、P8-B
> （matching-only activity compact）へ進む前提条件だった「persona 核情報の保持を守る自動/準自動
> harness」を追加する。**production code / route / prompt / selector / snapshot / orchestrator /
> AI schema / DB は一切変更しない**（harness + docs のみ追加）。
> secret / env / token / Supabase URL / service_role / API key は非参照・非出力。

追加物: [`scripts/career-persona-spotcheck-qa.ts`](../../scripts/career-persona-spotcheck-qa.ts) と本文書のみ。
関連: [P4-A 中央メモリ型・マップ](./p4a_memory_types_map.md) / [P3-H context budget 実測](./p3h_context_budget_report.md) /
[cross_feature_persona_consistency](./cross_feature_persona_consistency.md) /
[P7-B matching ES summary](./p7b_matching_es_summary.md) / [P7-F presentation ES summary](./p7f_presentation_es_summary.md)。

---

## 1. なぜこの harness が必要か（P8-A / P8-A2 との関係）

- **P8-A**: base context の残る最大レバーは activity block 一点に集中している（profile PII は
  P6-C〜F で回収済み・static system指示は AI 挙動直結で不可・values は小）。ただし activity は
  ES summary（P7）とは**リスク階級が違う** — persona consistency / self-analysis / ES / matching fit の
  一次材料であり、「低リスク高ROI」削減として扱えない。**persona を守る harness が無い**ことが最大 gap とされた。
- **P8-A2**: 削減は **BaseMemorySummary 直結ではなく**、P6-A と整合する **orchestrator-policy による
  matching-only activity compact**（既存 `formatCareerActivityForPrompt` を tighter limits で再利用）で
  実現するのが安全と結論。決定的根拠として、matching の最終スコアは決定論エンジン
  （`buildMeasuredReadiness` → `runCareerMatch`）が **raw activity を直読み**するため、prompt 圧縮の
  影響を一切受けない（AI の根拠 narrative だけが圧縮 activity を見る）。唯一の前提条件が
  「activity 圧縮前後で persona 核情報が欠落しないことを検査する harness」。
- **P8-A3（本フェーズ）**: その前提 harness を **production を変えずに先行追加**する。activity compact
  自体は未実装（`AFTER_LIMITS` は既定で現行 limits と同一 → before ≡ after で全ケース PASS ＝ 現行挙動固定）。

**位置づけ**: 本 harness は **orchestrator-policy matching-only activity compact（P8-B）の前提 guard** であり、
**BaseMemorySummary 直結の前提ではない**。BaseMemorySummary は接続しない（P8-A の結論を維持）。

---

## 2. 何を守るか / 何を守らないか

### 守る（activity 圧縮 after で欠落してはいけない核情報）

| 観点 | 検査内容 |
|---|---|
| section preservation | `■ {section label}` が after にも存在（主活動カテゴリ集合の保持） |
| title / headline | focused / overseas / internship 等の主要 title が after に残存 |
| 役割 / 成果 / 定量 | 役割・成果・数字（`160%` / `1.5` / `10%` 等）が after に残存 |
| qualifications / IT / 語学 | 資格名・ITスキル・言語（matching fit に効く）が after に残存 |
| overseas / internship | 海外経験（period / strength）・インターン（役割 / 定量）の主要要素が残存 |
| profile / values 非回帰 | strengths / targetIndustries / targetJobs / values 主要ラベルが base prompt に存在（activity 圧縮は本来これらを変えない） |
| normal no-loss | 上限未満の normal は before ≡ after（tighter limits でも小入力は不変） |
| rawTextGuard 非増加 | 圧縮で guard findings が増えない（構造化 context は不変・render 文字列のみ短縮） |

### 守らない（意図的に対象外）

- activity の **裾**（第2カード以降・field 末尾・`（ほか N 件省略）` になる分）— 圧縮で削れてよい。
- profile / values / static system指示の byte（activity 圧縮の対象外。守るのは prompt golden 側）。
- token 実測（本 harness は文字数ベース。日本語の token 実測は別途）。
- AI 出力そのものの品質（本 harness は入力 prompt の核保持のみ。AI 挙動評価はしない）。

---

## 3. AI 非使用・決定論であること

- **AI API を呼ばない / DB・Supabase に接続しない / env・secret を読まない**。現行 production 純関数
  （`buildCareerAiContext` / `formatCareerActivityForPrompt` / `buildCareerContextForPurpose` /
  `guardRawText`）を **import して読むだけ**。
- 検査は文字列 include / section marker(`■`) / token 一致のみ ＝ **完全に決定論的**（再実行で同一結果）。
- `Date.now()` / 乱数 / 時刻依存を持たない。

---

## 4. before / after 構造（P8-B でどう使うか）

- **before**: `formatCareerActivityForPrompt(activity, BEFORE_LIMITS)`（現行 production limits）。
- **after**: `formatCareerActivityForPrompt(activity, AFTER_LIMITS)`。**現時点では AFTER_LIMITS = BEFORE_LIMITS**
  （before ≡ after → 全ケース PASS ＝ 現行挙動を固定）。
- **P8-B**: `AFTER_LIMITS` を matching 専用 tighter limits に差し替えると、同じ harness が
  「圧縮しても核が残るか」の回帰ガードになる。`--tighter` フラグで demo tighter limits
  （`maxCardsPerSection:2 / maxFieldChars:100 / maxTotalChars:2000`）を手元シミュレートできる
  （CI では使わない）。demo 実行では `qualifications-it-languages` が第3スキル（AWS）を落として
  **FAIL する**ことを確認済み ＝ harness が実際に核欠落を検知する証跡。

> **production 側の記録（P8-B で必要）**: `CareerActivityFormatLimits` は `as const` の literal 型で
> 値が固定のため、別の数値を渡すと typecheck が通らない。本 harness は number へ緩めた `ActivityLimits` を
> 使い call 時に cast している。**P8-B で tighter limits を実通電するには production 側で
> `CareerActivityFormatLimits` を number へ widen する**（`formatCareerActivityForPrompt` の限界値を
> 可変にする）最小変更が要る。

---

## 5. fixture ケース（7 種）

既存 prompt-golden fixture を流用（normal / heavy / activity-multi-section / values-notes）＋ 新規 3 種
（overseas / internship / qualifications-it-languages）。各ケースは `expect.sections`（残るべき section）/
`expect.tokens`（残るべき核 token）/ `expect.profileValuesTokens`（非回帰の profile/values 由来 token）を持つ。

| case | 主眼 | 由来 |
|---|---|---|
| normal | 上限未満 no-loss + ガクチカ核 | 既存流用 |
| heavy | 圧縮が効く主ケース（ガクチカ/アルバイト/海外/定量） | 既存流用 |
| activity-multi-section | 多 section 見出し + IT/資格/語学 | 既存流用 |
| values-notes | values ラベル非回帰 | 既存流用 |
| overseas | 海外経験（period / strength / 学び） | 新規 |
| internship | インターン/アルバイト（役割 / 定量成果） | 新規 |
| qualifications-it-languages | 資格 / ITスキル / 語学（matching fit 要素） | 新規 |

現状（before ≡ after）の実行結果: **7/7 PASS（ALL_PASS）**。

---

## 6. 既存 harness との役割分担

| harness | 守る面 | P8-B での役割 |
|---|---|---|
| `qa:careerMemoryPromptGolden`（system prompt byte・25 golden） | **prompt byte**（活動含む base の完全一致） | activity compact 時に matching golden を意図更新・diff レビュー |
| `qa:careerMemory*`（request body byte・84 ケース） | **request body byte** | activity compact は body raw carry のため **不変**（回帰ガード継続） |
| **`career-persona-spotcheck-qa`（本 harness）** | **activity 圧縮前後の核情報保持**（意味論） | golden の byte 差分が「核を壊していない」ことを補完検査 |
| `career-context-budget-qa` | 文字数 readout | P8-B で base(activity) before/after を数値観測 |
| `rawTextGuard`（本 harness 内で呼ぶ） | raw 本文混入 | 圧縮で guard findings 非増加を確認 |

- **prompt golden = byte / persona spot-check = 情報集合**の 2 面で activity compact を守る。golden は
  「何 byte 変わったか」を、persona は「変わった結果、核が残っているか」を担当する。
- **budget QA** は削減効果の数値（body 不変 / render 減）を出す観測レーン（fail はさせない）。

---

## 7. 現時点では production behavior を変えない

- `AFTER_LIMITS = BEFORE_LIMITS`（現行 limits）＝ before ≡ after ＝ **現行 production 挙動を固定**するだけ。
- activity compact 自体は **未実装**。BaseMemorySummary は **未接続**。orchestrator-policy も **未変更**。
- 追加は harness 1 本 + docs のみ。既存 QA（prompt golden 25/25・matching body 18/18・ES render/body）は
  全て ALL_MATCH / ALL_PASS を維持（production 未変更のため）。

---

## 8. P7-H footnote の扱い

- P8-A / P8-A2 で挙げた「[p7b](./p7b_matching_es_summary.md) §7 の『presentation body 不変』は P7-B 時点の
  記述で、P7-F の summary 化と時点差がある」という cosmetic doc fix（P7-H）は、**本 P8-A3 では入れない**。
- 理由: 本フェーズは persona harness 追加が主眼で、p7b への footnote は無関係な doc への混在になる。
  実害も無い（§6 で presentation P7-F 化は既に記述済み・byte-QA は PASS 継続）。
- **P8-B の docs commit に同梱**するのが自然（activity compact の docs 更新と一緒に p7b §7 へ 1 行注記）。

---

## 9. 次工程（P8-B）への接続

1. production 側で `CareerActivityFormatLimits` を number へ widen（§4 の最小変更）。
2. `CAREER_CONTEXT_REGISTRY.matching.activity` に compact レベルを通電（orchestrator に profile:minimal と
   対称の 1 分岐追加。既存 `formatCareerActivityForPrompt` を matching 専用 tighter limits で呼ぶ）。
3. 本 harness の `AFTER_LIMITS` を同 tighter limits に合わせ、**7/7 PASS を維持できる limits**を選定する
   （demo tighter では qualifications の AWS が落ちるため、資格/IT/語学 section は card 上限を緩める等の調整が要る）。
4. matching heavy 系 golden を意図更新・budget QA で before/after を記録・rawTextGuard 非増加を確認。
5. rollback は policy 1 行 flip + golden revert + limits 定数 revert。
