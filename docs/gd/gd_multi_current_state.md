# GD Phase2 マルチGD — current state（合言葉参加型・server 正本）

> 本ドキュメントは Phase2「合言葉参加型マルチGD」の**現在の確定仕様**を記述する。
> Phase1 ソロGD（localStorage canonical）は不変。Phase2 は複数ユーザーの共有状態を扱うため
> **Supabase を server 正本**とする（Phase1 の mirror とは別レイヤ）。

## スコープ（Phase 切り分け）

- **Phase1（実装済み）**: ソロGD（ユーザー1人 + AI 補完）。localStorage canonical。
- **Phase2（本ドキュメント）**: 合言葉参加型マルチGD。member ログイン必須。Realtime なし（ポーリング）。
- **Phase3（未着手）**: ランダムマッチング / Supabase Realtime / 音声・WebRTC。

## 確定方針

- マルチは **member ログイン必須**。guest 参加不可。
- 合言葉は **6 桁数字コード**（MVP）。DB に平文は保存せず、
  `join_code_hash = HMAC_SHA256(normalizedCode, pepper)`（deterministic）で保存。
  pepper は server-only `CAREER_GD_JOIN_CODE_PEPPER`（無ければ `SUPABASE_SERVICE_ROLE_KEY` を fallback）。
  deterministic なので「同じ6桁＝同じ hash」となり、waiting 中の `UNIQUE(join_code_hash)` が平文重複を防ぐ
  （STEP-GD-12 で per-room salt 方式から変更。`room_salt` 列は廃止）。
- 有効期限は作成から **30 分**。**waiting のみ join 可**。active / finished / cancelled は join 不可。
- RLS は **API ゲートウェイ方式**：クライアントは `career_gd_*` を直接叩かない。service-role を使う
  API route（`app/api/career/gd/room/**`）が認証・参加権限・host 権限を検証して DB 操作する。
- AI 補完は **host が開始した瞬間に確定**（`planned - 参加人数` を AI で補完）。
  - persona は **10 タイプ固定プール**（下記）。`roomId` を seed に **deterministic** に選ぶ。
- ranking は参加者全員に共有。詳細 FB は本人のみ。AI も ranking に含めるが AI と明示する。
- ターン進行は **2〜3 秒ポーリング＋手動更新**（Realtime は Phase3）。

## AI persona（10 タイプ・STEP-GD-13）

- 定義: [`app/api/career/gd/room/aiMembers.ts`](../../app/api/career/gd/room/aiMembers.ts) の `CAREER_GD_AI_PERSONAS`。
- MBTI は使わない。就活GD 練習向けの 10 タイプ（`persona_key` はスネークケース）。

| persona_key | display_name | role（役回り） | 用途区分 |
|---|---|---|---|
| `leader` | AIリーダー | 進行・整理 | 実用（優先） |
| `logical` | AI論理派 | 根拠・因果確認 | 実用（優先） |
| `idea` | AIアイデアマン | 発想・選択肢拡張 | 実用（優先） |
| `cautious` | AI慎重派 | リスク・課題確認 | 実用（優先） |
| `cooperative` | AI協調役 | 合意形成・橋渡し | 実用（優先） |
| `data` | AIデータ担当 | 数字・事例提示 | 中間 |
| `critical` | AI批判役 | 反論・検証 | 難易度ノイズ役 |
| `quiet` | AI寡黙枠 | 無口な参加者 | 難易度ノイズ役 |
| `runaway` | AI暴走枠 | 脱線・過剰主張 | 難易度ノイズ役 |
| `indecisive` | AI優柔不断枠 | 迷い・結論保留 | 難易度ノイズ役 |

各 persona は `persona_summary` / `speaking_style` / `strengths` / `weaknesses` と、既存型後方互換の
`assertiveness`(1〜3) / `style` を持つ。`runaway` / `indecisive` は練習難易度を上げるノイズ役だが、
`weaknesses` に制御用の説明（「議論を破壊しすぎない」旨）を持たせる。

### deterministic selection の仕様

`selectAiPersonasForRoom(roomId, neededCount, existingPersonaKeys)` / `buildAiRoomMembers(...)`:

- **seed = roomId**（xmur3 で 32bit 化 → mulberry32 PRNG）。同じ room は毎回同じ並び。
- **ティア順**で埋める: ①実用5（leader/logical/idea/cautious/cooperative）→ ②data → ③ノイズ役4。
  - 補完人数が少ないほど実用タイプだけで埋まり、多いほどノイズ役まで混ざる（＝難易度が上がる）。
  - 各ティア内は roomId seed で決定的にシャッフル。
- **既存 AI の `persona_key` は除外**（重複防止）。同一 room 内で persona_key は一意。
- `participant_id = gdai-<roomId>-<persona_key>`（決定的。start リトライでも同じ ID）。
- persona 情報は `career_gd_room_members.persona`（jsonb）にそのまま格納（列分割しない）。

