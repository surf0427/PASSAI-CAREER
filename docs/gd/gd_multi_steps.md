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

> 注: GD-15〜GD-19 の詳細は [`gd_multi_current_state.md`](./gd_multi_current_state.md) の「進捗」を参照（本 steps.md では未転記）。

---

## STEP-GD-20: 公開GDロビー方式（先行実装 / 完全ランダムキューは後回し）

- **方針転換**: 当初検討した完全ランダムマッチ（`career_gd_match_queue` ＋ マッチ確定 RPC ＋ 自動 room 生成 ＋
  2.5秒 polling マッチング）ではなく、**公開GDロビー方式を先行**する。
  - **理由**: 初期ユーザー数が少ない段階では、完全自動マッチより「ユーザーが公開ルームを作り、他ユーザーが
    一覧から入りたい部屋を選んで参加する」方式のほうが、実装負担・運用負担・UX（過疎耐性・納得感）の面で安全。
    host も「作った本人」で自然に決まり host 決定ロジックが不要。完全ランダムキュー（`career_gd_match_queue`）は
    **未実装・後回し**（Phase3 相当）。

- **STEP-GD-20-A（DB / SQL・未適用）**: [`supabase/career_gd_public_lobby_apply.sql`](../../supabase/career_gd_public_lobby_apply.sql)（idempotent・**追加のみ**・既存 `career_gd_multi_apply.sql` を壊さない）。
  - `career_gd_rooms` に **`room_type`（NOT NULL default `'invite'` / CHECK `invite|public_lobby|random_match`）** と
    **`join_policy`（NOT NULL default `'code'` / CHECK `code|public|matched_only`）** を追加。既存 room は自動的に `invite`/`code`。
  - 部分 index: `career_gd_rooms_public_lobby_idx`（waiting×public_lobby 一覧用）/
    `career_gd_rooms_one_open_public_per_host`（同一 host の公開待機 room 乱立防止・部分 UNIQUE）。
  - RPC `career_gd_lobby_join(uuid, uuid, text)`：**`SECURITY DEFINER` / `SET search_path = public, pg_temp` /
    service_role のみ EXECUTE（anon/authenticated には付与しない）**。`pg_advisory_xact_lock` ＋ `FOR UPDATE` で
    満員（定員超過）と二重参加を原子的に制御。**既存 `career_gd_post_message` には触れない**。

- **STEP-GD-20-B（API）**: 公開ロビー専用 route を新設（既存 `room/create`・`room/join`・`room/start` は無改修）。
  - `POST /api/career/gd/lobby/create` — `public_lobby` room ＋ host member 作成。member 必須・service_role。
    **`join_code_hash = 'pub_' + roomId`（非 hex・1 回の INSERT で格納）/ `code_expires_at = now`**。
    同一 host が既に公開待機 room を持つ場合（乱立防止 index 発火）は既存 room を返して復帰（`reused:true`）。
  - `GET /api/career/gd/lobby/rooms` — `status='waiting' × room_type='public_lobby' × join_policy='public'` のみ。
    人間（`is_ai=false` かつ `left_at IS NULL`）で人数集計・満員は末尾。並びは `created_at desc`
    （waiting 中は member join で rooms 行が UPDATE されず `updated_at ≒ created_at` のため）。
    **`hostDisplayName` のみ返し、`host_user_id` / `user_id` / email / `join_code_hash` は返さない**。
  - `POST /api/career/gd/lobby/join` — `userId` はサーバ側の認証 user を使用（body の userId は受け取らない）。
    参加は **RPC `career_gd_lobby_join` に委譲**。404（room 無し / 公開でない）/ 409（満員・開始/終了済み）/
    503（DB 未適用）。二重参加は冪等成功。
  - `lib/careerGd/publicLobby.ts`（server-only ヘルパ）/ `lib/careerGd/publicLobbyTypes.ts`（client 安全な型）。

- **STEP-GD-20-C（UI）**:
  - `/career/gd/lobby`（新規）— 作成フォーム ＋ 10 秒ポーリング一覧 ＋ 参加。`isMine`/`isJoined` は「戻る」導線、
    `isFull` は参加 disabled、0 件時は「公開ルームを作成」「AIと今すぐ練習（`/career/gd/setup`）」導線。
    作成・参加後は既存 `/career/gd/room/[roomId]` へ `router.push`（room 画面は不変）。
  - `/career/gd` — 「公開ルームで練習する」カードを追加（既存 4 導線・マルチGDカードは不変）。

- **`join_code_hash = 'pub_' + roomId` の理由**: 公開 room は合言葉参加させないが `join_code_hash` は **NOT NULL**。
  HMAC-SHA256 出力（64 桁 hex）と構造上一致しない `'pub_'` prefix を入れることで、
  **既存の合言葉 join 検索（`.eq('join_code_hash', <hex>)`）に決してヒットせず、既存 join route を無改修のまま
  公開 room への合言葉参加を遮断**できる（room 単位に一意なので waiting `UNIQUE(join_code_hash)` とも競合しない）。

