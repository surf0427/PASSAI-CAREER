# P7-B: matching-only ES latest summary（設計固定 / P7-C aftercare）

> フェーズ: **P7-B（matching-only pilot）** の設計意図・cap・drop 方針・横展開しない理由を固定する文書。
> 本文書は P7-C aftercare で作成。実装（型・selector・route・harness）は P7-B commit
> `dd0eff9`（`feat(career): matching-only ES latest summary pilot`）で完了済み。
> 既存 production 挙動は原則不変（body/prompt が縮むのみ・AI 出力 schema / DB / SQL / Supabase 不変）。
> secret / env / token / Supabase URL / service_role / API key は非参照・非出力。

関連: [P4-A 中央メモリ型・マップ](./p4a_memory_types_map.md) / [P3-H context budget 実測](./p3h_context_budget_report.md)。
実装: [`lib/careerMemory/matchingEs.ts`](../../lib/careerMemory/matchingEs.ts) /
[`lib/careerMemory/snapshot.ts`](../../lib/careerMemory/snapshot.ts) /
[`lib/careerMemory/selector.ts`](../../lib/careerMemory/selector.ts) /
[`app/api/career/matching/route.ts`](../../app/api/career/matching/route.ts)。

---

## 1. 何をしたか（要旨）

matching purpose **のみ**、ES latest を full `CareerEsResult` carry から matching-local な
strict summary `MatchingEsSummary` に置き換えた。**pilot**（1 purpose 限定の試行）であり、
interview / presentation / consultation は一切変更していない。

- matching は ES を「補助情報」として使う。full draft（本文・設問・企業情報など）を prompt/body に
  再展開しない。
- matching の ES prompt render は元々 `headline / selfPr / motivation` の 3 field しか消費していない
  （`gakuchika` は matching では render されない）。full result を carry すると body も prompt も
  肥大するだけなので、matching だけを strict summary に落とす。

## 2. `MatchingEsSummary` の field と cap

| field | 用途 | cap（文字数） | 定数 |
|---|---|---|---|
| `headline` | キャッチコピー | **80** | `MATCHING_ES_HEADLINE_CAP` |
| `selfPr` | 自己PR | **200** | `MATCHING_ES_SELFPR_CAP` |
| `motivation` | 志望動機 | **200** | `MATCHING_ES_MOTIVATION_CAP` |

- `selfPr` / `motivation` は 200 字で truncate（P7-A の 160〜200 目安の上限側）。
- `headline` は短文想定だが、異常に長い入力への安全弁として 80 字 cap。
- truncate は `lib/careerMemory/summaryUtils` の `truncate`（超過時のみ `…` を付す）。

## 3. drop する field と理由

full `CareerEsResult` のうち、matching summary に **持たせない** field:

`gakuchika` / `appealPoints` / `interviewQuestions` / `improvements` / `answer` /
`question` / `charLimit` / `companyName` / `selectionType` / `industry` / `jobType`
（その他 matching render に不要な field を含む）。

- **`gakuchika` を落とす理由**: matching の ES block render では元々 `gakuchika` を使っていない
  （render は headline / selfPr / motivation の 3 行のみ）。matching の判断材料にならないため含めない。
- 他の field（appealPoints 等）も matching render で消費しないため落とす。

## 4. なぜ prompt/token まで縮んだか（重要な区別）

削減効果には性質の異なる 2 つがある。P7-B は両方を起こしている:

1. **body shrink（未使用 field の drop）** — full result の未 render field を落とすと request
   **body**（JSON）は縮む。ただし未 render field は元々 prompt に出ないため、**これだけでは
   prompt/token は減らない**。
2. **render shrink（render 対象 field の truncate）** — matching が実際に render している
   `selfPr` / `motivation` を cap したため、prompt に載る文字数が減る。**prompt/token が減るのは
   こちら**。

→ 「未使用 field を落とすだけ」では prompt は縮まない。P7-B は render 対象 field も truncate した
ため body と render（prompt）の両方が縮んだ。この区別は budget QA の `body` 行と `render` 行で
可視化している（§6）。