## URL 設計（予定）

Phase1 の `setup / session / view` は不変。マルチは `room/**` に隔離：

```
/career/gd/room/create            ホスト：作成 → 合言葉表示
/career/gd/room/join              参加者：合言葉入力
/career/gd/room/[roomId]          ロビー（参加者一覧・host のみ開始）
/career/gd/room/[roomId]/session  進行（ポーリング）
/career/gd/room/[roomId]/result   ルーム結果（自分の詳細FB＋全体ランキング）
/career/gd/view?id=<resultId>     各自の恒久保存（localStorage 書き戻し・Phase1 と共通）
```

## DB（server 正本 / STEP-GD-10 で DDL 追加）

DDL: [`supabase/career_gd_multi_apply.sql`](../../supabase/career_gd_multi_apply.sql)

| テーブル | 役割 | 主なキー / 制約 |
|---|---|---|
| `career_gd_rooms` | ルーム本体（状態・テーマ・合言葉hash・room_salt・期限） | PK id / status・format CHECK / 人数・時間 範囲CHECK / `UNIQUE(join_code_hash) WHERE status='waiting'` |
| `career_gd_room_members` | 参加者（人間＋AI補完・役割・persona） | PK id / `UNIQUE(room_id, user_id)`（AIは user_id NULL） / role CHECK |
| `career_gd_room_messages` | 発言ログ（seq 順序・二重投稿防止） | PK id / `UNIQUE(room_id, seq)` / `UNIQUE(room_id, client_msg_id)` / kind CHECK |
| `career_gd_room_results` | 各ユーザーの結果（自分FB＋共有ranking＋matchingHints） | PK id / `UNIQUE(room_id, user_id)` |

- AI 参加者は `user_id = NULL / is_ai = true`。
- `updated_at` trigger は rooms / members / results（messages は created_at のみ）。
- RLS: 全テーブル有効化・**deny-by-default**（許可ポリシー無し）。将来「本人結果のみ SELECT」案は SQL 内にコメントで保持。

## localStorage と Supabase の関係

- **共有状態（rooms / members / messages / ranking）= Supabase が正**。
- **各ユーザーの"自分の結果"の恒久保存＆一覧 = localStorage `careerGdResults`（Phase1 canonical）**。
  → feedback 完了後、各クライアントが自分の結果を `CareerGdResult`（`participationMode='multi'`・`roomId` 付き）
  として `appendGdResult()` で localStorage に書き戻し、既存 `/career/gd/view` で見返す。

## 型（既存で足りる範囲）

`types/careerGd.ts` は既にマルチ対応の placeholder（`participationMode='multi'` / `GdParticipant.userId?` /
`CareerGdSession.roomId?` / `CareerGdResult.roomId?` / `CareerGdResult.ranking?`）を持つため、
Phase2 でも型拡張は最小限。room DB 用の行→型変換は API route 側で行う。

## API（実装済み）

- `POST /api/career/gd/room/create`（STEP-GD-11）— room 作成＋6桁コード発行。member 必須。
  - `join_code_hash`(HMAC)のみ保存、平文コードは応答で1回のみ。
- `POST /api/career/gd/room/join`（STEP-GD-12）
  - 入力: `{joinCode, displayName?}` / 出力: `{roomId, status, joinedMember, members, codeExpiresAt}`
  - IP レート制限→member 認証→6桁 normalize/検証→HMAC hash で waiting・未期限 room 検索→
    既参加は冪等成功 / 満員は 409 / 未参加は member insert。該当なしは 404（詳細を出さない）。
- `GET /api/career/gd/room/[roomId]?afterSeq=<n>`（STEP-GD-12）
  - 出力: `{room, members, messages, isHost, currentUserMember, status}`。参加者本人のみ（非参加者 403）。
  - messages は STEP-GD-14 まで空。`afterSeq` でポーリング差分取得に対応。
  - AI member は `persona`（personaKey / personaRole / personaSummary / speakingStyle / strengths /
    weaknesses / assertiveness / style）を含む。`join_code_hash` 等の秘匿情報は一切返さない。
- `POST /api/career/gd/room/[roomId]/start`（STEP-GD-13 → GD-14 でテーマ確定を追加）— host が waiting→active にして AI 補完。
  - member 認証必須。room 無し 404 / 非参加者 403 / 非 host 403 / waiting 以外 409。
  - `status='waiting'` 条件付き UPDATE を「開始権の取得」に使い、**同時開始レースに耐える**
    （取得できなかった側は 409）。開始権を取れた本人のみ AI を insert（二重補完しない）。
  - `planned_participant_count` まで `buildAiRoomMembers()` で補完（既存 AI persona_key は除外）。
  - **STEP-GD-14**: 開始と同時に `buildRoomTheme(roomId, format)`（決定的キュレーション）で
    `theme` を確定して UPDATE する（同じ room は同じテーマ。AI 生成は将来置換）。
  - AI insert 失敗時は status を waiting に best-effort ロールバック。
  - 応答は GET room と同形（`{room, members, messages, isHost, currentUserMember, status}`）。
