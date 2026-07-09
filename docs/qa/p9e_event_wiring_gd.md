# P9-E: Career Event Log wiring 拡張（GD: solo / room）

## P9-A / P9-B / P9-C / P9-D との関係

- **P9-A**（read-only 監査）: Career Event Log は write-only。wiring 済みは matching /
  consultation / interview / ES の 4 機能で、presentation / company_research / self_analysis /
  **GD** が未 wiring。
- **P9-B**: `career_user_events` の owner-scoped read path を mypage timeline として開通。
- **P9-C**: presentation / company_research を wiring。
- **P9-D**: self_analysis を wiring。
- **P9-E（本 STEP）**: 残る主要機能 **GD（solo + room）** を wiring。これで career の主要 8 機能
  （matching / consultation / interview / ES / presentation / company_research / self_analysis / GD）
  すべてが Event Log に記録されるようになる。

## なぜ GD を次に wiring するか

- GD は主要機能の中で唯一 event 記録の欠測として残っていた（solo / room の 2 経路）。
- interview / presentation と同じ「結果確定時に `void recordCareerEvent(...)`」の型に乗る。
- GD の会社適性グレード（S/A/B/C/D）は server 算出済みの band であり、生スコアを持ち出さずに
  そのまま score_band として使える（raw text / 生スコアリスクが低い）。

## solo / room の対応範囲

**両方対応**した（最小差分で 2 経路をカバー）。

- **solo**: `app/career/gd/session/page.tsx` — 評価生成 → `appendGdResult(result)` 直後。
- **room（realtime multi）**: `app/career/gd/room/[roomId]/page.tsx` の `FinishedView` —
  結果生成 → `appendGdRoomLog(log)` 直後。
  - random match / public lobby / friend room はいずれも同じ `FinishedView` の結果生成経路に
    合流するため、1 箇所の wiring で全 room 種別をカバーする。

## 何を記録するか

共通:

- feature: `gd`
- event_type: **`feature_completed`**
  - 決定理由: GD は「議論のパフォーマンスを評価して結果を確定する」機能で、interview /
    presentation（同じく `feature_completed`）と同性質。生成系の ES / self_analysis の
    `ai_generated` ではなく、評価完了系の `feature_completed` が自然。
- completion_status: `completed`
- score_band: **既に S/A/B/C/D の会社適性グレード**（生スコアは持ち出さない）
  - solo: `result.selfCompanyGrade`
  - room: `log.evaluation.rank`（`evaluation.scored===true` のときのみ。採点不能時は null）
- industry / job_type / selection_phase: **なし**（GD は構造化された選考文脈を持たない）
- metadata（安全な enum / カウントのみ）:
  - `participationMode`: solo は `result.participationMode`（'solo'）、room は `'room'` 固定
  - `format`: GdFormat（objection / free など）
  - `participantCount`: 総参加者数（人間＋AI）
  - room のみ `durationSec`: 所要時間（秒）

## 何を記録しないか（raw text / PII 防御）

以下は event に**一切載せない**（列にも metadata にも入れない）:

- GD topic 本文 / 発言本文 / AI 補完発言 / transcript
- 評価コメント / 改善アドバイス本文 / ranking の詳細コメント / overallSummary
- 参加者名（displayName）/ join_code / room password / room title 自由記述
- userInput / prompt / response / profile.name / university / email / activity 本文 / values notes

多層防御:

1. 記録側は band / enum / カウントのみ渡す。本文・名前・join code フィールドは渡さない。
2. 書き込み側 sanitize が allowlist + denylist + scalar 限定 + truncation で遮断。
   **万一 metadata に本文/名前/join code key（topicText / displayName / participantName / joinCode /
   roomTitle 等）が混入しても drop**（`name` は denylist・その他は allowlist 外）。QA で検証。
3. score は band（S/A/B/C/D）のみで、生スコア（0〜100）は列にも metadata にも入らない。

## sanitize 仕様変更（最小・additive）

`ALLOWED_METADATA_KEYS` に **`participantCount` の 1 key を追加**（additive のみ）。

- 追加理由: GD の参加者数は L2/L4 で有用な body-free な小整数（solo/room の規模を表す）。
- 安全性: denylist（text/body/name/summary/email/university 等）・scalar 限定・truncation は
  **一切変更していない**。`participantCount` は denylist substring に非該当。PII/本文の遮断能力は不変。
  QA（`qa:careerEvents`）で「表示 allowlist ⊆ sanitize allowlist」と本文/名前 key drop を保証。