- **AI 補完**: 公開ロビー側では作らず、**既存 `start` 処理に委譲**（host が start → `planned_participant_count` まで
  既存 deterministic 補完。4 人なら補完なし、2〜3 人なら不足分を AI 補完）。**host start 必須の既存仕様は不変**。

- **STEP-GD-20-D（実DB QA ＋ docs 反映・本節）**:
  - 実 Supabase への **read-only probe**（service_role・**書き込みなし**・secret 非出力）の結果、
    **`career_gd_public_lobby_apply.sql`（STEP-GD-20-A）は実 Supabase に未適用**であることを確認：
    `career_gd_rooms.room_type` = `42703`（column does not exist）/ RPC `career_gd_lobby_join` = `PGRST202`
    （Could not find the function）。既存 GD マルチ table（`career_gd_room_messages` 等）は適用済み・到達可能。
  - このため **create / join / 満員 / 同時 join / RPC の実DB機能QAは未実施（不能）**。
    ただしコード側は列/RPC 不在を `isDbNotReady`（`42P01` / `42703` / `PGRST202`）で検出し **503 `DB_NOT_APPLIED`** を返し、
    UI は秘密を出さない固定文言を表示すること＝**未適用でも安全に縮退する**ことを確認。**最小修正なし**（コード変更不要）。
  - static 検証（typecheck / lint / build）clean・secret leak scan clean。本 STEP は **docs 反映のみ**。

- **非対象**: 完全ランダムキュー（`career_gd_match_queue`）/ 自動 start / host start 促し UI / lobby 専用 rate limit /
  Realtime・WebSocket（Phase3）。既存 room 系 route・受験版・Phase1 ソロGD に変更なし。

- **残課題**:
  1. `career_gd_public_lobby_apply.sql` を実 Supabase に適用 → 実DB QA（作成 / 一覧 / 参加 / 満員 / 同時 join /
     room 接続 / start / AI 補完 / message・result / 履歴 / 既存合言葉 join の分離）。
  2. host が start しない問題への促し UI。
  3. lobby/create・join の rate limit（現状なし・本番前に per-user/KV 検討）。
  4. 将来の完全ランダムマッチ（`career_gd_match_queue`）。

- **STEP-GD-20-G（member ログイン E2E QA・本節）**:
  - **前提更新**: 運用者により **正しい Supabase project ref `bhhmvupzcxoaonrowikg`** が確定。この project では
    **20-A DDL 適用済み**（`career_gd_rooms.room_type`/`join_policy` 列・公開一覧 index・同一 host 乱立防止 部分 UNIQUE・
    RPC `career_gd_lobby_join` すべて到達可能）。20-D 時点の「未適用」は誤った project を指していたための結果であり、本 STEP で解消。
  - **テスト member 準備**: 直近 20-G で `auth users = 0` によりブロックされていた member ログイン必須 E2E を実施するため、
    service_role で **email_confirm 済みテスト member を 4 名作成**（email / user_id / password / JWT / cookie は一切ログ出力せず・
    報告は member_count のみ）。E2E 完走後に **全員 service_role で削除**（`auth users` は 0→4→0 に復帰）。
  - **member ログイン → HTTP**: 未ログインで `GET /lobby/rooms` = 401 `LOGIN_REQUIRED`、member session cookie 付与で 200。
    session が route handler（`getServerSupabaseClient().auth.getUser()`）まで到達することを確認（token/cookie 値は非出力）。
  - **公開ロビー HTTP QA（31 checks PASS）**: create 成功 / 同一 host 再 create = `reused:true`（同一 roomId）/
    一覧は `public_lobby` のみ・invite room 混入なし / invite room への `lobby/join` = 404（存在秘匿）/ join 成功 /
    冪等 join（人数不変）/ 満員時 409 `ROOM_FULL` / **同時 join で定員超過しない**（planned=3 に 3 並列 join → 2 成功・1×409・最終 3 名）/
    レスポンスに `join_code_hash`/`host_user_id`/`user_id`/email/JWT/`pub_` hash なし。
  - **room 進行 QA（34 checks PASS）**: 非 host start = 403 `NOT_HOST` / host start = active・theme 確定 /
    **2〜3 人開始 → AI 補完あり（planned4・humans2 → AI2）** / **4 人開始 → AI 補完なし（AI0）** /
    `career_gd_post_message` の seq サーバ採番（poster 跨ぎで単調 +1）/ 同一 `clientMsgId` は冪等（同一 seq・二重計上なし・seq 欠番なし）/
    finish（非 host 403・host finished・二重 finish 冪等）/ **result 生成（AI 6 軸＋overallScore＋ranking）** /
    `career_gd_room_results` に DB 保存を確認 / result 再呼び出し冪等。
  - **履歴**: `careerGdRoomLogs` は **localStorage canonical（client 側）**で、result 後にクライアントが保存し `/career/gd/view` の
    `MultiGdHistorySection` が表示する設計。E2E では **durable mirror `career_gd_room_results` の DB 保存を確認**（localStorage/view の
    実描画はブラウザ依存のため下記 UI 注記参照）。
  - **既存合言葉 room 回帰（14 checks PASS）**: legacy `room/create`（6 桁 joinCode 返却）/ 誤コード 404 / code join / 冪等 join /
    start（AI 補完）/ message（seq 単調）/ finish / result 生成・DB 保存。**public_lobby と invite の分離維持**
    （invite room は lobby 一覧・`lobby/join` に出ない）。
  - **UI**: `/career/gd`・`/career/gd/lobby`・`/career/gd/view` は member session で **HTTP 200 render（error page なし）**。
    lobby UI コードに 作成フォーム / 10 秒ポーリング（`POLL_INTERVAL_MS=10_000`）/ 作成・参加後の `router.push(redirectTo)` で
    `/career/gd/room/[roomId]` 遷移 / `isMine`・`isJoined`・`isFull`（満員 disabled）/ 空状態導線 / `role="alert"` エラー表示 /
    公開項目（`LobbyRoomSummary`）のみ描画（秘匿列なし）を確認。room 詳細は 3 秒ポーリング。
    **⚠ 実ブラウザでの操作 E2E（クリック/画面遷移の実描画）はヘッドレスブラウザ（Playwright 等）が環境に無いため未実行**。
    上記は HTTP レベル（UI が呼ぶ API 契約を実 session で全通過）＋ページ render 200 ＋ UI コードレビューによる代替検証。
  - **cleanup**: 作成した test room / participants / messages / results を service_role で **cascade 削除（residual 0）**、
    test member 4 名削除（`auth users → 0`）、`career_gd_rooms` 等 4 table は全 0 行の想定状態を確認。
  - **static**: `tsc --noEmit` / `eslint` / `next build` clean・secret leak scan clean・**コード変更なし**。
  - **残課題（本 STEP 非対象）**: ① 実ブラウザ操作 E2E（Playwright 等の導入）② host start 促し UI
     ③ lobby/create・join の rate limit ④ 完全ランダムマッチ（`career_gd_match_queue`）⑤ Realtime（Phase3）。

