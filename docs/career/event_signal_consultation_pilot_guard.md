# Consultation Event Signal Pilot — Operational Guard / Rollback Runbook（P10-F）

Consultation-only Event Signal Pilot（P10-D/E）の停止・再開手順。運用者向けの短い runbook。

## Guard の種類

- **Deployment guard**（build-time env フラグ）。**Remote kill switch ではない。**
- 停止・再開には **env 変更 + 再 build / 再 deploy が必要**（即時反映ではない）。
- **localStorage / query / cookie / request body はガードに使っていない**（authoritative は server 側の build-time env）。
- Env var: `NEXT_PUBLIC_CAREER_EVENT_SIGNAL_PILOT_ENABLED`
  - `true` / `1` / `yes`（trim + 小文字化）→ **有効**
  - 未設定 / 空 / それ以外 / 非文字列 → **fail-closed = 無効**（default）
- `NEXT_PUBLIC_` prefix のため client / server 両 bundle に同一値が build 時 inline される。
  server（consultation route）が同じ値を **authoritative** に独立判定する。

canonical guard 実装: `lib/careerMemory/eventSignalPilotGuard.ts`
（`isConsultationEventSignalPilotEnabled()` / `shouldLoadConsultationEventSignals()` /
`evalConsultationEventSignalPilotEnabled()`）

## 停止手順（pilot OFF）

1. 対象 Vercel プロジェクト（CAREER デプロイ）の env `NEXT_PUBLIC_CAREER_EVENT_SIGNAL_PILOT_ENABLED`
   を **未設定にする**（または `false` に設定）。※ secret ではない・値の記載可。
2. **再 build / 再 deploy**（`NEXT_PUBLIC_*` は build 時 inline のため必須）。
3. 反映後、下記「停止確認」を実施。

> default が fail-closed（無効）のため、env 未設定のデプロイでは pilot は **最初から OFF**。
> 明示的に有効化していない限り、追加操作なしで Signal なし consultation として動作する。

## 停止確認

- consultation で **member でも Signal reader が呼ばれない**（reader 0 回・1000ms 待ちなし）。
- consultation request body に **`eventSignals` プロパティが無い**。
- consultation system prompt に **Event Signal 見出し（「【参考：最近30日の利用傾向】」）が無い**。
- 相談 AI は従来どおり正常動作（応答・thread 保存・`consultation_asked` 記録）。
- 既存 golden 一致（`npm run qa:careerMemoryPromptGolden` → match=25 / mismatch=0 / piiStrictFail=0）。
- matching / ES / 面接 / プレゼン / GD / 自己分析 / 企業研究 に影響なし。
- 自動確認: `npm run qa:careerEventSignalOperationalGuard`（OFF 系 matrix / fail-closed / isolation）。

## 再開手順（pilot ON）

1. env `NEXT_PUBLIC_CAREER_EVENT_SIGNAL_PILOT_ENABLED=true` を設定。
2. 再 build / 再 deploy。
3. 段階確認:
   - `npm run qa:careerEventSignalConsultation` / `qa:careerEventSignalAftercare` / `qa:careerEventSignalOperationalGuard` green。
   - member consultation で Signal block（固定見出し + 誤推論防止 note）が最下位補助として付く。
   - Signal あり時も本人入力を最優先・能力/合否/弱み断定なし・block ≤700B。

## 緊急コード rollback（guard 実装自体に問題がある場合）

- **DB rollback は不要**（SQL / RLS / schema / Event writer は一切変更していない）。
- P10-D/E/F 全体を削除せず、**wiring だけ切る**最小箇所:
  - `app/career/consultation/page.tsx`: `shouldLoadConsultationEventSignals(...)` 分岐を `false`
    相当（loader を呼ばない）に戻す。
  - `app/api/career/consultation/route.ts`: `eventSignalsBlock` を `''` 固定にする
    （`resolveConsultationEventSignalsBlock(...)` の結果を使わない）。
- commit 単位の revert 対象（新しい順）:
  - `P10-F` guard commit（本 runbook 追加 commit）
  - `f743caf` P10-E aftercare
  - `77a24b6` P10-D pilot wiring
  builder（`6a6e15a`）/ reader（`f719dac`）は **将来用 scaffold として保持**してよい
  （consultation へ未接続になるだけで無害）。

## 記載しないもの

- secret 値 / 実 Supabase URL / anon key / service_role / token / 実 userId は本 runbook に記載しない。