## idempotency / clientEventId 方針

- solo: `result.id`（= session.id。安定 id）。
- room: `log.roomId`（= roomId）。
  - **room id を clientEventId に使っても参加者間で衝突しない**理由: `career_user_events` の
    部分 unique index は `(user_id, client_event_id)` で **user 別に閉じている**。異なる参加者は
    user_id が異なるため、同一 roomId でも別タプルになり衝突しない。同一 user の結果再取得
    （冪等 re-fetch）だけが同一タプルとなり DB 側で冪等吸収される（2 回目 insert は error →
    devWarn で握り潰し・行は増えない）。
- `recordCareerEvent` は fire-and-forget / never throw / guest・env 未設定は no-op（本体機能を壊さない）。
- room の userId は `useCurrentUserId()`（= auth.uid()）を使用し、RLS の `auth.uid()=user_id` と一致させる。

## mypage timeline でどう見える

P9-B の `lib/careerEvents/timeline.ts`:

- feature ラベル: `gd` → GD（既存）
- event_type ラベル: `feature_completed` → 完了（既存）
- metadata 表示に **`participantCount` → 参加人数** を追加（sanitize allowlist の部分集合）。
  `participationMode`（参加形態）/ `format`（形式）/ `durationSec`（所要時間）は既存。
- score band は S/A/B/C/D 表示。room id / join code / 参加者名は構造的に出ない（QA で検証）。

## 接続しないもの（明示）

- **AI prompt / context / body に event を混ぜない**（記録のみ・表示は P9-B の owner-scoped read）。
- **BaseMemorySummary 未接続** / CareerMemorySnapshot / selector 未変更（event 混入なし）。
- **L2 eventSignals には接続しない**。
- **L4 匿名集計ではない**（本人 owner-scoped の観測ログ記録のみ）。
- Company Knowledge Base / 明示共有 / GD 発言・topic・評価本文の共有・集計には進まない。
- profile / activity / values / mypage / onboarding への wiring は本 STEP では行わない。

## QA

- `qa:careerEvents`（`scripts/career-event-timeline-qa.ts`）に section [12] を追加:
  GD solo / room の実 event 形状で feature/event ラベル（GD / 完了）・score band・
  participationMode / format / participantCount / durationSec chip・**topic 本文 / 発言本文 /
  評価本文 / join code / room title / 参加者名の drop と value 非出力**・想定外 key 非表示・
  feature/event_type が既存 enum と整合・sanitize 側の drop/保持（participantCount 保持）を検査。全 PASS。
- context 不変（本 STEP で変化なしを確認）: `qa:careerContextCore`（ALL_PASS）/ `qa:careerMemoryAll`
  （ALL_PASS）/ `qa:careerPersonaSpotcheck`（ALL_PASS）/ `qa:careerMemoryPromptGolden`（ALL_MATCH）/
  `qa:careerMemoryMatching`（ALL_MATCH）/ `career-context-budget-qa`（ALL PASS・P8-B 圧縮維持）。
  P9-B mypage timeline read path は timeline.ts の additive 変更（participantCount 追加）のみで既存表示は不変。

## rollback 方針

以下を revert すれば元へ戻る（DDL / read path / 既存 7 機能 wiring は無変更）:

- `app/career/gd/session/page.tsx` の event 記録ブロックと import（solo）
- `app/career/gd/room/[roomId]/page.tsx` の event 記録ブロック・`FinishedView` の userId ref・import（room）
- `lib/careerEvents/sanitize.ts` の allowlist 1 key（participantCount）
- `lib/careerEvents/timeline.ts` の META_DISPLAY 1 key（participantCount）
- `scripts/career-event-timeline-qa.ts` の section [12] と DISPLAY_KEYS の participantCount 追加

## 次に wiring するなら何か

- 主要 8 機能の wiring は本 STEP で完了。残りは **profile / activity / values**（準備完了度 signal。
  ただし単純状態更新イベントが増え SN 比が下がるため、記録する enum を絞るか event_type を
  `feature_completed` 以外にするか要検討）。
- 全機能が揃ったので、次フェーズの候補は **L2 eventSignals**（selector 実装で event を本人メモリに
  還流）だが、prompt / body / budget への波及と golden 再取得を伴うため別 STEP。
- **L4 匿名集計**は consent / k-anonymity / aggregation threshold / privacy policy の整備が前提で別フェーズ。
