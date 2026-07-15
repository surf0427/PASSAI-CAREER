# GD マルチ 決定的 QA（登録済み・再実行可能）

外部 AI / Supabase / env に依存しない純ロジックの回帰テスト。CI・ローカルで再実行できる。

```bash
# テーマ入力検証（修正1: 作成時テーマ確定）
npx tsx scripts/gd-qa/roomThemeInput.qa.ts

# ルーム終了 cancelRoom（修正2/3: 部屋終了・リーダー退出の再実行整合性）
npx tsx scripts/gd-qa/roomClose.qa.ts
```

いずれも失敗時は非0 exit で終了する。

- `roomThemeInput.qa.ts` — `lib/careerGd/roomThemeInput.ts` の `parseRoomThemeInput` / `isThemeConfirmed`。
- `roomClose.qa.ts` — `lib/careerGd/roomCloseCore.ts` の `cancelRoomCore` を fake Supabase adapter で検証
  （部分障害後の再実行補正・冪等 cleanup・finished 保護・close/host-leave の収束・レース耐性）。