- **STEP-GD-20-H（公開ロビー 実ブラウザ E2E・本節）**:
  - **目的**: 20-G で HTTP レベル完走済みの公開ロビーを **Playwright で実ブラウザ操作**し、クリック/遷移/満員表示/
    エラー表示/polling 反映まで UI で確認する（20-G 残課題①の解消）。
  - **実行環境**: `@playwright/test` 1.61.1。Playwright の browser バイナリDLは環境制約（CDN throttled）で不可のため、
    **システム Google Chrome を `channel:'chrome'`（headless）で駆動**。サーバは `next start -p 3111`。認証はテスト member の
    **storageState（Supabase auth cookie）**で行い、token/cookie/email/password/user_id は一切ログ出力・tracked files 非混入。
  - **導入（最小テスト設定）**: devDependency `@playwright/test`、`playwright.config.ts`、`tests/e2e/`。`tests/**` は
    tsc/eslint/Next build から除外（Playwright 独自 TS 解決）。`test-results/` `.e2e-tmp/` 等を `.gitignore`。
  - **本番コード変更（最小・非機能）**: 実ブラウザで特定 room を一意特定し live 状態を assert するための **data-* test hooks** を
    2 箇所追加。① `app/career/gd/lobby/page.tsx` の RoomCard 内 div に `data-room-id`/`data-count`/`data-full`/`data-mine`/`data-joined`、
    ② `app/career/gd/room/[roomId]/page.tsx` の MembersCard の `<li>` に `data-testid="gd-member-row"`/`data-ai`。
    **理由**: ロビーは多カード・満員・人数が動的で text-scoping が不安定なため。**影響**: DOM 属性追加のみで
    レンダリング・挙動・スタイルは不変（Card コンポーネントは props を spread しないため内側 div に付与）。
  - **検証結果（10/10 PASS・実ブラウザ）**:
    - **A render**: `/career/gd`・`/career/gd/lobby`・`/career/gd/view` が 200・error page なし・主要UI表示。
    - **B create**: UI から公開room作成 → `/career/gd/room/{id}` へ遷移、`参加者（1 / 4）`・ホストバッジ・`参加受付中` 表示。
    - **B2 reused**: 同一 host の再作成が既存 room（同一 id）へ復帰。
    - **C join**: 別 member が一覧で room を見て（`data-mine=false`/`data-joined=false`）参加ボタン → room 詳細（`参加者（2 / 4）`）。
    - **C2 states**: `isJoined` → 「ルームへ戻る」、`isMine` → 「自分のルームへ戻る」リンクに切替（破綻なし）。
    - **D polling**: lobby は **10 秒 auto-poll** でカード人数が 1→2 に更新（リロード無し）。waiting 詳細は「更新」ボタンで反映
      （waiting は auto-poll なし・設計どおり）。active の **3 秒 auto-poll は G で検証**。
    - **E full**: planned=2 を満員化 → 別 member の一覧で `data-full=true`・`data-count=2`・**「満員」ボタン disabled**。
    - **F start**: 非 host は開始ボタンなし（「ホストの開始を待っています」）、host start → `GD進行中`・theme 確定（プレースホルダ消滅）・
      **AI 補完 2・総勢 4**（`data-ai=true` 行が 2）。
    - **G message/finish/result/history**: 発言送信 → 自画面表示、他 member の発言が **3 秒 polling** で反映、finish（confirm accept）
      → `GDは終了しました`、**評価生成（AI）→ GdEvaluationDetail ＋「GD履歴（結果一覧）を見る」**、`/career/gd/view` に
      「ルームGD（マルチ）の履歴」表示（localStorage canonical・空状態でない）。
    - **H invite 回帰**: 合言葉作成 → **誤コード拒否** → 正コード参加（room 詳細遷移）→ **invite room は公開ロビーに出ない**
      （`data-room-id` カード 0 件）→ start/AI補完/message/finish/result。
  - **実ブラウザで確認できた範囲（HTTP でなく）**: 実 DOM・クリック・画面遷移・フォーム入力・`select`/textarea 操作・
    auto-poll による無リロード更新・disabled 状態・`window.confirm` ダイアログ・AI 評価描画・localStorage 履歴表示。
  - **DB**: 実行中に `career_gd_room_results` へ 4 行（HostMain 2＋invite 2）persist を確認（durable mirror）。
  - **cleanup**: 作成した rooms 4 / members 12 / messages 3 / results 4 と test member 4 名を service_role で削除
    （全 table 0・auth users 0）、storageState / creds / manifest ファイルを削除。
  - **static**: `tsc --noEmit` / `eslint` / `next build` clean・E2E **10/10 PASS**・secret leak scan clean。
  - **残課題**: ① host start 促し UI ② lobby/create・join の rate limit ③ 完全ランダムマッチ（`career_gd_match_queue`）
     ④ Realtime（Phase3）⑤ 別デバイス hydrate 用 `career_gd_room_results` の `GRANT SELECT`/owner-select RLS 整理の要否確認。
     （20-G 残課題①「実ブラウザ操作 E2E」は本 STEP で **完了**。）

