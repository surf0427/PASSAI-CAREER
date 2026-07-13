# Personal Memory Shadow Read Parity Contract（P16-J-PREP / offline）

## 目的

P16-I runtime canary 成功後に予定される **P16-J Shadow Read Parity Audit** の offline 先行準備。
production（prompt / Context Orchestrator）へは**接続しない**。read adapter（[readAdapter.ts](../../lib/careerMemory/persistence/readAdapter.ts)）+
repository read（[repository.ts](../../lib/careerMemory/persistence/repository.ts) `readCareerPersonalMemorySections`）の read 経路を、
in-memory store で contract として固定する。

- offline QA: [scripts/career-personal-memory-shadow-read-qa.ts](../../scripts/career-personal-memory-shadow-read-qa.ts)
  （`npm run qa:careerPersonalMemoryShadowRead`）。

## Read parity contract（各項目の期待）

| 項目 | 期待挙動 |
|---|---|
| Source section | schema の section discriminator（base/self_analysis/es/interview）が source of truth |
| expected revision | 要求端末の現 Source から `computeContentRevision` で算出（freshness の権威） |
| stored revision | 行の `source_revision`。expected と一致で fresh、不一致で stale |
| schema version | 現行=1 のみ usable。異なれば `unsupported_schema` |
| status | DB status `fresh/stale/failed`。`failed` は `unusable` |
| freshness | `deriveMemoryState`＝missing/fresh/stale/failed/unsupported。fresh のみ usable |
| usability | `isUsableForPrompt`＝fresh のみ true |
| fallback behavior | fresh でない（missing/stale/failed/invalid/unsupported）→ prompt に使わず **request-time rebuild** へ fallback（呼び出し側責務） |
| missing behavior | 行なし → `missing`（unavailable）。Source fallback |
| repository failure behavior | read が error/throw → `readCareerPersonalMemorySections` が **never-throw で `[]`**（missing 扱い・fallback） |
| unsupported schema behavior | `unsupported_schema`（usable でない） |
| invalid payload behavior | validation 不通過 → `invalid`（usable でない） |
| stale row behavior | revision 不一致 → `stale`（usable でない・payload は保持） |
| section isolation | 1 section の破損行が他 section の read を妨げない |
| Source/UI non-impact | read は純関数・never-throw。Source 保存・UI に影響しない |

## Offline cases（QA で固定）

1 missing→unavailable/fallback ／ 2 fresh valid→usable ／ 3 stale revision→unusable ／ 4 failed status→unusable ／
5 invalid payload→unusable ／ 6 unsupported schema→unusable ／ 7 repository throw→never-throw fallback ／
8 repository error→never-throw fallback ／ 9 one section corrupted→others usable ／
10 same revision + changed payload→revision 権威に従う（fresh・payload は行のまま／整合は revision の責務） ／
11 Source revision unavailable（expected 空）→ fail-closed（fresh にしない） ／ 12 raw forbidden data→reject（invalid） ／
13 payload size violation→reject（invalid/oversized） ／ 14 read adapter mutation なし ／ 15 repeated read deterministic ／
16 no prompt import ／ 17 no Orchestrator import ／ 18 no production callsite（read adapter は QA のみ import）。

## Independent parity golden

builder 生成 row を builder と比較する循環テストにしない。**最低 1 件は手書き独立 raw row fixture ＋ 手書き
expected adapter result** を用いる（QA の independent golden section）。

## Dormant integration contract（将来 seam・休眠）

将来の production integration を **型・interface・QA fixture** として QA 内に準備してよいが、以下を厳守:
- production file から import しない／route・page・prompt・Orchestrator へ接続しない／feature flag・runtime branch を
  追加しない／Source fallback を変更しない。
- `git grep` で **read adapter の production import が 0 件**であることを QA が検証する（QA scripts のみが import）。

## 非対象（P16-I 成功後・別 Decision Gate）

実 row parity（runtime）／prompt read pilot（Presentation 等）／Consultation・Interview・Matching read ／
section 拡大 ／ global rollout。本 contract は offline 準備のみ。
