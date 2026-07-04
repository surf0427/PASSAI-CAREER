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
- `POST /api/career/gd/room/[roomId]/result`（STEP-GD-15・本格採点）— messages 本文を根拠にした AI 評価。
  - finished のみ。**発言量ベースの暫定評価は廃止**。評価対象は**人間参加者のみ**（AI は文脈のみ・採点対象外）。
  - AI は 6 軸（0〜100）＋強み/課題/改善/goodQuotes/matchingHints を返す。**合計スコア・ランク(S〜D)・
    企業コミュ適性グレードは server が決定論算出**（AI に決めさせない）。goodQuotes は実発言に含まれるものだけ採用。
  - 初回呼び出しで room 内**全人間ぶんを評価・upsert**（ranking を共有・一貫化）。本人の評価済み行(version=2)が
    あれば AI を再呼び出しせず返す（二重実行に強い）。空議論・本人発言0件は**採点不能**(`scored:false`)。
  - 保存: `self_feedback`=本人評価(jsonb) / `ranking`=スコア順(共有) / `matching_hints`={hints[],summary} /
    `self_company_grade`=本人ランク / `overall_summary`=`generateCareerGdSummary()`（相談AI 連携用の圧縮サマリー）。
  - 評価ロジック・プロンプトは [`roomFeedback.ts`](../../app/api/career/gd/room/roomFeedback.ts)。

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
- [x] STEP-GD-15: 本格 feedback 採点（messages 本文を根拠にした AI 評価）。6 軸(0〜100)＋総合スコア・
      ランク(S〜D)・企業コミュ適性グレード（server 決定論）＋強み/課題/改善/goodQuotes/matchingHints。
      人間のみ採点・AI は採点対象外。goodQuotes は実発言検証。結果 UI（6軸レーダー・グレード・ヒント）。
      相談AI 連携用 `generateCareerGdSummary()` を追加し `overall_summary` に保存。
      **未実装（次 STEP 候補）**: 役割割当（role は 'member' 固定）/ 自動ターン進行・タイマー連動の締切 /
      result の localStorage 書き戻し（/career/gd/view 統合）/ 相談AI・careerMatching への実注入 /
      DB・KV ベースの join rate limit / システム進行メッセージ（役割アナウンス等）。
- [x] STEP-GD-16: マルチGD 結果の学習履歴。結果生成時に `careerGdRoomLogs`（localStorage canonical）へ
      書き戻し（roomId で重複排除）。`career_gd_room_results`（Supabase）が durable mirror。
      `/career/gd/view` に「マルチGD 履歴」セクション（統計＝実施回数/平均/最高スコア/最高ランク、
      テーマ検索＋ランク/スコア帯フィルタ、一覧カード、詳細＝`GdEvaluationDetail` 共用、履歴削除）を追加。
      評価詳細 UI は room 結果画面と共通コンポーネント `GdEvaluationDetail` に集約。
      **未実装（次 STEP 候補）**: run/result のルート統一（/career/gd/run・/career/gd/result）/
      Supabase からの履歴ハイドレート（別デバイス同期）/ 他機能への結果注入 / 役割割当・進行制御 / Realtime（Phase3）。
- [x] STEP-GD-17: マルチGD結果を **相談AI・careerMatching へ参考シグナルとして連携**。
      取得は `careerGdRoomLogs`（localStorage・既存 CAREER 設計どおり client→API へ圧縮スナップショットを送信、
      route は Supabase を読まない）。`lib/careerGd/context.ts` に multi-GD 用の
      `buildLatestGdRoomSignals` / `normalizeGdRoomSignal` / `formatGdRoomSignalsForConsultation` /
      `formatGdRoomSignalsForMatching` を追加（既存 solo 経路は非破壊）。
      - 相談AI: `gdRoom`（最新3件）を圧縮注入。overall_summary(=`generateCareerGdSummary`)＋総合/ランク/
        企業コミュ適性＋上位3軸＋strengths/improvements/matchingHints。「傾向」扱い・断定/人格分析禁止。
      - careerMatching: `gdRoomSignals`（最新3件・代表1件を軽量注入）。6軸＋企業コミュ適性を **補助シグナル・
        weight低め**として AI signal 根拠に添えるのみ。総合スコア・順位・重みは決定的エンジン
        `runCareerMatch` が担い、**GD はエンジンに入れない**（既存80〜90% / GD 10〜20% 相当の低影響）。
      - UI: 相談AIは「GD結果も参考にしています」を控えめ表示、matching は既存「GD結果」readiness を
        マルチGDでも点灯（過剰表示しない）。
      - **未実装（次 STEP 候補）**: run/result ルート統一 / Supabase 履歴同期 / 面接・ES への注入 / 成長グラフ。