- **STEP-GD-20-I（GD 参加人数を 4/6/8 の 3 択固定・本節）**:
  - **目的**: GD の参加人数仕様を、全モード共通で **4 / 6 / 8 の 3 択のみ**に固定する（将来のランダムマッチでも共通化）。
  - **仕様**:
    - ソロ: 自分 1 人 + AI で planned まで補完（AI = planned − 1）。
    - フレンド/合言葉: room capacity = planned。開始時に人間不足分を AI 補完。
    - 公開ロビー: 作成時に 4/6/8 を選択。参加上限 = planned。開始時に不足分 AI 補完。
    - ランダムマッチ: 本 STEP では本体未実装。将来 **人数別キュー**（4/6/8）に分ける前提で型/定数/TODO のみ用意。
  - **正本（single source of truth）**: [`lib/careerGd/participantCount.ts`](../../lib/careerGd/participantCount.ts)。
    `CAREER_GD_ALLOWED_PARTICIPANT_COUNTS = [4,6,8]`、`CareerGdParticipantCount` 型、`isCareerGdParticipantCount` 型ガード、
    `DEFAULT_CAREER_GD_PARTICIPANT_COUNT = 4`、`parseParticipantCount`（未指定→既定4 / 指定不正→拒否・**silently fallback しない**）、
    `coerceParticipantCount`（表示用）、`CAREER_GD_MATCH_QUEUE_KEY`（将来の人数別キュー・TODO）。**UI/API/DB/テストは本定数を参照（重複定義禁止）**。
  - **DB**: `career_gd_rooms.planned_participant_count` の CHECK を `BETWEEN 2 AND 8` → **`IN (4,6,8)`** に変更。
    - [`supabase/career_gd_multi_apply.sql`](../../supabase/career_gd_multi_apply.sql)（新規適用の正本）を更新。
    - 既存 DB 反映用に **idempotent 増分** [`supabase/career_gd_participant_count_apply.sql`](../../supabase/career_gd_participant_count_apply.sql) を新設。
      **既存に 4/6/8 以外の行があれば自動で丸めず RAISE EXCEPTION で停止**し手動修正を促す（テーブル未作成なら NOTICE でスキップ）。
    - ※ `career_gd_*` は `supabase/schema.sql` には無く apply SQL が正本（schema.sql への反映は不要）。
    - ※ **DB DDL は運用者が Supabase 上で適用**（20-A と同様。JS client では DDL 実行不可・QA harness に DB 資格情報なし）。
      アプリ層の 400 バリデーションが UI 改ざんに対する主要防御で、DB CHECK は defense-in-depth（本 QA で API 400 を検証済み）。
  - **API バリデーション**: `lib/careerGd/publicLobby.ts`（公開ロビー create）・`app/api/career/gd/room/create`（合言葉 create）で
    4/6/8 以外を **400 `INVALID_COUNT`**。未指定は既定 4。`app/api/career/gd/theme` の人数解決も 4/6/8 準拠に整合。
    start 時の AI 補完数は既存どおり `planned − 人間参加者`（`start` route・`buildAiRoomMembers` は元々 planned 依存で 6/8 も動作）。
  - **UI**: 人数選択を **4人/6人/8人 の 3 択・既定 4** に統一（`app/career/gd/lobby`＝select、`app/career/gd/setup`＝ソロ Chip、
    `app/career/gd/room/create`＝合言葉 Chip）。「実際の参加者が足りない場合は AI が補完」文言を明記。8 人でもレイアウト非破綻を E2E で確認。
  - **AI 補完**: room 側（`aiMembers.ts`：persona 10 種）は元々 planned 依存で 4/6/8 対応。ソロ側の名前/スタイル候補を 8 人分（AI 最大 7）に拡張（`gdRoles.ts`）。
    満員判定（`isFull`/`data-full`/`data-count`/`ROOM_FULL`/RPC `career_gd_lobby_join` の `v_human >= v_planned`）はすべて planned 基準で一致。
  - **Playwright E2E（17/17 PASS・実ブラウザ）**: 4人フロー（A–G：create/join/polling/満員disabled/host start/AI補完/message/finish/result/history）＋
    **6人**（create→上限/6→2人start→AI補完4→計6→result）＋**8人**（同→AI補完6→計8・roster/評価非破綻）＋
    **API 不正値拒否**（3/5/7/9/10/文字列→400、4/6/8→200、未指定/null→既定4）＋**合言葉 8人**（作成→参加→start→AI補完6→計8→result）。
  - **HTTP/API QA（25/25 PASS）**: 不正値 400（2/3/5/7/9/10/12/文字列）・有効値 200（4/6/8）・6人roomで5人join（>4・上限未達）・
    8人roomで6人join→start で AI 補完2→計8・4人room満員時 5人目 409 `ROOM_FULL`・同時 join で定員超過なし（planned 基準）。
  - **cleanup**: 作成した rooms/members/messages/results を service_role で削除（全 0）、テスト member（今回 6 名）削除（`auth users`→0）、
    storageState/creds/manifest 削除。※満員(4人)の disabled を未参加者視点で観測するため、最小人数 4 に伴い **テスト member を 6 名**用意（4 名充填＋観測＋予備）。
  - **static**: `tsc --noEmit`/`eslint`/`next build` clean・E2E 17/17・HTTP QA 25/25・secret leak scan clean。
  - **残課題**: ① host start 促し UI ② lobby/create・join の rate limit ③ 完全ランダムマッチ（人数別キュー `career_gd_match_queue_{4,6,8}`）
     ④ Realtime（Phase3）⑤ 別デバイス hydrate 用 `career_gd_room_results` の `GRANT SELECT`/RLS 整理の要否確認 ⑥ CI 用 Playwright browser setup（現状 system Chrome 依存）。

