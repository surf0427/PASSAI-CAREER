# P9-D: Career Event Log wiring 拡張（self_analysis）

## P9-A / P9-B / P9-C との関係

- **P9-A**（read-only 監査）: Career Event Log は write-only。未 wiring の優先順位で
  presentation → company_research → **self_analysis** の順を提示。
- **P9-B**: `career_user_events` の owner-scoped read path を mypage timeline として開通。
- **P9-C**: presentation / company_research を wiring。
- **P9-D（本 STEP）**: 就活行動の**起点**である self_analysis に event 記録を追加。
  これで「自己分析 → ES / 企業研究 / 面接 / プレゼン → マッチング / 相談」の遷移が
  Event Log 上で起点から追えるようになる。

## なぜ self_analysis を次に wiring するか

- 自己分析は多くの学生にとって**就活の入り口**であり、そこを起点に ES / 企業研究 / 面接へ
  遷移していく。起点イベントが欠けていると L2 の「遷移分析」が始点を失う。
- 既存の ES と同型（AI が結果を生成 → localStorage 保存 → Supabase mirror）で、
  完了タイミングに `void recordCareerEvent(...)` を足すだけ。実装容易・duplicate 安全。
- raw text リスクが低い（記録するのは深掘り回数のカウントのみ）。

## 何を記録するか

**場所**: `app/career/self-analysis/run/page.tsx`、AI 結果生成 → `appendSelfAnalysisLog` →
Supabase mirror 成功後（member のみ）。

- feature: `self_analysis`
- event_type: **`ai_generated`**
  - 決定理由: 自己分析の結果は「ユーザー入力から AI が生成した成果物」であり、ES（同じく
    `ai_generated`）と同性質。interview / presentation は「発表・回答を評価する」ため
    `feature_completed` を使うが、self_analysis は**生成**なので `ai_generated` が自然。
- completion_status: `completed`
- clientEventId: `log.id`（= `newId()`。localStorage dedup / Supabase mirror と同じ安定 id）
- score_band: **なし**（自己分析にスコア概念がない）
- industry / job_type / selection_phase: **なし**（構造化された選考文脈を持たない）
- metadata: **`turnCount`** のみ（= `countAnswers(turns)` = 深掘り壁打ちでユーザーが答えた回数）
  - `turnCount` は **既存の sanitize allowlist に既にある** key。→ **sanitize 仕様の変更は不要**（additive なし）。
  - 深掘りをどれだけ行ったか（0 = 一問一答なしで生成）を body-free なカウントで表す。

## 何を記録しないか（raw text / PII 防御）

以下は event に**一切載せない**（列にも metadata にも入れない）:

- 自己分析本文（summary / careerDirection 等）・AI 出力本文
- strength / weakness の本文・personality summary・career advice 本文
- 深掘り（deep dive）の question / answer 本文
- `userInput`（ユーザーが添えた相談・補足）
- prompt / response / profile.name / university / email / activity 本文 / values notes

多層防御:

1. 記録側は `turnCount`（カウント）だけを渡す。本文フィールドは一切渡さない。
2. 書き込み側 sanitize が allowlist + denylist + scalar 限定 + truncation で本文混入を機械遮断。
   **万一 metadata に本文 key（summary / weaknessText / deepDiveAnswer / userInput 等）が混入しても drop**（QA 検証）。
3. score / industry / job_type を持たないため、そもそも構造化列にも本文が入らない。

## sanitize 仕様変更

**なし**（P9-D は additive 変更ゼロ）。使用する `turnCount` は既存 allowlist に存在するため、
`lib/careerEvents/sanitize.ts` は無変更。

## idempotency / clientEventId 方針

- clientEventId に `log.id`（安定 id）を使用。
- `career_user_events` の部分 unique index `(user_id, client_event_id) WHERE client_event_id NOT NULL`
  により、二重記録は DB 側で冪等吸収（2 回目 insert は error → devWarn で握り潰し・行は増えない）。
- `recordCareerEvent` は fire-and-forget / never throw / guest・env 未設定は no-op（本体機能を壊さない）。
- 自己分析は「生成」1 回につき新しい `log.id` が発行されるため、複数回生成すれば各回が別 event として
  正しく記録される（同一 id の二重発火のみ index で吸収）。

## mypage timeline でどう見える

P9-B の `lib/careerEvents/timeline.ts` は**無変更で対応**:

- feature ラベル: `self_analysis` → 自己分析（既存）
- event_type ラベル: `ai_generated` → AI生成（既存）
- metadata 表示: `turnCount` → ターン数（既存の表示 allowlist に存在）
- band / industry / job は無いので表示されない。本文は構造的に出ない（QA で検証）。

## 接続しないもの（明示）

- **AI prompt / context / body に event を混ぜない**（記録のみ・表示は P9-B の owner-scoped read）。
- **BaseMemorySummary 未接続** / CareerMemorySnapshot / selector 未変更（event 混入なし）。
- **L2 eventSignals には接続しない**。
- **L4 匿名集計ではない**（本人 owner-scoped の観測ログ記録のみ）。
- Company Knowledge Base / 明示共有 / 自己分析本文の共有・集計には進まない。
- GD / profile / activity / values / mypage / onboarding への wiring は本 STEP では行わない。

## QA

- `qa:careerEvents`（`scripts/career-event-timeline-qa.ts`）に section [11] を追加:
  self_analysis の実 event 形状で feature/event ラベル（自己分析 / AI生成）・score/industry なし・
  `turnCount` chip・**自己分析本文 / 強み弱み本文 / deep dive 回答 / userInput / careerAdvice /
  personalitySummary の drop と value 非出力**・想定外 key 非表示・feature/event_type が既存 enum と整合・
  sanitize 側の drop/保持を検査。全 PASS。
- context 不変（本 STEP で変化なしを確認）: `qa:careerContextCore`（ALL_PASS）/ `qa:careerMemoryAll`
  （ALL_PASS）/ `qa:careerPersonaSpotcheck`（ALL_PASS）/ `qa:careerMemoryPromptGolden`（ALL_MATCH）/
  `qa:careerMemoryMatching`（ALL_MATCH）/ `career-context-budget-qa`（ALL PASS・P8-B 圧縮維持）。
  P9-B mypage timeline read path は timeline.ts 無変更のため不変。

## rollback 方針

以下を revert すれば元へ戻る（DB / sanitize / timeline / read path / 既存 5 機能 wiring は無変更）:

- `app/career/self-analysis/run/page.tsx` の event 記録ブロックと import
- `scripts/career-event-timeline-qa.ts` の section [11] と enum import

## 次に wiring するなら何か

- **GD**（solo/room 2 系統。topic は free text 化せず role/outcome を enum 化する前提。sanitize additive の可能性あり）
- profile / activity / values は「準備完了度」signal として意味はあるが、単純状態更新イベントが増えて
  SN 比が下がるため後段。
- 6 機能 + self_analysis が揃った後は、L2 eventSignals（selector 実装）/ L4 匿名集計（consent / k-anon 前提）
  が別フェーズの候補。ただし prompt / body / budget への波及と golden 再取得を伴う。
