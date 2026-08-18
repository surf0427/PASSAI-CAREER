# GD Production Readiness — STEP-GD-31

> 既存の Online MVP architecture（Supabase server 正本 / API ゲートウェイ / 合言葉 / 公開ロビー /
> ランダムマッチ / solo / human+AI 混成 / host 認可 / 冪等 / race 保護）を **温存したまま**、
> 本番運用に不足していた部分だけを埋めた STEP。作り直しは行っていない。

## 1. 何を足したか（7 本）

| # | 追加 | 主要ファイル |
|---|---|---|
| 1 | GD kill switch（server / UI 二段・**未設定 = OFF**） | `lib/careerGdGate/{flag,flags.server}.ts` |
| 2 | Realtime の実配信（publication + membership-scoped RLS） | `supabase/career_gd_realtime_apply.sql` |
| 3 | 切断検知（heartbeat + presence sweep + grace period） | `lib/careerGd/presence.ts` / `hooks/useCareerGdHeartbeat.ts` / `app/api/career/gd/room/[roomId]/heartbeat/route.ts` |
| 4 | timer の server 強制 + clock drift 補正 | `app/api/career/gd/room/roomLifecycle.ts` / `hooks/useCareerGdServerClock.ts` |
| 5 | Data Spine 接続（User + Company） | `app/api/career/gd/{resolveContextInputs,resolveCompanyOfficial,gdSpinePrompt}.ts` |
| 6 | observability / rate limit 拡張 | `app/api/career/gd/gdObservability.ts` / `lib/rateLimit/index.ts` |
| 7 | production QA + multi-client E2E | `scripts/gd-qa/production.qa.ts` / `tests/e2e/careerGdRealtime.spec.ts` |

## 2. 本番通電の手順（運用者向け）

### 2-1. DDL を適用する（Career Project B のみ）

```sql
-- Supabase SQL Editor（Project B = CAREER 専用プロジェクト）で実行する。
-- ★ 受験版 Project A では絶対に実行しない。
-- 再実行安全（idempotent）。DROP / TRUNCATE / 既存データ削除は含まない。
\i supabase/career_gd_realtime_apply.sql
```

適用後の確認（すべて read-only）:

```sql
-- ① publication に 3 表だけが入っていること（results / match_queue は入らない）
SELECT tablename FROM pg_publication_tables
 WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename LIKE 'career_gd_%'
 ORDER BY tablename;
-- 期待: career_gd_room_members / career_gd_room_messages / career_gd_rooms

-- ② policy は SELECT のみ・membership scoped
SELECT tablename, policyname, cmd, roles FROM pg_policies
 WHERE schemaname='public' AND tablename LIKE 'career_gd_%' ORDER BY tablename;

-- ③ presence 列が増えたこと
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='career_gd_room_members'
   AND column_name IN ('last_seen_at','connection_state');

-- ④ 非メンバーからは 0 行（別 user の JWT で実行すること）
SELECT count(*) FROM career_gd_rooms;
```

### 2-2. env を設定する

| env | 値 | 必須 | 未設定時 |
|---|---|---|---|
| `CAREER_GD_ENABLED` | `true` | **必須** | GD API が全て 404（kill switch ON = 機能停止） |
| `NEXT_PUBLIC_CAREER_GD_ENABLED` | `true` | **必須** | GD 導線が Home から消える |
| `CAREER_GD_JOIN_CODE_PEPPER` | 長いランダム文字列 | 推奨 | CAREER service-role key へ fallback |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Upstash の値 | **推奨** | in-memory fallback（上限が「インスタンス数 × limit」に緩む。合言葉 join は fail-closed のため 429 が出やすくなる） |
| `CRON_SECRET` | 既存 | 必須 | cleanup cron が 401（期限切れ room が回収されない） |

★ **緊急停止**は `CAREER_GD_ENABLED` を削除するだけ。DB データは消えない。

### 2-3. Realtime smoke（コード検査では代替できない）

DDL 適用後、必ず実配信を確認する:

1. member A で room を作り、member B（別端末 / 別ブラウザ）で join。
2. A の画面の同期バッジ（`[data-testid="gd-sync-mode"]`）が **`live`** になること。
   `degraded` のままなら publication か RLS が効いていない。
3. B が発言 → A に即時（3 秒ポーリングを待たずに）表示されること。
4. 非メンバー C の JWT で `SELECT count(*) FROM career_gd_rooms` が **0** を返すこと。

## 3. 切断検知のモデル

```text
heartbeat（15 秒ごと・POST /heartbeat）
        │  途絶
        ▼
 45 秒（GD_DISCONNECT_AFTER_SEC）… connection_state = 'disconnected'  ← grace period
        │  さらに途絶
        ▼
180 秒（GD_STALE_AFTER_SEC）……… connection_state = 'stale'
```

**★ disconnect ≠ leave。** どの段階でも `left_at` は立たない（再接続で `online` に戻る）。
モバイルの一時切断で参加者を退室させないための分離。既存の満員判定・AI 補完人数・評価対象は
従来どおり `left_at` のみを見る（`isActiveHumanMember`）ので、接続状態で product 挙動は変わらない。

## 4. timer の権限

| 項目 | 正本 |
|---|---|
| 開始時刻 | `career_gd_rooms.started_at`（DB / server now） |
| 残り時間の表示 | client（ただし `serverNow` で clock offset 補正済み） |
| **終了の決定** | **DB の `now()`**（`career_gd_finish_if_expired` / `status='active'` 条件付き UPDATE） |
| host 不在時 | 他参加者のリクエスト経路 + cron（`career_gd_finish_expired_all`）で必ず終了 |

クライアント時計を偽装しても、期限を越えた発言・AI 発言は server が 409 で拒否する。

## 5. Data Spine 接続

`gd_feedback` purpose を DORMANT → **live** へ昇格させた。

- **User Data Spine**: base 3（profile / activity / values）+ 自己分析 + 過去 GD
- **Company Data Spine**: 企業が指定されたときのみ（GD 専用 usage note 付き）

★ **採点契約は不変**: 総合点 / ランク / 企業コミュ適性は今も server の決定論算出で、
AI は軸スコアと根拠しか返さない。Spine は「助言の宛先合わせ」にのみ使い、
renderer が「採点根拠にしない」ことと prompt injection 境界を prompt 内で明示する。

★ Spine が解決できない環境（canary 未通電 / 企業未指定）では block が `''` になり、
prompt は従来と **byte 完全一致**（＝非破壊）。

## 6. QA

```bash
npm run qa:careerGd            # 既存: GD の product 仕様（お題 / テーマ / 部屋終了）
npm run qa:careerGdProduction  # 新規: 本番運用条件（flag / RLS / 切断 / timer / Spine / rate limit）
npx playwright test tests/e2e/careerGdRealtime.spec.ts   # multi-client（実 DB・要 storageState）
```

`qa:careerGdProduction` は **静的 + 単体**。Realtime の実配信・切断の相互可視・server timer の
実効は E2E（`careerGdRealtime.spec.ts`）でしか証明できないため、両方を通すこと。

## 7. 今回やっていないこと（別 Phase）

- **音声 / WebRTC**（remote audio）— 実装ゼロのまま。GD は text online GD として完成させた。
- host migration / kick / 高度な moderation / phase 進行（導入→発散→収束→発表）。