- `GET/POST /api/career/gd/room/[roomId]/messages`（STEP-GD-14）— 発言の取得・投稿。
  - GET: `afterSeq` 差分取得（ポーリング用）。参加者のみ。`{messages, latestSeq}`。
  - POST: `{content, clientMsgId}`。active のみ・退室者不可。人間は自分の member としてのみ投稿。
    同一 `client_msg_id` は冪等に同じ message を返す（`{message, idempotent}`）。
  - seq は room 単位でサーバ採番（`roomMessages.postRoomMessage`）。
- `POST /api/career/gd/room/[roomId]/ai-turn`（STEP-GD-14）— AI 1 名の発言生成・保存。
  - active のみ。直前発言者を避け発言最少の AI を決定的に選ぶ。theme/members/直近messages/persona で生成。
  - 生成成功時のみ保存（失敗時は保存しない）。冪等キー `ai-<participantId>-<priorCount>` で二重補完防止。
- `POST /api/career/gd/room/[roomId]/finish`（STEP-GD-14）— host が active→finished。
  - `finished_at` 設定。二重終了は冪等（既に finished は 200）。waiting/cancelled は 409。
  - `status='active'` 条件付き UPDATE でレース耐性。messages 0 件でも壊れない。
- `POST /api/career/gd/room/[roomId]/result`（STEP-GD-14・最小土台）— 発言量ベースの暫定結果。
  - finished のみ。参加者本人の簡易 self_feedback（実測発言量が根拠・断定なし）＋発言量ランキング（共有）を
    `career_gd_room_results` に `(room_id, user_id)` upsert（二重実行に強い）。`self_company_grade` は暫定 'B'。

### seq 採番 / 冪等（STEP-GD-14）

- **優先**: DB 側 RPC `career_gd_post_message`（`pg_advisory_xact_lock(room)` で採番を直列化して
  `max(seq)+1` を採番・INSERT。1 トランザクション内で atomic。`career_gd_multi_apply.sql` に追加・**未適用**）。
- **fallback**: RPC 未適用環境では app 層で「`max(seq)+1` → INSERT → 23505 なら再計算リトライ」。
  `UNIQUE(room_id, seq)` が重複・欠番を防ぐため競合しても破綻しない。
- 二重投稿は `UNIQUE(room_id, client_msg_id)` ＋アプリ層の既存行冪等返却で防ぐ。

## UI（実装済み）

- `/career/gd/room/create`（STEP-GD-11）— 作成→6桁コード表示。
- `/career/gd/room/join`（STEP-GD-12）— 6桁コード入力→参加→ロビーへ。
- `/career/gd/room/[roomId]`（STEP-GD-12 → STEP-GD-13 で開始対応）— ロビー。
  - room情報・参加者一覧（AIは persona 役回り・要約付き）・手動更新。
  - host かつ waiting: 「AIメンバーを補完して開始」ボタン（開始中は loading・成功で即反映）。
  - 非 host: 「ホストの開始を待っています」。active: 「開始済み（進行画面は STEP-GD-14 予定）」。

## 進捗

- [x] STEP-GD-10: DDL / RLS 設計ファイル・post-apply checklist 追加（**Supabase へは未適用**）。
- [x] STEP-GD-11: room 作成・6桁コード発行。
- [x] STEP-GD-12: 合言葉入力による参加（join）・room 取得・ロビー。join_code_hash を HMAC(pepper) 方式へ修正。
- [x] STEP-GD-13: AI 補完して開始（`start` API・10 タイプ persona・deterministic selection・ロビー開始UI）。
      persona は `persona`(jsonb) に格納。GET room で persona を返す（秘匿情報は返さない）。
- [x] STEP-GD-14: active session 画面（テーマ・残り時間・参加者・発言タイムライン・発言入力・AI発言・host終了）/
      messages GET・POST（seq サーバ採番・client_msg_id 冪等）/ ai-turn（AI 1名発言生成）/ finish /
      result（発言量ベースの暫定結果）/ 開始時テーマ確定（`buildRoomTheme` 決定的）。
      seq atomic RPC `career_gd_post_message` を apply SQL に追加（**未適用**・app 層 fallback あり）。
      **未実装（次 STEP 候補）**: 本格 feedback 採点（AI・軸別スコア→企業評価）/ 役割割当（role は 'member' 固定）/
      自動ターン進行・タイマー連動の締切 / result の localStorage 書き戻し（/career/gd/view 統合）/
      DB・KV ベースの join rate limit / システム進行メッセージ（役割アナウンス等）。
- [ ] STEP-GD-15 以降: 本格 feedback・順位（企業評価軸）/ view 統合 / 他機能連携 / Realtime（Phase3）。

詳細な履歴は [`gd_multi_steps.md`](./gd_multi_steps.md) を参照。