## 5. before / after 数値（文字数ベース）

`scripts/career-context-budget-qa.ts` の P7-B セクションで再現できる（決定論的 fixture）。

| case | body full → summary | render full → summary |
|---|---|---|
| typical (g=250 s=250 m=250) | 1426 → 461（**−67.7%**） | 545 → 447（**−18.0%**） |
| heavy (g=420 s=400 m=380) | 1876 → 461（**−75.4%**） | 825 → 447（**−45.8%**） |

- body の縮小率が大きいのは未使用 field の drop（§4-1）。
- render も縮んでいる（§4-2）ことが「prompt/token も減った」証跡。heavy で render −45.8% は
  cap（selfPr/motivation 200 字）が効いている。

## 6. なぜ interview / presentation / consultation に横展開しないか

P7-B は matching **pilot**。他 purpose に同じ cap を機械的に流用しない。

- **consultation**: ES は既に `EsHistorySnapshot` 相当（`buildEsHistory`）へ要約済みで carry される。
  full result を持っていないため、そもそも P7-B の削減対象外。
- **interview**: ES 本文が面接の深掘り・回答評価の品質に効く可能性がある。matching と同じ 200 字
  truncate を流用すると評価材料を削るリスクがある。P7-B では触らない。
- **presentation**: ES を使うのは `useCareerContext===true` のときだけで、利用条件が matching と
  異なる。削減可否は別途 purpose 別に判断が必要。P7-B では触らない。

**future expansion する場合の原則**: matching と同じ field/cap をそのまま横展開しない。purpose ごとに
「その purpose が ES の何をどこまで使うか」を品質評価してから、purpose 別の summary 形状・cap を
決める。

**横展開の実績**: presentation は [P7-F](./p7f_presentation_es_summary.md) で purpose-local に
summary 化（4 field / cap 300・`useCareerContext` gate 限定）。interview は P7-D 監査で
横展開しない判定（gakuchika が面接深掘りの一次材料のため）。

## 7. regression guard（P7-B harness で固定済み）

| 保証内容 | harness |
|---|---|
| matching body の `es` が 3 key（headline/selfPr/motivation）のみ | `qa:careerMatchingEsBody` |
| `gakuchika` / 未使用 field が body に残らない | `qa:careerMatchingEsBody` |
| `selfPr` / `motivation` が cap 済み・heavy で truncate | 両 harness |
| render 出力の golden 固定（typical / heavy） | `qa:careerMatchingEsRender` |
| render 出力に未使用字句（ガクチカ/appealPoints 等）が出ない | `qa:careerMatchingEsRender` |
| interview / presentation / consultation body が不変 | `qa:careerMemory{Interview,Presentation,Consultation}` byte-QA |
| before/after 数値の可読レポート（回帰検知の目視用） | `career-context-budget-qa`（P7-B セクション） |

fixture: `scripts/fixtures/matching-es-render/{typical,heavy}.txt` /
`scripts/fixtures/matching-es-body/heavy-es.json`。

> **P7-H 注記（時点差の明示 / P8-B 同梱）**: 上表「interview / presentation / consultation body が不変」は
> **P7-B 時点の記述**である。その後 **P7-F で presentation の ES body は strict summary 化された**
> （§6 の「横展開の実績」参照。`PresentationEsSummary` 4 field / cap 300）。したがって現時点では
> presentation の ES body は P7-B 当時とは異なる（`qa:careerMemoryPresentation` は両経路が同一 summary を
> 通るため PASS を継続するが、body 内容自体は P7-F で意図的に変わっている）。interview / consultation は
> 引き続き不変。この注記は P8-B（matching activity compact）の docs 更新に同梱して追加した。

## 8. スコープ厳守（P7-B / P7-C 共通）

- matching-local。interview / presentation / consultation の snapshot builder / render / body は不変。
- 純関数のみ（I/O / env / secret / DOM / Supabase / DB / SQL / AI schema / `BaseMemorySummary` 接続なし）。
- PII policy は P6-F のまま（本 summary は ES draft 由来で氏名等 PII を構造上含まない）。