- **STEP-GD-20-J（host start 促し UI・本節）**:
  - **目的**: waiting room で **host が開始せず room が放置される**問題を防ぐ。host/非host それぞれに状況が伝わる文言・CTA を出す。
    UI のみの変更（[`app/career/gd/room/[roomId]/page.tsx`](../../app/career/gd/room/[roomId]/page.tsx) の `WaitingView`）。**DB/API 変更なし**。
  - **人数状態表示（host/非host 共通）**: MembersCard 上部に「参加状況: {human} / {planned} 人」＋
    「AIメンバー補完予定: {aiFill} 人」（`aiFill = max(0, planned − human)`）。満員時は「全員そろっています」。
    non-functional test hook: `data-testid="gd-waiting-status"` に `data-human`/`data-planned`/`data-ai-fill`（DOM 属性のみ・挙動不変）。
  - **host 向け（waiting・不足あり）**: 「**あなたがホストです**」＋「参加者がそろったら、またはAIメンバーで始めたい場合は『開始』を押してください。
    現在 {human} / {planned} 人が参加中です。不足分の {aiFill} 人はAIメンバーが自動で参加します。」＋ CTA「**AIメンバーを補完して開始**」。
    start 実行中は disabled/「開始中…」、失敗は既存 `role="alert"` エラー、成功で active UI へ自然遷移（既存 `onStarted`）。
  - **host 向け（満員 aiFill=0）**: 「**参加者が全員そろいました**」＋「準備ができたらGDを開始してください。」＋ CTA「**GDを開始する**」
    （「AI補完されます」は出さない）。full でも host は開始可能。
  - **非host 向け**: 「**ホストの開始を待っています**」＋「このGDはホストが開始すると始まります。現在 {human} / {planned} 人が参加中です。
    参加者が足りない場合は、AIメンバーが自動で参加します。この画面は自動更新されます。」**start CTA は非表示**。
  - **4/6/8 いずれでも文言非破綻**（aiFill: 4人→3 / 6人→4 / 8人→6・8人でも縦に自然に伸びる）。既存 start ボタン挙動・active/finished 表示は不変。
  - **Playwright E2E（21/21 PASS）**: 新規 `careerGdHostPrompt.spec.ts`（A host UI＋人数＋AI補完予定＋start→active／B 非host UI・CTAなし・人数／
    C 満員 host UI「全員そろいました」・aiFill=0・「GDを開始する」で start／D 6人=補完4・8人=補完6）＋既存
    Counts/Invite/Lobby/ParticipantApi 全回帰（create/join/polling/満員disabled/host start/message/finish/result/history/合言葉/人数validation）。
  - **HTTP/API QA（25/25 PASS）**: start 挙動不変（非host start 403・host start active・AI補完 = planned−humans）・4/6/8 validation 維持。
  - **環境メモ**: 初回フル E2E は実行中に Supabase の一時 **DNS 障害（`ENOTFOUND`）**でセッション検証が 401 になり失敗。ネットワーク回復後に
    storageState を再生成して再実行し **21/21 PASS**（コード起因ではない）。system Chrome `channel:'chrome'` 駆動は 20-H 同様。
  - **cleanup**: rooms/members/messages/results と test member（6 名）を削除（全 table 0・auth users 0）・storageState/creds 削除。
  - **static**: `tsc --noEmit`/`eslint`/`next build` clean・E2E 21/21・HTTP QA 25/25・secret leak scan clean。
  - **非目標（TODO 明記・本 STEP 非対象）**: host 自動開始 / メール・Push 通知 / 非host→host 催促送信 / room timeout / abandon cleanup /
    Realtime / 完全ランダムマッチ / rate limit / DB schema 変更（コード内 TODO と下記残課題に記載）。
  - **残課題**: ① lobby/create・join の rate limit ② 完全ランダムマッチ（`career_gd_match_queue_{4,6,8}`）③ Realtime（Phase3）
     ④ 別デバイス hydrate 用 `career_gd_room_results` の `GRANT SELECT`/RLS 整理の要否確認 ⑤ CI 用 Playwright browser setup
     ⑥ DB CHECK 4/6/8 の本番/preview 適用状況（`career_gd_participant_count_apply.sql`・運用者適用）。
     （**host start 促し UI は本 STEP で完了**。）