- [x] STEP-GD-18: GD導線の整理（`/career/gd` ハブ完成形に近づける）。
      - `/career/gd/run`（新規）: 1人練習（ソロGD）の正規エントリ。実体は既存 `setup`→`session`（`redirect`）。
      - `/career/gd/result`（新規）: ソロ結果画面。`careerGdResults` を読み `?id=` or 直近1件を表示。
        結果無しは `run`/ハブへ誘導。**マルチ結果は混ぜず** `view` へ誘導。ソロ session 完了後の遷移先も
        `view?id=` → `result?id=` に統一。
      - `GdSoloResultDetail`（新規・共有）: ソロ結果詳細を view から抽出し view/result で共用（挙動不変）。
      - `/career/gd/view`: 「1人練習（ソロGD）の履歴」/「ルームGD（マルチ）の履歴」に表示名整理（STEP-16 統合は非破壊）。
      - hub: 4 導線（1人練習を始める / ルーム作成 / 合言葉で参加 / 結果・履歴）に整理。
      - solo=`careerGdResults` / multi=`careerGdRoomLogs` の分離維持（key 追加なし・Supabase 変更なし・採点ロジック不変）。
      - STEP-GD-17 の consultation/matching 連携は非破壊（context 連携はそのまま）。
- [x] STEP-GD-19: マルチGD履歴の **Supabase durable mirror → localStorage hydrate**（別デバイス閲覧）。
      - GD履歴表示時に **1 回だけ**、ログイン済みユーザーのみ `career_gd_room_results` を **RLS 経由**（authenticated・
        `getBrowserSupabaseClient`）で自分の行(`user_id=auth.uid()`)を取得（service_role 不使用・必要列のみ select）。
      - 取得 → `mergeGdRoomLogs`（**merge only**・local を消さない・重複判定キー=**roomId**・両方あれば richer な local 優先）
        → `careerGdRoomLogs`（既存 key・新 key 追加なし）。UI に「クラウド同期済み」を控えめ表示。
      - **localStorage canonical + Supabase durable mirror は不変**（Supabase canonical 化しない）。
      - 失敗（未ログイン / env 未設定 / ネットワーク / RLS 拒否）は never throw・[] で localStorage 表示を継続。
      - hydrate 行はテーマ/所要時間を持たない（結果 table に無い）ため既定値になるが、評価・ランキング・
        matchingHints・サマリー・スコア/ランク/企業コミュ適性は self_feedback 等から復元される。
      - STEP-17 の consultation/matching 連携は `careerGdRoomLogs` を読むだけなので hydrate 後もそのまま動作。
      - **⚠ 運用前提（本 STEP では変更しない）**: 現状 `career_gd_*` は service_role のみ table 権限を持つため、
        authenticated の直接 SELECT は `42501 permission denied` になる（実機確認済み）。別デバイス hydrate を有効化するには
        運用者が `career_gd_room_results` に対し **(1) `GRANT SELECT ... TO authenticated`** と
        **(2) owner-select RLS policy `USING (auth.uid() = user_id)`**（apply SQL 内にコメントで用意済み）を適用する必要がある。
        いずれも本 STEP では適用しない（コードは 42501/0 行でも never throw・localStorage 表示を継続）。
        GD-14.5 の RPC と同じ「コード先行・運用者が SQL 適用」方式。
