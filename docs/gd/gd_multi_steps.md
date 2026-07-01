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

## STEP-GD-12: 合言葉入力による参加・ロビー＋join_code_hash 修正（完了）

- **課題1（設計修正）**: 旧 `join_code_hash = sha256(code + room_salt)` は room ごとに salt が異なり、
  同じ 6 桁でも hash が変わるため `UNIQUE(join_code_hash) WHERE status='waiting'` が平文重複を防げなかった。
- **対応1**: `hashJoinCode(code)` を **HMAC-SHA256(normalizedCode, server-side pepper)** の deterministic 方式へ変更。
  - pepper = `CAREER_GD_JOIN_CODE_PEPPER`（無ければ `SUPABASE_SERVICE_ROLE_KEY` fallback、`env.ts` 経由で読む）。
    実値はログ/クライアントに出さない。未設定なら hash=null → 呼び出し側が 503。
  - `room_salt` を廃止（`career_gd_multi_apply.sql` から列削除・`createRoomSalt` 削除・create route から除去）。
  - `.env.example` に `CAREER_GD_JOIN_CODE_PEPPER`（名前のみ）を追加。
- **対応2（参加）**: `POST /api/career/gd/room/join`。
  - `checkServerRateLimit`（IP・best-effort）→ member 認証 → 6桁 normalize/検証 → HMAC hash →
    `career_gd_rooms` を hash一致 & status='waiting' & code_expires_at>now() で検索。
  - 該当なし=404（詳細を出さない）/ 既参加=冪等成功 / 満員(planned到達)=409 / 未参加=member insert。
  - レース時（UNIQUE(room_id,user_id) 違反）は既参加として冪等成功に倒す。
- **対応3（取得）**: `GET /api/career/gd/room/[roomId]?afterSeq=`。member 認証 → 参加者本人のみ（非参加者 403）→
  room/members/messages を返す（`join_code_hash` は返さない）。messages は GD-14 まで空。
- **対応4（UI）**: `room/join`（6桁入力・空白/ハイフン除去・member gate）、`room/[roomId]`（ロビー・手動更新・
  参加者一覧・host バッジ・開始/進行は近日公開）。ハブに「合言葉で参加」導線追加。
- **共通**: `roomAuth.ts`（member 認証 / service-role 取得 / 42P01・23505 判定）、`roomMappers.ts`（行→client 型）。
- **rate limit 課題**: 現状は IP ベース best-effort のみ。**本番公開前に per-user / DB or KV ベースの
  join attempt 制限へ置き換える**（checklist §10 に明記）。新テーブルは今回追加しない。
- **非対象**: start（AI補完開始）/ session / message / ai-turn / feedback / ranking / Realtime / 音声 /
  ランダムマッチングは未実装。Supabase への実適用もしない。
- **影響範囲**: `app/career/gd/room/**`・`app/api/career/gd/room/**`・`types/careerGd.ts`（追加）・
  `app/career/gd/page.tsx`（career）・`supabase/career_gd_multi_apply.sql`（未適用DDL）・`.env.example`・
  `docs/gd/*` のみ。受験版・Phase1 ソロGD・既存テーブルに影響なし。

## STEP-GD-13: AI 補完して開始（`start` API・10 タイプ persona・deterministic selection）（完了）

- **対応1（persona プール）**: `app/api/career/gd/room/aiMembers.ts` を追加。
  - `CAREER_GD_AI_PERSONAS`（10 タイプ・MBTI 不使用・`persona_key` はスネークケース）。
    persona_key / display_name / role / persona_summary / speaking_style / strengths / weaknesses と、
    既存型後方互換の assertiveness(1〜3) / style を持つ。`runaway` / `indecisive` は難易度ノイズ役だが
    `weaknesses` に制御説明を持たせ議論を壊しすぎない。
  - `selectAiPersonasForRoom(roomId, neededCount, existingPersonaKeys)`: **roomId を seed**（xmur3→mulberry32）に
    deterministic 選択。ティア順（①実用5 → ②data → ③ノイズ役4）で埋め、既存 persona_key は除外・room 内一意。
  - `buildAiRoomMembers(...)`: insert 用行を生成（`user_id=null` / `is_ai=true` /
    `participant_id=gdai-<roomId>-<persona_key>`（決定的）/ persona jsonb）。
