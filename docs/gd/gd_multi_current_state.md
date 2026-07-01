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
- ranking は参加者全員に共有。詳細 FB は本人のみ。AI も ranking に含めるが AI と明示する。
- ターン進行は **2〜3 秒ポーリング＋手動更新**（Realtime は Phase3）。

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

## UI（実装済み）

- `/career/gd/room/create`（STEP-GD-11）— 作成→6桁コード表示。
- `/career/gd/room/join`（STEP-GD-12）— 6桁コード入力→参加→ロビーへ。
- `/career/gd/room/[roomId]`（STEP-GD-12）— ロビー（room情報・参加者一覧・手動更新）。開始/進行は近日公開。

## 進捗

- [x] STEP-GD-10: DDL / RLS 設計ファイル・post-apply checklist 追加（**Supabase へは未適用**）。
- [x] STEP-GD-11: room 作成・6桁コード発行。
- [x] STEP-GD-12: 合言葉入力による参加（join）・room 取得・ロビー。join_code_hash を HMAC(pepper) 方式へ修正。
      **start / session / message / ai-turn / feedback は未実装**。
- [ ] STEP-GD-13: AI 補完して開始（`start` API：`/theme`＋`buildAiParticipants`＋`assignRoles` 再利用）。
- [ ] STEP-GD-14 以降: 進行 / feedback・順位 / view 統合 / 連携確認。

詳細な履歴は [`gd_multi_steps.md`](./gd_multi_steps.md) を参照。
