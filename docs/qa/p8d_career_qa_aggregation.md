# P8-D: career QA 集約 / persona spot-check strict gate 配線

> フェーズ: **P8-D（QA 集約のみ）**。P8-A3 / P8-B / P8-C を受け、matching activity compact の回帰と
> persona 核情報保持を **CI に載せやすい形**で束ねる。**production code は一切変更しない**
> （package.json の script 追加 + docs のみ）。matching activity compact の挙動不変・
> **BaseMemorySummary 未接続**・他 purpose への横展開なし。
> secret / env / token / Supabase URL / service_role / API key は非参照・非出力。

追加物: `package.json`（`qa:careerContextCore` / `qa:careerMemoryAll` の 2 script）と本文書のみ。
関連: [P8-A3 persona spot-check](./p8a3_persona_spotcheck.md) / [P8-B matching activity compact](./p8b_matching_activity_reduction.md) /
[P7-B matching ES summary](./p7b_matching_es_summary.md)。

---

## 1. なぜ career QA を集約するか

P8-B（matching activity compact）の回帰は **複数 harness の組（面が違う）**で守られている。個別に叩くのは
漏れやすいため、CI / pre-merge で **1 コマンド**で回せる集約を用意する。既存 career QA は 12 本の
standalone `qa:career*` に散っており、束ねる aggregate が無かった（唯一の chain は無関係の `qa:diagnosis`）。

集約は **決定論 QA だけ**を対象にする（AI/API/DB/env 非依存＝flakiness ゼロ・CI 安全）。

## 2. 追加した 2 script（既存 `qa:diagnosis` と同じ `&&` chain）

### `qa:careerContextCore`（軽量・per-change CI gate / 実測 ~5s）
matching activity compact + matching pilot（P6/P7/P8）の回帰を守る最小セット:

| 構成 | 面 | 何を守るか |
|---|---|---|
| `qa:careerPersonaSpotcheck` | activity 圧縮前後の**核情報保持** | **P8-B の strict guard**（section/title/役割/定量/資格·IT·語学）。rawTextGuard 非増加も検査 |
| `qa:careerMemoryPromptGolden` | **system prompt byte**（25 golden） | base/activity/PII の意図しない prompt 変化 |
| `qa:careerMemoryMatching` | **request body byte**（18） | activity compact の **body-neutral**（raw carry 不変） |
| `qa:careerMatchingEsRender` | ES render golden | P7-B の ES summary render 保証 |
| `qa:careerMatchingEsBody` | ES body shape | P7-B の ES body 3-key 保証 |

### `qa:careerMemoryAll`（full 回帰 / 実測 ~11s・`careerContextCore` を composes）
上記 core に加え、**matching-only の横展開ゼロ**を保証する他 purpose の byte QA を含む:
`qa:careerMemory{Presentation,Interview,Consultation}` + `qa:career{Interview,Presentation}EsRender` +
`qa:careerPresentationEsBody`。→ presentation/interview/consultation body byte が不変であることを CI で担保。

いずれも `npm run X && npm run Y ...` で、**1 本でも失敗すれば aggregate は exit 1**（`&&` 短絡・npm が
exit code を伝播）。

## 3. persona spot-check の strict gate 性

- `qa:careerPersonaSpotcheck`（引数なし）は **7/7 PASS で exit 0 / 1 件でも FAIL で exit 1**
  （`process.exit(ok ? 0 : 1)`, `ok = failed === 0`）。
- **AI/API/DB/env 非依存・完全決定論**（実測 ~0.94s）。production 変更なしでも安定。
- **rawTextGuard findings 非増加**を検査（`guardAfter <= guardBefore`）。
- **future tighter limits 調整時に核欠落を検知**する（`--tighter` demo で 3 件目 IT スキル欠落→exit 1 を実証）。
- **`--tighter` demo は CI に入れない**（意図的に FAIL する手元検証用）。aggregate は引数なしの
  `qa:careerPersonaSpotcheck` を呼ぶため、`--tighter` は自然に除外される。

→ activity limits を今後調整する際は、**`AFTER_LIMITS` を production の `MATCHING_ACTIVITY_LIMITS` に合わせた
persona spot-check が green であること**を必須ゲートにする。

## 4. harness 役割分担（面が違うものを重ねる）

| harness | 面 | 単独では見えないもの |
|---|---|---|
| persona spot-check | 活動核情報の**集合**（意味論） | byte（golden が担当） |
| prompt golden | **system prompt byte** | 情報集合の保持（persona が担当） |
| matching body byte | **request body byte**（body-neutral） | prompt 側の変化（golden が担当） |
| ES render/body | ES の render/shape | activity（persona/golden が担当） |
| `career-context-budget-qa`（**手動 readout**） | 文字数 before/after・rawTextGuard self-check | — |

persona = 「圧縮しても核が残るか」、golden = 「何 byte 変わったか」、body byte = 「body は不変か」を
それぞれ担当し、**3 面が揃って初めて activity compact の安全性を担保**する。

## 5. CI 向け / 手動確認向けの使い分け

- **CI（per-change の必須 gate）**: `npm run qa:careerContextCore`（~5s・決定論）。
- **CI（pre-merge / nightly の full 回帰）**: `npm run qa:careerMemoryAll`（~11s・他 purpose 不変も担保）。
- **手動（activity limits 調整の before/after 観測）**: `npx tsx scripts/career-context-budget-qa.ts`
  （body 不変 / render 削減の数値 readout + rawTextGuard self-check。readout 主体のため集約には入れない）。
- **手動（guard が実際に効くことの確認）**: `npx tsx scripts/career-persona-spotcheck-qa.ts --tighter`
  （**CI には入れない**。意図的に FAIL する demo）。

## 6. 集約に**入れない**もの（と理由）

- `qa:careerMatching`（scoring engine 回帰）: 決定論だが prompt/memory 面ではなく scoring 面。本集約は
  activity compact / prompt / memory の回帰に focus するため対象外（必要なら別途 CI に追加可）。
- `qa:rateLimit`: `process.env` を書き換え・専用 tsconfig・timing 依存のため CI 軽量集約に不適。
- `career-context-budget-qa`: readout 主体（exit は rawTextGuard self-check）。手動観測用に残す。

## 7. 不変性の確認（本フェーズで変えていないもの）

- **production code 変更ゼロ**（`lib` / `app` に差分なし）。matching activity compact の挙動不変。
- **BaseMemorySummary 未接続**（memory 層に触れていない）。
- self_analysis / ES / interview / presentation / consultation への activity compact **横展開なし**。
- 変更は `package.json` の 2 script 追加 + 本 docs のみ。

## 8. QA 実測

- `qa:careerContextCore`: **exit 0 / ~5.2s**（persona 7/7・prompt golden 25/25・matching body 18/18・
  matching ES render/body ALL_PASS）。
- `qa:careerMemoryAll`: **exit 0 / ~11.0s**（上記 + presentation/interview/consultation body 16/18/32・
  interview/presentation ES render/body ALL_PASS）。
- typecheck 0 error / lint OK（TS 変更なし）。