- [~] STEP-GD-20: **公開GDロビー方式（先行実装）**。完全ランダムキュー（`career_gd_match_queue`）ではなく、
      ユーザーが公開 room を作り一覧から選んで参加する方式を先行（初期ユーザー数が少ない段階での実装/運用/UX の安全性）。
      - **20-A（DB・未適用）**: [`supabase/career_gd_public_lobby_apply.sql`](../../supabase/career_gd_public_lobby_apply.sql)。
        `career_gd_rooms.room_type`（invite|public_lobby|random_match・default invite）/ `join_policy`（code|public|matched_only・default code）追加、
        公開一覧用 index・同一 host 乱立防止 部分 UNIQUE、RPC `career_gd_lobby_join(uuid,uuid,text)`
        （`SECURITY DEFINER` / `search_path=public,pg_temp` / service_role のみ EXECUTE）。**追加のみ・既存 DDL/RPC 不変**。
      - **20-B（API・実装済み）**: `POST /api/career/gd/lobby/create` / `GET /api/career/gd/lobby/rooms` /
        `POST /api/career/gd/lobby/join`。公開 room は `join_code_hash='pub_'+roomId`（非 hex・NOT NULL 充足）で、
        既存合言葉 join 検索（`.eq(<hex>)`）に構造上ヒットしない＝**既存 join route 無改修で合言葉参加を遮断**。
        join は **RPC `career_gd_lobby_join` に委譲**（advisory lock で満員/二重参加を原子制御）。
        レスポンスに `host_user_id`/`user_id`/email/`join_code_hash` を出さない。
      - **20-C（UI・実装済み）**: `/career/gd/lobby`（作成フォーム＋10秒ポーリング一覧＋参加、0件時はソロAI導線）と
        `/career/gd` の「公開ルームで練習する」カード。作成・参加後は既存 `/career/gd/room/[roomId]` へ遷移（room 画面不変）。
      - **AI 補完は既存 `start` 処理に委譲**（host start 必須の既存仕様は不変。4 人なら補完なし・2〜3 人なら AI 補完）。
      - **20-D（実DB QA ＋ docs）**: read-only probe で（当時参照していた project では）**20-A の SQL が未適用**を確認
        （`room_type`=42703 / RPC=PGRST202）。コードは未適用時に 503 `DB_NOT_APPLIED` で安全縮退（`isDbNotReady`）。
      - **20-G（member ログイン E2E QA・最新）**: 運用者により **正しい project ref `bhhmvupzcxoaonrowikg`** が確定
        （この project は **20-A 適用済み**）。service_role で email_confirm 済みテスト member を用意し（email/id/pw/JWT/cookie 非出力・
        member_count のみ報告）、**member ログイン必須 E2E を完走**：HTTP（未ログイン401 / session→API 200）・公開ロビー
        **31 checks**（create/reused/一覧 public_lobby のみ/invite 混入なし＆ lobby/join 404/join/冪等/満員409/**同時 join 定員超過なし**/秘匿列なし）・
        room 進行 **34 checks**（非host start 403 / host start active / **2〜3人=AI補完あり・4人=AI補完なし** / `career_gd_post_message`
        seq 単調採番・`clientMsgId` 冪等 / finish 冪等 / **result 生成 AI 6軸＋ranking** / `career_gd_room_results` DB 保存）・
        **合言葉回帰 14 checks**（legacy create/join/start/message/result・public_lobby↔invite 分離維持）。
        履歴は `careerGdRoomLogs`=localStorage canonical（client）で durable mirror の DB 保存を確認。UI は 3 ページ member session で
        **HTTP 200 render**＋lobby UI コード（作成フォーム/10秒polling/redirect/isMine·isJoined·isFull/空状態/error表示/秘匿列なし）を確認。
        **⚠ 実ブラウザ操作 E2E はヘッドレスブラウザ不在で未実行**（HTTP＋render＋コードレビューで代替）。
        cleanup で test room/members/messages/results を cascade 削除（residual 0）・test member 削除（`auth users`→0）・4 table 全 0 行を確認。
        `tsc`/`lint`/`build`・secret scan clean・**コード変更なし**。
      - **20-H（公開ロビー 実ブラウザ E2E・最新）**: **Playwright（`@playwright/test` 1.61.1）＋ システム Chrome
        `channel:'chrome'` headless**（browser バイナリDLは環境制約で不可）で公開ロビーを実操作。テスト member の storageState
        （auth cookie・秘密は tracked 非混入）で認証し、**10/10 PASS**：render / 作成→room遷移 / reused / 一覧→参加 /
        isMine·isJoined ボタン切替 / **lobby 10秒auto-poll の人数更新** / **満員ボタン disabled** / 非host開始不可・host start＝active＋theme＋
        **AI補完2/総勢4** / 発言→表示・**他member発言が3秒polling反映**・finish・**AI評価描画**・`/career/gd/view` 履歴表示 /
        **合言葉回帰**（誤コード拒否・invite は公開ロビー非表示・start/message/finish/result）。実行中 `career_gd_room_results` 4行 persist を確認。
        **本番コード変更は非機能の data-* test hooks 2箇所のみ**（lobby RoomCard／room MembersCard・DOM 属性追加・挙動不変）。
        `tests/**` は tsc/eslint/build 除外・`test-results/`・`.e2e-tmp/` gitignore。cleanup で rooms4/members12/messages3/results4・
        test member4 を削除（全 table 0・auth users 0）・storageState/creds 削除。`tsc`/`lint`/`build` clean・E2E 10/10・secret scan clean。
      - **20-I（参加人数 4/6/8 の 3 択固定・最新）**: GD 人数を全モード共通で **4/6/8 のみ**に固定。正本
        [`lib/careerGd/participantCount.ts`](../../lib/careerGd/participantCount.ts)（定数/型/ガード/既定4/`parseParticipantCount`/将来の人数別キュー定数）を
        UI/API/DB/テストが参照。**DB**: `career_gd_rooms_planned_count_chk` を `IN (4,6,8)` に（`career_gd_multi_apply.sql` 更新＋
        idempotent 増分 `career_gd_participant_count_apply.sql`・既存不正値は丸めず RAISE で停止・**運用者適用**）。**API**: 公開ロビー/合言葉 create で
        4/6/8 以外を 400 `INVALID_COUNT`・未指定は既定4。**UI**: lobby/setup/room-create を 4人/6人/8人 の 3 択・既定4。**AI 補完**: room 側は元々 planned 依存で
        6/8 動作、ソロ側 AI 名/スタイルを 8 人分に拡張。満員判定・RPC `career_gd_lobby_join` は planned 基準で一致。
        検証: **Playwright 17/17 PASS**（4人 A–G ＋ 6人 ＋ 8人 ＋ API不正値拒否 ＋ 合言葉8人）・**HTTP QA 25/25 PASS**（不正値400/有効200/6人5join/8人6join→AI補完2→計8/
        満員409/同時join定員超過なし）。cleanup で全 table 0・auth users 0（テスト member は満員観測のため 6 名）。`tsc`/`lint`/`build`・secret scan clean。
      - **20-J（host start 促し UI・最新）**: waiting room の放置を防ぐ UI 追加（`WaitingView` のみ・**DB/API 変更なし**）。
        人数状態「参加状況 {human}/{planned}・AIメンバー補完予定 {aiFill}」（`aiFill=max(0,planned−human)`・満員は「全員そろっています」）を
        host/非host 共通表示。**host**: 不足あり=「あなたがホストです」＋補完人数説明＋CTA「AIメンバーを補完して開始」／満員=「参加者が全員そろいました」＋CTA「GDを開始する」（AI補完文言なし）。
        **非host**: 「ホストの開始を待っています」＋AI補完で開始可能な旨・start CTA なし。4/6/8 で文言非破綻・start実行中disabled・失敗は`role="alert"`。
        検証: **Playwright 21/21 PASS**（新規 `careerGdHostPrompt.spec` A host/B 非host/C 満員/D 6人=補完4・8人=補完6 ＋ 既存全回帰）・**HTTP QA 25/25 PASS**。
        cleanup で全 table 0・auth users 0。`tsc`/`lint`/`build`・secret scan clean。（フル E2E は Supabase 一時 DNS 障害で1度失敗→回復後 21/21・コード起因でない）
      - **20-K（公開ロビー create/join rate limit・最新）**: 連打/改ざん濫用を 429 で止める MVP。**user（auth.uid()）単位**・key は hash 化
        （生 user_id を store/ログ/response に出さない）・namespace 分離・短期/中期 2 window。lobby create=3/60s・10/3600s、lobby join=10/60s・30/3600s、
        合言葉 create=5/60s・20/3600s、join=10/60s・40/3600s。store は **Upstash Redis REST（env 設定時）→ 未設定は in-memory fallback**（本番未設定時は起動警告＝
        silent no-op にしない）。無効化フラグ `CAREER_GD_RATE_LIMIT_DISABLED`（**test/local 用**・既定=有効）。429=`{error:'RATE_LIMITED',message,retryAfterSeconds}`＋
        `Retry-After`/`X-RateLimit-*` header（PII/user_id/room_id 非混入・`ROOM_FULL`/`INVALID_COUNT` と非混同）。UI は lobby `friendlyError` に 429 文言を追加（`role="alert"`・
        ボタン永久 disabled にならない）。util `lib/rateLimit/`（将来 ES/面接/プレゼン再利用可）。検証: **unit 19/19**（`npm run qa:rateLimit`）・**HTTP QA 17/17**
        （create/join 429・別member非影響・namespace 分離）・**Playwright @ratelimit 2/2**（UI 429 alert・満員と区別）・**回帰 Playwright 21/21＋counts QA 25/25**（bypass）。
        cleanup で全 table 0・auth users 0・rate limit test key は in-memory（サーバ停止で消滅）。`tsc`/`lint`/`build`・secret scan clean。
      - **20-L（GD 結果履歴 DB hydrate / SELECT・RLS 整理・最新）**: 別デバイス・再ログイン・localStorage 消失後でも
        「**本人が参加した room の自分の結果だけ**」復元可能に。**owner-select RLS**（`auth.uid()=user_id`）＋`GRANT SELECT TO authenticated`
        （[`career_gd_results_hydrate_apply.sql`](../../supabase/career_gd_results_hydrate_apply.sql)・idempotent・運用者適用・本 project は適用済み確認）。
        取得は新規 **server route `GET /api/career/gd/room/results`**（member 必須・`user_id=session` をサーバ強制・theme/人数を join・**RLS 未適用でも動作**・PII 非返却）。
        client は route→`CareerGdRoomLog` 正規化→ `mergeGdRoomLogs`（roomId 重複排除・local 優先・merge only・DB 失敗でも LS 維持）。UI（`MultiGdHistorySection`）は
        loading/「別デバイス保存分も表示中」/失敗時の控えめ警告を表示。**owner-scoped 採用理由**: member-scoped は共有 room の他人 self_feedback が読めてしまい厳守事項に反するため。
        検証: **security/API 18/18**（A/B/C の自分のみ・他人不可視・401・PII非混入・共有room人数）・**Playwright @hydrate 4/4**（別デバイス復元/他人不可視/重複なし/DB失敗fallback）・
        **回帰 21/21＋@ratelimit 2/2＋counts 25/25＋rate unit 19/19**。cleanup で全 table 0・auth users 0。`tsc`/`lint`/`build`・secret scan clean。
      - **残課題**: ① Realtime（Phase3）② CI 用 Playwright browser setup ③ DB CHECK 4/6/8 の本番/preview 適用状況
        ④ Upstash Redis の本番/preview 設定状況 ⑤ room timeout / abandon cleanup ⑥ 将来的な Bot 対策/CAPTCHA。
        （20-G/H/I/J/K/L に加え **STEP-GD-21「完全ランダムマッチ本体」も完了**＝残課題①の完全ランダムマッチは解消。）
