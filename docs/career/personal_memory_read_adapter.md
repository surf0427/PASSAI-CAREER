# Personal Memory Shadow-Read Adapter（P16-E / Data Spine Layer 2 read contract）

## 位置づけ

L2 Personal Memory の **read 側 scaffold**。persisted の `career_personal_memory` row を安全に
read model へ変換し、prompt 使用可否まで含む discriminated union を返す。

- 実装: [lib/careerMemory/persistence/readAdapter.ts](../../lib/careerMemory/persistence/readAdapter.ts)
- QA: [scripts/career-personal-memory-read-contract-qa.ts](../../scripts/career-personal-memory-read-contract-qa.ts)
  （`npm run qa:careerPersonalMemoryReadContract`・オフライン）

**今回は read rollout ではない。** prompt / Context Orchestrator / app callsite / 実 Supabase へは
未配線（呼び出しが無いこと自体が read 無効）。write 側（P16-A〜D）は既に完成・flag OFF。

## 責務と再利用

read adapter は「validation → 状態判定 → read model」の **合成のみ**。新しい validator / 状態機械を
作らず、既存を再利用する:

| 関心 | 委譲先 |
|---|---|
| payload / section 妥当性 | `validate.ts` `validateCareerPersonalMemorySection` |
| fresh/stale/failed/unsupported 状態 | `state.ts` `deriveMemoryState` |
| prompt 使用可否 | `state.ts` `isUsableForPrompt`（fresh のみ true。coupling は QA [16] が回帰検証） |
| 型・定数 | `schema.ts` |
| raw row 形 | `repository.ts`（type-only） |

## Read result contract

`readPersonalMemorySection(sectionKey, rawRow, expected)` → `PersonalMemoryReadResult`（純関数・never-throw）:

| status | 意味 | section | usableForPrompt |
|---|---|---|---|
| `missing` | 行不在（null/undefined） | – | false |
| `invalid` | malformed_row / section_mismatch / bad_status / (validate) invalid_payload・oversized・forbidden_key・unknown_section | – | false |
| `unsupported_schema` | schema_version が正の整数で現行版と不一致 | – | false |
| `stale` | payload 妥当だが revision が expected と不一致 | あり | false |
| `fresh` | payload 妥当かつ revision 一致 | あり | **true** |
| `unusable` | DB status=failed（revision 一致でも使わない） | あり | false |

- freshness の権威は **sourceRevision**（state.ts と同一）。`sourceUpdatedAt` / `generatedAt` は権威にしない。
- result に載せないもの: raw Supabase error / secret / env 値 / raw transcript / raw turns / PII。
  section payload は forbidden-key guard 通過済み（構造上 PII/本文を持たない）。

`readPersonalMemorySectionsFromRows(requests, rawRows)` は複数 section を **section 単位で独立**に read
（1 row 破損が他 section に波及しない。rawRows 非配列 = 全 missing）。row の fetch は呼び出し側の責務
（writer coordinator と同じく、pure 層に Supabase client 生成を持ち込まない）。

## section 別対応状況

| section | offline contract 判定 |
|---|---|
| base / self_analysis / es | **完了判定可**（independent golden fixture + writer-reader compatibility） |
| interview | **contract fixture のみ可**。実データ projection / field provenance / runtime parity / Event Log 時系列整合 / prompt context 整合 / latency は **Interview 実機まで HOLD** |

presentation / matching / consultation / company_research / GD は section 追加せず（対象外）。

## 今回証明したこと / していないこと

**証明済み（オフライン）**: row contract validation、決定性、discriminated union 保持、schema version、
size cap、PII/forbidden key guard、missing/invalid/stale/fresh/unsupported/unusable 処理、
writer 生成 payload の受理（writer-reader compatibility）、手書き golden read model との一致、section 独立。

**未証明（HOLD）**: 実 Supabase row との read parity、request-time production context との parity、
prompt output parity、Context Orchestrator parity、Interview 実データ parity、runtime shadow read、
prompt read pilot、read rollout readiness。

> independent golden は production builder で expected を生成しない（循環比較を避ける）。
> writer-reader compatibility は「write contract の payload を read contract が受理できる」ことの確認であり、
> 独立した read parity ではない。実 row を使わない限り「runtime read parity 完了」とは表現しない。

## 次段（本タスク範囲外・HOLD）

1. Interview 実機実行 → interview section の実データ contract / provenance 確認
2. dev/staging での実 row read（DDL 適用 + owner session が前提。本番不可）
3. request-time rebuild との read parity 実測（base/self/es → 実 row）
4. shadow read の Orchestrator/prompt 配線（read pilot）→ read rollout 判定