- **対応2（start API）**: `POST /api/career/gd/room/[roomId]/start`。
  - member 認証 → room 無し 404 → 非参加者 403 → 非 host 403 → waiting 以外 409。
  - **同時開始レース対策**: `status='waiting'` 条件付き UPDATE→active を「開始権の取得」に使う。
    0 行更新（＝他が先に開始）なら 409。開始権を取れた本人のみ AI を insert（二重補完しない）。
  - `planned_participant_count` まで `buildAiRoomMembers()` で補完。AI insert 失敗時は
    status を waiting に best-effort ロールバック。応答は GET room と同形。
- **対応3（型・mapper）**: `CareerGdRoomMember.persona` を拡張（personaKey / personaRole / personaSummary /
  speakingStyle / strengths / weaknesses を追加・任意）。`mapMemberRow` が persona jsonb（snake_case）を
  camelCase へ写す。`join_code_hash` 等の秘匿情報は一切返さない。
- **対応4（DDL）**: 列追加は不要（`rooms.started_at` / `members.persona` は既存）。persona は列分割せず
  `persona`(jsonb) に集約（jsonb はスキーマレス・移行不要）。コメントのみ STEP-GD-13 反映（冪等）。
- **対応5（UI）**: ロビー `room/[roomId]` を更新。host かつ waiting は「AIメンバーを補完して開始」
  （開始中 loading・成功で即反映）、非 host は「ホストの開始を待っています」、active は「開始済み
  （進行画面は STEP-GD-14 予定）」。AI member は persona 役回り・要約付きで表示。
- **未実装（GD-14 以降）**: message generation / turn 制御 / session 画面 / feedback 生成 /
  テーマ確定・役割割当（role は 'member' 固定）/ DB・KV ベースの rate limit。
- **影響範囲**: `app/api/career/gd/room/**`・`app/career/gd/room/[roomId]/page.tsx`・`types/careerGd.ts`・
  `supabase/career_gd_multi_apply.sql`（コメントのみ）・`docs/gd/*` のみ。受験版・Phase1 ソロGD・
  既存テーブルに影響なし。

## STEP-GD-13.5: Supabase 実機 read-only 検証（DDL 適用確認 + service_role grant 修正）

- **目的**: create→join→start の前提として、career_gd_* が実 Supabase に存在し API から到達できるかを
  **read-only**（write なし）で確認する。
- **判明1（env）**: 当初 `.env.local` は受験版プロジェクト（未 prefix の presentation_results 等）を指しており
  career_gd_* が無かった。career プロジェクト（`career_` prefix）へ切替後に解決。
  さらに切替後の `NEXT_PUBLIC_SUPABASE_URL` が **REST エンドポイント（末尾 `/rest/v1/`）** になっており、
  supabase-js が `…/rest/v1/rest/v1/…` を生成して `PGRST125` になる不具合を発見 →
  **Project URL（`https://<ref>.supabase.co`・末尾スラッシュ/パスなし）** に直す必要あり。
- **判明2（grant）**: career プロジェクトは長らく localStorage canonical で service_role の
  PostgREST 書込みを実運用してこなかったため、public テーブルへの service_role 権限が未付与。
  service_role でも career_gd_*（および既存 career_presentation_results）が `42501 permission denied` になる。
  マルチGD Phase2 が初めて server 書込みを必要とするため顕在化。
- **対応**: `career_gd_multi_apply.sql` に **service_role のみへの CRUD GRANT**（4テーブル）を idempotent に追加。
  anon/authenticated には付与せず deny-by-default を維持（API ゲートウェイ方式）。
- **検証手段**: service-role / anon の PostgREST REST を `select=…&limit=0/5` で叩くだけ（INSERT/UPDATE/DELETE なし）。
  secret leak scan（`.next/static` に service-role key 実値 / 秘匿 env 名が無いこと）も継続 clean。
- **残作業**: ① `NEXT_PUBLIC_SUPABASE_URL` を Project URL へ修正（env 側）② GRANT 追記版 SQL を SQL Editor で再適用
  → 再 read-only probe で service_role 200・anon ブロックを確認 → その後 create→join→start の write 検証（GD-14 前）。

## STEP-GD-14 以降（予定）

- **GD-14**: テキストGD 進行（`message` / `ai-turn` API ＋ ポーリング）。テーマ確定・役割割当もここで。
- **GD-15**: 終了・feedback・順位（`finish` / `feedback` API：Phase1 feedback の multi 経路を流用）。
- **GD-16**: view 統合（各自 localStorage 書き戻し・既存 `/career/gd/view` で閲覧）。
- **GD-17**: careerMatching / consultation 連携の回帰確認（マルチ結果が snapshot に乗ること）。