- **STEP-GD-20-K（公開ロビー create/join rate limit・本節）**:
  - **目的**: 公開GDロビーの create/join がログイン済みユーザーに連打・改ざんで荒らされるリスクを下げる MVP rate limit。
    完璧な Bot 対策ではなく「過剰リクエストを 429 で止める」第一段階。
  - **対象 API**: `POST /api/career/gd/lobby/create`・`POST /api/career/gd/lobby/join`（主対象）＋
    `POST /api/career/gd/room/create`・`POST /api/career/gd/room/join`（合言葉。cheap なので同時対応）。
  - **key 設計**: **member `auth.uid()` 単位**（email/IP は使わない）。key は SHA-256 の先頭 20 桁に hash 化してから store/ログに渡す
    （生の user_id を store・ログ・response に出さない）。namespace で機能別分離（`career_gd_lobby_create`/`_join`/`career_gd_invite_create`/`_join`）。
  - **limit 値**（短期・中期の 2 window。どちらか超過で 429）:
    lobby create = **3/60s・10/3600s** / lobby join = **10/60s・30/3600s** / invite create = 5/60s・20/3600s / invite join = 10/60s・40/3600s。
  - **store 方式**: [`lib/rateLimit/store.ts`](../../lib/rateLimit/store.ts)。**production/preview は Upstash Redis REST**（env
    `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`・依存追加なし・fetch のみ・INCR+EXPIRE(NX) の固定 window）、
    **未設定時は in-memory fallback**。**本番で silent no-op にしない**: Upstash 未設定の production では in-memory に落ちるが起動時に
    一度だけ警告（実効上限は「インスタンス数 × limit」＝保守的 fallback）。接続文字列/token はログに出さない。
  - **無効化フラグ**: `CAREER_GD_RATE_LIMIT_DISABLED=1|true` で無効化（**local/test/CI 用**・本番では設定しない）。既定=有効なので
    本番が既定で no-op になることはない。E2E 回帰 run はこのフラグ ON、rate limit 検証 run は OFF（enabled）で別サーバ実行。
  - **429 response**: `{ error:'RATE_LIMITED', message, detail, retryAfterSeconds }`＋header `Retry-After` / `X-RateLimit-Limit` /
    `X-RateLimit-Remaining` / `X-RateLimit-Reset`。secret/PII/user_id/room_id を含めない。`ROOM_FULL`/`INVALID_COUNT`/`NOT_HOST` と混同しない安定コード。
  - **UI**: [`/career/gd/lobby`](../../app/career/gd/lobby/page.tsx) の `friendlyError` に **RATE_LIMITED（429）** を追加し
    「短時間に操作が集中しています。少し待ってからもう一度お試しください。」を既存 `role="alert"` に表示。ボタンは永久 disabled にならない（`creating`/`joiningRoomId` を finally で解除）。
  - **ユーティリティ**: [`lib/rateLimit/index.ts`](../../lib/rateLimit/index.ts)（`checkRateLimit`/`checkRateLimits`/`enforceRateLimit`/`rateLimitedResponse`/`CAREER_GD_RATE_LIMITS`）。将来 ES/面接/プレゼンでも再利用可。
  - **ログ**: 発火時 `GD rate limited: namespace=... limit=... retryAfterSec=...` のみ（user_id/email/IP/JWT/cookie 非出力）。
  - **テスト結果**:
    - **unit（19/19 PASS）** [`scripts/career-gd-rate-limit-qa.ts`](../../scripts/career-gd-rate-limit-qa.ts)（`npm run qa:rateLimit`）: 上限内 allowed / 超過 blocked /
      user 分離 / namespace 分離 / 短期・長期 window 独立 / window ロール / 無効化フラグ / 429 header・body（PII 非混入）。
    - **HTTP QA（17/17 PASS）**: create 超過 429（Retry-After/X-RateLimit-*）/ join 超過 429（**ROOM_FULL と非混同**）/
      別 member 非影響（user 分離）/ create-limited でも join 可・join-limited でも create 可（namespace 分離）/ 429 body PII 非混入。
    - **Playwright（@ratelimit・2/2 PASS）** [`careerGdRateLimit.spec.ts`](../../tests/e2e/careerGdRateLimit.spec.ts): create/join を上限まで消費 →
      UI で 429 の `role="alert"` 文言表示・ボタン再有効・満員と区別。fixed-window 境界に依存しないよう「API で 429 を観測してから UI 操作」する設計。
    - **既存回帰**: 非 @ratelimit の Playwright **21/21 PASS**（render/create/join/polling/満員/host prompt/start/message/finish/result/history/合言葉/4-6-8 validation）
      ＋ HTTP counts QA **25/25 PASS**（bypass サーバ）。※AI result は Anthropic 一時遅延で 1 度 flake→再実行で緑（コード起因でない）。
  - **cleanup**: rooms/members/messages/results と test member（6 名）削除（全 table 0・auth users 0）・storageState/creds 削除・
    rate limit test key は **in-memory**（サーバ停止＝プロセス終了で消滅・TTL でも自然消滅）。
  - **static**: `tsc --noEmit`/`eslint`/`next build` clean・unit 19/19・HTTP QA 17/17・Playwright 2/2＋21/21・secret leak scan clean（Redis 接続文字列/token 非混入）。
  - **非目標（TODO 明記）**: 本格 Bot 対策/CAPTCHA/abuse monitoring・IP 単位の本格化・room timeout。
  - **残課題**: ① 完全ランダムマッチ（`career_gd_match_queue_{4,6,8}`）② Realtime（Phase3）③ 別デバイス hydrate 用 `career_gd_room_results` の SELECT/RLS 整理
     ④ CI 用 Playwright browser setup ⑤ DB CHECK 4/6/8 の本番/preview 適用状況 ⑥ 必要なら invite rate limit のチューニング ⑦ 将来的な Bot 対策/CAPTCHA。
     （**lobby/create・join の rate limit は本 STEP で完了**。）