- [x] STEP-GD-21: **完全ランダムマッチ本体（完了・実DB / 実ブラウザ QA 済み）**。ユーザーが人数（4/6/8）を選び「ランダムマッチに参加」で
      同人数希望の他 member と自動で room 成立→room 詳細へ遷移。公開ロビーとは分離した `RandomMatchPanel`（`/career/gd/lobby` 上部）。
      - **方式（自動成立を優先）**: 満員成立（planned に達したら即）＋ AI 補完前提の早期成立（人間≥2 かつ 最古待機者が
        しきい値超過＝4→30s/6→45s/8→60s）。人間1人では成立させない（ソロ化防止・しばらく相手が来なければソロGD導線）。手動開始方式は不採用。
        しきい値は env `CAREER_GD_MATCH_WAIT_OVERRIDE_SEC`（test/local 用・本番未設定・body 非経由）で一律上書き可。
      - **DB（[`career_gd_match_queue_apply.sql`](../../supabase/career_gd_match_queue_apply.sql)・idempotent・運用者適用待ち）**:
        `career_gd_match_queue`（人数別は planned_count 列・status waiting|matched|cancelled|expired・room_id FK・expires_at 10min）＋
        **部分 UNIQUE `WHERE status='waiting'`（同一 user は waiting 1つ）**。RLS は deny-by-default（authenticated 直読み用 GRANT/policy はコメントで用意・未適用）。
        競合制御 RPC（SECURITY DEFINER・service_role のみ）`career_gd_match_try/enter/poll/cancel`：バケット `pg_advisory_xact_lock`＋
        **`FOR UPDATE SKIP LOCKED`** で二重 room・定員超過を原子的に防止。room は `room_type='random_match'`/`join_policy='matched_only'`/
        `join_code_hash='rnd_'+uuid`（合言葉 join に構造上ヒットせず・公開ロビー一覧＝public_lobby 限定にも出ない）。host=最古の待機者。
      - **API**（member 必須・service_role・DB 未適用は 503 縮退・`p_user_id`=session 強制）:
        `POST /match/enter`（`{plannedCount}`・4/6/8 以外は 400 `INVALID_COUNT`）/`GET /match/status`（matched/waiting/cancelled/expired/none・5秒 polling 前提）/`POST /match/cancel`。
        rate limit: enter 10/60s・30/3600s、status 60/60s・600/3600s、cancel 10/60s・30/3600s（超過 429）。
      - **UI**: 4/6/8 選択→参加→waiting（`waitingCount` 表示）＋キャンセル・5秒 polling（matched で `router.push`・離脱で cleanup・429 でも壊さない）・
        ソロGD導線。非機能 test hooks（`data-testid=gd-random-match-panel`/`data-phase`/`data-waiting-count`）。秘匿列は非表示。
      - **reconciliation（STEP-GD-21.1・実DB適用時）**: 先行適用された参照実装に **`career_gd_rooms.planned_count`（存在しない列）へ INSERT する致命バグ**が
        あり room 生成が必ず失敗（4人 enter しても matched にならない）。加えて公開契約が異なった（`enter` 2引数・戻り値 camelCase・`expire_stale()` あり）。
        → SQL を **reconciled 版に書き換え**（契約＝`enter(uuid,int,int)`/`poll(uuid[,int])`/`cancel(uuid)`/`try(int[,int])`/`expire_stale()`・
        戻り値 camelCase を維持しつつ **列名を `planned_participant_count` に修正**・旧シグネチャ DROP→再作成の冪等・`service_role` にテーブル CRUD GRANT）。
        API route も camelCase/3引数契約に適合。**reconciled SQL は運用者が再適用済み**（`Success. No rows returned`）。
      - **実DB / 実ブラウザ QA（STEP-GD-21.2・再適用後・完了）**:
        **契約/RPC** `career_gd_rooms.planned_count` 参照なし・`planned_participant_count` 使用・enter/poll/cancel/try/expire_stale 解決（DB_APPLIED・camelCase・service_role SELECT 可）。
        **実DB 並行 enter 競合（真の並行=Promise.all・44/44）**：4/6/8 同時 enter→room1・全員同 roomId・members一致・host最古1名・queue全matched／5名4希望→4名room1＋1waiting／同一user多重→waiting1行。
        **Live HTTP/API（26/26）**：未ログイン401・不正人数400 INVALID_COUNT・認証 enter→200 waiting（**503でない**）・4member HTTP→同 roomId・match rate limit 429・PII非返却。
        **Playwright `@random-match`（4/4・WAIT_OVERRIDE=0）**：enter/waiting/cancel/再enter・2人成立→room遷移→host start→AI補完2→active4・非公開・queue分離。
        **既存回帰**：lobby 9/9（G は AI latency 1回 flake→再実行 PASS）・counts+hostPrompt+invite 8/8・participantApi 4/4・@ratelimit 2/2・rate unit 19/19・hydrate route intact（401/200/PII非返却）。
        cleanup で全 career_gd_* 0・auth users 0・storageState/一時資材削除。`tsc`/`lint`/`build`・secret scan clean。
      - **残課題**: Realtime（Phase3）/ CI 用 Playwright browser setup / DB CHECK 4/6/8 の本番/preview 適用 / Upstash Redis 設定 / room timeout・abandon cleanup（本 STEP は期限切れ expire の最小 cleanup のみ）/
        Bot/CAPTCHA/abuse monitoring / ランダムマッチ UX 改善（待機時間表示・自動 start・条件別/企業・業界・志望職種別マッチング）。
