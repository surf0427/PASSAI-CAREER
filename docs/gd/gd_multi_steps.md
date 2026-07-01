# GD Phase2 マルチGD — steps（STEP 開発履歴）

Phase2「合言葉参加型マルチGD」の STEP 履歴。Phase1 ソロGD は不変。

---

## STEP-GD-10: Supabase テーブル / RLS 設計ファイル追加（完了・未適用）

- **課題**: Phase2 マルチGD は複数ユーザーの共有状態（ルーム・メンバー・発言・結果）を扱うため、
  Phase1 の localStorage canonical では表現できない。server 正本の DB 基盤が必要。
- **対応**: DDL / RLS 設計ファイルと post-apply checklist を追加した（**Supabase へは適用しない**）。
  - [`supabase/career_gd_multi_apply.sql`](../../supabase/career_gd_multi_apply.sql) — 4 テーブル
    （`career_gd_rooms` / `career_gd_room_members` / `career_gd_room_messages` /
    `career_gd_room_results`）を idempotent に定義。
  - [`gd_multi_post_apply_checklist.md`](./gd_multi_post_apply_checklist.md) — 適用前後の検証手順。
  - [`gd_multi_current_state.md`](./gd_multi_current_state.md) — Phase2 現状仕様。
- **設計ポイント**:
  - **API ゲートウェイ方式の RLS**: 全テーブル RLS 有効化＋許可ポリシー無し（deny-by-default）。
    service-role を使う API route のみが DB 操作する前提（合言葉検証・membership 検証はアプリ層）。
  - **合言葉は平文非保存**: `join_code_hash`（`room_salt` 込み）で保存。平文は作成 API 応答で 1 回のみ返す。
  - **制約**: status/format/role/kind CHECK、人数(2〜8)・時間(300〜1800)範囲 CHECK、
    `UNIQUE(room_id,user_id)`・`UNIQUE(room_id,seq)`・`UNIQUE(room_id,client_msg_id)`、
    waiting 中の `join_code_hash` 部分 UNIQUE。
  - **AI 参加者**: `user_id=NULL / is_ai=true`。
  - **idempotent**: `CREATE TABLE/INDEX IF NOT EXISTS`＋存在チェック付き DO ブロック（trigger / RLS）。
    `DROP` / `TRUNCATE` / 既存テーブル ALTER なし。
- **非対象（この STEP でやらないこと）**:
  - room UI（`app/career/gd/room/**`）実装なし。
  - room API（`app/api/career/gd/room/**`）実装なし。
  - Supabase への実適用なし。
  - Phase1 ソロGD / 受験版 / 既存 career_* への変更なし。
  - Realtime / 音声・WebRTC / ランダムマッチング なし（Phase3）。
- **影響範囲**: `supabase/career_gd_multi_apply.sql`（新規）・`docs/gd/*`（新規）のみ。
  TypeScript コード変更なし → tsc / build に影響なし。

---

## STEP-GD-11: room 作成・6桁コード発行（完了）

- **課題**: ホストがマルチGDルームを作成し、参加者に配る 6 桁合言葉を安全に発行する必要がある。
- **対応**:
  - `app/api/career/gd/room/roomCode.ts`（**server-only**）：`generateSixDigitJoinCode` /
    `normalizeJoinCode` / `createRoomSalt` / `hashJoinCode`（`sha256(code + salt)`）。node:crypto 使用。
  - `app/api/career/gd/room/create/route.ts`：`POST /api/career/gd/room/create`。
    - member ログイン必須（`getServerSupabaseClient().auth.getUser()`、`is_anonymous` は 403）。
    - service-role で `career_gd_rooms`（status=waiting・code_expires_at=+30分）＋ host member を insert。
    - 6 桁コード衝突（waiting 中 unique）は再生成で最大 6 回リトライ。
    - **平文コードはレスポンスで 1 回だけ返す**（DB には `join_code_hash` + `room_salt` のみ保存）。
    - env 未設定→503 / service-role 未設定→503 / テーブル未作成(42P01)→503 と分かりやすく失敗。
    - バリデーション：format(free/case/abstract) / count(2〜8) / time(300〜1800)、不正は 400。
  - `app/career/gd/room/create/page.tsx`：作成フォーム→6桁コード大表示＋有効期限＋コピー＋共有説明。
    未ログインは「ログインが必要」表示。ロビー導線は近日公開（STEP-GD-12）。
  - `app/career/gd/page.tsx`：マルチGDカードを「ルーム作成」導線に変更（参加は近日公開）。
  - `types/careerGd.ts`：`GdRoomStatus` / `CareerGdRoom` / `CareerGdRoomMember` /
    `CareerGdRoomCreateResponse` を **optional 追加**（Phase1 型は不変）。
- **非対象**: join API/UI・session・message・ai-turn・feedback・Realtime・音声・ランダムマッチングは未実装。
  Supabase への実適用もしない（テーブル未作成時はコードが 503 で分かりやすく失敗する）。
- **影響範囲**: `app/career/gd/room/**`・`app/api/career/gd/room/**`・`types/careerGd.ts`（追加）・
  `app/career/gd/page.tsx`（career）・`docs/gd/*` のみ。受験版・Phase1 ソロGD・既存テーブルに影響なし。

## STEP-GD-12 以降（予定）

- **GD-12**: 合言葉入力による参加・待機画面（`room/join`・`room/[roomId]` ＋ join / GET room API）。
- **GD-13**: AI 補完して開始（`start` API：`/theme`＋`buildAiParticipants`＋`assignRoles` 再利用）。
- **GD-14**: テキストGD 進行（`message` / `ai-turn` API ＋ ポーリング）。
- **GD-15**: 終了・feedback・順位（`finish` / `feedback` API：Phase1 feedback の multi 経路を流用）。
- **GD-16**: view 統合（各自 localStorage 書き戻し・既存 `/career/gd/view` で閲覧）。
- **GD-17**: careerMatching / consultation 連携の回帰確認（マルチ結果が snapshot に乗ること）。
