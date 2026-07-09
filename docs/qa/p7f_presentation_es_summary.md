# P7-F: presentation-only ES latest summary（設計固定）

> フェーズ: **P7-F（presentation-only pilot）**。P7-D 監査 → P7-E golden coverage を受けた実装 step。
> matching pilot（[P7-B](./p7b_matching_es_summary.md)）を presentation **だけ**へ限定横展開する。
> **interview には横展開しない**（P7-D 判定 = C。gakuchika が面接深掘りの一次材料のため）。
> DB / SQL / AI schema / BaseMemorySummary は不変。secret / env / token / Supabase URL /
> service_role / API key は非参照・非出力。

実装: [`lib/careerMemory/presentationEs.ts`](../../lib/careerMemory/presentationEs.ts) /
[`lib/careerMemory/snapshot.ts`](../../lib/careerMemory/snapshot.ts)（`buildPresentationSnapshot`）/
[`lib/careerMemory/selector.ts`](../../lib/careerMemory/selector.ts)（`CareerPresentationContextPayload.es`）/
[`app/api/career/presentation/presentationPrompt.ts`](../../app/api/career/presentation/presentationPrompt.ts) /
presentation の theme / qa / evaluate route（`es` body 型）。

---

## 1. 何をしたか（要旨）

presentation purpose **のみ**、ES latest を full `CareerEsResult` carry から presentation-local な
strict summary `PresentationEsSummary` に置き換えた。**pilot**（presentation 限定）であり、
interview / matching / consultation は一切変更していない。

- presentation の ES block は `useCareerContext === true` のときだけ prompt に出る「参考情報
  （発表の主役ではない）」。評価対象は transcript / お題であり ES は補助。
- そのため保守的に summary 化して prompt/token を削る（cap は matching より緩い 300 字）。

## 2. `PresentationEsSummary` の field と cap

| field | 用途 | cap（文字数） | 定数 |
|---|---|---|---|
| `headline` | キャッチコピー | **80** | `PRESENTATION_ES_HEADLINE_CAP` |
| `gakuchika` | ガクチカ | **300** | `PRESENTATION_ES_GAKUCHIKA_CAP` |
| `selfPr` | 自己PR | **300** | `PRESENTATION_ES_SELFPR_CAP` |
| `motivation` | 志望動機 | **300** | `PRESENTATION_ES_MOTIVATION_CAP` |

## 3. drop する field

full `CareerEsResult` のうち summary に持たせない field:
`appealPoints` / `interviewQuestions` / `improvements` / `answer` / `question` / `charLimit` /
`companyName` / `selectionType` / `industry` / `jobType`（その他 presentation render に不要な field）。

## 4. matching（3 field / 200 字）と presentation（4 field / 300 字）の違いと理由

| | matching（P7-B） | presentation（P7-F） |
|---|---|---|
| render する field | headline / selfPr / motivation（**gakuchika なし**） | headline / **gakuchika** / selfPr / motivation |
| cap | 200 字 | **300 字** |
| gate | 常時（cross-feature block） | **`useCareerContext === true` のときだけ** |

- **gakuchika を残す理由**: matching は元々 gakuchika を render しないが、presentation は render する
  （theme personalization 等に効き得る）。drop すると出力が変わるため残す。
- **200 → 300 に緩めた理由**: presentation の ES は参考情報だが theme personalization に多少効く
  可能性があるため、matching の 200 字より保守的にする。300 字は **typical では無損失**になりやすく、
  **heavy の裾だけ削る**（§6 の実測どおり）。aggressive cap（160/200）は入れない。

## 5. useCareerContext gate（不変）

- gate は `buildPresentationBaseSystem`（[presentationPrompt.ts](../../app/api/career/presentation/presentationPrompt.ts)）に
  従来どおり存在し、**P7-F でも変更していない**。`const useCtx = input.config?.useCareerContext === true`。
- **`useCareerContext === true`** のときだけ `renderPresentationEsSummary(input.es)` が prompt に出る。
- **`useCareerContext !== true`（false / undefined / config=null）** では `esBlock = ''` のまま
  prompt に出ない（ES block 0）。summary 化しても gate 挙動は不変。
  - body には summary（4 key）が載るが、gate off では prompt に出ないため token には無関係。
- ES block の見出し `# 参考: 直近の ES ドラフト（発表の主役ではない）` と参考情報ガード
  `# 参考情報の扱い（重要）` の文脈も不変。

## 6. before / after 数値（文字数ベース）

`scripts/career-context-budget-qa.ts` の P7-F セクションで再現できる（決定論 fixture）。

| case | body full → summary | render full → summary |
|---|---|---|
| typical (g=250 s=250 m=250) | 1426 → 824（**−42.2%**） | 804 → 804（**−0.0%**） |
| heavy (g=420 s=400 m=380) | 1876 → 977（**−47.9%**） | 1254 → 957（**−23.7%**） |

- body の縮小は未使用 field の drop（prompt には出ない → token 不変）。
- render は typical で無損失（cap 300 は typical に効かない＝保守 cap の狙いどおり）、heavy で
  −23.7%（cap が裾を削る）。**prompt/token が減るのは render shrink の分のみ**、かつ
  **useCareerContext===true のセッションに限る**。

## 7. regression guard（P7-F harness）

| 保証内容 | harness |
|---|---|
| body の `es` が 4 key（headline/gakuchika/selfPr/motivation）のみ・cap 済み・null fallback | `qa:careerPresentationEsBody` |
| render 出力 golden（typical 無損失 / heavy cap）・gate（true/false/undefined/null）・未使用字句非出 | `qa:careerPresentationEsRender` |
| before/after 数値の可読レポート | `career-context-budget-qa`（P7-F セクション） |
| selector ≡ snapshot の body byte 等価 | `qa:careerMemoryPresentation`（両経路とも同一 summary を通るため不変で PASS） |
| **interview は不変** | `qa:careerInterviewEsRender`（変更なしで PASS）/ `qa:careerMemoryInterview` |
| **matching は不変** | `qa:careerMatchingEsRender` / `qa:careerMatchingEsBody` |

fixture: `scripts/fixtures/presentation-es-render/{typical,heavy,use-context-false}.txt` /
`scripts/fixtures/presentation-es-body/heavy-es.json`。

## 8. future expansion

- **interview へ flat cap を横展開しない**（P7-D 判定 = C）。interview の gakuchika は面接深掘りの
  一次材料であり、200/300 字 flat cap は深掘り・最終フィードバックの品質を損なう。interview を
  削るなら purpose-specific / mode-aware / extractive な別設計（P8 級）が必要。
- presentation の cap 妥当性（300 が theme personalization を損なわないか）は運用で観測してから
  調整する。aggressive cap への変更は品質評価を経てから。