- [x] STEP-GD-22: **room timeout / abandon cleanup（production hardening・DB は運用者適用待ち）**。放置 room/queue/member/message が本番で残り続けないよう定期 cleanup。
      **finished room・result 済み room・現在 waiting の match_queue は絶対に消さない**。random_match/public_lobby/invite は状態・TTL・結果有無だけで判定。
      - **DB（[`career_gd_cleanup_apply.sql`](../../supabase/career_gd_cleanup_apply.sql)・idempotent・運用者適用待ち）**: `career_gd_cleanup_abandoned_rooms(waiting_ttl=60,active_ttl=180,dry)`
        （未開始 waiting room[結果なし]削除＋queue 行削除／放置 active[結果なし]→cancelled soft-close／古い cancelled[結果なし]削除）＋`career_gd_cleanup_stale_queue(ttl_days=7,dry)`
        （終端 match_queue 行削除・waiting は消さない）。両 RPC SECURITY DEFINER・service_role のみ・no-result/finished ガード。waiting queue→expired は既存 `career_gd_match_expire_stale()` 再利用。
      - **API [`GET|POST /api/cron/gd-cleanup`](../../app/api/cron/gd-cleanup/route.ts)**: `Authorization: Bearer CRON_SECRET`（未設定 fail-closed 401）・`?dryRun=true`・TTL は query 上書き可・secret/PII 非出力・env 未設定でも build 落ちない。
        `vercel.json` に daily cron（`0 16 * * *`）追加・`.env.example` に `CRON_SECRET` 明記。
      - **QA**: cleanup ロジック **PGlite 30/30**（abandoned 削除＋cascade＋queue／recent public・invite 誤削除なし／result・finished 保護／active soft-cancel で message 保持／old cancelled 削除／
        stale_queue 終端のみ・waiting 保護／dry-run 非 mutate）・route auth **live 5/5**（401/正secret DB 到達・PII 非漏洩）・`tsc`/`lint`/`build`・secret scan clean。
        **⏳ 実DB cleanup QA は `career_gd_cleanup_apply.sql` 運用者適用後に実施予定。**
      - **残課題**: 運用者適用 → 実DB cleanup QA／finished room 長期アーカイブ方針（現状 残す）。
- [ ] STEP-GD-23 以降: room 情報（theme/所要時間）を含む hydrate（rooms owner-select policy 検討）/ 面接・ES 連携 / Realtime（Phase3）。

詳細な履歴は [`gd_multi_steps.md`](./gd_multi_steps.md) を参照。