- **STEP-GD-20-L（GD 結果履歴の DB hydrate / SELECT・RLS 整理・本節）**:
  - **目的**: マルチGD 結果履歴を、**別デバイス・再ログイン・localStorage 消失後でも「ログイン本人が参加した room の自分の結果だけ」安全に復元**できるようにする。
    方針は `localStorage canonical + authenticated DB durable mirror`（localStorage は即時表示 canonical・DB は復元用 mirror）。
  - **RLS/GRANT 方針（owner-scoped・他人の結果は読ませない）**: [`supabase/career_gd_results_hydrate_apply.sql`](../../supabase/career_gd_results_hydrate_apply.sql)（idempotent・
    `DROP POLICY IF EXISTS`→`CREATE`・運用者適用）。`career_gd_room_results` **のみ** に `GRANT SELECT ... TO authenticated`＋
    **owner-select RLS** `USING (auth.uid() = user_id)`。anon は付与なし（42501 拒否）。service_role は従来どおり（RLS bypass）。
    ※ 依頼例の member-scoped（EXISTS on career_gd_room_members）は**共有 room の他人 self_feedback（本人のみ表示の私的評価）が読めてしまい**、
      厳守事項「他人のGD結果が読める状態にしない」に反するため採らず、**owner-scoped（自分の user_id 行のみ）**を採用。
    ※ 本 project では **既に適用済み**を確認（authenticated 直 SELECT は自分の 2 行のみ返り他人ゼロ・anon は 42501）。
  - **取得経路（server route 優先）**: 新規 [`GET /api/career/gd/room/results`](../../app/api/career/gd/room/results/route.ts)。member 必須（未ログイン 401）・
    service_role ＋ **`user_id = session.user.id` をサーバ側で強制**（user_id は入力で受け取らない＝他人 result は取得不能）。
    theme / room_type / 人間・AI 人数は `career_gd_rooms` / `career_gd_room_members` を join して補完。**RLS 未適用でも動作**（route は service_role）。
    直 SELECT（方針A）用の [`lib/supabase/careerGdRoomResults.ts`](../../lib/supabase/careerGdRoomResults.ts) は RLS 適用済み環境向けの defense-in-depth として残置。
  - **返却 shape**（PII 非返却）: `CareerGdRoomResultHistoryItem`（roomId/resultId/roomType/theme/format/participantCount/humanParticipantCount/
    aiParticipantCount/createdAt/durationSec/participantId/evaluation/ranking/matchingHints/consultationSummary）。**user_id/email/join_code_hash/sender_user_id は返さない**。
  - **merge 方針**: [`lib/careerGd/roomResultHistory.ts`](../../lib/careerGd/roomResultHistory.ts) が route を叩き `CareerGdRoomLog` に正規化 → 既存 `mergeGdRoomLogs`
    で localStorage(`careerGdRoomLogs`) へ **merge only**（重複キー=**roomId**・両方あれば local 優先で richer 維持・DB のみは追加・新しい順）。DB 取得失敗でも localStorage は壊さない。未ログインは hydrate しない。never throw。
  - **UI**: [`MultiGdHistorySection`](../../app/career/gd/MultiGdHistorySection.tsx) を route hydrate に切替。ログイン時に 1 回 hydrate、loading「保存済みのルームGD履歴を確認しています…」・
    成功で「別デバイス保存分も表示中」バッジ・失敗は控えめに「オンライン履歴の取得に失敗しました。端末内の履歴のみ表示しています。」（画面全体は壊さない）。
  - **RLS/security QA（18/18 PASS）**: seed（A 専用 / B 専用 / A+B 共有 / C 専用 room＋result）に対し、route で **A は自分の 2 件のみ（B/C 専用は不可視）**・
    B も同様・C は自分のみ・未ログイン 401・返却に PII なし・共有 room の人数（humans=2/ai=1）正確。加えて **authenticated 直 SELECT は自分の行のみ・anon は 42501** を確認。
  - **Playwright（@hydrate・4/4 PASS）** [`careerGdHydrate.spec.ts`](../../tests/e2e/careerGdHydrate.spec.ts): A) localStorage 無し＋DB あり → DB から復元・**他人 room 不可視**・同期バッジ／
    B) 別 member は自分の履歴のみ／C) 同一 roomId が local にもある状態で **重複表示なし**／D) results API を 500 に固定 → **localStorage 履歴は表示継続＋控えめ警告**。
  - **既存回帰**: 非 @ratelimit/@hydrate の Playwright **21/21 PASS**・@ratelimit **2/2**・HTTP counts QA **25/25**・rate limit unit **19/19**（結果生成/合言葉/4-6-8/rate limit/host prompt 全て非破壊）。
  - **cleanup**: seed 含む rooms/members/messages/results と test member（6 名）削除（全 table 0・auth users 0）・storageState/creds/hydrate-manifest 削除。
    ※テスト harness の注意: RLS 直 SELECT 検証の `signOut` は **`scope:'local'`**（global だと他セッションの refresh token を revoke し storageState を壊すため）。
  - **static**: `tsc --noEmit`/`eslint`/`next build` clean・security/API 18/18・@hydrate 4/4・回帰 21/21＋2/2＋25/25＋19/19・secret leak scan clean（user_id/join_code_hash/token 非混入）。
  - **残課題**: ① 完全ランダムマッチ ② Realtime（Phase3）③ CI 用 Playwright browser setup ④ DB CHECK 4/6/8 の本番/preview 適用状況
     ⑤ Upstash Redis の本番/preview 設定状況 ⑥ room timeout / abandon cleanup ⑦ 将来的な Bot 対策/CAPTCHA/abuse monitoring。
     （**別デバイス hydrate 用 `career_gd_room_results` SELECT/RLS 整理は本 STEP で完了**。）
